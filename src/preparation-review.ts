import type { LocalControlCallOptions } from "./local-control.js";
import type { JsonValue, ToolOutput } from "./protocol.js";

export const PREPARATION_REVIEW_SCHEMA_VERSION = "loomex/preparation-review/v1" as const;

const PREPARATION_METHODS = new Set(["builder.prepare", "editor.prepare", "runs.prepare"]);
const LOOKUP_TIMEOUT_MS = 5_000;

export interface PreparationReviewProvider {
  readonly name: string;
  readonly model: string | null;
}

export interface PreparationReview {
  readonly schemaVersion: typeof PREPARATION_REVIEW_SCHEMA_VERSION;
  readonly preparationId: string;
  readonly bindingDigest: string;
  readonly workflowId: string;
  readonly versionId: string;
  readonly organizationId: string;
  readonly workflowName: string;
  readonly workflowVersion: number;
  readonly organizationName: string | null;
  readonly providers: readonly PreparationReviewProvider[] | null;
}

export interface PreparationReviewClient {
  call(
    method: string,
    params: Record<string, JsonValue>,
    options: LocalControlCallOptions,
  ): Promise<ToolOutput>;
}

export interface PreparationReviewBinding {
  readonly preparationId: string;
  readonly bindingDigest: string;
  readonly workflowId: string;
  readonly versionId: string;
  readonly organizationId: string;
  readonly providers: readonly PreparationReviewProvider[] | null;
  readonly closureWorkflowVersion: number | null;
}

interface ParsedClosureEntry {
  readonly identity: string;
  readonly workflowId: string;
  readonly versionId: string;
  readonly version: number;
  readonly targets: readonly string[];
}

interface ClosureProjection {
  readonly providers: readonly PreparationReviewProvider[];
  readonly rootVersion: number;
}

const AGENT_NODE_TYPES = new Set(["ai_agent", "ai_prompt", "person"]);
const SUBWORKFLOW_NODE_TYPES = new Set(["sub_workflow", "subworkflow"]);
const SHA256 = /^[a-f0-9]{64}$/;

function objectValue(value: JsonValue | undefined): Record<string, JsonValue> | undefined {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return undefined;
  return value;
}

function nonemptyString(value: JsonValue | undefined): string | undefined {
  return typeof value === "string" && value.trim() !== "" ? value : undefined;
}

function versionNumber(value: Record<string, JsonValue>): number | undefined {
  const candidates = [value.version, value.versionNumber].filter(
    (candidate): candidate is number =>
      typeof candidate === "number" && Number.isInteger(candidate) && candidate >= 0,
  );
  if (candidates.length === 0 || candidates.some((candidate) => candidate !== candidates[0])) {
    return undefined;
  }
  return candidates[0];
}

function exactVersion(
  data: Record<string, JsonValue>,
  binding: PreparationReviewBinding,
): Record<string, JsonValue> | undefined {
  const candidates: Record<string, JsonValue>[] = [];
  for (const field of [data.selectedVersion, data.activeVersion]) {
    const candidate = objectValue(field);
    if (candidate !== undefined) candidates.push(candidate);
  }
  if (Array.isArray(data.versions)) {
    for (const item of data.versions) {
      const candidate = objectValue(item);
      if (candidate !== undefined) candidates.push(candidate);
    }
  }
  return candidates.find(
    (candidate) =>
      nonemptyString(candidate.id) === binding.versionId &&
      nonemptyString(candidate.workflowId) === binding.workflowId,
  );
}

function exactWorkflowData(
  output: ToolOutput,
  binding: PreparationReviewBinding,
): Record<string, JsonValue> | undefined {
  if (!output.ok || output.method !== "workflows.get" || output.data === undefined) return undefined;
  const workflow = objectValue(output.data.workflow);
  if (
    workflow === undefined ||
    nonemptyString(workflow.id) !== binding.workflowId ||
    nonemptyString(workflow.organizationId) !== binding.organizationId
  ) {
    return undefined;
  }
  return output.data;
}

function positiveVersion(value: JsonValue | undefined): number | undefined {
  if (typeof value === "number") {
    return Number.isSafeInteger(value) && value > 0 ? value : undefined;
  }
  if (typeof value !== "string" || !/^v?[1-9][0-9]*$/.test(value.trim())) return undefined;
  const parsed = Number(value.trim().replace(/^v/, ""));
  return Number.isSafeInteger(parsed) ? parsed : undefined;
}

function subworkflowTarget(node: Record<string, JsonValue>): string | null | undefined {
  const type = nonemptyString(node.type);
  if (type === undefined || !SUBWORKFLOW_NODE_TYPES.has(type)) return null;
  const config = objectValue(node.config);
  if (config === undefined) return undefined;
  const workflowId = nonemptyString(config.workflowId) ?? nonemptyString(config.workflow_id);
  const version = positiveVersion(config.workflowVersion ?? config.workflow_version);
  if (workflowId === undefined || version === undefined) return undefined;
  return `${workflowId}\u0000${version}`;
}

function closureProjection(
  value: JsonValue | undefined,
  rootWorkflowId: string,
  rootVersionId: string,
): ClosureProjection | undefined {
  if (!Array.isArray(value) || value.length === 0) return undefined;
  const providers: PreparationReviewProvider[] = [];
  const seen = new Set<string>();
  const entries = new Map<string, ParsedClosureEntry>();
  const versionIds = new Set<string>();
  let root: ParsedClosureEntry | undefined;

  for (const entryValue of value) {
    const entry = objectValue(entryValue);
    const workflowId = nonemptyString(entry?.workflowId);
    const versionId = nonemptyString(entry?.workflowVersionId);
    const version = positiveVersion(entry?.version);
    const definitionDigest = nonemptyString(entry?.definitionDigest);
    const dependenciesDigest = nonemptyString(entry?.nodeDependenciesDigest);
    const dependencies = objectValue(entry?.nodeDependencies);
    if (
      entry === undefined ||
      workflowId === undefined ||
      versionId === undefined ||
      version === undefined ||
      definitionDigest === undefined ||
      !SHA256.test(definitionDigest) ||
      dependenciesDigest === undefined ||
      !SHA256.test(dependenciesDigest) ||
      dependencies === undefined
    ) {
      return undefined;
    }
    const identity = `${workflowId}\u0000${version}`;
    const versionIdentity = `${workflowId}\u0000${versionId}`;
    if (entries.has(identity) || versionIds.has(versionIdentity)) return undefined;

    const targets: string[] = [];
    for (const [dependencyKey, snapshotValue] of Object.entries(dependencies)) {
      if (dependencyKey.trim() === "") return undefined;
      const snapshot = objectValue(snapshotValue);
      const node = objectValue(snapshot?.node);
      const nodeType = nonemptyString(node?.type);
      if (
        snapshot === undefined ||
        node === undefined ||
        nodeType === undefined ||
        nonemptyString(node.key) !== dependencyKey
      ) {
        return undefined;
      }
      const target = subworkflowTarget(node);
      if (target === undefined) return undefined;
      if (target !== null) targets.push(target);
      if (!AGENT_NODE_TYPES.has(nodeType)) continue;
      const resolution = objectValue(snapshot.modelResolution);
      const name = nonemptyString(resolution?.provider);
      const model = nonemptyString(resolution?.runtimeModel);
      if (resolution === undefined || name === undefined || model === undefined) return undefined;
      const providerKey = `${name}\u0000${model}`;
      if (seen.has(providerKey)) continue;
      seen.add(providerKey);
      providers.push({ name, model });
    }

    const parsed = { identity, workflowId, versionId, version, targets };
    entries.set(identity, parsed);
    versionIds.add(versionIdentity);
    if (workflowId === rootWorkflowId && versionId === rootVersionId) {
      if (root !== undefined) return undefined;
      root = parsed;
    }
  }

  if (root === undefined) return undefined;
  const reachable = new Set<string>();
  const pending = [root.identity];
  while (pending.length > 0) {
    const identity = pending.pop();
    if (identity === undefined || reachable.has(identity)) continue;
    const entry = entries.get(identity);
    if (entry === undefined) return undefined;
    reachable.add(identity);
    pending.push(...entry.targets);
  }
  if (reachable.size !== entries.size) return undefined;
  return { providers, rootVersion: root.version };
}

function organizationName(output: ToolOutput, organizationId: string): string | null {
  if (!output.ok || output.method !== "organizations.list" || output.data === undefined) return null;
  const organizations = output.data.organizations;
  if (!Array.isArray(organizations)) return null;
  for (const item of organizations) {
    const organization = objectValue(item);
    if (organization === undefined || nonemptyString(organization.id) !== organizationId) continue;
    return nonemptyString(organization.name) ?? null;
  }
  return null;
}

function readOptions(signal: AbortSignal, deadline: number): LocalControlCallOptions {
  return {
    mutating: false,
    signal,
    timeoutMs: Math.max(1, deadline - Date.now()),
  };
}

export function preparationReviewBinding(
  method: string,
  output: ToolOutput,
): PreparationReviewBinding | undefined {
  if (!PREPARATION_METHODS.has(method) || !output.ok || output.method !== method) return undefined;
  const data = output.data;
  const binding = objectValue(data?.binding);
  const preparationId = nonemptyString(data?.preparationId);
  const bindingDigest = nonemptyString(data?.bindingDigest);
  const workflowId = nonemptyString(binding?.workflowId);
  const versionId = nonemptyString(binding?.versionId);
  const organizationId = nonemptyString(binding?.organizationId);
  if (
    preparationId === undefined ||
    bindingDigest === undefined ||
    workflowId === undefined ||
    versionId === undefined ||
    organizationId === undefined
  ) {
    return undefined;
  }
  const closure = closureProjection(binding?.workflowClosure, workflowId, versionId);
  return {
    preparationId,
    bindingDigest,
    workflowId,
    versionId,
    organizationId,
    providers: closure?.providers ?? null,
    closureWorkflowVersion: closure?.rootVersion ?? null,
  };
}

export async function buildPreparationReview(
  client: PreparationReviewClient,
  binding: PreparationReviewBinding,
  parentSignal?: AbortSignal,
): Promise<PreparationReview | undefined> {
  const deadline = Date.now() + LOOKUP_TIMEOUT_MS;
  const timeoutSignal = AbortSignal.timeout(LOOKUP_TIMEOUT_MS);
  const signal = parentSignal ? AbortSignal.any([parentSignal, timeoutSignal]) : timeoutSignal;

  const [workflowResult, organizationsResult] = await Promise.allSettled([
    client.call(
      "workflows.get",
      { workflowId: binding.workflowId },
      readOptions(signal, deadline),
    ),
    client.call("organizations.list", {}, readOptions(signal, deadline)),
  ]);
  if (workflowResult.status !== "fulfilled") return undefined;
  let workflowData = exactWorkflowData(workflowResult.value, binding);
  if (workflowData === undefined) return undefined;

  let version = exactVersion(workflowData, binding);
  let number = version === undefined ? undefined : versionNumber(version);
  if (version === undefined || number === undefined) return undefined;

  if (objectValue(version.definition) === undefined) {
    if (signal.aborted || Date.now() >= deadline) return undefined;
    let exactOutput: ToolOutput;
    try {
      exactOutput = await client.call(
        "workflows.get",
        { workflowId: binding.workflowId, version: String(number) },
        readOptions(signal, deadline),
      );
    } catch {
      return undefined;
    }
    workflowData = exactWorkflowData(exactOutput, binding);
    if (workflowData === undefined) return undefined;
    version = exactVersion(workflowData, binding);
    const exactNumber = version === undefined ? undefined : versionNumber(version);
    if (exactNumber !== number) return undefined;
    number = exactNumber;
  }

  if (binding.closureWorkflowVersion !== null && binding.closureWorkflowVersion !== number) {
    return undefined;
  }

  const workflow = objectValue(workflowData.workflow);
  const workflowName = nonemptyString(workflow?.name);
  if (workflowName === undefined) return undefined;
  return {
    schemaVersion: PREPARATION_REVIEW_SCHEMA_VERSION,
    preparationId: binding.preparationId,
    bindingDigest: binding.bindingDigest,
    workflowId: binding.workflowId,
    versionId: binding.versionId,
    organizationId: binding.organizationId,
    workflowName,
    workflowVersion: number,
    organizationName:
      organizationsResult.status === "fulfilled"
        ? organizationName(organizationsResult.value, binding.organizationId)
        : null,
    providers: binding.providers,
  };
}
