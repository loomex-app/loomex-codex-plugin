import { randomUUID } from "node:crypto";
import { lstat } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, isAbsolute, join } from "node:path";
import { createConnection, type Socket } from "node:net";

import {
  LOCAL_PROTOCOL,
  MAX_FRAME_BYTES,
  RpcErrorCodeSchema,
  RpcRequestSchema,
  RpcResponseSchema,
  safeErrorMessage,
  type JsonValue,
  type RpcErrorCode,
  type ToolOutput,
} from "./protocol.js";
import { parseMethodResult } from "./result-schemas.js";

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

  constructor(options: {
    code: RpcErrorCode;
    correlationId?: string;
    retryable?: boolean;
    requestId?: string;
    idempotencyKey?: string;
    transportFailure?: boolean;
  }) {
    super(safeErrorMessage(options.code));
    this.name = "LocalControlError";
    this.code = options.code;
    this.correlationId = options.correlationId;
    this.retryable = options.retryable ?? false;
    this.requestId = options.requestId;
    this.idempotencyKey = options.idempotencyKey;
    this.transportFailure = options.transportFailure ?? false;
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
    const requestId = randomUUID();
    const path = socketPath();
    await assertOwnerCheckedSocket(path);

    const request = RpcRequestSchema.parse({
      protocol: LOCAL_PROTOCOL,
      id: requestId,
      method,
      params,
    });
    const frame = `${JSON.stringify(request)}\n`;
    if (Buffer.byteLength(frame) > MAX_FRAME_BYTES) {
      throw new LocalControlError({ code: "FRAME_TOO_LARGE", requestId });
    }

    return await new Promise<ToolOutput>((resolve, reject) => {
      let socket: Socket | undefined;
      let sent = false;
      let settled = false;
      let received = Buffer.alloc(0);
      const timeoutMs = options.timeoutMs ?? 30_000;

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
              sent,
              requestId,
              params,
            }),
          ),
        );
      };

      const onAbort = (): void => {
        if (options.mutating && sent) {
          failTransport();
          return;
        }
        finish(() => reject(new LocalControlError({ code: "CANCELLED", requestId })));
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
        sent = true;
        socket?.write(frame);
      });
      socket.on("data", (chunk: Buffer) => {
        received = Buffer.concat([received, chunk]);
        if (received.byteLength > MAX_FRAME_BYTES) {
          finish(() => reject(new LocalControlError({ code: "FRAME_TOO_LARGE", requestId })));
          return;
        }

        const newline = received.indexOf(0x0a);
        if (newline < 0) return;
        const trailing = received.subarray(newline + 1).toString("utf8").trim();
        if (trailing.length > 0) {
          finish(() => reject(new LocalControlError({ code: "INVALID_RESPONSE", requestId })));
          return;
        }

        let decoded: unknown;
        try {
          decoded = JSON.parse(received.subarray(0, newline).toString("utf8"));
        } catch {
          finish(() => reject(new LocalControlError({ code: "INVALID_RESPONSE", requestId })));
          return;
        }

        const parsed = RpcResponseSchema.safeParse(decoded);
        if (!parsed.success || parsed.data.id !== requestId) {
          finish(() => reject(new LocalControlError({ code: "INVALID_RESPONSE", requestId })));
          return;
        }

        if ("error" in parsed.data) {
          const rpcError = parsed.data.error;
          const code = RpcErrorCodeSchema.parse(rpcError.code);
          const idempotencyKey = options.mutating ? idempotencyKeyFrom(params) : undefined;
          finish(() =>
            reject(
              new LocalControlError({
                code,
                correlationId: rpcError.correlationId,
                retryable: rpcError.retryable,
                requestId,
                ...(idempotencyKey === undefined ? {} : { idempotencyKey }),
              }),
            ),
          );
          return;
        }

        const rpcResult = parseMethodResult(method, parsed.data.result);
        if (rpcResult === undefined) {
          finish(() => reject(new LocalControlError({ code: "INVALID_RESPONSE", requestId })));
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
    },
    ...(local.idempotencyKey === undefined ? {} : { idempotencyKey: local.idempotencyKey }),
  };
}
