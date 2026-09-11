/**
 * The canonical UI resource inventory.  Tool declarations and MCP resource
 * registration both consume this registry so a view cannot acquire a second,
 * incompatible identity merely by being registered in a different module.
 */
export const BROWSER_UI_URI = "ui://loomex/browser.html";
export const AUTHORING_UI_URI = "ui://loomex/authoring.html";
export const PREPARE_UI_URI = "ui://loomex/prepare.html";
export const MONITOR_UI_URI = "ui://loomex/monitor.html";
export const INTERACTION_UI_URI = "ui://loomex/interaction.html";
export const CONNECTION_UI_URI = "ui://loomex/connection.html";
export const ORGANIZATIONS_UI_URI = "ui://loomex/organizations.html";

export type UiResourceMode =
  | "browser"
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
  // Connection was never an addressable legacy card.  Browser entered the
  // compatibility template only at 0.2.7; the other original views retain all
  // released aliases.  New tools must always use the canonical URI above.
  const versions = mode === "connection"
    ? []
    : mode === "browser"
      ? ["0.2.7"]
      : CACHED_RELEASES;
  return versions.map((version) => ({
    uri: `ui://loomex/${mode}-${version}.html`,
    deprecated: true as const,
    replacementUri: uri,
  }));
}

function resource(name: string, uri: string, mode: UiResourceMode): UiResourceDefinition {
  return Object.freeze({ name, uri, mode, aliases: Object.freeze(aliases(mode, uri)) });
}

export const UI_RESOURCE_REGISTRY: readonly UiResourceDefinition[] = Object.freeze([
  resource("loomex-browser", BROWSER_UI_URI, "browser"),
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
