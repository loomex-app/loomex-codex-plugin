import { performance } from "node:perf_hooks";
import { z } from "zod";

const METHODS = [
  "builder.prepare", "editor.prepare", "runs.prepare", "workflows.list",
  "workflows.get", "runs.list", "runs.get", "interactions.get",
  "connection.get", "organizations.list", "personas.list", "builder.get",
] as const;
export const OperatorTimingSchema = z.object({
  schema: z.literal("loomex.plugin.operator-timing/v1"),
  stage: z.enum(["preparation_review", "presentation_persistence"]),
  method: z.enum(METHODS), durationMs: z.number().finite().nonnegative(),
  outcome: z.enum(["definitive_success", "definitive_failure", "unknown"]),
  correlationId: z.uuid().optional(),
}).strict();
export type OperatorTiming = z.infer<typeof OperatorTimingSchema>;

/** Opt-in stderr diagnostics: no payloads, prompts, answer values or card metadata. */
export async function timedOperatorStage<T>(options: {
  stage: OperatorTiming["stage"]; method: string; correlationId?: string;
  classify: (result: T) => OperatorTiming["outcome"];
  enabled?: boolean; sink?: (timing: OperatorTiming) => void; clock?: () => number;
}, action: () => Promise<T>): Promise<T> {
  if (!(options.enabled ?? process.env.LOOMEX_DIAGNOSTICS_TIMINGS === "1") ||
      !(METHODS as readonly string[]).includes(options.method)) return action();
  const clock = options.clock ?? (() => performance.now());
  let began: number;
  try { began = clock(); } catch { return action(); }
  let outcome: OperatorTiming["outcome"] = "unknown";
  try {
    const result = await action();
    try { outcome = options.classify(result); } catch { outcome = "unknown"; }
    return result;
  } catch (error) {
    outcome = "definitive_failure";
    throw error;
  } finally {
    // Observability is never a dependency of an accepted domain result.
    try {
      const timing = OperatorTimingSchema.parse({
        schema: "loomex.plugin.operator-timing/v1", stage: options.stage,
        method: options.method, durationMs: Math.max(0, clock() - began), outcome,
        ...(z.uuid().safeParse(options.correlationId).success
          ? { correlationId: options.correlationId } : {}),
      });
      (options.sink ?? (value => process.stderr.write(`${JSON.stringify(value)}\n`)))(timing);
    } catch { /* Preserve the original result/error. */ }
  }
}
