import type { ActionIcon, JsonObject } from "./contracts.js";
import { createElement as element } from "./components.js";
import type { WorkflowNode } from "./page-models.js";

export interface WorkflowGraphServices {
  createButton(label: string, actionId: "expand" | "close"): HTMLButtonElement;
  createIcon(name: ActionIcon): SVGSVGElement;
}

type GraphNode = { key: string; label: string; type: string; x: number; y: number };
type GraphEdge = { from: string; to: string };
const PREVIEW_LIMIT = 40;
const INSPECT_LIMIT = 120;

function text(value: unknown, limit = 120): string { return typeof value === "string" ? value.trim().slice(0, limit) : ""; }
function record(value: unknown): JsonObject | undefined { return value !== null && typeof value === "object" && !Array.isArray(value) ? value as JsonObject : undefined; }
function nodeKey(node: WorkflowNode, index: number): string { return text(node.id ?? node.key, 120) || `node-${index}`; }
function position(node: WorkflowNode): { x: number; y: number } | undefined {
  const value = record(node.position);
  const x = value?.x; const y = value?.y;
  return typeof x === "number" && Number.isFinite(x) && typeof y === "number" && Number.isFinite(y) ? { x, y } : undefined;
}
function graphModel(nodes: readonly WorkflowNode[], rawTransitions: unknown, limit: number): { nodes: GraphNode[]; edges: GraphEdge[]; omitted: number } {
  const included = nodes.slice(0, limit).map((node, index) => {
    const fixed = position(node);
    return { key: nodeKey(node, index), label: text(node.name, 72) || "Untitled step", type: text(node.type, 48) || "step", x: fixed?.x ?? (index % 4) * 220, y: fixed?.y ?? Math.floor(index / 4) * 110 };
  });
  const known = new Set(included.map(node => node.key));
  const edges: GraphEdge[] = [];
  const seen = new Set<string>();
  for (const item of Array.isArray(rawTransitions) ? rawTransitions : []) {
    const transition = record(item);
    const from = text(transition?.fromNodeKey ?? transition?.from ?? transition?.source, 120);
    const to = text(transition?.toNodeKey ?? transition?.to ?? transition?.target, 120);
    const key = `${from}\u0000${to}`;
    if (from && to && known.has(from) && known.has(to) && !seen.has(key)) { seen.add(key); edges.push({ from, to }); }
  }
  return { nodes: included, edges, omitted: Math.max(0, nodes.length - included.length) };
}
function svgNode(name: string, attrs: Record<string, string>): SVGElement {
  const node = document.createElementNS("http://www.w3.org/2000/svg", name);
  for (const [key, value] of Object.entries(attrs)) node.setAttribute(key, value);
  return node;
}
function drawing(model: ReturnType<typeof graphModel>, interactive: boolean, onSelect?: (node: GraphNode) => void): SVGSVGElement {
  const svg = svgNode("svg", { viewBox: "0 0 960 560", role: "img", "aria-label": "Workflow graph" }) as SVGSVGElement;
  const defs = svgNode("defs", {}); const marker = svgNode("marker", { id: "workflow-arrow", markerWidth: "8", markerHeight: "8", refX: "7", refY: "4", orient: "auto" });
  marker.append(svgNode("path", { d: "M0,0 L8,4 L0,8 Z", fill: "currentColor" })); defs.append(marker); svg.append(defs);
  const byKey = new Map(model.nodes.map(node => [node.key, node]));
  for (const edge of model.edges) {
    const from = byKey.get(edge.from); const to = byKey.get(edge.to); if (!from || !to) continue;
    svg.append(svgNode("path", { d: `M${from.x + 152},${from.y + 32} C${from.x + 184},${from.y + 32} ${to.x - 32},${to.y + 32} ${to.x},${to.y + 32}`, fill: "none", stroke: "currentColor", "stroke-opacity": ".45", "stroke-width": "1.5", "marker-end": "url(#workflow-arrow)" }));
  }
  for (const node of model.nodes) {
    const group = svgNode("g", { transform: `translate(${node.x} ${node.y})`, class: "workflow-graph-node", ...(interactive ? { tabindex: "0", role: "button", "aria-label": `${node.label}, ${node.type}` } : {}) });
    group.append(svgNode("rect", { width: "152", height: "64", rx: "8", fill: "var(--color-bg-dark)", stroke: "var(--color-line)" }));
    const label = svgNode("text", { x: "12", y: "28", fill: "currentColor", "font-size": "12", "font-weight": "650" }); label.textContent = node.label; group.append(label);
    const type = svgNode("text", { x: "12", y: "47", fill: "currentColor", "fill-opacity": ".65", "font-size": "10" }); type.textContent = node.type; group.append(type);
    if (interactive) {
      const select = () => onSelect?.(node);
      group.addEventListener("click", select); group.addEventListener("keydown", event => { if (event.key === "Enter" || event.key === " ") { event.preventDefault(); select(); } });
    }
    svg.append(group);
  }
  return svg;
}

/** A display-only graph. It intentionally uses only node identity and topology. */
export function createWorkflowGraphPreview(nodes: readonly WorkflowNode[], transitions: unknown, services: WorkflowGraphServices): HTMLElement | null {
  if (!nodes.length) return null;
  const preview = graphModel(nodes, transitions, PREVIEW_LIMIT);
  const section = element("section", { className: "workflow-detail-section", "aria-label": "Workflow graph" });
  const heading = element("div", { className: "workflow-summary-row" }); heading.append(element("h3", { className: "ui-label" }, "Workflow graph"));
  if (preview.omitted) heading.append(element("span", { className: "ui-meta" }, `${preview.omitted} more steps`));
  section.append(heading);
  const canvas = element("div", { className: "workflow-graph-preview" }); canvas.append(drawing(preview, false));
  const expand = services.createButton("Expand workflow graph", "expand"); expand.classList.add("graph-expand");
  expand.addEventListener("click", () => openInspector(nodes, transitions, services, expand)); canvas.append(expand); section.append(canvas);
  return section;
}

function openInspector(nodes: readonly WorkflowNode[], transitions: unknown, services: WorkflowGraphServices, returnFocus: HTMLElement): void {
  const model = graphModel(nodes, transitions, INSPECT_LIMIT);
  const dialog = document.createElement("dialog"); dialog.className = "workflow-graph-dialog"; dialog.setAttribute("aria-labelledby", "workflow-graph-title");
  const body = element("div", { className: "workflow-graph-dialog-content" });
  const heading = element("div", { className: "workflow-graph-dialog-header" });
  heading.append(element("h2", { id: "workflow-graph-title", className: "ui-value" }, "Workflow graph"));
  const close = services.createButton("Close graph", "close"); heading.append(close); body.append(heading);
  const canvas = element("div", { className: "workflow-graph-dialog-canvas", tabindex: 0 });
  const selection = element("p", { className: "ui-caption", role: "status" }, "Select a step to inspect its name and type.");
  canvas.append(drawing(model, true, node => { selection.textContent = `${node.label} · ${node.type}`; })); body.append(canvas, selection);
  if (model.omitted) body.append(element("p", { className: "ui-caption" }, `${model.omitted} steps are not shown in this inspector. Open the workflow editor for the complete graph.`));
  dialog.append(body);
  const closeDialog = () => { dialog.close(); dialog.remove(); returnFocus.focus({ preventScroll: true }); };
  close.addEventListener("click", closeDialog); dialog.addEventListener("cancel", event => { event.preventDefault(); closeDialog(); });
  document.body.append(dialog); dialog.showModal(); close.focus();
}
