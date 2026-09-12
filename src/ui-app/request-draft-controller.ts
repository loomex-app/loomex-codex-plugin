import type { JsonObject } from "./contracts.js";
import type { HumanRequest, InteractionDraft } from "./page-models.js";

type Identity = { readonly sessionId: string; readonly requestId: string; readonly schemaDigest: string; readonly key: string };
type Attempt = { readonly version: number; readonly payload: JsonObject };
type Scope = { readonly identity: Identity };
type DraftPhase = "answer" | "review";

export interface AcceptedDraftCleanup {
  readonly requestId: string;
  readonly expectedRevision: number;
  readonly expectedSchemaDigest: string;
  readonly idempotencyKey: string;
  readonly scopeKey: string;
}

export interface RequestDraftServices {
  draftRequest(): HumanRequest | null;
  inputSupported(request: HumanRequest): boolean;
  sessionId(): string | undefined;
  hydrationReady(): boolean;
  hydrationEpoch(): number;
  validId(value: unknown): value is string;
  persistenceTool(name: string, args: JsonObject): Promise<JsonObject>;
  answers(): JsonObject;
  currentQuestionId(): string | null;
  phase(): DraftPhase;
  uuid(): string;
  exactEqual(left: unknown, right: unknown): boolean;
  restoreAnswers(answers: JsonObject): void;
  showQuestion(questionId: string | null): void;
  beginReview(): void;
  status(status: "dirty" | "saved" | "save_failed" | "load_failed", error?: Error): void;
  markViewDirty(): void;
  flushView(): Promise<boolean>;
  persistenceBlocked(): boolean;
  setError(error: Error): void;
}

/** Keeps one interaction's local draft and its exact idempotent mutation attempt. */
export class RequestDraftController {
  readonly state: { draft: InteractionDraft | null; dirty: boolean; busy: boolean; scope: Scope | null } = { draft: null, dirty: false, busy: false, scope: null };
  #timer: ReturnType<typeof setTimeout> | null = null;
  #attempt: Attempt | null = null;
  #drainPromise: Promise<boolean> | null = null;
  #drainScope: Scope | null = null;
  #changeVersion = 0;
  #disposed = false;

  constructor(private readonly host: RequestDraftServices) {}

  requestSchemaDigest(request: HumanRequest | null): string | undefined {
    return typeof request?.schemaDigest === "string" && /^[a-f0-9]{64}$/.test(request.schemaDigest) ? request.schemaDigest : undefined;
  }

  identity(request = this.host.draftRequest(), sessionId = this.host.sessionId()): Identity | null {
    const requestId = request?.id;
    const schemaDigest = this.requestSchemaDigest(request);
    if (!this.host.validId(sessionId) || !this.host.validId(requestId) || !schemaDigest) return null;
    return { sessionId, requestId, schemaDigest, key: `${sessionId}:${requestId}:${schemaDigest}` };
  }

  dispose(): void {
    this.#disposed = true;
    this.detachInteractionDraft();
  }

  detachInteractionDraft(): void {
    if (this.#timer) clearTimeout(this.#timer);
    this.#timer = null;
    this.state.scope = null;
    this.state.draft = null;
    this.state.busy = false;
    this.state.dirty = false;
    this.#attempt = null;
    this.#changeVersion = 0;
  }

  ensureInteractionDraftScope(identity = this.identity()): Scope | null {
    if (this.#disposed || !identity) {
      this.detachInteractionDraft();
      return null;
    }
    if (!this.state.scope || this.state.scope.identity.key !== identity.key) {
      this.detachInteractionDraft();
      this.state.scope = { identity };
    }
    return this.state.scope;
  }

  draftScopeCurrent(scope: Scope | null): boolean {
    return !this.#disposed && scope === this.state.scope && scope?.identity.key === this.identity()?.key;
  }

  synchronizeInteractionDraftScope(): void {
    if (!this.#disposed) this.ensureInteractionDraftScope();
  }

  /** Capture the exact deletion tuple before an accepted mutation can rerender this request. */
  captureAcceptedDraft(requestId: unknown): AcceptedDraftCleanup | null {
    const scope = this.state.scope;
    const draft = this.state.draft;
    if (this.#disposed || !scope || !this.host.validId(requestId) || !draft
      || draft.requestId !== requestId
      || draft.schemaDigest !== scope.identity.schemaDigest
      || !numeric(draft.revision)) return null;
    return {
      requestId,
      expectedRevision: draft.revision,
      expectedSchemaDigest: draft.schemaDigest,
      idempotencyKey: this.host.uuid(),
      scopeKey: scope.identity.key,
    };
  }

  /** Delete a previously captured accepted draft without touching a replacement request. */
  async deleteAcceptedDraft(cleanup: AcceptedDraftCleanup | null): Promise<boolean> {
    if (this.#disposed || !cleanup) return false;
    if (this.matchesAcceptedCleanup(cleanup)) this.detachInteractionDraft();
    try {
      await this.host.persistenceTool("loomex_interaction_draft_delete", {
        requestId: cleanup.requestId,
        expectedRevision: cleanup.expectedRevision,
        expectedSchemaDigest: cleanup.expectedSchemaDigest,
        idempotencyKey: cleanup.idempotencyKey,
      });
      return true;
    } catch {
      return false;
    }
  }

  async loadInteractionDraft(request: HumanRequest, epoch = this.host.hydrationEpoch()): Promise<boolean> {
    if (this.#disposed) return false;
    if (!request.id || !this.host.inputSupported(request)) return true;
    const identity = this.identity(request);
    if (!identity || identity.key !== this.identity()?.key) return false;
    const scope = this.ensureInteractionDraftScope(identity);
    if (!scope || this.state.busy) return true;
    this.state.busy = true;
    try {
      const data = await this.host.persistenceTool("loomex_interaction_draft_get", { requestId: request.id });
      if (!this.draftScopeCurrent(scope) || epoch !== this.host.hydrationEpoch()) return false;
      const draft = this.readDraft(data.draft, scope.identity);
      if (data.draft !== undefined && data.draft !== null && !draft) {
        this.host.status("load_failed", new Error("The saved answer draft did not match this request."));
        return false;
      }
      if (this.state.dirty) {
        if (!this.#attempt || !draft || !this.receiptMatchesAttempt(draft, this.#attempt)) {
          this.host.status("save_failed", draftConflictError());
          return false;
        }
        if (this.#changeVersion !== this.#attempt.version) {
          this.host.status("save_failed", draftConflictError());
          return false;
        }
        this.#attempt = null;
      }
      this.state.draft = draft;
      if (draft) {
        this.host.restoreAnswers(draft.answers ?? {});
        this.host.showQuestion(draft.currentQuestionId ?? null);
        if (draft.phase === "review") {
          try { this.host.beginReview(); } catch { /* The current page may no longer support review. */ }
        }
      }
      this.state.dirty = false;
      this.host.status("saved");
      return true;
    } catch (error: unknown) {
      if (this.draftScopeCurrent(scope) && epoch === this.host.hydrationEpoch()) this.host.status("load_failed", asError(error));
      return false;
    } finally {
      if (this.draftScopeCurrent(scope)) this.state.busy = false;
    }
  }

  scheduleInteractionDraft(): void {
    if (this.#disposed) return;
    const request = this.host.draftRequest();
    if (!this.host.hydrationReady() || !request || !this.host.inputSupported(request) || !this.requestSchemaDigest(request)) return;
    const scope = this.ensureInteractionDraftScope(this.identity(request));
    if (!scope) return;
    this.state.dirty = true;
    this.#changeVersion += 1;
    this.host.status("dirty");
    if (this.#timer) clearTimeout(this.#timer);
    this.#timer = setTimeout(() => {
      this.#timer = null;
      if (this.draftScopeCurrent(scope)) void this.flushInteractionDraft();
    }, 350);
  }

  flushInteractionDraft(): Promise<boolean> {
    if (this.#disposed) return Promise.resolve(false);
    const request = this.host.draftRequest();
    if (!this.host.sessionId() || !request || !this.host.inputSupported(request) || !this.state.dirty) return Promise.resolve(true);
    if (!this.host.hydrationReady()) return Promise.resolve(false);
    const scope = this.ensureInteractionDraftScope(this.identity(request));
    if (!scope || !this.draftScopeCurrent(scope)) {
      this.host.status("save_failed");
      return Promise.resolve(false);
    }
    if (this.#drainPromise) {
      if (this.#drainScope === scope) return this.#drainPromise;
      const priorDrain = this.#drainPromise;
      return priorDrain.then(() => this.#disposed ? false : this.flushInteractionDraft());
    }
    if (this.#timer) clearTimeout(this.#timer);
    this.#timer = null;
    const drain = this.drainInteractionDraft(scope);
    this.#drainPromise = drain;
    this.#drainScope = scope;
    void drain.then(
      () => {
        if (this.#drainPromise === drain) {
          this.#drainPromise = null;
          this.#drainScope = null;
        }
      },
      () => {
        if (this.#drainPromise === drain) {
          this.#drainPromise = null;
          this.#drainScope = null;
        }
      },
    );
    return drain;
  }

  private async drainInteractionDraft(scope: Scope): Promise<boolean> {
    this.state.busy = true;
    try {
      while (this.draftScopeCurrent(scope) && this.state.dirty) {
        const attempt = this.#attempt ?? this.createAttempt(scope);
        if (!attempt) return false;
        this.#attempt = attempt;
        let data: JsonObject;
        try {
          data = await this.host.persistenceTool("loomex_interaction_draft_update", structuredClone(attempt.payload));
        } catch (error: unknown) {
          if (this.draftScopeCurrent(scope) && this.#attempt === attempt) {
            this.state.dirty = true;
            this.host.status("save_failed", asError(error));
          }
          return false;
        }
        if (!this.draftScopeCurrent(scope) || this.#attempt !== attempt) return false;
        const draft = this.readDraft(receiptValue(data), scope.identity);
        if (!draft || !this.receiptMatchesAttempt(draft, attempt)) {
          this.host.status("save_failed", new Error("The saved answer draft receipt did not match the submitted changes."));
          return false;
        }
        this.state.draft = draft;
        if (this.#changeVersion === attempt.version) this.state.dirty = false;
        this.#attempt = null;
        this.host.status("saved");
      }
      return this.draftScopeCurrent(scope) && !this.state.dirty;
    } finally {
      if (this.draftScopeCurrent(scope)) this.state.busy = false;
    }
  }

  private createAttempt(scope: Scope): Attempt | null {
    const request = this.host.draftRequest();
    const identity = this.identity(request);
    if (!request?.id || !identity || identity.key !== scope.identity.key || !this.draftScopeCurrent(scope)) return null;
    const expectedRevision = this.state.draft?.requestId === request.id ? numeric(this.state.draft.revision) ? this.state.draft.revision : 0 : 0;
    return {
      version: this.#changeVersion,
      payload: {
        requestId: request.id,
        expectedRevision,
        expectedSchemaDigest: identity.schemaDigest,
        idempotencyKey: this.host.uuid(),
        answers: this.host.answers(),
        currentQuestionId: this.host.currentQuestionId(),
        phase: this.host.phase(),
      },
    };
  }

  private matchesAcceptedCleanup(cleanup: AcceptedDraftCleanup): boolean {
    const scope = this.state.scope;
    const draft = this.state.draft;
    return scope?.identity.key === cleanup.scopeKey
      && draft?.requestId === cleanup.requestId
      && draft.schemaDigest === cleanup.expectedSchemaDigest
      && draft.revision === cleanup.expectedRevision;
  }

  private readDraft(value: unknown, identity: Identity): InteractionDraft | null {
    if (!isRecord(value)
      || value.requestId !== identity.requestId
      || value.schemaDigest !== identity.schemaDigest
      || !numeric(value.revision)
      || !isRecord(value.answers)
      || (value.currentQuestionId !== null && typeof value.currentQuestionId !== "string")
      || !isDraftPhase(value.phase)) return null;
    return value as InteractionDraft;
  }

  private receiptMatchesAttempt(draft: InteractionDraft, attempt: Attempt): boolean {
    const payload = attempt.payload;
    return draft.requestId === payload.requestId
      && draft.schemaDigest === payload.expectedSchemaDigest
      && numeric(draft.revision) && numeric(payload.expectedRevision) && draft.revision > payload.expectedRevision
      && this.host.exactEqual(draft.answers, payload.answers)
      && draft.currentQuestionId === payload.currentQuestionId
      && draft.phase === payload.phase;
  }

  scheduleCurrentPersistence(): void {
    if (this.#disposed || !this.host.hydrationReady()) return;
    this.host.markViewDirty();
    this.scheduleInteractionDraft();
  }

  async flushCurrentPersistence(): Promise<boolean> {
    if (this.#disposed) return false;
    if (this.host.persistenceBlocked()) {
      this.host.setError(new Error("This action needs saved view storage, but it is currently unavailable. Try again after the view reconnects."));
      return false;
    }
    if (this.host.sessionId() && !this.host.hydrationReady()) {
      this.host.setError(new Error("The saved view is still restoring. Wait for it to finish, then try this action again."));
      return false;
    }
    const scope = this.state.scope;
    const draftSaved = await this.flushInteractionDraft();
    if (this.#disposed || (scope && !this.draftScopeCurrent(scope))) return false;
    const viewSaved = await this.host.flushView();
    if (this.#disposed) return false;
    if (!draftSaved || !viewSaved) {
      this.host.status("save_failed");
      this.host.setError(new Error("Your changes could not be saved, so this action was not sent. Try again after saving succeeds."));
    }
    return draftSaved && viewSaved;
  }

  saveReviewNavigation(): void {
    if (this.#disposed) return;
    this.scheduleCurrentPersistence();
    const scope = this.state.scope;
    void this.flushInteractionDraft()
      .then((draftSaved) => {
        if (this.#disposed || (scope && !this.draftScopeCurrent(scope))) return true;
        return draftSaved ? this.host.flushView() : false;
      })
      .then((saved) => {
        if (!saved && !this.#disposed && (!scope || this.draftScopeCurrent(scope))) this.host.status("save_failed");
      })
      .catch((error: unknown) => {
        if (!this.#disposed && (!scope || this.draftScopeCurrent(scope))) this.host.status("save_failed", asError(error));
      });
  }

  restoreReviewNavigationControls(button: HTMLButtonElement): void {
    button.dataset.reviewNavigation = "true";
  }
}

function receiptValue(data: JsonObject): unknown {
  return Object.hasOwn(data, "draft") ? data.draft : data;
}

function isRecord(value: unknown): value is JsonObject {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isDraftPhase(value: unknown): value is DraftPhase {
  return value === "answer" || value === "review";
}

function numeric(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function draftConflictError(): Error {
  return Object.assign(new Error("This answer draft changed while local edits were pending."), { code: "INTERACTION_DRAFT_CONFLICT" });
}

function asError(value: unknown): Error {
  return value instanceof Error ? value : new Error("The answer draft could not be saved.");
}
