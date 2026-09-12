import type { JsonObject, JsonRpcMessage } from "./contracts.js";
import { HostBridge, type HostBridgeOptions } from "./host-bridge.js";
import { RequestFence } from "./lifecycle.js";

export type TransportRequestOptions = Readonly<{ timeoutMs: number }>;

/** Owns the host JSON-RPC bridge and the authoritative-result ordering fence. */
export class RuntimeTransport {
  readonly #bridge: HostBridge;
  readonly #authoritativeFences = new Map<string, RequestFence>();
  #disposed = false;

  constructor(options: HostBridgeOptions = {}) {
    this.#bridge = new HostBridge(options);
  }

  request(method: string, params: JsonObject, options: TransportRequestOptions): Promise<unknown> {
    return this.#bridge.call(method, params, options.timeoutMs);
  }

  notify(method: string, params: JsonObject): void {
    this.#bridge.notify(method, params);
  }

  accept(value: unknown): boolean {
    const message = jsonRpcMessage(value);
    return message !== undefined && this.#bridge.accept(message);
  }

  acceptEvent(event: MessageEvent<unknown>): boolean { return this.#bridge.acceptEvent(event); }

  dispose(): void { this.#disposed = true; this.#authoritativeFences.clear(); this.#bridge.dispose(); }

  beginAuthoritativeRequest(scope = "page"): number {
    if (this.#disposed) throw new Error("The UI transport has been disposed.");
    let fence = this.#authoritativeFences.get(scope);
    if (!fence) { fence = new RequestFence(); this.#authoritativeFences.set(scope, fence); }
    return fence.begin();
  }

  isAuthoritativeRequestCurrent(epoch: number, scope = "page"): boolean {
    return !this.#disposed && this.#authoritativeFences.get(scope)?.current(epoch) === true;
  }
}

function jsonRpcMessage(value: unknown): JsonRpcMessage | undefined {
  if (!isObject(value) || value.jsonrpc !== "2.0") return undefined;
  if (value.id !== undefined && (typeof value.id !== "number" || !Number.isSafeInteger(value.id))) return undefined;
  if (value.method !== undefined && typeof value.method !== "string") return undefined;
  if (value.params !== undefined && !isObject(value.params)) return undefined;
  return {
    jsonrpc: "2.0",
    ...(value.id !== undefined ? { id: value.id } : {}),
    ...(value.method !== undefined ? { method: value.method } : {}),
    ...(value.params !== undefined ? { params: value.params } : {}),
    ...(value.result !== undefined ? { result: value.result } : {}),
    ...(value.error !== undefined ? { error: value.error } : {}),
  };
}

function isObject(value: unknown): value is JsonObject {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
