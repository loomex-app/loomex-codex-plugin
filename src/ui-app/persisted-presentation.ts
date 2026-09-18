import type { JsonObject } from "./contracts.js";

export interface PersistedHandoff { readonly ref?: string; readonly lifecycle: string; }
const lifecycles = new Set(["prepared", "approving", "approved", "committing", "ambiguous", "committed", "expired", "rejected", "unknown"]);

/** Decode display-only recovery references, never approval or mutation authority. */
export function decodePersistedHandoff(state: JsonObject): PersistedHandoff {
  const raw = state.startHandoff;
  const value = raw && typeof raw === "object" && !Array.isArray(raw) ? raw as JsonObject : undefined;
  if (value && typeof value === "object" && !Array.isArray(value) && (value.schemaVersion === 2 || value.schemaVersion === 3)) {
    const ref = typeof value.handoffRef === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value.handoffRef) ? value.handoffRef : undefined;
    const lifecycle = typeof value.lifecycle === "string" && lifecycles.has(value.lifecycle) ? value.lifecycle : "unknown";
    return { ...(ref ? { ref } : {}), lifecycle };
  }
  // A newly created preparation can legitimately have no handoff yet.
  return { lifecycle: ["startHandoff", "startHandoffRef", "startHandoffTicket", "startHandoffState"].some(key => state[key] !== undefined) ? "legacy" : "unknown" };
}
