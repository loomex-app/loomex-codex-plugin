import type { JsonObject, JsonValue } from "./contracts.js";

const INVALID_JSON: unique symbol = Symbol("invalid-json");
type Normalized = JsonValue | typeof INVALID_JSON;

function object(value: unknown): JsonObject | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as JsonObject
    : undefined;
}

/**
 * A browser App receives values through postMessage, so ordinary JSON can
 * originate in a different JavaScript realm. Comparing directly with this
 * iframe's Object.prototype rejects those valid records. An Object prototype
 * is itself rooted at null in every realm; custom instances retain their
 * class prototype between the object and that root.
 */
function plainObject(value: object): boolean {
  const prototype = Object.getPrototypeOf(value);
  return prototype === null || Object.getPrototypeOf(prototype) === null;
}

/**
 * Array.isArray is cross-realm safe. Its direct prototype must be the realm's
 * native Array prototype (whose parent is that realm's Object prototype), not
 * an Array subclass prototype.
 */
function plainArray(value: readonly unknown[]): boolean {
  const prototype = Object.getPrototypeOf(value);
  return prototype !== null && Object.getPrototypeOf(prototype) !== null &&
    Object.getPrototypeOf(Object.getPrototypeOf(prototype)) === null;
}

function defineJsonProperty(target: JsonObject, key: string, value: JsonValue): void {
  Object.defineProperty(target, key, {
    value,
    enumerable: true,
    configurable: true,
    writable: true,
  });
}

function normalizeArray(value: readonly unknown[], ancestors: WeakSet<object>): Normalized {
  if (!plainArray(value) || ancestors.has(value)) return INVALID_JSON;
  const ownKeys = Reflect.ownKeys(value);
  if (ownKeys.some((key) => typeof key === "symbol")) return INVALID_JSON;
  const allowedKeys = new Set<string>(["length"]);
  for (let index = 0; index < value.length; index += 1) allowedKeys.add(String(index));
  if (ownKeys.some((key) => typeof key === "string" && !allowedKeys.has(key))) return INVALID_JSON;

  ancestors.add(value);
  try {
    const normalized: JsonValue[] = [];
    for (let index = 0; index < value.length; index += 1) {
      if (!Object.hasOwn(value, index)) return INVALID_JSON;
      const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
      if (descriptor === undefined || !descriptor.enumerable || !("value" in descriptor) || descriptor.value === undefined) {
        return INVALID_JSON;
      }
      const item = normalizeValue(descriptor.value, ancestors);
      if (item === INVALID_JSON) return INVALID_JSON;
      normalized.push(item);
    }
    return normalized;
  } finally {
    ancestors.delete(value);
  }
}

function normalizeObject(value: object, ancestors: WeakSet<object>): Normalized {
  if (!plainObject(value) || ancestors.has(value)) return INVALID_JSON;
  const ownKeys = Reflect.ownKeys(value);
  if (ownKeys.some((key) => typeof key === "symbol")) return INVALID_JSON;
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const normalized: JsonObject = {};

  ancestors.add(value);
  try {
    for (const key of ownKeys) {
      if (typeof key !== "string") return INVALID_JSON;
      const descriptor = descriptors[key];
      if (descriptor === undefined || !descriptor.enumerable || !("value" in descriptor)) return INVALID_JSON;
      if (descriptor.value === undefined) continue;
      const child = normalizeValue(descriptor.value, ancestors);
      if (child === INVALID_JSON) return INVALID_JSON;
      defineJsonProperty(normalized, key, child);
    }
    return normalized;
  } finally {
    ancestors.delete(value);
  }
}

function normalizeValue(value: unknown, ancestors: WeakSet<object>): Normalized {
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number") return Number.isFinite(value) ? value : INVALID_JSON;
  if (Array.isArray(value)) return normalizeArray(value, ancestors);
  if (typeof value === "object") return normalizeObject(value, ancestors);
  return INVALID_JSON;
}

/**
 * Copies an untrusted value into a plain JSON object.
 *
 * Undefined object properties are omitted like JSON serialization. Every
 * other non-JSON construct fails closed, including undefined or sparse array
 * entries, accessors, symbol keys, cycles, and objects with custom prototypes.
 */
export function normalizeJsonObject(value: unknown): JsonObject | null {
  try {
    const normalized = normalizeValue(value, new WeakSet());
    return normalized === INVALID_JSON ? null : object(normalized) ?? null;
  } catch {
    // Reflective operations on hostile proxies may throw. The trust boundary
    // treats those values exactly like every other invalid JSON payload.
    return null;
  }
}
