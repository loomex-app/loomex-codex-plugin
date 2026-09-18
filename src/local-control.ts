import { errorRecovery } from "./protocol.js";
import { randomUUID } from "node:crypto";
import { lstat } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, isAbsolute, join } from "node:path";
import { createConnection, type Socket } from "node:net";

import {
  LOCAL_PROTOCOL,
  MAX_FRAME_BYTES,
  NegotiationParamsSchema,
  NegotiationResultSchema,
  RpcErrorCodeSchema,
  RpcRequestSchema,
  RpcResponseSchema,
  VALIDATION_ISSUE_VERSION,
  safeErrorMessage,
  type JsonValue,
  type RpcErrorCode,
  type ToolOutput,
  type ValidationIssue,
} from "./protocol.js";
import { parseMethodResult } from "./result-schemas.js";
import { REQUIRED_RUNNER_CAPABILITIES } from "./tool-catalog.js";

export interface LocalControlCallOptions {
  readonly mutating: boolean;
  readonly signal?: AbortSignal;
  readonly timeoutMs?: number;
}

export class LocalControlError extends Error {
  readonly code: RpcErrorCode;
  readonly correlationId: string | undefined;
  readonly retryable: boolean;
  readonly requestId: string | undefined;
  readonly idempotencyKey: string | undefined;
  readonly transportFailure: boolean;
  readonly validationIssues: readonly ValidationIssue[] | undefined;

  constructor(options: {
    code: RpcErrorCode;
    correlationId?: string;
    retryable?: boolean;
    requestId?: string;
    idempotencyKey?: string;
    transportFailure?: boolean;
    validationIssues?: readonly ValidationIssue[];
  }) {
    super(safeErrorMessage(options.code));
    this.name = "LocalControlError";
    this.code = options.code;
    this.correlationId = options.correlationId ?? options.requestId ?? randomUUID();
    this.retryable = options.retryable ?? false;
    this.requestId = options.requestId;
    this.idempotencyKey = options.idempotencyKey;
    this.transportFailure = options.transportFailure ?? false;
    this.validationIssues = options.validationIssues;
  }
}

function socketPath(): string {
  const configuredStateDir = process.env.LOOMEX_STATE_DIR;
  const stateDir =
    configuredStateDir ?? join(homedir(), ".local", "share", "loomex", "runner");
  if (!isAbsolute(stateDir)) {
    throw new LocalControlError({ code: "RUNNER_UNAVAILABLE" });
  }
  return join(stateDir, "control.sock");
}

async function assertOwnerCheckedSocket(path: string): Promise<void> {
  const effectiveUid = process.geteuid?.();
  if (effectiveUid === undefined) {
    throw new LocalControlError({ code: "RUNNER_UNAVAILABLE" });
  }

  try {
    const [parent, socket] = await Promise.all([lstat(dirname(path)), lstat(path)]);
    if (!parent.isDirectory() || !socket.isSocket()) {
      throw new LocalControlError({ code: "RUNNER_UNAVAILABLE" });
    }
    if (parent.uid !== effectiveUid || socket.uid !== effectiveUid) {
      throw new LocalControlError({ code: "RUNNER_UNAVAILABLE" });
    }
    if ((parent.mode & 0o077) !== 0 || (socket.mode & 0o077) !== 0) {
      throw new LocalControlError({ code: "RUNNER_UNAVAILABLE" });
    }
  } catch (error) {
    if (error instanceof LocalControlError) throw error;
    throw new LocalControlError({ code: "RUNNER_UNAVAILABLE", retryable: true });
  }
}

function idempotencyKeyFrom(params: Record<string, JsonValue>): string | undefined {
  const candidate = params.idempotencyKey;
  return typeof candidate === "string" ? candidate : undefined;
}

function transportError(options: {
  mutating: boolean;
  sent: boolean;
  requestId: string;
  params: Record<string, JsonValue>;
}): LocalControlError {
  if (options.mutating && options.sent) {
    const idempotencyKey = idempotencyKeyFrom(options.params);
    return new LocalControlError({
      code: "NETWORK_AMBIGUOUS",
      retryable: true,
      requestId: options.requestId,
      ...(idempotencyKey === undefined ? {} : { idempotencyKey }),
      transportFailure: true,
    });
  }
  return new LocalControlError({
    code: "RUNNER_UNAVAILABLE",
    retryable: true,
    requestId: options.requestId,
    transportFailure: true,
  });
}

export class LocalControlClient {
  async call(
    method: string,
    params: Record<string, JsonValue>,
    options: LocalControlCallOptions,
  ): Promise<ToolOutput> {
    const deadline = Date.now() + (options.timeoutMs ?? 30_000);
    const attempt = (): Promise<ToolOutput> =>
      this.callOnce(method, params, {
        ...options,
        timeoutMs: Math.max(1, deadline - Date.now()),
      });
    try {
      return await attempt();
    } catch (error) {
      if (
        options.mutating ||
        options.signal?.aborted ||
        !(error instanceof LocalControlError) ||
        !error.transportFailure ||
        Date.now() >= deadline
      ) {
        throw error;
      }
      return await attempt();
    }
  }

  private async callOnce(
    method: string,
    params: Record<string, JsonValue>,
    options: LocalControlCallOptions,
  ): Promise<ToolOutput> {
    const negotiationId = randomUUID();
    const requestId = randomUUID();
    const path = socketPath();
    await assertOwnerCheckedSocket(path);

    const negotiation = RpcRequestSchema.parse({
      protocol: LOCAL_PROTOCOL,
      id: negotiationId,
      method: "protocol.negotiate",
      params: NegotiationParamsSchema.parse({
        supportedProtocols: [LOCAL_PROTOCOL],
        requiredCapabilities: [...REQUIRED_RUNNER_CAPABILITIES],
      }),
    });
    const request = RpcRequestSchema.parse({
      protocol: LOCAL_PROTOCOL,
      id: requestId,
      method,
      params,
    });
    const negotiationFrame = `${JSON.stringify(negotiation)}\n`;
    const requestFrame = `${JSON.stringify(request)}\n`;
    if (
      Buffer.byteLength(negotiationFrame) > MAX_FRAME_BYTES ||
      Buffer.byteLength(requestFrame) > MAX_FRAME_BYTES
    ) {
      throw new LocalControlError({ code: "FRAME_TOO_LARGE", requestId });
    }

    return await new Promise<ToolOutput>((resolve, reject) => {
      let socket: Socket | undefined;
      let phase: "negotiation" | "action" = "negotiation";
      let actionSent = false;
      let settled = false;
      let received = Buffer.alloc(0);
      const timeoutMs = options.timeoutMs ?? 30_000;

      const activeRequestId = (): string =>
        phase === "negotiation" ? negotiationId : requestId;

      const finish = (callback: () => void): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        options.signal?.removeEventListener("abort", onAbort);
        socket?.destroy();
        callback();
      };

      const failTransport = (): void => {
        finish(() =>
          reject(
            transportError({
              mutating: options.mutating,
              sent: actionSent,
              requestId: activeRequestId(),
              params,
            }),
          ),
        );
      };

      const failNonDefinitiveResponse = (code: RpcErrorCode): void => {
        if (options.mutating && actionSent) {
          failTransport();
          return;
        }
        finish(() =>
          reject(new LocalControlError({ code, requestId: activeRequestId() })),
        );
      };

      const onAbort = (): void => {
        if (options.mutating && actionSent) {
          failTransport();
          return;
        }
        finish(() =>
          reject(new LocalControlError({ code: "CANCELLED", requestId: activeRequestId() })),
        );
      };

      const timer = setTimeout(failTransport, timeoutMs);
      timer.unref();
      options.signal?.addEventListener("abort", onAbort, { once: true });
      if (options.signal?.aborted) {
        onAbort();
        return;
      }

      socket = createConnection(path);
      socket.setNoDelay(true);
      socket.once("connect", () => {
        socket?.write(negotiationFrame);
      });
      socket.on("data", (chunk: Buffer) => {
        received = Buffer.concat([received, chunk]);
        while (!settled) {
          const newline = received.indexOf(0x0a);
          if (newline < 0) {
            if (received.byteLength > MAX_FRAME_BYTES) {
              failNonDefinitiveResponse("FRAME_TOO_LARGE");
            }
            return;
          }
          if (newline + 1 > MAX_FRAME_BYTES) {
            failNonDefinitiveResponse("FRAME_TOO_LARGE");
            return;
          }

          const frame = received.subarray(0, newline).toString("utf8");
          received = received.subarray(newline + 1);
          let decoded: unknown;
          try {
            decoded = JSON.parse(frame);
          } catch {
            failNonDefinitiveResponse("INVALID_RESPONSE");
            return;
          }

          const parsed = RpcResponseSchema.safeParse(decoded);
          const expectedId = activeRequestId();
          if (!parsed.success || parsed.data.id !== expectedId) {
            failNonDefinitiveResponse("INVALID_RESPONSE");
            return;
          }

          if ("error" in parsed.data) {
            const rpcError = parsed.data.error;
            const code = RpcErrorCodeSchema.parse(rpcError.code);
            const idempotencyKey =
              phase === "action" && options.mutating ? idempotencyKeyFrom(params) : undefined;
            finish(() =>
              reject(
                new LocalControlError({
                  code,
                  correlationId: rpcError.correlationId,
                  retryable: rpcError.retryable,
                  requestId: expectedId,
                  ...(idempotencyKey === undefined ? {} : { idempotencyKey }),
                  ...(code === "RUN_VALIDATION_FAILED" && rpcError.data !== undefined
                    ? { validationIssues: rpcError.data.validationIssues }
                    : {}),
                }),
              ),
            );
            return;
          }

          if (phase === "negotiation") {
            const negotiated = NegotiationResultSchema.safeParse(parsed.data.result);
            const capabilities = negotiated.success
              ? new Set(negotiated.data.capabilities)
              : undefined;
            const compatible =
              negotiated.success &&
              negotiated.data.maxFrameBytes === MAX_FRAME_BYTES &&
              REQUIRED_RUNNER_CAPABILITIES.every((capability) =>
                capabilities?.has(capability),
              );
            if (!compatible) {
              finish(() =>
                reject(
                  new LocalControlError({
                    code: "COMPATIBILITY_ERROR",
                    requestId: negotiationId,
                  }),
                ),
              );
              return;
            }
            if (received.byteLength > 0) {
              failNonDefinitiveResponse("INVALID_RESPONSE");
              return;
            }
            phase = "action";
            actionSent = true;
            socket?.write(requestFrame);
            continue;
          }

          if (received.byteLength > 0) {
            failNonDefinitiveResponse("INVALID_RESPONSE");
            return;
          }
          const rpcResult = parseMethodResult(method, parsed.data.result);
          if (rpcResult === undefined) {
            failNonDefinitiveResponse("INVALID_RESPONSE");
            return;
          }
          finish(() =>
            resolve({
              ok: true,
              protocol: LOCAL_PROTOCOL,
              method,
              requestId,
              data: rpcResult,
            }),
          );
          return;
        }
      });
      socket.once("error", failTransport);
      socket.once("end", () => {
        if (!settled) failTransport();
      });
    });
  }
}

export function toolErrorOutput(method: string, error: unknown): ToolOutput {
  const local =
    error instanceof LocalControlError
      ? error
      : new LocalControlError({ code: "INTERNAL", retryable: false });
  return {
    ok: false,
    protocol: LOCAL_PROTOCOL,
    method,
    requestId: local.requestId ?? randomUUID(),
    error: {
      code: local.code,
      message: safeErrorMessage(local.code),
      ...(local.correlationId === undefined ? {} : { correlationId: local.correlationId }),
      retryable: local.retryable,
      ...errorRecovery(local.code),
      ...(local.validationIssues === undefined
        ? {}
        : { validationIssueVersion: VALIDATION_ISSUE_VERSION }),
      ...(local.validationIssues === undefined
        ? {}
        : { validationIssues: [...local.validationIssues] }),
    },
    ...(local.idempotencyKey === undefined ? {} : { idempotencyKey: local.idempotencyKey }),
  };
}
