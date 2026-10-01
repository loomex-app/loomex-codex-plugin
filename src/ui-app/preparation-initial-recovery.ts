import type { UiData } from "./page-models.js";

type ObjectValue = Record<string, unknown>;

function object(value: unknown): ObjectValue | null {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as ObjectValue : null;
}

function uuid(value: unknown): value is string {
  return typeof value === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}

const bindingFields = ["workflowId", "versionId", "organizationId", "workspacePath", "executionPolicy"] as const;

export interface InitialPreparationIdentity {
  readonly preparationId: string;
  readonly bindingDigest: string;
  readonly binding: Readonly<Record<(typeof bindingFields)[number], string>>;
  readonly viewSessionId?: string;
}

/** The compact model result is a lookup key, never a review or approval. */
export function initialPreparationIdentity(value: UiData): InitialPreparationIdentity | null {
  const binding = object(value.binding);
  if (value.status !== "valid" || value.operation !== "runs.prepare" ||
      !uuid(value.preparationId) ||
      typeof value.bindingDigest !== "string" || !/^[0-9a-f]{64}$/.test(value.bindingDigest) || !binding ||
      !uuid(binding.workflowId) || !uuid(binding.versionId) || !uuid(binding.organizationId) ||
      typeof binding.workspacePath !== "string" || !binding.workspacePath.startsWith("/") ||
      binding.executionPolicy !== "host_user/v1" ||
      (value.viewSessionId !== undefined && !uuid(value.viewSessionId))) return null;
  return {
    preparationId: value.preparationId,
    bindingDigest: value.bindingDigest,
    binding: Object.fromEntries(bindingFields.map((field) => [field, binding[field]])) as Record<(typeof bindingFields)[number], string>,
    ...(uuid(value.viewSessionId) ? { viewSessionId: value.viewSessionId } : {}),
  };
}

/** An exact owner-checked read may restore only the original reviewed binding. */
export function verifyInitialPreparationRead(identity: InitialPreparationIdentity, value: UiData): UiData {
  if (value.operation !== "runs.prepare" || value.status !== "valid") {
    if (value.operation === "runs.prepare" && value.status === "stale" && value.preparationId === identity.preparationId) {
      throw new Error(value.reason === "commit_started"
        ? "This preparation has already moved past Start. Refresh its run from Loomex."
        : "This preparation is no longer current. Review a fresh run preparation.");
    }
    throw new Error("The original run preparation could not be verified.");
  }
  const prepared = object(value.preparation);
  const binding = object(prepared?.binding);
  if (!prepared || prepared.preparationId !== identity.preparationId ||
      prepared.bindingDigest !== identity.bindingDigest || !uuid(prepared.confirmationKey) ||
      !binding || bindingFields.some((field) => binding[field] !== identity.binding[field]) ||
      !uuid(binding.installationId) ||
      !object(binding.inputs) || !object(binding.providerConfiguration)) {
    throw new Error("The restored run preparation does not match the reviewed result.");
  }
  return prepared as UiData;
}

export function preparationSessionMatches(value: unknown, preparationId: string): boolean {
  const session = object(value);
  return session !== null && uuid(session.viewSessionId) &&
    session.kind === "prepare" && session.entityType === "preparation" &&
    session.entityId === preparationId &&
    (session.status === undefined || session.status === "active" || session.status === "inactive" || session.status === "resolved");
}
