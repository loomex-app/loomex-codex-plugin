import type { JsonObject, JsonRpcMessage } from "./contracts.js";
import { rpcError, UiTransportError } from "./result-decoder.js";

type PendingRequest = {
  readonly resolve: (value: unknown) => void;
  readonly reject: (reason: UiTransportError) => void;
  readonly timer: number;
};

export interface HostBridgeOptions {
  readonly target?: WindowProxy;
  /** Pin an origin when the embedding host supplies one; otherwise retain MCP Apps' opaque-origin transport. */
  readonly targetOrigin?: string;
}

/** Request-fenced postMessage bridge. It owns only transport, never lifecycle policy. */
export class HostBridge {
  #nextId = 1;
  readonly #pending = new Map<number, PendingRequest>();
  readonly #target: WindowProxy;
  readonly #targetOrigin: string;
  #disposed = false;

  constructor(options: HostBridgeOptions = {}) {
    this.#target = options.target ?? window.parent;
    this.#targetOrigin = options.targetOrigin ?? "*";
  }

  call(method: string, params: JsonObject, timeoutMs: number): Promise<unknown> {
    if (this.#disposed) return Promise.reject(new UiTransportError({ code: "HOST_BRIDGE_DISPOSED", message: "The host connection is no longer available.", retryable: true }));
    if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
      return Promise.reject(new UiTransportError({ code: "HOST_BRIDGE_INVALID_TIMEOUT", message: "The request timeout is invalid." }));
    }
    const id = this.#nextId++;
    const message: JsonRpcMessage = { jsonrpc: "2.0", id, method, params };
    return new Promise((resolve, reject) => {
      const timer = window.setTimeout(() => {
        this.#pending.delete(id);
        reject(new UiTransportError({ code: "HOST_TIMEOUT", message: method === "tools/call" ? "The runner did not reply in time." : "The host did not reply in time.", retryable: true }));
      }, timeoutMs);
      this.#pending.set(id, { resolve, reject, timer });
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
    window.clearTimeout(pending.timer);
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
      clearTimeout(pending.timer);
      pending.reject(new UiTransportError({ code: "HOST_BRIDGE_DISPOSED", message: "The host connection is no longer available.", retryable: true }));
    }
    this.#pending.clear();
  }
}

function isJsonRpcMessage(value: unknown): value is JsonRpcMessage {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  return record.jsonrpc === "2.0" && (record.id === undefined || (typeof record.id === "number" && Number.isSafeInteger(record.id)));
}
