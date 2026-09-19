import type { JsonObject, JsonRpcError } from "./contracts.js";
import { normalizeJsonObject } from "./json-boundary.js";

type DiagnosticStage = "envelope" | "canonical" | "error" | "projection";
type DiagnosticChannel = "meta" | "structuredContent" | "root" | "connection";

/** A deliberately value-free description of a browser/host contract failure. */
export interface UiResultDiagnostic {
  readonly format: "loomex/ui-result-diagnostic/v1";
  readonly stage: DiagnosticStage;
  readonly channel: DiagnosticChannel;
  readonly code: string;
  readonly fields: readonly string[];
}

/** Result decoding must fail closed: malformed host data never becomes `{}`. */
export class UiResultDecodeError extends Error {
  readonly diagnostic: UiResultDiagnostic;

  constructor(message: string, diagnostic: UiResultDiagnostic) {
    super(message);
    this.name = "UiResultDecodeError";
    this.diagnostic = diagnostic;
  }
}

function diagnostic(stage: DiagnosticStage, channel: DiagnosticChannel, code: string, value: unknown): UiResultDiagnostic {
  return { format: "loomex/ui-result-diagnostic/v1", stage, channel, code, fields: fieldShapes(value) };
}

// Do not expose result values, arbitrary keys, credentials, or provider output.
function fieldShapes(value: unknown): readonly string[] {
  const object = normalizeJsonObject(value);
  if (object === null) return ["value:non_json_object"];
  const allowed = ["isError", "structuredContent", "_meta", "error", "ok", "data"];
  return allowed.flatMap((key) => {
    if (!Object.hasOwn(object, key)) return [];
    const field = object[key];
    return [`${key}:${field === null ? "null" : Array.isArray(field) ? "array" : typeof field}`];
  });
}

function object(value: unknown, stage: DiagnosticStage, channel: DiagnosticChannel, code: string, message: string): JsonObject {
  const normalized = normalizeJsonObject(value);
  if (normalized === null) throw new UiResultDecodeError(message, diagnostic(stage, channel, code, value));
  return normalized;
}

function optionalObject(value: unknown): JsonObject | undefined {
  if (value === undefined) return undefined;
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as JsonObject : undefined;
}

/** Normalizes only the result fields that the browser bridge may inspect. */
export function normalizeUiRpcResult(value: unknown): JsonObject {
  const root = object(value, "envelope", "root", "UI_RESULT_ROOT_INVALID", "The host returned an invalid result envelope.");
  const structured = optionalObject(root.structuredContent);
  const meta = optionalObject(root._meta);
  if (root.structuredContent !== undefined && structured === undefined) {
    throw new UiResultDecodeError("The host returned an invalid structured result.", diagnostic("envelope", "structuredContent", "UI_STRUCTURED_CONTENT_INVALID", root));
  }
  if (root._meta !== undefined && meta === undefined) {
    throw new UiResultDecodeError("The host returned invalid result metadata.", diagnostic("envelope", "meta", "UI_METADATA_INVALID", root));
  }
  return {
    ...(root.isError === true ? { isError: true } : {}),
    ...(structured !== undefined ? { structuredContent: structured } : {}),
    ...(meta !== undefined ? { _meta: meta } : {}),
    ...(root.error !== undefined ? { error: root.error } : {}),
    // Some hosts send the result itself as a notification parameter.
    ...(root.ok !== undefined ? { ok: root.ok } : {}),
    ...(root.data !== undefined ? { data: root.data } : {}),
  };
}

function canonicalEnvelope(root: JsonObject): { readonly channel: DiagnosticChannel; readonly envelope: JsonObject } {
  const meta = optionalObject(root._meta);
  const fromMeta = meta === undefined ? undefined : optionalObject(meta["loomex/uiData"]);
  if (meta !== undefined && meta["loomex/uiData"] !== undefined && fromMeta === undefined) {
    throw new UiResultDecodeError("The host returned invalid Loomex view data.", diagnostic("canonical", "meta", "UI_METADATA_DATA_INVALID", meta));
  }
  if (fromMeta !== undefined) return { channel: "meta", envelope: fromMeta };
  const structured = optionalObject(root.structuredContent);
  if (structured !== undefined) {
    if (structured.ok !== undefined || structured.data !== undefined || structured.error !== undefined) {
      return { channel: "structuredContent", envelope: structured };
    }
    throw new UiResultDecodeError("The host did not provide the data required by this view.", diagnostic("canonical", "structuredContent", "UI_CANONICAL_DATA_MISSING", structured));
  }
  if (root.ok !== undefined || root.data !== undefined || root.error !== undefined) return { channel: "root", envelope: root };
  throw new UiResultDecodeError("The host did not provide the data required by this view.", diagnostic("canonical", "root", "UI_CANONICAL_DATA_MISSING", root));
}

export interface UiResultReceipt {
  readonly data: JsonObject;
  readonly channel: DiagnosticChannel;
  readonly method?: string;
}

/** Decodes the one result envelope used by MCP Apps and Loomex's UI bridge. */
function decodeUiResultReceipt(result: unknown): UiResultReceipt {
  const { channel, envelope } = canonicalEnvelope(normalizeUiRpcResult(result));
  if (envelope.ok === true) {
    const data = optionalObject(envelope.data);
    if (data === undefined) {
      throw new UiResultDecodeError("The host returned incomplete Loomex view data.", diagnostic("canonical", channel, "UI_SUCCESS_DATA_INVALID", envelope));
    }
    return { data, channel, ...(typeof envelope.method === "string" ? { method: envelope.method } : {}) };
  }
  return { data: envelope, channel, ...(typeof envelope.method === "string" ? { method: envelope.method } : {}) };
}

export function decodeUiResult(result: unknown): JsonObject {
  return decodeUiResultReceipt(result).data;
}

export function uiResultFailed(result: unknown): boolean {
  try {
    const root = normalizeUiRpcResult(result);
    const content = optionalObject(root.structuredContent);
    return root.isError === true || content?.ok === false || root.ok === false;
  } catch {
    return true;
  }
}

/** Error fields that can safely cross the host/UI boundary. */
export interface UiResultError {
  readonly code?: string | undefined;
  readonly message: string;
  readonly retryable?: boolean | undefined;
  readonly correlationId?: string | undefined;
}

/**
 * Extracts a structured tool or JSON-RPC failure without turning arbitrary
 * provider data into an Error object. Callers can retain retry and correlation
 * details when they present a recoverable failure.
 */
export function decodeUiError(result: unknown, fallback = "The host could not complete this action."): UiResultError | undefined {
  let root: JsonObject;
  try {
    root = normalizeUiRpcResult(result);
  } catch {
    // Callers that need canonical data call decodeUiResult next; keeping the
    // decoder failure intact there preserves its safe diagnostic instead of
    // converting it to a generic transport error.
    return undefined;
  }
  const structured = optionalObject(root.structuredContent);
  const envelope = optionalObject(optionalObject(root._meta)?.["loomex/uiData"]) ?? structured ?? root;
  const candidate = optionalObject(envelope.error) ?? optionalObject(root.error);
  if (candidate === undefined && root.isError !== true && structured?.ok !== false && root.ok !== false) return undefined;
  return readError(candidate, fallback);
}

export class UiTransportError extends Error implements UiResultError {
  readonly code?: string | undefined;
  readonly retryable?: boolean | undefined;
  readonly correlationId?: string | undefined;
  readonly diagnostic?: UiResultDiagnostic | undefined;

  constructor(error: UiResultError, diagnosticValue?: UiResultDiagnostic) {
    super(error.message);
    this.name = "UiTransportError";
    this.code = error.code;
    this.retryable = error.retryable;
    this.correlationId = error.correlationId;
    this.diagnostic = diagnosticValue;
  }
}

export function toUiTransportError(error: unknown, fallback?: string): UiTransportError {
  if (error instanceof UiTransportError) return error;
  if (error instanceof UiResultDecodeError) return new UiTransportError({ code: error.diagnostic.code, message: error.message }, error.diagnostic);
  if (error instanceof Error) {
    const shaped = error as Error & Partial<UiResultError>;
    return new UiTransportError({
      message: shaped.message || fallback || "The host could not complete this action.",
      ...(typeof shaped.code === "string" ? { code: shaped.code } : {}),
      ...(typeof shaped.retryable === "boolean" ? { retryable: shaped.retryable } : {}),
      ...(typeof shaped.correlationId === "string" ? { correlationId: shaped.correlationId } : {}),
    });
  }
  return new UiTransportError(readError(error, fallback || "The host could not complete this action."));
}

export function rpcError(error: unknown, fallback = "The host could not complete this action."): UiResultError {
  const source = normalizeJsonObject(error) as JsonRpcError | null;
  const data = source === null ? undefined : optionalObject(source.data);
  return readError({
    ...(source?.code !== undefined ? { code: source.code } : {}),
    ...(source?.message !== undefined ? { message: source.message } : {}),
    ...(source?.retryable !== undefined ? { retryable: source.retryable } : {}),
    ...(source?.correlationId !== undefined ? { correlationId: source.correlationId } : {}),
    ...(data?.retryable !== undefined ? { retryable: data.retryable } : {}),
    ...(data?.correlationId !== undefined ? { correlationId: data.correlationId } : {}),
  }, fallback);
}

function readError(value: unknown, fallback: string): UiResultError {
  const source = normalizeJsonObject(value);
  const code = source?.code;
  const message = source?.message;
  const retryable = source?.retryable;
  const correlationId = source?.correlationId;
  return {
    message: typeof message === "string" && message.length > 0 ? message : fallback,
    ...(typeof code === "string" || typeof code === "number" ? { code: String(code) } : {}),
    ...(typeof retryable === "boolean" ? { retryable } : {}),
    ...(typeof correlationId === "string" ? { correlationId } : {}),
  };
}

/** Persistence requires a successful canonical receipt, never an error envelope. */
export function decodePersistenceResult(result: unknown): JsonObject {
  return decodePersistenceReceipt(result).data;
}

/** The selected canonical channel and method are retained only for local diagnostics. */
export function decodePersistenceReceipt(result: unknown): UiResultReceipt {
  const error = decodeUiError(result, "The saved state could not be verified.");
  if (error) throw new UiTransportError(error);
  return decodeUiResultReceipt(result);
}
