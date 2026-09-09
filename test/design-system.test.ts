import { validateDesignSystem } from "../src/design-system.js";
import * as assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { renderUiHtml } from "../src/ui-template.js";

test("every UI resource embeds the same verified offline frontend design artifact", () => {
  const css = readFileSync("assets/frontend-design-system.css", "utf8");
  const provenance = JSON.parse(readFileSync("assets/frontend-design-system.json", "utf8"));
  assert.equal(provenance.schema, "loomex/frontend-design-system/v1");
  assert.equal(provenance.cssSha256, createHash("sha256").update(css).digest("hex"));
  for (const path of ["packages/ui/src/styles.css", "packages/ui/src/components/Button.tsx", "packages/ui/src/components/StatusBadge.tsx", "packages/theme/src/brandTokens.ts"]) {
    assert.match(provenance.sources[path], /^[a-f0-9]{64}$/);
  }
  for (const mode of ["browser", "authoring", "prepare", "monitor", "interaction"]) {
    const html = renderUiHtml(mode);
    assert.ok(html.includes(css));
    assert.equal(html.split(css).length, 2, "exactly one foundation per view");
    assert.doesNotMatch(html, /__LOOMEX_DESIGN_SYSTEM__|__LOOMEX_STATUS_CLASSES__|__LOOMEX_MODE__|@import\s|url\(/);
    assert.ok(html.includes(`data-mode="${mode}"`));
    assert.match(html, /data-theme-mode="dark"/);
  }
  assert.throws(() => renderUiHtml("unknown"));
});


test("stale consumer templates and malformed design metadata fail before serving a view", () => {
  const css = readFileSync("assets/frontend-design-system.css", "utf8");
  const template = readFileSync("assets/loomex-app.html", "utf8");
  const snapshot = JSON.parse(readFileSync("assets/frontend-design-system.json", "utf8"));
  assert.throws(() => validateDesignSystem(snapshot, template + "<!-- new utility -->", css));
  assert.throws(() => validateDesignSystem(snapshot, template, css + "body {}"));
  for (const statusClasses of [{}, [], { low: "", unknown: "x", failed: "x" }]) {
    assert.throws(() => validateDesignSystem({ ...snapshot, statusClasses }, template, css));
  }
  assert.throws(() => validateDesignSystem({ ...snapshot, sources: {} }, template, css));
  assert.throws(() => validateDesignSystem({ ...snapshot, compiler: {} }, template, css));
  assert.throws(() => validateDesignSystem({ ...snapshot, candidatesSha256: "bad" }, template, css));
  assert.match(css, /\.pl-10\s*\{/); // Canonical SearchInput icon spacing is included.
});
