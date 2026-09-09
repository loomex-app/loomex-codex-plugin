(() => {
  "use strict";
  const clone = (value) => value === undefined ? undefined : structuredClone(value);
  const equal = (left, right) => {
    if (Object.is(left, right)) return true;
    if (!left || !right || typeof left !== "object" || typeof right !== "object" || Array.isArray(left) !== Array.isArray(right)) return false;
    const keys = Object.keys(left).sort();
    const other = Object.keys(right).sort();
    return keys.length === other.length && keys.every((key, index) => key === other[index] && equal(left[key], right[key]));
  };
  const conflictCodes = new Set(["REVISION_CONFLICT", "PRESENTATION_SESSION_CONFLICT"]);
  const valid = (value, id) => value && value.viewSessionId === id && Number.isSafeInteger(value.revision) && value.revision >= 0;

  class ViewPersistenceController {
    constructor(options) {
      this.read = options.read;
      this.write = options.write;
      this.onStatus = options.onStatus || (() => {});
      this.snapshot = options.snapshot || (() => ({}));
      this.debounceMs = options.debounceMs ?? 350;
      this.session = null;
      this.pendingState = undefined;
      this.timer = null;
      this.writePromise = null;
      this.changeVersion = 0;
      this.savedVersion = 0;
      this.hydrationToken = 0;
      this.sessionEpoch = 0;
      this.attempt = null;
      this.conflict = null;
    }
    dirty() { return this.changeVersion > this.savedVersion || !!this.attempt || !!this.writePromise; }
    reportConflict() {
      this.conflict = Object.assign(new Error("This view changed elsewhere. Choose the saved version before continuing."), {code:"PRESENTATION_SESSION_CONFLICT"});
      clearTimeout(this.timer);
      this.timer = null;
      this.onStatus("save_failed", this.conflict);
    }
    configure(session) {
      if (!valid(session, session?.viewSessionId) || typeof session.viewSessionId !== "string") return false;
      const changed = this.session?.viewSessionId !== session.viewSessionId;
      if (changed) {
        this.session = {viewSessionId:session.viewSessionId, revision:session.revision};
        clearTimeout(this.timer);
        this.timer = null;
        this.pendingState = undefined;
        this.changeVersion = this.savedVersion = 0;
        this.hydrationToken += 1;
        this.sessionEpoch += 1;
        this.writePromise = null;
        this.attempt = this.conflict = null;
      } else if (session.revision > this.session.revision) {
        if (this.dirty()) this.reportConflict();
        else this.session.revision = session.revision;
      }
      return changed;
    }
    async hydrate() {
      if (!this.session) return null;
      const token = ++this.hydrationToken;
      const id = this.session.viewSessionId;
      try {
        const projection = await this.read(id);
        if (token !== this.hydrationToken || this.session?.viewSessionId !== id) return null;
        if (!valid(projection, id) || projection.revision < this.session.revision) throw new Error("The saved view state could not be verified.");
        const attempt = this.attempt;
        const landed = attempt && projection.revision > attempt.expectedRevision && equal(projection.state, attempt.state) &&
          (!attempt.options?.status || projection.status === attempt.options.status);
        if (landed) {
          this.session.revision = projection.revision;
          this.savedVersion = Math.max(this.savedVersion, attempt.version);
          this.attempt = this.conflict = null;
          if (this.savedVersion === this.changeVersion) this.pendingState = undefined;
        } else if (projection.revision !== this.session.revision && this.dirty()) {
          this.reportConflict();
          return null;
        } else if (!this.dirty()) this.session.revision = projection.revision;
        this.onStatus(this.conflict || this.attempt ? "save_failed" : this.dirty() ? "dirty" : "saved", this.conflict || this.attempt?.error);
        return clone(projection);
      } catch (error) {
        if (token === this.hydrationToken) this.onStatus("load_failed", error);
        return null;
      }
    }
    markDirty(state) {
      if (!this.session) return;
      this.pendingState = clone(state);
      this.changeVersion += 1;
      clearTimeout(this.timer);
      if (this.conflict) { this.onStatus("save_failed", this.conflict); return; }
      this.onStatus("dirty");
      this.timer = setTimeout(() => { void this.flush(); }, this.debounceMs);
    }
    async flush(state) {
      if (!this.session) return true;
      if (state !== undefined) { this.pendingState = clone(state); this.changeVersion += 1; }
      clearTimeout(this.timer);
      this.timer = null;
      if (this.conflict) { this.onStatus("save_failed", this.conflict); return false; }
      if (this.writePromise) return this.writePromise;
      const id = this.session.viewSessionId;
      const epoch = this.sessionEpoch;
      const current = () => this.session?.viewSessionId === id && this.sessionEpoch === epoch;
      const drain = async () => {
        while (current() && this.savedVersion !== this.changeVersion) {
          if (!this.attempt) this.attempt = {sessionId:id, expectedRevision:this.session.revision, state:clone(this.pendingState),
            idempotencyKey:crypto.randomUUID(), options:clone(this.snapshot()), version:this.changeVersion};
          const attempt = this.attempt;
          try {
            const projection = await this.write(id, attempt.expectedRevision, clone(attempt.state), attempt.idempotencyKey, clone(attempt.options));
            if (!valid(projection,id) || projection.revision <= attempt.expectedRevision) throw new Error("The saved view state could not be verified.");
            if (!current()) return false;
            this.session.revision = projection.revision;
            this.savedVersion = attempt.version;
            this.attempt = null;
            if (this.savedVersion === this.changeVersion) this.pendingState = undefined;
            this.onStatus(this.savedVersion === this.changeVersion ? "saved" : "dirty");
          } catch (error) {
            if (!current()) return false;
            if (this.attempt === attempt) attempt.error = error;
            if (conflictCodes.has(error?.code)) this.reportConflict();
            else this.onStatus("save_failed", error);
            return false;
          }
        }
        return current();
      };
      const task = drain();
      this.writePromise = task;
      try { return await task; }
      finally { if (this.writePromise === task) this.writePromise = null; }
    }
    async flushBefore(state, action) {
      if (!await this.flush(state)) return false;
      await action();
      return true;
    }
    async useSavedVersion() {
      if (!this.session) return null;
      clearTimeout(this.timer);
      this.timer = null;
      if (this.writePromise) await this.writePromise;
      const id = this.session.viewSessionId;
      const generation = this.changeVersion;
      const token = ++this.hydrationToken;
      try {
        const projection = await this.read(id);
        if (token !== this.hydrationToken || this.session?.viewSessionId !== id || this.changeVersion !== generation) return null;
        if (!valid(projection,id)) throw new Error("The saved view state could not be verified.");
        this.session.revision = projection.revision;
        this.attempt = this.conflict = null;
        this.pendingState = undefined;
        this.changeVersion = this.savedVersion = 0;
        this.onStatus("saved");
        return clone(projection);
      } catch (error) { this.onStatus("load_failed",error); return null; }
    }
  }
  globalThis.LoomexViewPersistence = Object.freeze({create(options) { return new ViewPersistenceController(options); }});
})();
