import type { JsonObject, JsonRpcMessage } from "./contracts.js";
import { HostBridge, type HostBridgeOptions } from "./host-bridge.js";
import { RequestFence } from "./lifecycle.js";
import { UiTransportError } from "./result-decoder.js";
import {
  DEFAULT_TRANSPORT_OPERATION_POLICY,
  resolveTransportRequestOptions,
  type TransportOperationPolicy,
  type TransportRequestOptions,
} from "./transport-policy.js";

export type { TransportRequestOptions, TransportSlowDiagnostic, TransportOperationPolicy } from "./transport-policy.js";
export type InitializationStatus = "idle" | "connecting" | "ready" | "failed" | "disposed";

export interface RuntimeTransportOptions extends HostBridgeOptions {
  readonly operationPolicy?: TransportOperationPolicy;
}

/** Owns the host JSON-RPC bridge and the authoritative-result ordering fence. */
export class RuntimeTransport {
  readonly #bridge: HostBridge;
  readonly #authoritativeFences = new Map<string, RequestFence>();
  readonly #operationPolicy: TransportOperationPolicy;
  #disposed = false;
  #initializationGeneration = 0;
  #initializationStatus: InitializationStatus = "idle";

  constructor(options: RuntimeTransportOptions = {}) {
    this.#bridge = new HostBridge(options);
    this.#operationPolicy = options.operationPolicy ?? DEFAULT_TRANSPORT_OPERATION_POLICY;
  }

  request(method: string, params: JsonObject, options: TransportRequestOptions = {}): Promise<unknown> {
    return this.#bridge.call(method, params, resolveTransportRequestOptions(method, options, this.#operationPolicy));
  }

  /** Send to the current task through MCP Apps. Do not invoke compatibility
   * follow-up APIs: hosts may use those to open a target-selection dialog. */
  sendFollowUpMessage(params: JsonObject, options: TransportRequestOptions = {}): Promise<unknown> {
    if (this.#disposed) {
      return Promise.reject(new UiTransportError({ code: "HOST_BRIDGE_DISPOSED", message: "The host connection is no longer available.", retryable: true }));
    }
    const prompt = followUpPrompt(params);
    if (!prompt) {
      return Promise.reject(new UiTransportError({ code: "HOST_BRIDGE_INVALID_MESSAGE", message: "The follow-up message is invalid." }));
    }
    return this.request("ui/message", params, options);
  }

  /**
   * Establishes the MCP Apps bridge once per attempt. The bridge's request
   * timeout is the sole timeout authority; a late answer from an older
   * attempt cannot make a newer attempt ready.
   */
  async initialize(params: JsonObject, options: TransportRequestOptions = {}): Promise<unknown> {
    if (this.#disposed) throw new Error("The UI transport has been disposed.");
    const generation = ++this.#initializationGeneration;
    this.#initializationStatus = "connecting";
    try {
      const result = await this.#bridge.call("ui/initialize", params, resolveTransportRequestOptions("ui/initialize", options, this.#operationPolicy));
      if (this.#disposed || generation !== this.#initializationGeneration) {
        throw new Error("The host connection was superseded before it became ready.");
      }
      this.#initializationStatus = "ready";
      return result;
    } catch (error) {
      if (!this.#disposed && generation === this.#initializationGeneration) this.#initializationStatus = "failed";
      throw error;
    }
  }

  initializationStatus(): InitializationStatus { return this.#initializationStatus; }

  notify(method: string, params: JsonObject): void {
    this.#bridge.notify(method, params);
  }

  accept(value: unknown): boolean {
    const message = jsonRpcMessage(value);
    return message !== undefined && this.#bridge.accept(message);
  }

  acceptEvent(event: MessageEvent<unknown>): boolean { return this.#bridge.acceptEvent(event); }

  dispose(): void {
    this.#disposed = true;
    ++this.#initializationGeneration;
    this.#initializationStatus = "disposed";
    this.#authoritativeFences.clear();
    this.#bridge.dispose();
  }

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

function followUpPrompt(params: JsonObject): string | undefined {
  if (params.role !== "user" || !Array.isArray(params.content) || params.content.length !== 1) return undefined;
  const item = params.content[0];
  if (item === null || typeof item !== "object" || Array.isArray(item)) return undefined;
  const record = item as JsonObject;
  return record.type === "text" && typeof record.text === "string" && record.text.trim().length > 0 ? record.text : undefined;
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
