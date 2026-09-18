import type { JsonObject, UiMode, ViewSessionIdentity, ViewSessionProjection } from "./contracts.js";

export type PersistenceStatus = "dirty" | "saving" | "saved" | "save_failed" | "load_failed";
export type PersistenceWriteOptions = JsonObject;
/**
 * Restoration has two deliberately separate stages. A saved presentation can
 * be shown while it is being checked, but never makes the card mutable.
 */
export type ViewRestorationPhase = "loading_snapshot" | "verifying" | "ready" | "read_only" | "verification_failed" | "reentry_required" | "disposed";

export type LifecyclePersistence = "clean" | "dirty" | "saving" | "conflicted" | "unavailable";
export type LifecycleRefresh = "idle" | "refreshing" | "failed";
export interface ViewLifecycleAdapter<Snapshot> extends ViewRestorationCallbacks<Snapshot> {
  readonly mode: UiMode;
  readonly identity: string;
  readonly domainIdentity: string;
  /** Domain controllers provide these boundaries; the coordinator orders them. */
  reconcile?(snapshot: Snapshot, fence: RestorationScopeFence): Promise<void>;
  restoreDraft?(snapshot: Snapshot, fence: RestorationScopeFence): Promise<void>;
  project?(snapshot: Snapshot, fence: RestorationScopeFence): Promise<"ready" | "read_only">;
  cleanup?(): void;
}

export interface RestorationRequestFence {
  readonly generation: number;
  readonly scope: string;
  readonly domainIdentity: string;
  readonly operation: string;
  readonly request: number;
}

export interface RestorationScopeFence {
  readonly generation: number;
  readonly scope: string;
  current(): boolean;
  request(operation: string): RestorationRequestFence;
  currentRequest(fence: RestorationRequestFence): boolean;
}

export interface ViewRestorationCoordinatorState {
  readonly phase: ViewRestorationPhase;
  readonly mode?: UiMode;
  readonly persistence: LifecyclePersistence;
  readonly refresh: LifecycleRefresh;
  readonly completed: boolean;
  readonly generation: number;
  readonly scope: string;
  readonly failedSection?: string;
  /** Monotonic local timings for diagnostics; no session or user data is recorded. */
  readonly snapshotDurationMs?: number;
  readonly verificationDurationMs?: number;
  readonly totalDurationMs?: number;
}

export interface ViewRestorationCoordinatorOptions {
  readonly snapshotTimeoutMs?: number;
  readonly verificationTimeoutMs?: number;
  readonly onPhase?: (state: ViewRestorationCoordinatorState) => void;
}

export interface ViewRestorationCallbacks<Snapshot> {
  /** Reads an owner-checked, display-safe saved snapshot. */
  snapshot(fence: RestorationScopeFence): Promise<Snapshot | null | undefined>;
  /** Renders only cached display/navigation state; mutation controls stay disabled. */
  display(snapshot: Snapshot, fence: RestorationScopeFence): "verifying" | "read_only" | void | Promise<"verifying" | "read_only" | void>;
  /** Reads current authority independently of the saved snapshot. */
  verify(snapshot: Snapshot, fence: RestorationScopeFence): Promise<"ready" | "read_only">;
  ready?(): void;
  failed(section: "snapshot" | "verification", error: Error, fence: RestorationScopeFence): void;
}

/**
 * Fences a restoration scope and each of its unrelated requests. A late
 * interaction refresh, for example, cannot overwrite a later run refresh.
 * Timers only stop waiting; they never cancel or authorize provider work.
 */
export class ViewRestorationCoordinator {
  readonly #snapshotTimeoutMs: number;
  readonly #verificationTimeoutMs: number;
  readonly #onPhase: NonNullable<ViewRestorationCoordinatorOptions["onPhase"]>;
  #generation = 0;
  #mode: UiMode | undefined;
  #persistence: LifecyclePersistence = "clean";
  #stores = new Map<string,LifecyclePersistence>();
  #refresh: LifecycleRefresh = "idle";
  #refreshRequests = new Set<symbol>();
  #refreshFailed = false;
  #completed = false;
  #disposed = false;
  #listeners = new Set<(state: ViewRestorationCoordinatorState) => void>();
  #resources = new Map<string, () => void>();
  #deadlines = new Set<() => void>();
  #scope = "";
  #domainIdentity = "";
  #phase: ViewRestorationPhase = "loading_snapshot";
  #failedSection: string | undefined;
  #requests = new Map<string, number>();
  #startedAt = 0;
  #snapshotCompletedAt: number | undefined;
  #verificationCompletedAt: number | undefined;

  constructor(options: ViewRestorationCoordinatorOptions = {}) {
    this.#snapshotTimeoutMs = options.snapshotTimeoutMs ?? 5_000;
    this.#verificationTimeoutMs = options.verificationTimeoutMs ?? 15_000;
    this.#onPhase = options.onPhase ?? (() => undefined);
  }

  get state(): ViewRestorationCoordinatorState {
    const now = this.#now();
    const snapshotDurationMs = this.#snapshotCompletedAt === undefined ? undefined : this.#snapshotCompletedAt - this.#startedAt;
    const verificationDurationMs = this.#snapshotCompletedAt === undefined || this.#verificationCompletedAt === undefined
      ? undefined
      : this.#verificationCompletedAt - this.#snapshotCompletedAt;
    return { phase: this.#phase, ...(this.#mode ? {mode:this.#mode}:{}), persistence: this.#persistence, refresh: this.#refresh, completed: this.#completed, generation: this.#generation, scope: this.#scope,
      ...(this.#failedSection ? { failedSection: this.#failedSection } : {}),
      ...(snapshotDurationMs === undefined ? {} : { snapshotDurationMs }),
      ...(verificationDurationMs === undefined ? {} : { verificationDurationMs }),
      ...(this.#startedAt === 0 ? {} : { totalDurationMs: (this.#verificationCompletedAt ?? now) - this.#startedAt }),
    };
  }

  subscribe(listener: (state: ViewRestorationCoordinatorState) => void): () => void {
    if(this.#disposed)return ()=>undefined;
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  permissions(identity = this.#scope) {
    const authority = !this.#disposed && identity === this.#scope && ["ready", "read_only"].includes(this.#phase);
    const writable = !["conflicted", "unavailable"].includes(this.#persistence);
    return { navigate: !this.#disposed && this.#phase !== "loading_snapshot",
      authority, edit: authority && !this.#completed,
      retryPersistence: authority && !this.#completed && this.#persistence === "unavailable",
      mutate: authority && !this.#completed && writable && this.#refresh !== "refreshing",
      save: authority && !this.#completed && writable };
  }

  persistence(status: PersistenceStatus, error?: PersistenceError, store="presentation"): void {
    const value:LifecyclePersistence = /CONFLICT|STALE/.test(error?.code ?? "") ? "conflicted"
      : status === "saved" ? "clean" : status === "dirty" ? "dirty" : status === "saving" ? "saving" : "unavailable";
    this.#stores.set(store,value);
    this.#persistence=(["conflicted","unavailable","saving","dirty","clean"] as const).find(state=>[...this.#stores.values()].includes(state)) ?? "clean";
    this.#emit();
  }

  complete(): void { if(this.#disposed)return; this.#completed = true; this.#emit(); }
  loading(): void { this.invalidate(); this.#set("loading_snapshot"); }
  unavailable(): void { this.invalidate(); this.#set("verification_failed", "snapshot"); }
  reenter(): void { this.invalidate(); this.#set("reentry_required"); }
  ownResource(key: string, release: () => void): void { if(this.#disposed){release();return;} this.releaseResource(key); this.#resources.set(key, release); }
  releaseResource(key: string): void { const release = this.#resources.get(key); this.#resources.delete(key); release?.(); }

  /** Separate request lanes prevent an unrelated refresh from cancelling a draft read. */
  request(lane: string): { current(): boolean } {
    const fence = this.#fence(this.#generation, this.#scope);
    const request = fence.request(lane);
    return { current: () => !this.#disposed && fence.currentRequest(request) };
  }

  async refresh<T>(lane: string, read: () => Promise<T>, apply: (value: T) => void | Promise<void>): Promise<boolean> {
    if (this.#disposed) return false;
    const fence = this.request(lane);
    const token=Symbol(lane);this.#refreshRequests.add(token);this.#refreshFailed=false;
    this.#refresh = "refreshing"; this.#emit();
    try {
      const value = await this.#deadline(read(), this.#verificationTimeoutMs, "The latest state could not be verified. Refresh to retry.");
      if (!fence.current()) return false;
      await apply(value);
      if (!fence.current()) return false;
      return true;
    } catch (error) {
      if (!fence.current()) return false;
      // Fence the timed-out read before a late result can affect this page.
      this.request(lane);
      this.#refreshFailed=true; throw error;
    } finally {
      if(this.#refreshRequests.delete(token)){
        this.#refresh=this.#refreshRequests.size ? "refreshing" : this.#refreshFailed ? "failed" : "idle";this.#emit();
      }
    }
  }

  async open<Snapshot>(adapter: ViewLifecycleAdapter<Snapshot>): Promise<boolean> {
    this.#mode = adapter.mode;
    const opening = this.begin(adapter.identity, {
      snapshot: adapter.snapshot, display: adapter.display, failed: adapter.failed, ...(adapter.ready ? {ready:adapter.ready}:{}),
      verify: async (snapshot, fence) => {
        const status = await adapter.verify(snapshot, fence);
        if (!fence.current()) return "read_only";
        await adapter.reconcile?.(snapshot, fence);
        if (!fence.current()) return "read_only";
        if (status !== "read_only") await adapter.restoreDraft?.(snapshot, fence);
        if (!fence.current()) return "read_only";
        return adapter.project ? adapter.project(snapshot,fence) : status;
      },
    },adapter.domainIdentity);
    const generation = this.#generation;
    if (adapter.cleanup && !this.#disposed) this.ownResource("adapter", adapter.cleanup);
    const opened = await opening;
    return opened && generation === this.#generation;
  }

  invalidate(): void {
    this.#generation += 1;
    this.#scope = "";
    this.#requests.clear();
    this.#refreshRequests.clear();this.#refresh="idle";this.#refreshFailed=false;
    for (const cancel of [...this.#deadlines]) cancel();
    for (const key of [...this.#resources.keys()]) this.releaseResource(key);
  }

  dispose(): void { this.#disposed = true; this.invalidate(); this.#set("disposed"); this.#listeners.clear(); }

  #deadline<T>(promise: Promise<T>, timeout: number, message: string): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const cancel = () => { clearTimeout(timer); this.#deadlines.delete(cancel); reject(new Error("The view changed.")); };
      const timer = setTimeout(() => { this.#deadlines.delete(cancel); reject(new Error(message)); }, timeout);
      this.#deadlines.add(cancel);
      void promise.then(value => { clearTimeout(timer); this.#deadlines.delete(cancel); resolve(value); }, error => { clearTimeout(timer); this.#deadlines.delete(cancel); reject(error); });
    });
  }

  async begin<Snapshot>(scope: string, callbacks: ViewRestorationCallbacks<Snapshot>, domainIdentity=scope): Promise<boolean> {
    if (this.#disposed) return false;
    const changed = this.#scope !== scope;
    this.invalidate();
    const generation = this.#generation;
    this.#scope = scope;
    this.#domainIdentity=domainIdentity;
    if (changed) { this.#completed = false; this.#persistence = "clean"; this.#stores.clear(); }
    this.#refresh = "idle";
    this.#requests.clear();
    this.#startedAt = this.#now();
    this.#snapshotCompletedAt = undefined;
    this.#verificationCompletedAt = undefined;
    this.#mark(generation, "snapshot-start");
    this.#set("loading_snapshot");
    const fence = this.#fence(generation, scope);
    try {
      const snapshot = await this.#deadline(callbacks.snapshot(fence), this.#snapshotTimeoutMs, "The saved view snapshot took too long to load.");
      if (!fence.current()) return false;
      if (snapshot === null || snapshot === undefined) throw new Error("The saved view snapshot is unavailable.");
      await callbacks.display(snapshot, fence);
      if (!fence.current()) return false;
      this.#snapshotCompletedAt = this.#now();
      this.#mark(generation, "snapshot-ready", this.#startedAt);
      // A cached read-only projection is still unverified domain state.
      this.#set("verifying");
      // Verification deliberately continues after the caller receives a
      // displayable snapshot. The shell uses the phase/ready identity gate to
      // keep every mutation disabled until this completes.
      void this.#verify(snapshot, callbacks, fence);
      return true;
    } catch (error: unknown) {
      if (!fence.current()) return false;
      const typed = error instanceof Error ? error : new Error("The saved view snapshot could not be loaded.");
      this.#snapshotCompletedAt = this.#now();
      this.#mark(generation, "snapshot-failed", this.#startedAt);
      this.#generation++; this.#requests.clear();
      this.#set("verification_failed", "snapshot");
      callbacks.failed("snapshot", typed, fence);
      return false;
    }
  }

  async #verify<Snapshot>(snapshot: Snapshot, callbacks: ViewRestorationCallbacks<Snapshot>, fence: RestorationScopeFence): Promise<void> {
    try {
      const phase = await this.#deadline(callbacks.verify(snapshot, fence), this.#verificationTimeoutMs, "Saved-view verification took too long.");
      if (fence.current()) {
        this.#verificationCompletedAt = this.#now();
        this.#mark(fence.generation, "verification-ready", this.#snapshotCompletedAt);
        if (phase === "read_only") this.#completed = true;
        this.#set(phase);
        callbacks.ready?.();
      }
    } catch (error: unknown) {
      if (!fence.current()) return;
      const typed = error instanceof Error ? error : new Error("The saved view could not be verified.");
      this.#verificationCompletedAt = this.#now();
      this.#mark(fence.generation, "verification-failed", this.#snapshotCompletedAt);
      this.#generation++; this.#requests.clear();
      this.#set("verification_failed", "verification");
      callbacks.failed("verification", typed, fence);
    }
  }

  #fence(generation: number, scope: string): RestorationScopeFence {
    const domainIdentity=this.#domainIdentity;
    const current = (): boolean => !this.#disposed && this.#generation === generation && this.#scope === scope && this.#domainIdentity===domainIdentity;
    return {
      generation,
      scope,
      current,
      request: (operation: string): RestorationRequestFence => {
        const request = (this.#requests.get(operation) ?? 0) + 1;
        this.#requests.set(operation, request);
        return { generation, scope, domainIdentity, operation, request };
      },
      currentRequest: (request: RestorationRequestFence): boolean => current() &&
        request.generation === generation && request.scope === scope && request.domainIdentity===domainIdentity && this.#requests.get(request.operation) === request.request,
    };
  }

  #set(phase: ViewRestorationPhase, failedSection?: string): void {
    this.#phase = phase;
    this.#failedSection = failedSection;
    this.#emit();
  }

  #emit(): void { const state = this.state; this.#onPhase(state); for (const listener of this.#listeners) listener(state); }

  #now(): number {
    return typeof performance !== "undefined" && typeof performance.now === "function" ? performance.now() : Date.now();
  }

  /**
   * Keep a correlation-free browser performance trace. The generation is local
   * to this iframe and never contains an account, run, request, or view ID.
   */
  #mark(generation: number, stage: string, startedAt?: number): void {
    if (typeof performance === "undefined" || typeof performance.mark !== "function") return;
    const name = `loomex.restore.${generation}.${stage}`;
    performance.mark(name);
    if (startedAt !== undefined && typeof performance.measure === "function") {
      performance.measure(`${name}.duration`, { start: startedAt, end: performance.now() });
    }
  }
}

export interface PersistenceError extends Error {
  readonly code?: string;
  readonly retryable?: boolean;
  readonly correlationId?: string;
}

export interface ViewPersistenceOptions<State extends JsonObject = JsonObject> {
  readonly read: (viewSessionId: string) => Promise<ViewSessionProjection<State> | null | undefined>;
  /**
   * Optional low-latency owner-checked snapshot reader for a reopen. It is
   * display-only: callers must still use `hydrate` before enabling mutation.
   */
  readonly restore?: (viewSessionId: string) => Promise<ViewSessionProjection<State> | null | undefined>;
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
  readonly #restore: NonNullable<ViewPersistenceOptions<State>["restore"]>;
  readonly #write: ViewPersistenceOptions<State>["write"];
  readonly #onStatus: NonNullable<ViewPersistenceOptions<State>["onStatus"]>;
  readonly #snapshot: NonNullable<ViewPersistenceOptions<State>["snapshot"]>;
  readonly #debounceMs: number;
  #timer: ReturnType<typeof setTimeout> | undefined;
  #writePromise: Promise<boolean> | undefined;
  #hydrationToken = 0;
  #sessionEpoch = 0;
  /** Last server-acknowledged presentation projection. Kept only to avoid
   * re-writing an unchanged card immediately before an authoritative action. */
  #savedState: State | undefined;
  #savedStatus: string | undefined;

  session: ViewSessionIdentity | null = null;
  pendingState: State | undefined;
  pendingOptions: PersistenceWriteOptions | undefined;
  changeVersion = 0;
  savedVersion = 0;
  attempt: SaveAttempt<State> | null = null;
  conflict: PresentationConflictError | null = null;

  constructor(options: ViewPersistenceOptions<State>) {
    this.#read = options.read;
    this.#restore = options.restore ?? options.read;
    this.#write = options.write;
    this.#onStatus = options.onStatus ?? (() => undefined);
    this.#snapshot = options.snapshot ?? (() => undefined);
    this.#debounceMs = options.debounceMs ?? 350;
  }

  dirty(): boolean {
    return this.changeVersion > this.savedVersion || this.attempt !== null || this.#writePromise !== undefined;
  }

  configure(session: ViewSessionIdentity | ViewSessionProjection<State>): boolean {
    if (!validIdentity(session)) return false;
    const changed = this.session?.viewSessionId !== session.viewSessionId;
    if (changed) {
      this.session = { viewSessionId: session.viewSessionId, revision: session.revision };
      this.#resetLocalState();
      this.#rememberProjection(session);
    } else if (this.session !== null && session.revision > this.session.revision) {
      if (this.dirty()) this.#reportConflict();
      else {
        this.session = { viewSessionId: this.session.viewSessionId, revision: session.revision };
        this.#rememberProjection(session);
      }
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
    this.#savedState = undefined;
    this.#savedStatus = undefined;
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
      if (!this.dirty()) this.#rememberProjection(projection);
      this.#onStatus(this.conflict !== null || this.attempt !== null ? "save_failed" : this.dirty() ? "dirty" : "saved",
        this.conflict ?? this.attempt?.error);
      return clone(projection);
    } catch (error: unknown) {
      if (token === this.#hydrationToken) this.#onStatus("load_failed", persistenceError(error));
      return null;
    }
  }

  /**
   * Gets a display-safe saved snapshot without reconciling revision, pending
   * writes, or mutation authority. `hydrate()` remains the authoritative read.
   */
  async restoreSnapshot(): Promise<ViewSessionProjection<State> | null> {
    if (this.session === null) return null;
    const id = this.session.viewSessionId;
    const epoch = this.#sessionEpoch;
    try {
      const projection = await this.#restore(id);
      if (this.session?.viewSessionId !== id || this.#sessionEpoch !== epoch) return null;
      if (!validProjection(projection, id) || projection.revision < this.session.revision) {
        throw new Error("The saved view snapshot could not be verified.");
      }
      return clone(projection);
    } catch (error: unknown) {
      if (this.session?.viewSessionId === id && this.#sessionEpoch === epoch) this.#onStatus("load_failed", persistenceError(error));
      return null;
    }
  }

  markDirty(state: State): void {
    if (this.session === null) return;
    // Input/change handlers can report the same DOM state more than once.
    // Treat an already acknowledged value as a no-op instead of manufacturing
    // a revision race with an upcoming response mutation.
    if (!this.dirty() && this.#savedState !== undefined && equal(state, this.#savedState)) {
      this.#onStatus("saved");
      return;
    }
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
      if (!this.#sameTarget(copiedState, copiedOptions)) {
        this.pendingState = copiedState;
        this.pendingOptions = copiedOptions;
        this.changeVersion += 1;
      }
    }
    this.#clearTimer();
    if (this.conflict !== null) {
      this.#onStatus("save_failed", this.conflict);
      return false;
    }
    if (this.#writePromise !== undefined) return this.#writePromise;
    if (this.savedVersion === this.changeVersion) {
      this.#onStatus("saved");
      return true;
    }
    const id = this.session.viewSessionId;
    const epoch = this.#sessionEpoch;
    const current = (): boolean => this.session?.viewSessionId === id && this.#sessionEpoch === epoch;
    this.#onStatus("saving");
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
      this.#rememberProjection(projection);
      this.#onStatus("saved");
      return clone(projection);
    } catch (error: unknown) {
      this.#onStatus("load_failed", persistenceError(error));
      return null;
    }
  }

  /** Explicit conflict resolution; never drops or replaces an ambiguous attempt. */
  async reapplyLocal(merge:(saved:State,local:State)=>State):Promise<boolean> {
    if(!this.session || !this.conflict || !this.pendingState) return false;
    this.#clearTimer();
    if(this.#writePromise) await this.#writePromise;
    const id=this.session.viewSessionId, epoch=this.#sessionEpoch, version=this.changeVersion;
    try {
      const projection=await this.#read(id);
      if(this.#sessionEpoch!==epoch || this.session?.viewSessionId!==id || this.changeVersion!==version)return false;
      if(!validProjection(projection,id) || (projection.status!==undefined && projection.status!=="active") || !projection.state)throw new Error("Reload the current view before reapplying edits.");
      if(projection.operation && projection.operation.status!=="completed")throw new Error("Load the saved pending operation before reapplying edits.");
      const merged=merge(clone(projection.state),clone(this.pendingState));
      this.#setRevision(projection.revision);
      this.#rememberProjection(projection);
      this.attempt=null; this.conflict=null;
      this.pendingOptions=undefined;this.pendingState=merged; this.changeVersion++;
      return this.flush();
    } catch(error){this.#onStatus("save_failed",persistenceError(error));return false;}
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
        this.#rememberProjection(projection);
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
    this.#savedState = undefined;
    this.#savedStatus = undefined;
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

  /** Whether a requested save is already represented by the local durable target. */
  #sameTarget(state: State, options: PersistenceWriteOptions | undefined): boolean {
    if (this.dirty()) return this.#samePending(state, options);
    const requestedStatus = statusOption(options);
    return this.#savedState !== undefined && equal(state, this.#savedState) &&
      (requestedStatus === undefined || this.#savedStatus === requestedStatus);
  }

  #rememberProjection(projection: ViewSessionIdentity | ViewSessionProjection<State>): void {
    if (!isProjection(projection)) return;
    this.#savedState = clone(projection.state);
    this.#savedStatus = typeof projection.status === "string" ? projection.status : undefined;
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

function isProjection<State extends JsonObject>(value: ViewSessionIdentity | ViewSessionProjection<State>): value is ViewSessionProjection<State> & { state: State } {
  return "state" in value && value.state !== undefined;
}

function statusOption(options: PersistenceWriteOptions | undefined): string | undefined {
  return typeof options?.status === "string" ? options.status : undefined;
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
