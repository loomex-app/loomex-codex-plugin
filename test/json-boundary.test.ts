import * as assert from "node:assert/strict";
import { test } from "node:test";
import { normalizeJsonObject } from "../src/ui-app/json-boundary.js";

test("undefined object properties are omitted while nested JSON values are detached", () => {
  const input = {
    keep: "value",
    absent: undefined,
    nested: { count: 2, absent: undefined },
    list: [{ enabled: true }],
  };
  const normalized = normalizeJsonObject(input);
  assert.deepEqual(normalized, {
    keep: "value",
    nested: { count: 2 },
    list: [{ enabled: true }],
  });
  assert.notEqual(normalized, input);
  assert.notEqual(normalized?.nested, input.nested);
  assert.notEqual(normalized?.list, input.list);
});

test("undefined and sparse array entries are rejected", () => {
  assert.equal(normalizeJsonObject({ values: [1, undefined, 3] }), null);
  assert.equal(normalizeJsonObject({ values: new Array(2) }), null);
  const sparse: unknown[] = [1, 2];
  delete sparse[1];
  assert.equal(normalizeJsonObject({ values: sparse }), null);
});

test("non-finite numbers and non-JSON primitives are rejected at every depth", () => {
  for (const value of [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY, 1n, Symbol("value"), () => true]) {
    assert.equal(normalizeJsonObject({ value }), null);
  }
  assert.equal(normalizeJsonObject({ nested: [{ value: Number.NaN }] }), null);
});

test("Date, Map, Set, typed arrays, and custom prototypes are rejected", () => {
  class CustomValue { readonly value = 1; }
  for (const value of [new Date(), new Map(), new Set(), new Uint8Array([1]), new CustomValue(), Object.create({ inherited: true })]) {
    assert.equal(normalizeJsonObject({ value }), null);
  }
});

test("cycles fail closed while repeated acyclic references are copied independently", () => {
  const cyclic: { self?: unknown } = {};
  cyclic.self = cyclic;
  assert.equal(normalizeJsonObject(cyclic), null);

  const shared = { value: 1 };
  const normalized = normalizeJsonObject({ first: shared, second: shared });
  assert.deepEqual(normalized, { first: { value: 1 }, second: { value: 1 } });
  assert.notEqual(normalized?.first, normalized?.second);
});

test("null-prototype input is accepted and copied into a plain object", () => {
  const input = Object.create(null) as Record<string, unknown>;
  input.value = 3;
  const normalized = normalizeJsonObject(input);
  assert.deepEqual(normalized, { value: 3 });
  assert.equal(Object.getPrototypeOf(normalized), Object.prototype);
});

test("own __proto__ and constructor keys are preserved without prototype mutation", () => {
  const input = JSON.parse('{"__proto__":{"polluted":true},"constructor":{"prototype":{"polluted":true}},"safe":1}') as unknown;
  const normalized = normalizeJsonObject(input);
  assert.ok(normalized);
  assert.equal(Object.hasOwn(normalized, "__proto__"), true);
  assert.equal(Object.hasOwn(normalized, "constructor"), true);
  assert.deepEqual(Object.getOwnPropertyDescriptor(normalized, "__proto__")?.value, { polluted: true });
  assert.deepEqual(Object.getOwnPropertyDescriptor(normalized, "constructor")?.value, { prototype: { polluted: true } });
  assert.equal(Object.getPrototypeOf(normalized), Object.prototype);
  assert.equal(({} as { polluted?: boolean }).polluted, undefined);
});

test("accessors, symbols, and non-enumerable properties are rejected without invoking getters", () => {
  let getterCalls = 0;
  const accessor = {};
  Object.defineProperty(accessor, "value", {
    enumerable: true,
    get: () => { getterCalls += 1; return 1; },
  });
  assert.equal(normalizeJsonObject(accessor), null);
  assert.equal(getterCalls, 0);

  const symbolKey = { value: 1, [Symbol("hidden")]: 2 };
  assert.equal(normalizeJsonObject(symbolKey), null);

  const nonEnumerable = { value: 1 };
  Object.defineProperty(nonEnumerable, "hidden", { value: 2, enumerable: false });
  assert.equal(normalizeJsonObject(nonEnumerable), null);
});

test("top-level arrays and primitives are rejected by the object boundary", () => {
  for (const value of [null, true, 1, "text", [1, 2]]) {
    assert.equal(normalizeJsonObject(value), null);
  }
});
