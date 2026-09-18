import artifact from "../assets/ui-artifacts.json" with { type: "json" };
import packageMetadata from "../package.json" with { type: "json" };

/**
 * MCP Apps hosts may cache HTML by resource URI beyond the lifetime of an MCP
 * server process. A stable URI can therefore pair a newly installed server
 * with an old browser bundle. Derive the canonical URI from every asset that
 * forms the rendered document, so a UI change necessarily receives a fresh
 * host cache key. The release asset check owns these hashes.
 */
function digestPrefix(value: unknown): string {
  if (typeof value !== "string" || !/^[a-f0-9]{64}$/.test(value)) {
    throw new Error("Invalid packaged UI artifact digest");
  }
  return value.slice(0, 12);
}

function releaseVersion(value: unknown): string {
  if (typeof value !== "string" || !/^\d+\.\d+\.\d+(?:-[a-zA-Z0-9.-]+)?$/.test(value)) {
    throw new Error("Invalid plugin release version");
  }
  return value;
}

export const UI_RESOURCE_REVISION = [
  releaseVersion(packageMetadata.version),
  digestPrefix(artifact.templateSha256),
  digestPrefix(artifact.foundationSha256),
  digestPrefix(artifact.browserCodeSha256),
].join("-");

function uri(mode: string): string {
  return `ui://loomex/${mode}-${UI_RESOURCE_REVISION}.html`;
}

/**
 * The canonical UI resource inventory. Tool declarations and MCP resource
 * registration consume this registry, so the active UI identity cannot drift
 * from the installed browser assets.
 */
export const BROWSER_UI_URI = uri("browser");
export const RUNS_UI_URI = uri("runs");
export const AUTHORING_UI_URI = uri("authoring");
export const PREPARE_UI_URI = uri("prepare");
export const MONITOR_UI_URI = uri("monitor");
export const INTERACTION_UI_URI = uri("interaction");
export const CONNECTION_UI_URI = uri("connection");
export const ORGANIZATIONS_UI_URI = uri("organizations");

export type UiResourceMode =
  | "browser"
  | "runs"
  | "authoring"
  | "prepare"
  | "monitor"
  | "interaction"
  | "organizations"
  | "connection";

export interface UiResourceAlias {
  readonly uri: string;
  readonly deprecated: true;
  readonly replacementUri: string;
}

export interface UiResourceDefinition {
  readonly name: string;
  readonly uri: string;
  readonly mode: UiResourceMode;
  /** Historical resource identities retained only to restore already-open cards. */
  readonly aliases: readonly UiResourceAlias[];
}

const CACHED_RELEASES = ["0.2.3", "0.2.4", "0.2.5", "0.2.6", "0.2.7"] as const;

function aliases(mode: UiResourceMode, uri: string): readonly UiResourceAlias[] {
  // The unversioned identities were canonical through 0.14.11. Keep them as
  // explicit aliases so an already-open card can recover after an upgrade.
  // Browser entered the older compatibility template only at 0.2.7; the other
  // original views retain all released aliases. New tools always use the
  // content-addressed URI above.
  const versions = mode === "connection"
    ? []
    : mode === "browser"
      ? ["0.2.7"]
      : CACHED_RELEASES;
  return [
    `ui://loomex/${mode}.html`,
    ...versions.map((version) => `ui://loomex/${mode}-${version}.html`),
  ].map((legacyUri) => ({
    uri: legacyUri,
    deprecated: true as const,
    replacementUri: uri,
  }));
}

function resource(name: string, uri: string, mode: UiResourceMode): UiResourceDefinition {
  return Object.freeze({ name, uri, mode, aliases: Object.freeze(aliases(mode, uri)) });
}

export const UI_RESOURCE_REGISTRY: readonly UiResourceDefinition[] = Object.freeze([
  resource("loomex-browser", BROWSER_UI_URI, "browser"),
  resource("loomex-runs", RUNS_UI_URI, "runs"),
  resource("loomex-authoring", AUTHORING_UI_URI, "authoring"),
  resource("loomex-prepare", PREPARE_UI_URI, "prepare"),
  resource("loomex-monitor", MONITOR_UI_URI, "monitor"),
  resource("loomex-interaction", INTERACTION_UI_URI, "interaction"),
  resource("loomex-organizations", ORGANIZATIONS_UI_URI, "organizations"),
  resource("loomex-connection", CONNECTION_UI_URI, "connection"),
]);

export function uiResourceForUri(uri: string): UiResourceDefinition | undefined {
  return UI_RESOURCE_REGISTRY.find((resource) => resource.uri === uri);
}

export function uiResourceForLegacyAlias(uri: string): UiResourceDefinition | undefined {
  return UI_RESOURCE_REGISTRY.find((resource) => resource.aliases.some((alias) => alias.uri === uri));
}
