import { z } from "zod";
import { createHash } from "node:crypto";

import {
  REQUIRED_RUNNER_CAPABILITIES,
  TOOL_DEFINITIONS,
  type ToolDefinition,
} from "./tool-catalog.js";
import { UI_RESOURCE_REGISTRY } from "./ui-resources.js";

export const PLUGIN_COMPONENT_EXPORT_SCHEMA = "loomex.plugin-compatibility-components/v1";

type JsonRecord = Record<string, unknown>;

export interface RunnerCatalogMethod {
  readonly name: string;
  readonly inputSchema: {
    readonly properties: Record<string, unknown>;
    readonly required?: readonly string[];
  };
  readonly outputSchema: unknown;
}

export interface PackagedSkill {
  readonly path: string;
  readonly source: string;
}

export interface PackagedPluginLayout {
  readonly manifest: unknown;
  readonly hooks: unknown;
  readonly files: readonly string[];
  readonly skills: readonly PackagedSkill[];
}

export interface PluginCompatibilityComponents {
  readonly schemaVersion: typeof PLUGIN_COMPONENT_EXPORT_SCHEMA;
  readonly plugin: { readonly name: string; readonly version: string; readonly mcpNamespace: "loomex" };
  readonly tools: readonly JsonRecord[];
  readonly resources: readonly JsonRecord[];
  readonly requiredRunnerCapabilities: readonly string[];
  readonly skills: readonly JsonRecord[];
  readonly hooks: readonly JsonRecord[];
}

function fail(message: string): never {
  throw new Error(`Plugin compatibility contract: ${message}`);
}

function sortedUnique(values: readonly string[], label: string): readonly string[] {
  const sorted = [...values].sort();
  if (new Set(sorted).size !== sorted.length) fail(`${label} contains a duplicate`);
  return Object.freeze(sorted);
}

/** Recursively order evaluated Zod JSON Schema output for byte-stable exports. */
function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value === null || typeof value !== "object") return value;
  return Object.fromEntries(Object.entries(value as JsonRecord)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, child]) => [key, canonical(child)]));
}

function schemaFor(definition: ToolDefinition): { properties: Record<string, unknown>; required: readonly string[]; schema: unknown } {
  const schema = canonical(z.toJSONSchema(definition.inputSchema)) as JsonRecord;
  const properties = schema.properties;
  if (properties === null || typeof properties !== "object" || Array.isArray(properties)) {
    fail(`${definition.name} does not evaluate to an object input schema`);
  }
  const required = schema.required === undefined
    ? []
    : Array.isArray(schema.required) && schema.required.every((item) => typeof item === "string")
      ? schema.required as string[]
      : fail(`${definition.name} has a malformed evaluated required list`);
  return { properties: properties as Record<string, unknown>, required: sortedUnique(required, `${definition.name} required fields`), schema };
}

function schemaRecord(value: unknown, label: string): JsonRecord {
  if (value === null || typeof value !== "object" || Array.isArray(value)) fail(`${label} is not a JSON Schema object`);
  return value as JsonRecord;
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function numberValue(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function valuesFor(schema: JsonRecord): readonly unknown[] | undefined {
  if (Object.hasOwn(schema, "const")) return [schema.const];
  if (Array.isArray(schema.enum)) return schema.enum;
  return undefined;
}

function schemaVariants(schema: JsonRecord): readonly JsonRecord[] {
  if (!Array.isArray(schema.anyOf)) return [schema];
  return schema.anyOf.map((variant, index) => schemaRecord(variant, `schema anyOf[${index}]`));
}

function schemaTypes(schema: JsonRecord): readonly string[] | undefined {
  if (typeof schema.type === "string") return [schema.type];
  if (Array.isArray(schema.type) && schema.type.every((value) => typeof value === "string")) return schema.type as string[];
  return undefined;
}

function appliesTo(types: readonly string[] | undefined, type: string): boolean {
  return types === undefined || types.includes(type) || (type === "number" && types.includes("integer"));
}

/**
 * A public Zod field may deliberately be narrower than the runner's broad
 * transport field (UUIDs, absolute paths, JSON values). It must never accept a
 * value rejected by a constraint the runner publishes. This comparison keeps
 * those adapter refinements while fencing enum, type, format, and bounds drift.
 */
function assertFieldSchemaCompatible(publicSchema: unknown, runnerSchema: unknown, label: string): void {
  const publicField = schemaRecord(publicSchema, `${label} public schema`);
  const runnerField = schemaRecord(runnerSchema, `${label} runner schema`);
  const runnerTypes = schemaTypes(runnerField);
  for (const publicVariant of schemaVariants(publicField)) {
    const publicTypes = schemaTypes(publicVariant);
    if (runnerTypes !== undefined && (publicTypes === undefined || publicTypes.some((type) => !runnerTypes.includes(type)))) {
      fail(`${label} input schema type is incompatible with runner type`);
    }
    const runnerFormat = stringValue(runnerField.format);
    if (runnerFormat !== undefined && appliesTo(publicTypes, "string") && stringValue(publicVariant.format) !== runnerFormat) {
      fail(`${label} input schema format is incompatible with runner format ${runnerFormat}`);
    }
    const runnerValues = valuesFor(runnerField);
    if (runnerValues !== undefined) {
      const publicValues = valuesFor(publicVariant);
      if (publicValues === undefined || publicValues.some((value) => !runnerValues.some((candidate) => JSON.stringify(candidate) === JSON.stringify(value)))) {
        fail(`${label} input schema accepts values outside the runner enum`);
      }
    }
    const runnerPattern = stringValue(runnerField.pattern);
    if (runnerPattern !== undefined && appliesTo(publicTypes, "string") && stringValue(publicVariant.pattern) !== runnerPattern) {
      fail(`${label} input schema pattern is incompatible with the runner pattern`);
    }
    for (const [minimum, maximum, type] of [["minimum", "maximum", "number"], ["minLength", "maxLength", "string"], ["minItems", "maxItems", "array"]] as const) {
      if (!appliesTo(publicTypes, type)) continue;
      const runnerMinimum = numberValue(runnerField[minimum]);
      const publicMinimum = numberValue(publicVariant[minimum]);
      if (runnerMinimum !== undefined && (publicMinimum === undefined || publicMinimum < runnerMinimum)) {
        fail(`${label} input schema ${minimum} is less restrictive than the runner`);
      }
      const runnerMaximum = numberValue(runnerField[maximum]);
      const publicMaximum = numberValue(publicVariant[maximum]);
      if (runnerMaximum !== undefined && (publicMaximum === undefined || publicMaximum > runnerMaximum)) {
        fail(`${label} input schema ${maximum} is less restrictive than the runner`);
      }
    }
  }
}

function toolComponent(definition: ToolDefinition, runnerOutputSchemaSha256?: string): JsonRecord {
  const evaluated = schemaFor(definition);
  const inputKeys = Object.keys(evaluated.properties);
  const localOnly = sortedUnique(definition.localOnlyInputKeys ?? [], `${definition.name} local-only fields`);
  const omitted = sortedUnique(definition.omittedRunnerInputKeys ?? [], `${definition.name} omitted runner fields`);
  const aliases = Object.fromEntries(Object.entries(definition.runnerInputAliases ?? {}).sort(([left], [right]) => left.localeCompare(right)));

  for (const key of localOnly) {
    if (!Object.hasOwn(evaluated.properties, key)) fail(`${definition.name} local-only field ${key} is absent from its Zod schema`);
  }
  for (const key of Object.keys(aliases)) {
    if (!Object.hasOwn(evaluated.properties, key)) fail(`${definition.name} aliases unknown public field ${key}`);
    if (localOnly.includes(key)) fail(`${definition.name} aliases adapter-local field ${key}`);
  }
  if (new Set(Object.values(aliases)).size !== Object.values(aliases).length) {
    fail(`${definition.name} maps multiple public fields onto one runner field`);
  }
  for (const key of omitted) {
    if (inputKeys.includes(key) || Object.values(aliases).includes(key)) {
      fail(`${definition.name} both exposes and omits runner field ${key}`);
    }
  }

  const runnerInputKeys = inputKeys.filter((key) => !localOnly.includes(key)).map((key) => aliases[key] ?? key);
  return canonical({
    name: definition.name,
    rpcMethod: definition.rpcMethod,
    mutating: definition.mutating,
    destructive: definition.destructive,
    ...(definition.uiUri === undefined ? {} : { uiResourceUri: definition.uiUri }),
    inputSchema: evaluated.schema,
    localOnlyInputKeys: localOnly,
    runnerInputAliases: aliases,
    omittedRunnerInputKeys: omitted,
    runnerInputKeys: [...runnerInputKeys].sort(),
    ...(runnerOutputSchemaSha256 === undefined ? {} : { runnerOutputSchemaSha256 }),
  }) as JsonRecord;
}

/** SHA-256 of runner wire-canonical outputSchema JSON, before MCP projection. */
export function runnerOutputSchemaDigest(outputSchema: unknown): string {
  if (outputSchema === undefined) fail("runner method has no output schema");
  // Match the runner's digest() wire algorithm exactly: recursively sorted
  // compact JSON, UTF-8, and one terminal newline.
  const encoded = `${JSON.stringify(canonical(outputSchema))}\n`;
  if (encoded === "undefined\n") fail("runner method output schema is not JSON-serializable");
  return createHash("sha256").update(encoded, "utf8").digest("hex");
}

/**
 * Verify public tool-to-runner mappings against the vendored runner catalog.
 * This is intentionally data-driven so the same check works for a cached
 * package without importing runner source.
 */
export function validateToolMappings(methods: readonly RunnerCatalogMethod[]): void {
  const byMethod = new Map(methods.map((method) => [method.name, method]));
  if (byMethod.size !== methods.length) fail("runner catalog has duplicate method names");
  const toolNames = sortedUnique(TOOL_DEFINITIONS.map((definition) => definition.name), "tool names");
  void toolNames;
  for (const definition of TOOL_DEFINITIONS) {
    const component = toolComponent(definition);
    const method = byMethod.get(definition.rpcMethod);
    if (method === undefined) fail(`${definition.name} maps to unknown runner method ${definition.rpcMethod}`);
    runnerOutputSchemaDigest(method.outputSchema);
    const expectedProperties = Object.keys(method.inputSchema.properties).filter((key) => !((component.omittedRunnerInputKeys as string[]).includes(key))).sort();
    const expectedRequired = [...(method.inputSchema.required ?? [])].filter((key) => !((component.omittedRunnerInputKeys as string[]).includes(key))).sort();
    if (JSON.stringify(component.runnerInputKeys) !== JSON.stringify(expectedProperties)) {
      fail(`${definition.name} runner input mapping differs from ${definition.rpcMethod}`);
    }
    const evaluated = schemaFor(definition);
    const localOnly = new Set(component.localOnlyInputKeys as string[]);
    const aliases = component.runnerInputAliases as Record<string, string>;
    const runnerRequired = evaluated.required.filter((key) => !localOnly.has(key)).map((key) => aliases[key] ?? key).sort();
    if (JSON.stringify(runnerRequired) !== JSON.stringify(expectedRequired)) {
      fail(`${definition.name} runner required mapping differs from ${definition.rpcMethod}`);
    }
    for (const [publicKey, publicSchema] of Object.entries(evaluated.properties)) {
      if (localOnly.has(publicKey)) continue;
      const runnerKey = aliases[publicKey] ?? publicKey;
      if ((component.omittedRunnerInputKeys as string[]).includes(runnerKey)) continue;
      const runnerSchema = method.inputSchema.properties[runnerKey];
      if (runnerSchema === undefined) fail(`${definition.name} maps ${publicKey} to missing runner field ${runnerKey}`);
      assertFieldSchemaCompatible(publicSchema, runnerSchema, `${definition.name}.${publicKey} → ${definition.rpcMethod}.${runnerKey}`);
    }
  }
  const methodCapabilities = new Set(REQUIRED_RUNNER_CAPABILITIES.filter((capability) => capability.startsWith("method:")));
  const expectedMethodCapabilities = new Set(TOOL_DEFINITIONS.map((definition) => `method:${definition.rpcMethod}`));
  if (methodCapabilities.size !== expectedMethodCapabilities.size ||
      [...methodCapabilities].some((capability) => !expectedMethodCapabilities.has(capability))) {
    fail("runner method capabilities differ from the public tool mapping");
  }
  for (const definition of TOOL_DEFINITIONS) {
    if (!methodCapabilities.has(`method:${definition.rpcMethod}`)) fail(`${definition.name} lacks a required runner method capability`);
  }
}

export function validateUiResourceRegistry(): void {
  const names = sortedUnique(UI_RESOURCE_REGISTRY.map((resource) => resource.name), "UI resource names");
  const uris = sortedUnique(UI_RESOURCE_REGISTRY.map((resource) => resource.uri), "UI resource URIs");
  const modes = sortedUnique(UI_RESOURCE_REGISTRY.map((resource) => resource.mode), "UI resource modes");
  void names; void uris; void modes;
  const allIdentities = new Set<string>();
  for (const resource of UI_RESOURCE_REGISTRY) {
    if (!/^ui:\/\/loomex\/[a-z]+\.html$/.test(resource.uri)) fail(`invalid canonical resource URI ${resource.uri}`);
    if (!allIdentities.add(resource.uri)) fail(`duplicate UI resource identity ${resource.uri}`);
    for (const alias of resource.aliases) {
      if (alias.deprecated !== true || alias.replacementUri !== resource.uri) fail(`invalid alias declaration for ${alias.uri}`);
      if (!/^ui:\/\/loomex\/[a-z]+-0\.2\.[3-7]\.html$/.test(alias.uri)) fail(`invalid legacy resource URI ${alias.uri}`);
      if (!alias.uri.startsWith(`ui://loomex/${resource.mode}-`)) fail(`legacy resource URI has the wrong view ${alias.uri}`);
      if (!allIdentities.add(alias.uri)) fail(`duplicate UI resource identity ${alias.uri}`);
    }
  }
  for (const definition of TOOL_DEFINITIONS) {
    if (definition.uiUri !== undefined && !UI_RESOURCE_REGISTRY.some((resource) => resource.uri === definition.uiUri)) {
      fail(`${definition.name} references an unregistered UI resource ${definition.uiUri}`);
    }
  }
}

function object(value: unknown, label: string): JsonRecord {
  if (value === null || typeof value !== "object" || Array.isArray(value)) fail(`${label} must be an object`);
  return value as JsonRecord;
}

/** Validate package-local skill references and the hook entrypoint declared by the plugin. */
export function validateSkillAndHookReferences(layout: PackagedPluginLayout): { skills: readonly JsonRecord[]; hooks: readonly JsonRecord[] } {
  const manifest = object(layout.manifest, "plugin manifest");
  if (manifest.skills !== "./skills/" || manifest.hooks !== "./hooks/hooks.json") fail("plugin manifest must declare packaged skills and hooks");
  const files = new Set(layout.files);
  if (!files.has("hooks/lifecycle-adapter.mjs")) fail("lifecycle hook adapter is not packaged");
  const tools = new Set(TOOL_DEFINITIONS.map((definition) => definition.name));
  const skills: JsonRecord[] = [];
  for (const skill of [...layout.skills].sort((left, right) => left.path.localeCompare(right.path))) {
    const referenced = skill.source.match(/\bloomex_[a-z0-9_]+\b/g) ?? [];
    for (const tool of referenced) if (!tools.has(tool)) fail(`${skill.path} references unknown tool ${tool}`);
    if (!/^skills\/loomex-[a-z0-9-]+\/SKILL\.md$/.test(skill.path)) continue;
    const name = skill.path.split("/")[1];
    if (name === undefined || !skill.source.startsWith("---\n") || !new RegExp(`(?:^|\\n)name:\\s*${name}(?:\\s|$)`).test(skill.source)) {
      fail(`${skill.path} does not declare its package name`);
    }
    skills.push({ name, path: skill.path, referencedTools: Object.freeze([...new Set(referenced)].sort()) });
  }
  if (skills.length === 0) fail("no packaged SKILL.md files found");

  const hooksRoot = object(layout.hooks, "hooks manifest");
  const hookGroups = object(hooksRoot.hooks, "hooks manifest hooks");
  const expectedHooks: Readonly<Record<string, number>> = {
    Interrupt: 3,
    PostToolUse: 10,
    SessionStart: 10,
    Stop: 10,
    UserPromptSubmit: 10,
  };
  if (JSON.stringify(Object.keys(hookGroups).sort()) !== JSON.stringify(Object.keys(expectedHooks).sort())) {
    fail("hooks manifest has an unexpected event set");
  }
  const hooks: JsonRecord[] = [];
  for (const [event, groups] of Object.entries(hookGroups).sort(([left], [right]) => left.localeCompare(right))) {
    if (!Array.isArray(groups) || groups.length !== 1) fail(`hook ${event} must have exactly one group`);
    const group = object(groups[0], `hook ${event}`);
    const entries = group.hooks;
    if (!Array.isArray(entries) || entries.length !== 1) fail(`hook ${event} must have exactly one command`);
    const entry = object(entries[0], `hook ${event} command`);
    if (entry.type !== "command" || typeof entry.command !== "string" || !entry.command.includes("$PLUGIN_ROOT/hooks/lifecycle-adapter.mjs")) {
      fail(`hook ${event} does not reference the packaged lifecycle adapter`);
    }
    if (typeof entry.timeout !== "number" || !Number.isFinite(entry.timeout) || entry.timeout !== expectedHooks[event]) fail(`hook ${event} has an invalid timeout`);
    hooks.push({ event, adapter: "hooks/lifecycle-adapter.mjs", timeoutSeconds: entry.timeout });
  }
  return { skills: Object.freeze(skills), hooks: Object.freeze(hooks) };
}

export function createPluginCompatibilityComponents(
  plugin: { readonly name: string; readonly version: string },
  layout: PackagedPluginLayout,
  methods: readonly RunnerCatalogMethod[],
): PluginCompatibilityComponents {
  if (plugin.name !== "@loomex/codex-plugin") fail("unexpected package name");
  if (!/^\d+\.\d+\.\d+$/.test(plugin.version)) fail("package version must be SemVer");
  validateUiResourceRegistry();
  validateToolMappings(methods);
  const packageReferences = validateSkillAndHookReferences(layout);
  const methodsByName = new Map(methods.map((method) => [method.name, method]));
  const tools = TOOL_DEFINITIONS.map((definition) => {
    const method = methodsByName.get(definition.rpcMethod);
    if (method === undefined) fail(`${definition.name} maps to unknown runner method ${definition.rpcMethod}`);
    return toolComponent(definition, runnerOutputSchemaDigest(method.outputSchema));
  }).sort((left, right) => String(left.name).localeCompare(String(right.name)));
  const resources = UI_RESOURCE_REGISTRY.map((resource) => canonical({
    name: resource.name,
    uri: resource.uri,
    mode: resource.mode,
    aliases: resource.aliases,
  }) as JsonRecord).sort((left, right) => String(left.uri).localeCompare(String(right.uri)));
  return canonical({
    schemaVersion: PLUGIN_COMPONENT_EXPORT_SCHEMA,
    plugin: { name: plugin.name, version: plugin.version, mcpNamespace: "loomex" },
    tools,
    resources,
    requiredRunnerCapabilities: sortedUnique(REQUIRED_RUNNER_CAPABILITIES, "required runner capabilities"),
    skills: packageReferences.skills,
    hooks: packageReferences.hooks,
  }) as PluginCompatibilityComponents;
}
