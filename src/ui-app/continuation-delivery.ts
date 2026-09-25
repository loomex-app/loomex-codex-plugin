import { formatFollowContinuationMarkdown } from "../monitoring-contract.js";
import type { JsonObject } from "./contracts.js";
import { UiTransportError, UiResultDecodeError } from "./result-decoder.js";

export type DeliveryStatus = "ready" | "sending" | "not_sent" | "acknowledged" | "rejected" | "unknown" | "unsupported";
export type ContinuationPurpose = "reviewed_start" | "accepted_interaction" | "follow_run" | "long_answer";
export interface ContinuationDeliveryRecord {
  schemaVersion: 1 | 2;
  identity: string;
  purpose: ContinuationPurpose;
  text: string;
  status: DeliveryStatus;
  attemptId: string;
  failureCode?: string;
  failureStage?: "reconcile" | "read" | "begin" | "send" | "settle";
  /** Transient, value-free shape of a failed host projection. */
  failureDiagnostic?: string;
}
export interface DeliveryProjection {
  schemaVersion: 2;
  identity: string;
  continuation: JsonObject;
  revision: number;
  status: Exclude<DeliveryStatus, "unsupported">;
  attemptId: string | null;
}
export interface DeliveryProjectionContext {
  readonly channel: "meta" | "structuredContent" | "root" | "connection" | "unknown";
  readonly method: "expected" | "unexpected" | "missing" | "unknown";
}
const deliveryStatuses = ["ready", "sending", "not_sent", "acknowledged", "rejected", "unknown"];
function valueType(value: unknown, present: boolean): string {
  return !present ? "missing" : value === null ? "null" : Array.isArray(value) ? "array" : typeof value;
}
function projectionDiagnostic(value: unknown, context: DeliveryProjectionContext): string {
  const root = value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
  const item = (source: Record<string, unknown> | null, key: string, valid: (value: unknown) => boolean, label = key): string => {
    const present = source !== null && Object.hasOwn(source, key);
    const entry = present ? source[key] : undefined;
    return `${label}=${valueType(entry, present)}:${present && valid(entry) ? "expected" : "unexpected"}`;
  };
  const fields = [
    item(root, "schemaVersion", entry => entry === 2),
    item(root, "identity", entry => typeof entry === "string" && entry.length > 0),
    item(root, "continuation", entry => entry !== null && typeof entry === "object" && !Array.isArray(entry)),
    item(root, "revision", entry => Number.isSafeInteger(entry) && typeof entry === "number" && entry >= 0),
    item(root, "status", entry => typeof entry === "string" && deliveryStatuses.includes(entry)),
    item(root, "attemptId", entry => entry === null || typeof entry === "string"),
  ];
  return `channel=${context.channel} · method=${context.method} · ${fields.join(" · ")}`;
}
export class DeliveryProjectionError extends UiTransportError {
  readonly projectionDiagnostic: string;
  constructor(value: unknown, context: DeliveryProjectionContext) {
    super({code:"DELIVERY_PROJECTION_INVALID",message:"The saved continuation could not be verified."});
    this.projectionDiagnostic = projectionDiagnostic(value, context);
  }
}
export function decodeDeliveryProjection(value: unknown, context: DeliveryProjectionContext = {channel:"unknown",method:"unknown"}): DeliveryProjection {
  const v = value as Partial<DeliveryProjection> | null;
  // The installed host can omit null-valued metadata properties. Only the
  // initial, revision-zero ready record proves that no attempt exists. Keep
  // all existing-attempt and ambiguous-outcome receipts strict; the runner
  // still reserves the exact revision before any message can be sent.
  const elidedInitialAttempt = v !== null && typeof v === "object" &&
    !Object.hasOwn(v, "attemptId") && v.status === "ready" && v.revision === 0;
  if (!v || v.schemaVersion !== 2 || typeof v.identity !== "string" || !v.identity ||
      !Number.isSafeInteger(v.revision) || v.revision! < 0 || !v.status ||
      !deliveryStatuses.includes(v.status) ||
      !(elidedInitialAttempt || v.attemptId === null || typeof v.attemptId === "string") ||
      !v.continuation || typeof v.continuation !== "object" || Array.isArray(v.continuation)) {
    throw new DeliveryProjectionError(value, context);
  }
  return elidedInitialAttempt ? { ...v, attemptId: null } as DeliveryProjection : v as DeliveryProjection;
}
export interface DeliveryJournal {
  get(identity: string): Promise<DeliveryProjection>;
  begin(value: {identity: string; expectedRevision: number; attemptId: string; idempotencyKey: string}): Promise<DeliveryProjection>;
  settle(value: {identity: string; expectedRevision: number; attemptId: string; idempotencyKey: string; status: "not_sent" | "acknowledged" | "rejected" | "unknown"}): Promise<DeliveryProjection>;
}
export interface DeliveryServices {
  available(): boolean;
  scope?(): string;
  uuid(): string;
  changed?(): void;
  journal: DeliveryJournal;
  send(text: string): Promise<unknown>;
}
const statuses = new Set<DeliveryStatus>(["ready", "sending", "not_sent", "acknowledged", "rejected", "unknown", "unsupported"]);
export function decodeDelivery(value: unknown): ContinuationDeliveryRecord | undefined {
  if (!value || typeof value !== "object") return;
  const r = value as Partial<ContinuationDeliveryRecord>;
  if (![1, 2].includes(r.schemaVersion ?? 0) || typeof r.identity !== "string" || !r.identity || typeof r.text !== "string" || !r.text || typeof r.attemptId !== "string" || !r.attemptId || !r.status || !statuses.has(r.status) || !["reviewed_start", "accepted_interaction", "follow_run", "long_answer"].includes(r.purpose || "")) return;
  try {
    const match = r.text.match(/```json\n([\s\S]*?)\n```/);
    const c = match ? JSON.parse(match[1] || "null") as Record<string, unknown> : null;
    if (!c || typeof c !== "object") return;
    const accepted = c.acceptedInteraction as {requestId?:unknown} | undefined;
    const identity = r.purpose === "reviewed_start" ? `start:${c.handoffRef}` : r.purpose === "long_answer" ? `question:${c.requestId}` : `follow:${c.runId}:${accepted?.requestId || c.trigger}`;
    if (identity !== r.identity) return;
  } catch { return; }
  const {failureDiagnostic: _transient, ...restored} = r;
  return { ...restored, status: r.status === "sending" ? "unknown" : r.status } as ContinuationDeliveryRecord;
}
export function continuationMessage(instruction: string, context: JsonObject): string {
  return `${instruction}\n\nLoomex continuation context:\n\n\`\`\`json\n${JSON.stringify(context)}\n\`\`\``;
}
/** One instruction for automatic delivery and its visible recovery copy. */
export function reviewedStartMessage(ref: string): string {
  return continuationMessage(`$loomex:loomex-runs reviewed-handoff ${ref}\n\nRead loomex_run_start_handoff_get for this exact reference. That read may reconcile an uncertain commit through the original backend receipt. Commit it only if the runner reports approved. Never prepare or approve a replacement. If the handoff remains ambiguous, preserve it and report the observation dependency; never retry commit. After a successful or reconciled commit, use the exact run ID returned by the runner and immediately call loomex_run_get. If the handoff is already committed, use its existing run ID without committing again. Continue following that same run using its authoritative nextAction, draining event pages and serial loomex_run_wait calls with timeoutSeconds 30 while active. A queued or running commit receipt is not the final response. For a pending question, follow its answerChannel: chat uses loomex_interaction_get and asks the verified question directly; ui uses loomex_interaction_view once. At terminal state retrieve the complete loomex_run_result. Stop only for verified human input, a complete terminal result, or an actionable observation failure.`,
    {schema:"loomex/run-start-handoff/v2",intent:"commit_reviewed_handoff",handoffRef:ref,state:"requires_fresh_read"});
}
export function deliveryMessage(projection: DeliveryProjection): string {
  const c = projection.continuation;
  if (projection.identity.startsWith("start:")) {
    const ref = projection.identity.slice(6);
    if (c.handoffRef !== ref) throw new Error("DELIVERY_IDENTITY_MISMATCH");
    return reviewedStartMessage(ref);
  }
  if (projection.identity.startsWith("question:")) {
    const id=projection.identity.slice(9);
    if(c.requestId !== id) throw new Error("DELIVERY_IDENTITY_MISMATCH");
    return continuationMessage(`Read Loomex interaction ${id} using loomex_interaction_get. Ask its verified long-answer question directly in chat. Do not answer for me or submit research as an answer.`,
      {schema:"loomex/chat-continuation/v2",intent:"answer_existing_interaction",requestId:id,state:"requires_fresh_read"});
  }
  if (typeof c.runId !== "string" || typeof c.receipt !== "string" || !/^[A-Za-z0-9_-]{16,2048}$/.test(c.receipt)) throw new Error("DELIVERY_RECEIPT_MISSING");
  const suffix = projection.identity.slice(`follow:${c.runId}:`.length);
  if (!projection.identity.startsWith(`follow:${c.runId}:`) || (c.requestId && c.requestId !== suffix)) throw new Error("DELIVERY_IDENTITY_MISMATCH");
  return continuationMessage(formatFollowContinuationMarkdown(c.runId,c.receipt), {
    schema:"loomex/chat-continuation/v2",intent:"monitor_existing_run",runId:c.runId,
    trigger:c.requestId ? "interaction_accepted" : suffix,
    ...(typeof c.requestId === "string" ? {acceptedInteraction:{requestId:c.requestId,status:typeof c.requestStatus === "string" ? c.requestStatus : "resolved"}} : {}),
    followContinuation:{schemaVersion:"loomex-runs-follow-existing-run-continuation/v2",source:"generated_markdown",runId:c.runId,receipt:c.receipt},
    state:"requires_fresh_read",
  });
}
function projectedStatus(value: DeliveryProjection): DeliveryStatus {
  return value.status === "sending" ? "unknown" : value.status;
}
function failureCode(error: unknown, fallback: string): string {
  const code = error instanceof UiResultDecodeError ? error.diagnostic.code : error instanceof UiTransportError ? error.code : undefined;
  if (code && /^-?\d{1,6}$/.test(code)) return `HOST_RPC_${code.startsWith("-") ? "MINUS_" + code.slice(1) : code}`;
  return code && /^[A-Z][A-Z0-9_]{0,63}$/.test(code) ? code : fallback;
}
function retainProjectionDiagnostic(record: ContinuationDeliveryRecord, error: unknown): void {
  if (error instanceof DeliveryProjectionError) record.failureDiagnostic = error.projectionDiagnostic;
}
/** Domain acceptance, durable delivery attempts and disposable card state are independent. */
export class ContinuationDeliveryController {
  #record: ContinuationDeliveryRecord | undefined;
  #recordScope: string | undefined;
  get record(): ContinuationDeliveryRecord | undefined {
    if (this.#recordScope !== this.host.scope?.()) this.#record = undefined;
    return this.#record;
  }
  set record(value: ContinuationDeliveryRecord | undefined) {
    this.#record = value;
    this.#recordScope = this.host.scope?.();
  }
  #disposed = false;
  #generation = 0;
  #active = false;
  #pendingReconciliation: { input: Pick<ContinuationDeliveryRecord, "identity" | "purpose" | "text">; scope: string | undefined } | undefined;
  constructor(private readonly host: DeliveryServices) {}
  restore(value: unknown): void {
    // Rendering an accepted result must not invalidate its in-flight continuation.
    if (this.#active) return;
    const restored = decodeDelivery(value);
    if (!restored && this.record) return;
    ++this.#generation;
    this.record = restored;
    this.host.changed?.();
  }
  async reconcile(input: Pick<ContinuationDeliveryRecord, "identity" | "purpose" | "text">): Promise<void> {
    if (this.#disposed) return;
    if (this.#active) {
      if (this.record?.identity !== input.identity) this.#pendingReconciliation = {input, scope:this.host.scope?.()};
      return;
    }
    const generation = ++this.#generation, scope = this.host.scope?.();
    try {
      const saved = await this.host.journal.get(input.identity);
      if (this.#disposed || this.#active || generation !== this.#generation || scope !== this.host.scope?.()) return;
      if (saved.identity !== input.identity) throw new Error("DELIVERY_IDENTITY_MISMATCH");
      this.record = {...input, text:deliveryMessage(saved), schemaVersion:2, attemptId:saved.attemptId || this.host.uuid(), status:projectedStatus(saved)};
    } catch (error) {
      if (generation !== this.#generation || this.#disposed || scope !== this.host.scope?.()) return;
      const record: ContinuationDeliveryRecord = {...input, schemaVersion:2, attemptId:this.host.uuid(), status:"unknown", failureStage:"reconcile", failureCode:failureCode(error,"DELIVERY_RECONCILIATION_UNAVAILABLE")};
      retainProjectionDiagnostic(record, error);
      this.record = record;
    }
    this.host.changed?.();
  }
  async deliver(input: Pick<ContinuationDeliveryRecord, "identity" | "purpose" | "text">, retry = false, automatic = true): Promise<DeliveryStatus> {
    if (this.#disposed) return "unknown";
    if (this.#active) {
      if (this.record?.identity === input.identity) return this.record.status;
      // A replacement card must never borrow the old card's outcome. Retain
      // its own unsent continuation for explicit recovery after disposal work.
      this.record = {...input, schemaVersion:2, attemptId:this.host.uuid(), status:"ready", failureCode:"DELIVERY_PREVIOUS_ATTEMPT_PENDING"};
      this.host.changed?.();
      return "ready";
    }
    const previous = this.record;
    // Local uncertainty may only describe a failed read, not a send. Always
    // consult durable authority before deciding whether an attempt exists.
    // Preserve an observed host acknowledgement if its settlement was lost.
    if (previous?.identity === input.identity && previous.status === "acknowledged") return previous.status;
    const generation = ++this.#generation, scope = this.host.scope?.();
    const record: ContinuationDeliveryRecord = { ...input, schemaVersion: 2, attemptId: this.host.uuid(), status: "ready" };
    this.record = record;
    this.#active = true;
    const current = () => !this.#disposed && generation === this.#generation && this.record === record && this.host.scope?.() === scope;
    let projection: DeliveryProjection | undefined;
    let dispatched = false, beginning = false;
    const settle = async (status: "not_sent" | "acknowledged" | "rejected" | "unknown") => {
      if (!projection || projection.attemptId !== record.attemptId) return;
      await this.host.journal.settle({identity:input.identity, expectedRevision:projection.revision, attemptId:record.attemptId, idempotencyKey:this.host.uuid(), status});
    };
    try {
      projection = await this.host.journal.get(input.identity);
      if (!current()) return "unknown";
      if (projection.identity !== input.identity) throw new Error("DELIVERY_IDENTITY_MISMATCH");
      record.text = deliveryMessage(projection);
      if (!["ready", "not_sent", "rejected"].includes(projection.status)) {
        record.status = projectedStatus(projection); return record.status;
      }
      if (projection.status !== "ready" && !retry) { record.status = projection.status; return record.status; }
      if (!automatic || !this.host.available()) { record.status = "unsupported"; record.failureCode = "HOST_MESSAGE_UNAVAILABLE"; return record.status; }
      beginning = true;
      projection = await this.host.journal.begin({identity:input.identity, expectedRevision:projection.revision, attemptId:record.attemptId, idempotencyKey:this.host.uuid()});
      if (projection.identity !== input.identity || projection.attemptId !== record.attemptId || projection.status !== "sending") throw new Error("DELIVERY_ATTEMPT_MISMATCH");
      if (!current()) { await settle("not_sent").catch(() => undefined); return "unknown"; }
      record.status = "sending"; this.host.changed?.();
      dispatched = true;
      try {
        const result = await this.host.send(record.text);
        record.status = result && typeof result === "object" && (result as {isError?:unknown}).isError === true ? "rejected" : "acknowledged";
      } catch (error) {
        record.status = error instanceof UiTransportError && !["HOST_TIMEOUT", "HOST_BRIDGE_DISPOSED"].includes(error.code || "") ? "rejected" : "unknown";
        record.failureStage = "send";
        record.failureCode = failureCode(error,"DELIVERY_HOST_RESPONSE_UNCONFIRMED");
      }
      // Even an unmounted card may settle its exact owned attempt. This never repeats work.
      await settle(record.status as "acknowledged" | "rejected" | "unknown").catch(error => { record.failureStage = "settle"; record.failureCode = failureCode(error,"DELIVERY_SETTLEMENT_UNAVAILABLE"); });
      return record.status;
    } catch (error) {
      record.status = dispatched || beginning ? "unknown" : "not_sent";
      record.failureStage = beginning ? "begin" : "read";
      record.failureCode = failureCode(error, beginning ? "DELIVERY_BEGIN_UNCONFIRMED" : "DELIVERY_PREPARATION_UNAVAILABLE");
      retainProjectionDiagnostic(record, error);
      return record.status;
    } finally {
      this.#active = false;
      const pending = this.#pendingReconciliation;
      this.#pendingReconciliation = undefined;
      if (!this.#disposed) {
        if (pending && pending.scope === this.host.scope?.()) void this.reconcile(pending.input);
        this.host.changed?.();
      }
    }
  }
  dispose(): void { this.#disposed = true; this.#pendingReconciliation = undefined; ++this.#generation; }
}
