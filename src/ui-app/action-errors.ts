/** Diagnostics contain fixed field names only, never answers or response bodies. */
export type PersistenceStage = "draft_read" | "draft_write" | "receipt_verification" | "presentation_write" | "operation_reconciliation";
export interface PersistenceDiagnostic {
  readonly stage: PersistenceStage;
  readonly code: string;
  readonly mismatches: Readonly<Record<string, boolean>>;
}
export function persistenceDiagnostic(stage: PersistenceStage, cause: Error, mismatches: Record<string, boolean> = {}): PersistenceDiagnostic {
  const code = "code" in cause ? cause.code : undefined;
  const known = ["HOST_TIMEOUT", "NETWORK_AMBIGUOUS", "RUNNER_UNAVAILABLE", "REVISION_CONFLICT", "INTERACTION_DRAFT_CONFLICT", "CONFLICT", "RECEIPT_MISMATCH", "VIEW_SESSION_NOT_FOUND", "INTERNAL"];
  return { stage, code: typeof code === "string" && known.includes(code) ? code : "PERSISTENCE_UNAVAILABLE", mismatches };
}
export class PersistenceFailureError extends Error {
  readonly code: string;
  readonly diagnostic: PersistenceDiagnostic;
  constructor(message: string, stage: PersistenceStage, cause: Error, mismatches: Record<string, boolean> = {}) {
    super(message, { cause }); this.name = "PersistenceFailureError";
    this.diagnostic = persistenceDiagnostic(stage, cause, mismatches);
    this.code = this.diagnostic.code;
  }
}
export class PresentationPersistenceError extends Error {
  readonly code = "PRESENTATION_SAVE_FAILED" as const;
  readonly recovery = "save_then_retry" as const;
  readonly diagnostic: PersistenceDiagnostic;
  constructor(action: string, cause: Error, stage: PersistenceStage = "draft_write") {
    super(messageFor(action, stage), { cause }); this.name = "PresentationPersistenceError";
    this.diagnostic = cause instanceof PersistenceFailureError ? cause.diagnostic : persistenceDiagnostic(stage, cause);
  }
}
export function persistenceSaveError(action: string | undefined, cause: Error, stage: PersistenceStage = "draft_write"): PresentationPersistenceError {
  return new PresentationPersistenceError(action?.trim().toLowerCase() || "answers", cause, stage);
}
function messageFor(action: string, stage: PersistenceStage): string {
  if (action === "run preparation") return "The run preparation could not be saved. Save it before starting.";
  if (stage === "presentation_write") return "Your answers were saved, but this view could not be updated. Retry saving the view before submitting.";
  if (stage === "operation_reconciliation") return "The previous submission could not be verified. Check its outcome before submitting again.";
  return "Your answers could not be saved. Save them before submitting.";
}
