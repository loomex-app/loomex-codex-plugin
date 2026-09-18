/**
 * Transport timing is kept separate from request payloads.  In particular,
 * diagnostics must not retain or expose a user's prompt or tool arguments.
 */
export type TransportSlowDiagnostic = Readonly<{
  readonly stage: "slow";
  readonly operation: string;
  readonly elapsedMs: number;
}>;

export type TransportRequestOptions = Readonly<{
  /** Overrides the operation's timeout. */
  readonly timeoutMs?: number;
  /** Overrides the operation's slow-observation threshold. */
  readonly slowAfterMs?: number;
  /** A best-effort, one-time observation callback. Errors are ignored. */
  readonly onSlow?: (diagnostic: TransportSlowDiagnostic) => void;
}>;

export type ResolvedTransportRequestOptions = Readonly<{
  readonly timeoutMs: number;
  readonly slowAfterMs?: number;
  readonly onSlow?: (diagnostic: TransportSlowDiagnostic) => void;
}>;

export type TransportTimingPolicy = Readonly<{
  readonly timeoutMs: number;
  readonly slowAfterMs?: number;
}>;

export type TransportOperationPolicy = Readonly<{
  readonly default: TransportTimingPolicy;
  readonly operations: Readonly<Record<string, TransportTimingPolicy>>;
}>;

/** The bounded defaults used by the MCP Apps transport. */
export const DEFAULT_TRANSPORT_OPERATION_POLICY: TransportOperationPolicy = Object.freeze({
  default: Object.freeze({ timeoutMs: 5_000 }),
  operations: Object.freeze({
    "tools/call": Object.freeze({ timeoutMs: 60_000 }),
    "ui/message": Object.freeze({ timeoutMs: 120_000, slowAfterMs: 5_000 }),
  }),
});

/**
 * Resolves a request's timing from one central operation policy.  Callers can
 * provide a different policy for an embedded host or explicit per-request
 * timings for a deliberate exceptional case.
 */
export function resolveTransportRequestOptions(
  operation: string,
  options: TransportRequestOptions = {},
  policy: TransportOperationPolicy = DEFAULT_TRANSPORT_OPERATION_POLICY,
): ResolvedTransportRequestOptions {
  const timing = policy.operations[operation] ?? policy.default;
  const timeoutMs = options.timeoutMs ?? timing.timeoutMs;
  const slowAfterMs = options.slowAfterMs ?? timing.slowAfterMs;
  return {
    timeoutMs,
    ...(slowAfterMs === undefined ? {} : { slowAfterMs }),
    ...(options.onSlow === undefined ? {} : { onSlow: options.onSlow }),
  };
}
