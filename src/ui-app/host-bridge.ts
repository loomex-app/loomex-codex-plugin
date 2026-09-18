import type { JsonObject, JsonRpcMessage } from "./contracts.js";
import { rpcError, UiTransportError } from "./result-decoder.js";
import type { ResolvedTransportRequestOptions, TransportSlowDiagnostic } from "./transport-policy.js";

type PendingRequest = {
  readonly resolve: (value: unknown) => void;
  readonly reject: (reason: UiTransportError) => void;
  readonly timeoutTimer: number;
  readonly slowTimer?: number;
};

export interface HostBridgeOptions {
  readonly target?: WindowProxy;
  /** Pin an origin when the embedding host supplies one; otherwise retain MCP Apps' opaque-origin transport. */
  readonly targetOrigin?: string;
  /** Monotonic elapsed-time source, overridable by deterministic host tests. */
  readonly now?: () => number;
}

/** Request-fenced postMessage bridge. It owns only transport, never lifecycle policy. */
export class HostBridge {
  #nextId = 1;
  readonly #pending = new Map<number, PendingRequest>();
  readonly #target: WindowProxy;
  readonly #targetOrigin: string;
  readonly #now: () => number;
  #disposed = false;

  constructor(options: HostBridgeOptions = {}) {
    this.#target = options.target ?? window.parent;
    this.#targetOrigin = options.targetOrigin ?? "*";
    this.#now = options.now ?? (() => globalThis.performance?.now?.() ?? Date.now());
  }

  call(method: string, params: JsonObject, options: ResolvedTransportRequestOptions): Promise<unknown> {
    if (this.#disposed) return Promise.reject(new UiTransportError({ code: "HOST_BRIDGE_DISPOSED", message: "The host connection is no longer available.", retryable: true }));
    if (!Number.isFinite(options.timeoutMs) || options.timeoutMs <= 0) {
      return Promise.reject(new UiTransportError({ code: "HOST_BRIDGE_INVALID_TIMEOUT", message: "The request timeout is invalid." }));
    }
    if (options.slowAfterMs !== undefined && (!Number.isFinite(options.slowAfterMs) || options.slowAfterMs <= 0)) {
      return Promise.reject(new UiTransportError({ code: "HOST_BRIDGE_INVALID_SLOW_TIMEOUT", message: "The slow-observation timeout is invalid." }));
    }
    const id = this.#nextId++;
    const message: JsonRpcMessage = { jsonrpc: "2.0", id, method, params };
    return new Promise((resolve, reject) => {
      const startedAt = this.#now();
      const timeoutTimer = window.setTimeout(() => {
        const pending = this.#pending.get(id);
        if (!pending) return;
        this.#pending.delete(id);
        clearPendingTimers(pending);
        reject(new UiTransportError({ code: "HOST_TIMEOUT", message: method === "tools/call" ? "The runner did not reply in time." : "The host did not reply in time.", retryable: true }));
      }, options.timeoutMs);
      const slowTimer = options.slowAfterMs === undefined ? undefined : window.setTimeout(() => {
        if (!this.#pending.has(id)) return;
        safelyReportSlow(options.onSlow, { stage: "slow", operation: method, elapsedMs: Math.max(0, this.#now() - startedAt) });
      }, options.slowAfterMs);
      this.#pending.set(id, {
        resolve,
        reject,
        timeoutTimer,
        ...(slowTimer === undefined ? {} : { slowTimer }),
      });
      this.#target.postMessage(message, this.#targetOrigin);
    });
  }

  notify(method: string, params: JsonObject): void {
    if (this.#disposed) return;
    this.#target.postMessage({ jsonrpc: "2.0", method, params } satisfies JsonRpcMessage, this.#targetOrigin);
  }

  accept(message: JsonRpcMessage): boolean {
    if (message.id === undefined) return false;
    const pending = this.#pending.get(message.id);
    if (!pending) return false;
    this.#pending.delete(message.id);
    clearPendingTimers(pending);
    if (message.error !== undefined) pending.reject(new UiTransportError(rpcError(message.error)));
    else pending.resolve(message.result);
    return true;
  }

  /** Rejects messages from another window before they can resolve a pending request. */
  acceptEvent(event: MessageEvent<unknown>): boolean {
    if (event.source !== this.#target) return false;
    if (this.#targetOrigin !== "*" && event.origin !== this.#targetOrigin) return false;
    return isJsonRpcMessage(event.data) && this.accept(event.data);
  }

  dispose(): void {
    if (this.#disposed) return;
    this.#disposed = true;
    for (const pending of this.#pending.values()) {
      clearPendingTimers(pending);
      pending.reject(new UiTransportError({ code: "HOST_BRIDGE_DISPOSED", message: "The host connection is no longer available.", retryable: true }));
    }
    this.#pending.clear();
  }
}

function clearPendingTimers(pending: PendingRequest): void {
  window.clearTimeout(pending.timeoutTimer);
  if (pending.slowTimer !== undefined) window.clearTimeout(pending.slowTimer);
}

function safelyReportSlow(
  onSlow: ((diagnostic: TransportSlowDiagnostic) => void) | undefined,
  diagnostic: TransportSlowDiagnostic,
): void {
  if (!onSlow) return;
  try { onSlow(diagnostic); } catch { /* Diagnostics must never alter transport settlement. */ }
}

function isJsonRpcMessage(value: unknown): value is JsonRpcMessage {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  return record.jsonrpc === "2.0" && (record.id === undefined || (typeof record.id === "number" && Number.isSafeInteger(record.id)));
}
