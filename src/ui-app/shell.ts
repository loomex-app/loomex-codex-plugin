import type { ActionIcon, ActionMetadata, UiMode } from "./contracts.js";

const ICONS: Record<ActionIcon, string> = {
  back: "m12 5-7 7 7 7 M5 12h15", check: "m5 12 4 4L19 6", clock: "M12 6v6l4 2 M22 12a10 10 0 1 1-20 0 10 10 0 0 1 20 0",
  close: "m6 6 12 12 M6 18 18 6", connection: "M8 3v5 M16 3v5 M6 8h12v3a6 6 0 0 1-12 0Z M12 17v4",
  copy: "M9 9h12v12H9Z M15 9V3H3v12h6", edit: "m14 5 5 5 M4 20l5-1L21 7l-4-4L5 15Z", external: "M14 3h7v7 M21 3 10 14 M10 3H3v18h18v-7",
  eye: "M2 12s3-7 10-7 10 7 10 7-3 7-10 7S2 12 2 12 M15 12a3 3 0 1 1-6 0 3 3 0 0 1 6 0",
  info: "M12 17v-5m0-4h.01 M22 12a10 10 0 1 1-20 0 10 10 0 0 1 20 0", logout: "M9 3H3v18h6 M10 12h11 m-5-5 5 5-5 5",
  message: "M21 15a3 3 0 0 1-3 3H8l-5 3V6a3 3 0 0 1 3-3h12a3 3 0 0 1 3 3Z", next: "m12 5 7 7-7 7 M19 12H4",
  organization: "M5 21V3h14v18 M2 21h20 M9 7h1 m4 0h1 M9 11h1 m4 0h1 M10 21v-6h4v6", play: "m8 5 11 7-11 7Z",
  refresh: "M20 7v5h-5 M4 17v-5h5 M6 7a7 7 0 0 1 12-1l2 6 M4 12l2 6a7 7 0 0 0 12-1", search: "M21 21l-5-5 M18 10a8 8 0 1 1-16 0 8 8 0 0 1 16 0",
  shield: "m12 3 8 3v6c0 5-8 9-8 9s-8-4-8-9V6Z m-4 9 3 3 5-6", stop: "M6 6h12v12H6Z",
};

export type ActionId = "refresh" | "back" | "edit" | "start" | "chat" | "results" | "review" | "submit" | "approve" | "reject" | "cancel" | "clear" | "search" | "connection" | "organizations" | "logout" | "grant" | "copy" | "open" | "next";

/** Action identity is independent of presentation copy or localization. */
export const ACTIONS: Readonly<Record<ActionId, ActionMetadata>> = Object.freeze({
  refresh: { icon: "refresh" }, back: { icon: "back" }, edit: { icon: "edit" },
  start: { icon: "play", labelVisibility: "text" }, chat: { icon: "message" }, results: { icon: "eye" },
  review: { icon: "eye", labelVisibility: "text" }, submit: { icon: "check", labelVisibility: "text" },
  approve: { icon: "check" }, reject: { icon: "close" }, cancel: { icon: "stop" }, clear: { icon: "close" },
  search: { icon: "search" }, connection: { icon: "connection" }, organizations: { icon: "organization" },
  logout: { icon: "logout" }, grant: { icon: "shield" }, copy: { icon: "copy" }, open: { icon: "external" }, next: { icon: "next" },
});

export function createIcon(name: ActionIcon): SVGSVGElement {
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  for (const [key, value] of Object.entries({ viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", "stroke-width": "1.7", "stroke-linecap": "round", "stroke-linejoin": "round", "aria-hidden": "true", focusable: "false" })) svg.setAttribute(key, value);
  const path = document.createElementNS(svg.namespaceURI, "path");
  path.setAttribute("d", ICONS[name]); svg.append(path); return svg;
}

export function initialTitle(mode: UiMode): string {
  return ({ browser: "Browse workflows", runs: "Workflow runs", authoring: "Authoring review", prepare: "Review run", monitor: "Run monitor", interaction: "Your response", connection: "Connection", organizations: "Organizations" } as const)[mode];
}
