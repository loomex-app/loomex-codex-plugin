import { z } from "zod";

const Counter = z.number().int().nonnegative();
export const FingerprintStageObservationSchema = z.object({
  operation: z.string().min(1).max(128),
  stage: z.enum(["credential", "queue", "hash", "backend", "review_enrichment", "presentation", "total"]),
  durationMicros: Counter, byteCount: Counter,
  provider: z.enum(["codex", "claude", "gemini", "antigravity", "none"]),
  correlationReference: z.uuid(),
  outcome: z.enum(["completed", "changed", "unavailable", "canceled", "unknown"]),
}).strict();
export const FingerprintDiagnosticsSchema = z.object({
  workerLimit: z.literal(2), activeWorkers: Counter, peakWorkers: Counter,
  started: Counter, shared: Counter, bytesHashed: Counter, queueMicros: Counter,
  hashMicros: Counter, unavailable: Counter, changed: Counter, canceled: Counter,
  inFlight: Counter, queued: Counter, completedCache: z.literal(false),
  stageObservations: z.array(FingerprintStageObservationSchema).max(128),
}).strict();
export const RunnerBuildDiagnosticsSchema = z.object({
  profile: z.enum(["dev", "distribution-dev", "release"]),
  optimizationLevel: z.enum(["0", "2", "3"]), debugAssertions: z.boolean(),
  classification: z.enum(["development", "production"]),
}).strict();
