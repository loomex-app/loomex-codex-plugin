import type { JsonObject, ViewSessionIdentity, ViewSessionProjection } from "./contracts.js";

export type PersistenceStatus = "dirty" | "saved" | "save_failed" | "load_failed";
export type PersistenceWriteOptions = JsonObject;

export interface PersistenceError extends Error {
  readonly code?: string;
  readonly retryable?: boolean;
  readonly correlationId?: string;
}

export interface ViewPersistenceOptions<State extends JsonObject = JsonObject> {
  readonly read: (viewSessionId: string) => Promise<ViewSessionProjection<State> | null | undefined>;
  readonly write: (
    viewSessionId: string,
    expectedRevision: number,
    state: State,
    idempotencyKey: string,
    options: PersistenceWriteOptions | undefined,
  ) => Promise<ViewSessionProjection<State>>;
  readonly onStatus?: (status: PersistenceStatus, error?: PersistenceError) => void;
  readonly snapshot?: () => PersistenceWriteOptions | undefined;
  readonly debounceMs?: number;
}

type SaveAttempt<State extends JsonObject> = {
  readonly sessionId: string;
  readonly expectedRevision: number;
  readonly state: State;
  readonly idempotencyKey: string;
  readonly options: PersistenceWriteOptions | undefined;
  readonly version: number;
  error?: PersistenceError;
};

const CONFLICT_CODES = new Set(["REVISION_CONFLICT", "PRESENTATION_SESSION_CONFLICT"]);

export class PresentationConflictError extends Error implements PersistenceError {
  readonly code = "PRESENTATION_SESSION_CONFLICT";

  constructor() {
    super("This view changed elsewhere. Choose the saved version before continuing.");
    this.name = "PresentationConflictError";
  }
}

/**
 * Serializes a view session's local presentation state. The server projection
 * remains authoritative; an ambiguous save keeps its exact idempotency tuple.
 */
export class ViewPersistenceController<State extends JsonObject = JsonObject> {
  readonly #read: ViewPersistenceOptions<State>["read"];
  readonly #write: ViewPersistenceOptions<State>["write"];
  readonly #onStatus: NonNullable<ViewPersistenceOptions<State>["onStatus"]>;
  readonly #snapshot: NonNullable<ViewPersistenceOptions<State>["snapshot"]>;
  readonly #debounceMs: number;
  #timer: ReturnType<typeof setTimeout> | undefined;
  #writePromise: Promise<boolean> | undefined;
  #hydrationToken = 0;
  #sessionEpoch = 0;

  session: ViewSessionIdentity | null = null;
  pendingState: State | undefined;
  pendingOptions: PersistenceWriteOptions | undefined;
  changeVersion = 0;
  savedVersion = 0;
  attempt: SaveAttempt<State> | null = null;
  conflict: PresentationConflictError | null = null;

  constructor(options: ViewPersistenceOptions<State>) {
    this.#read = options.read;
    this.#write = options.write;
    this.#onStatus = options.onStatus ?? (() => undefined);
    this.#snapshot = options.snapshot ?? (() => undefined);
    this.#debounceMs = options.debounceMs ?? 350;
  }

  dirty(): boolean {
    return this.changeVersion > this.savedVersion || this.attempt !== null || this.#writePromise !== undefined;
  }

  configure(session: ViewSessionIdentity): boolean {
    if (!validIdentity(session)) return false;
    const changed = this.session?.viewSessionId !== session.viewSessionId;
    if (changed) {
      this.session = { viewSessionId: session.viewSessionId, revision: session.revision };
      this.#resetLocalState();
    } else if (this.session !== null && session.revision > this.session.revision) {
      if (this.dirty()) this.#reportConflict();
      else this.session = { viewSessionId: this.session.viewSessionId, revision: session.revision };
    }
    return changed;
  }

  clear(): void {
    this.#clearTimer();
    this.pendingState = undefined;
    this.pendingOptions = undefined;
    this.session = null;
    this.changeVersion = 0;
    this.savedVersion = 0;
    this.#hydrationToken += 1;
    this.#sessionEpoch += 1;
    this.#writePromise = undefined;
    this.attempt = null;
    this.conflict = null;
  }

  async hydrate(): Promise<ViewSessionProjection<State> | null> {
    if (this.session === null) return null;
    const token = ++this.#hydrationToken;
    const id = this.session.viewSessionId;
    try {
      const projection = await this.#read(id);
      if (token !== this.#hydrationToken || this.session?.viewSessionId !== id) return null;
      if (!validProjection(projection, id) || projection.revision < this.session.revision) {
        throw new Error("The saved view state could not be verified.");
      }
      const attempt = this.attempt;
      const landed = attempt !== null && projection.revision > attempt.expectedRevision &&
        equal(projection.state, attempt.state) &&
        (!attempt.options?.status || projection.status === attempt.options.status);
      if (landed) {
        this.#setRevision(projection.revision);
        this.savedVersion = Math.max(this.savedVersion, attempt.version);
        this.attempt = null;
        this.conflict = null;
        if (this.savedVersion === this.changeVersion) {
          this.pendingState = undefined;
          this.pendingOptions = undefined;
        }
      } else if (projection.revision !== this.session.revision && this.dirty()) {
        this.#reportConflict();
        return null;
      } else if (!this.dirty()) {
        this.#setRevision(projection.revision);
      }
      this.#onStatus(this.conflict !== null || this.attempt !== null ? "save_failed" : this.dirty() ? "dirty" : "saved",
        this.conflict ?? this.attempt?.error);
      return clone(projection);
    } catch (error: unknown) {
      if (token === this.#hydrationToken) this.#onStatus("load_failed", persistenceError(error));
      return null;
    }
  }

  markDirty(state: State): void {
    if (this.session === null) return;
    this.pendingState = clone(state);
    this.changeVersion += 1;
    this.#clearTimer();
    if (this.conflict !== null) {
      this.#onStatus("save_failed", this.conflict);
      return;
    }
    this.#onStatus("dirty");
    this.#timer = setTimeout(() => { void this.flush(); }, this.#debounceMs);
  }

  async flush(state?: State): Promise<boolean> {
    return this.#flush(state);
  }

  /** Queues one durable status transition behind any pending presentation write. */
  async flushStatus(state: State, status: string): Promise<boolean> {
    if (!status.trim()) return false;
    return this.#flush(state, { status }, true);
  }

  async #flush(state?: State, options?: PersistenceWriteOptions, coalesce = false): Promise<boolean> {
    if (this.session === null) return true;
    if (state !== undefined) {
      const copiedState = clone(state);
      const copiedOptions = clone(options);
      if (coalesce && this.#writePromise !== undefined && this.#samePending(copiedState, copiedOptions)) return this.#writePromise;
      this.pendingState = copiedState;
      if (copiedOptions !== undefined) this.pendingOptions = copiedOptions;
      this.changeVersion += 1;
    }
    this.#clearTimer();
    if (this.conflict !== null) {
      this.#onStatus("save_failed", this.conflict);
      return false;
    }
    if (this.#writePromise !== undefined) return this.#writePromise;
    const id = this.session.viewSessionId;
    const epoch = this.#sessionEpoch;
    const current = (): boolean => this.session?.viewSessionId === id && this.#sessionEpoch === epoch;
    const task = this.#drain(id, current);
    this.#writePromise = task;
    try {
      return await task;
    } finally {
      if (this.#writePromise === task) this.#writePromise = undefined;
    }
  }

  async flushBefore(state: State | undefined, action: () => Promise<void>): Promise<boolean> {
    if (!await this.flush(state)) return false;
    await action();
    return true;
  }

  async useSavedVersion(): Promise<ViewSessionProjection<State> | null> {
    if (this.session === null) return null;
    this.#clearTimer();
    if (this.#writePromise !== undefined) await this.#writePromise;
    const id = this.session.viewSessionId;
    const generation = this.changeVersion;
    const token = ++this.#hydrationToken;
    try {
      const projection = await this.#read(id);
      if (token !== this.#hydrationToken || this.session?.viewSessionId !== id || this.changeVersion !== generation) return null;
      if (!validProjection(projection, id)) throw new Error("The saved view state could not be verified.");
      this.#setRevision(projection.revision);
      this.attempt = null;
      this.conflict = null;
      this.pendingState = undefined;
      this.pendingOptions = undefined;
      this.changeVersion = 0;
      this.savedVersion = 0;
      this.#onStatus("saved");
      return clone(projection);
    } catch (error: unknown) {
      this.#onStatus("load_failed", persistenceError(error));
      return null;
    }
  }

  async #drain(id: string, current: () => boolean): Promise<boolean> {
    while (current() && this.savedVersion !== this.changeVersion) {
      if (this.attempt === null) {
        if (this.session === null || this.pendingState === undefined) return false;
        this.attempt = {
          sessionId: id,
          expectedRevision: this.session.revision,
          state: clone(this.pendingState),
          idempotencyKey: randomUuid(),
          options: clone(this.pendingOptions ?? this.#snapshot()),
          version: this.changeVersion,
        };
      }
      const attempt = this.attempt;
      try {
        const projection = await this.#write(id, attempt.expectedRevision, clone(attempt.state), attempt.idempotencyKey, clone(attempt.options));
        if (!validProjection(projection, id) || projection.revision <= attempt.expectedRevision) {
          throw new Error("The saved view state could not be verified.");
        }
        if (!current()) return false;
        this.#setRevision(projection.revision);
        this.savedVersion = attempt.version;
        this.attempt = null;
        if (this.savedVersion === this.changeVersion) this.pendingState = undefined;
        if (this.savedVersion === this.changeVersion) this.pendingOptions = undefined;
        this.#onStatus(this.savedVersion === this.changeVersion ? "saved" : "dirty");
      } catch (error: unknown) {
        if (!current()) return false;
        const typedError = persistenceError(error);
        if (this.attempt === attempt) attempt.error = typedError;
        if (CONFLICT_CODES.has(typedError.code ?? "")) this.#reportConflict();
        else this.#onStatus("save_failed", typedError);
        return false;
      }
    }
    return current();
  }

  #setRevision(revision: number): void {
    if (this.session !== null) this.session = { viewSessionId: this.session.viewSessionId, revision };
  }

  #resetLocalState(): void {
    this.#clearTimer();
    this.pendingState = undefined;
    this.pendingOptions = undefined;
    this.changeVersion = 0;
    this.savedVersion = 0;
    this.#hydrationToken += 1;
    this.#sessionEpoch += 1;
    this.#writePromise = undefined;
    this.attempt = null;
    this.conflict = null;
  }

  #clearTimer(): void {
    if (this.#timer !== undefined) clearTimeout(this.#timer);
    this.#timer = undefined;
  }

  #reportConflict(): void {
    this.conflict = new PresentationConflictError();
    this.#clearTimer();
    this.#onStatus("save_failed", this.conflict);
  }

  #samePending(state: State, options: PersistenceWriteOptions | undefined): boolean {
    const queuedAfterAttempt = this.attempt !== null && this.changeVersion > this.attempt.version;
    const pending = queuedAfterAttempt ? this.pendingState : this.attempt?.state ?? this.pendingState;
    const pendingOptions = queuedAfterAttempt ? this.pendingOptions : this.attempt?.options ?? this.pendingOptions;
    return pending !== undefined && equal(state, pending) && equal(options, pendingOptions);
  }
}

export function createViewPersistence<State extends JsonObject = JsonObject>(options: ViewPersistenceOptions<State>): ViewPersistenceController<State> {
  return new ViewPersistenceController(options);
}

function validIdentity(value: ViewSessionIdentity): boolean {
  return typeof value.viewSessionId === "string" && value.viewSessionId.length > 0 &&
    Number.isSafeInteger(value.revision) && value.revision >= 0;
}

function validProjection<State extends JsonObject>(value: ViewSessionProjection<State> | null | undefined, id: string): value is ViewSessionProjection<State> {
  return value !== null && value !== undefined && value.viewSessionId === id && validIdentity(value);
}

function clone<Value>(value: Value): Value {
  return value === undefined ? value : structuredClone(value);
}

function equal(left: unknown, right: unknown): boolean {
  if (Object.is(left, right)) return true;
  if (left === null || right === null || typeof left !== "object" || typeof right !== "object" || Array.isArray(left) !== Array.isArray(right)) return false;
  if (Array.isArray(left) && Array.isArray(right)) {
    return left.length === right.length && left.every((value, index) => equal(value, right[index]));
  }
  if (Array.isArray(left) || Array.isArray(right)) return false;
  const leftRecord = left as Record<string, unknown>;
  const rightRecord = right as Record<string, unknown>;
  const keys = Object.keys(leftRecord).sort();
  const other = Object.keys(rightRecord).sort();
  return keys.length === other.length && keys.every((key, index) => key === other[index] && equal(leftRecord[key], rightRecord[key]));
}

function randomUuid(): string {
  if (typeof crypto?.randomUUID !== "function") throw new Error("This host cannot generate a safe idempotency UUID.");
  return crypto.randomUUID();
}

function persistenceError(error: unknown): PersistenceError {
  if (error instanceof Error) return error as PersistenceError;
  return new Error("The view state could not be saved.");
}
