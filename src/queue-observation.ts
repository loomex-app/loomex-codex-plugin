/** Versioned, execution-bound queue evidence. Never render runner-supplied prose. */
export interface QueueObservation {
  schemaVersion: "loomex.workflow-queue-observation/v1";
  state: "queued";
  workerState: "starting" | "available" | "busy" | "unavailable" | "unknown";
  code: "WORKFLOW_QUEUED" | "WORKFLOW_WORKER_STARTING" | "WORKFLOW_WORKER_BUSY" | "WORKFLOW_WORKER_UNAVAILABLE" | "WORKFLOW_WORKER_OBSERVATION_UNKNOWN";
  queuedAt: string;
  waitSeconds: number;
  observedAt: string;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const ISO_TIME = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d{1,6})?(?:Z|[+-](\d{2}):(\d{2}))$/;
const WORKER_CODES: Readonly<Record<string, string>> = {
  available: "WORKFLOW_QUEUED", starting: "WORKFLOW_WORKER_STARTING", busy: "WORKFLOW_WORKER_BUSY",
  unavailable: "WORKFLOW_WORKER_UNAVAILABLE", unknown: "WORKFLOW_WORKER_OBSERVATION_UNKNOWN",
};
function record(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}
function isoTime(value: unknown): value is string {
  if (typeof value !== "string") return false;
  const parts = ISO_TIME.exec(value);
  if (!parts) return false;
  const [year, month, day, hour, minute, second, offsetHour, offsetMinute] = parts.slice(1).map(Number);
  const leapYear = year! % 4 === 0 && (year! % 100 !== 0 || year! % 400 === 0);
  const days = [31, leapYear ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  return month! >= 1 && month! <= 12 && day! >= 1 && day! <= days[month! - 1]! &&
    hour! < 24 && minute! < 60 && second! < 60 &&
    (parts[7] === undefined || (offsetHour! < 24 && offsetMinute! < 60)) && Number.isFinite(Date.parse(value));
}

export function queueObservation(value: unknown, execution: unknown): QueueObservation | undefined {
  const source = record(value);
  const run = record(execution);
  if (typeof run.id !== "string" || !UUID.test(run.id) || run.status !== "queued" ||
      source.executionId !== run.id || source.schemaVersion !== "loomex.workflow-queue-observation/v1" ||
      source.state !== "queued" || !["starting", "available", "busy", "unavailable", "unknown"].includes(String(source.workerState)) ||
      WORKER_CODES[String(source.workerState)] !== source.code ||
      typeof source.waitSeconds !== "number" || !Number.isSafeInteger(source.waitSeconds) || source.waitSeconds < 0 ||
      !isoTime(source.queuedAt) || !isoTime(source.observedAt) || Date.parse(source.observedAt) < Date.parse(source.queuedAt)) return undefined;
  return {
    schemaVersion: "loomex.workflow-queue-observation/v1", state: "queued",
    workerState: source.workerState as QueueObservation["workerState"],
    code: source.code as QueueObservation["code"], queuedAt: source.queuedAt,
    waitSeconds: source.waitSeconds, observedAt: source.observedAt,
  };
}

export const WORKFLOW_WORKER_UNAVAILABLE_MESSAGE = "This workflow is queued because the workflow worker is unavailable. Start or restore the workflow worker, then check this run again.";

export function queueLabel(observation: QueueObservation): string {
  if (observation.workerState === "unavailable") return "Queued · workflow worker unavailable";
  if (observation.workerState === "starting") return "Queued · workflow worker starting";
  if (observation.workerState === "busy") return "Queued · waiting for workflow worker capacity";
  return "Queued · waiting for workflow worker";
}
