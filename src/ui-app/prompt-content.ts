import { createElement as element, type ElementAttributes } from "./components.js";

/** A layout decision only: the complete question always remains in the body. */
export function compactQuestion(value: string): boolean {
  return value.length <= 240 && !/[\r\n]/.test(value) && !/^(?:#{1,6}\s|[-*+]\s|\d+[.)]\s|```|~~~)/.test(value.trim());
}

function appendInline(parent: HTMLElement, text: string): boolean {
  // This is deliberately a small presentation subset, not a CommonMark parser.
  // HTML, links, images and unsupported syntax remain inert, visible text.
  const pattern = /(`+)([^`\n]+)\1|\*\*([^*\n]+)\*\*|__([^_\n]+)__|\*([^*\n]+)\*|_([^_\n]+)_/g;
  let position = 0;
  let formatted = false;
  for (const match of text.matchAll(pattern)) {
    const index = match.index;
    parent.append(text.slice(position, index));
    const content = match[2] ?? match[3] ?? match[4] ?? match[5] ?? match[6] ?? "";
    parent.append(element(match[2] !== undefined ? "code" : match[3] !== undefined || match[4] !== undefined ? "strong" : "em", {}, content));
    position = index + match[0].length;
    formatted = true;
  }
  parent.append(text.slice(position));
  return formatted;
}

export type PromptFormattingBudget = { remaining: number };

/** Limits formatting expansion, never the amount of content that can be read. */
export function createPromptContent(text: string, attributes: ElementAttributes = {}, budget: PromptFormattingBudget = { remaining: 512 }): HTMLElement {
  const wrapper = element("div", { ...attributes, className: "ui-prompt-content" });
  const body = element("div", { className: "ui-rich-text" });
  const lines = text.length <= 65_536 ? text.replaceAll("\r\n", "\n").replaceAll("\r", "\n").split("\n") : null;
  const inlineCount = lines ? [...text.matchAll(/`+[^`\n]+`+|\*\*[^*\n]+\*\*|__[^_\n]+__|\*[^*\n]+\*|_[^_\n]+_/g)].length : 0;
  const expansion = (lines?.length ?? 0) * 3 + inlineCount * 3 + 8;
  if (!lines || lines.length > 256 || expansion > budget.remaining) {
    body.append(element("p", {}, text));
    wrapper.append(body);
    return wrapper;
  }
  budget.remaining -= expansion;
  let formatted = false;
  let index = 0;
  while (index < lines.length) {
    const line = lines[index] ?? "";
    if (!line.trim()) { index += 1; continue; }
    const fence = /^\s{0,3}(`{3,}|~{3,})([^`]*)$/.exec(line);
    if (fence) {
      const marker = fence[1] ?? "";
      const close = lines.findIndex((candidate, candidateIndex) => candidateIndex > index &&
        candidate.trim().length >= marker.length && [...candidate.trim()].every(character => character === marker[0]));
      if (close >= 0) {
        const pre = element("pre");
        pre.append(element("code", {}, lines.slice(index + 1, close).join("\n")));
        body.append(pre);
        formatted = true;
        index = close + 1;
        continue;
      }
    }
    const heading = /^\s{0,3}#{1,6}\s+(.+)$/.exec(line);
    // A provider-flattened report may be one enormous apparent Markdown heading.
    // It stays readable body text rather than becoming another oversized title.
    if (heading && (heading[1]?.length ?? 0) <= 240) {
      const title = element("h3");
      appendInline(title, heading[1] ?? "");
      body.append(title);
      formatted = true;
      index += 1;
      continue;
    }
    const item = /^\s{0,3}(?:([-*+])|(\d+)[.)])\s+(.+)$/.exec(line);
    if (item) {
      const ordered = item[2] !== undefined;
      const list = element(ordered ? "ol" : "ul");
      if (ordered) list.setAttribute("start", item[2] ?? "1");
      while (index < lines.length) {
        const entry = /^\s{0,3}(?:([-*+])|(\d+)[.)])\s+(.+)$/.exec(lines[index] ?? "");
        if (!entry || (entry[2] !== undefined) !== ordered) break;
        const li = element("li");
        appendInline(li, entry[3] ?? "");
        list.append(li);
        index += 1;
      }
      body.append(list);
      formatted = true;
      continue;
    }
    const paragraph: string[] = [line];
    index += 1;
    while (index < lines.length && (lines[index] ?? "").trim() &&
      !/^\s{0,3}(?:#{1,6}\s|[-*+]\s|\d+[.)]\s|`{3,}|~{3,})/.test(lines[index] ?? "")) {
      paragraph.push(lines[index] ?? "");
      index += 1;
    }
    const p = element("p");
    formatted = appendInline(p, paragraph.join("\n")) || formatted;
    body.append(p);
  }
  wrapper.append(body);
  if (formatted && !compactQuestion(text)) {
    const source = element("details", { className: "ui-prompt-source" });
    source.append(element("summary", {}, "View full text"), element("pre", { className: "ui-prompt-original", tabIndex: 0, "aria-label": "Full text" }, text));
    wrapper.append(source);
  }
  return wrapper;
}

let readingId = 0;

/** Register a local reading region and its shared accessible continuation cue. */
export function enablePromptReading(region: HTMLElement, label: string): void {
  region.classList.add("ui-prompt-reading");
  region.dataset.promptReading = "true";
  region.tabIndex = 0;
  region.setAttribute("role", "region");
  region.setAttribute("aria-label", label);
  const hint = element("p", { id: `ui-reading-hint-${++readingId}`, className: "ui-prompt-scroll-hint", hidden: true }, "Scroll to read all details.");
  region.setAttribute("aria-describedby", hint.id);
  region.after(hint);
}

/** The composition owner measures all regions after rendering or resizing. */
export function updatePromptOverflowHints(root: ParentNode): void {
  for (const region of root.querySelectorAll<HTMLElement>("[data-prompt-reading]")) {
    const hint = region.nextElementSibling;
    if (hint instanceof HTMLElement && hint.classList.contains("ui-prompt-scroll-hint")) {
      hint.hidden = region.clientHeight === 0 || region.scrollHeight <= region.clientHeight;
    }
  }
}

/** A bounded, independently keyboard-scrollable body; response controls stay outside it. */
export function createReadingPromptContent(text: string, label = "Question details", attributes: ElementAttributes = {}, budget: PromptFormattingBudget = { remaining: 512 }): HTMLElement {
  const content = createPromptContent(text, attributes, budget);
  const reading = content.querySelector<HTMLElement>(".ui-rich-text");
  if (reading) enablePromptReading(reading, label);
  return content;
}

/** Full question copy for previews and read-only submitted answer reviews. */
export function createQuestionReviewCopy(question: string): Node {
  return compactQuestion(question) ? document.createTextNode(question) : createReadingPromptContent(question);
}
