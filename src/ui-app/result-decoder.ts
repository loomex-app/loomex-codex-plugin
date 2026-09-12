import type { JsonObject, JsonRpcError } from "./contracts.js";

function object(value: unknown): JsonObject | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as JsonObject
    : undefined;
}

/** Decodes the one result envelope used by MCP Apps and Loomex's UI bridge. */
export function decodeUiResult(result: unknown): JsonObject {
  const root = object(result) ?? {};
  const meta = object(root._meta);
  const envelope = object(meta?.["loomex/uiData"]) ?? object(root.structuredContent) ?? root;
  const data = object(envelope.data);
  return envelope.ok === true && data ? data : envelope;
}

export function uiResultFailed(result: unknown): boolean {
  const root = object(result);
  const content = object(root?.structuredContent);
  return root?.isError === true || content?.ok === false;
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
  const root = object(result);
  const structured = object(root?.structuredContent);
  const envelope = object(object(root?._meta)?.["loomex/uiData"]) ?? structured ?? root;
  const candidate = object(envelope?.error) ?? object(root?.error);
  if (!candidate && root?.isError !== true && structured?.ok !== false) return undefined;
  return readError(candidate, fallback);
}

export class UiTransportError extends Error implements UiResultError {
  readonly code?: string | undefined;
  readonly retryable?: boolean | undefined;
  readonly correlationId?: string | undefined;

  constructor(error: UiResultError) {
    super(error.message);
    this.name = "UiTransportError";
    this.code = error.code;
    this.retryable = error.retryable;
    this.correlationId = error.correlationId;
  }
}

export function toUiTransportError(error: unknown, fallback?: string): UiTransportError {
  if (error instanceof UiTransportError) return error;
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
  const source = object(error) as JsonRpcError | undefined;
  const data = object(source?.data);
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
  const source = object(value);
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
