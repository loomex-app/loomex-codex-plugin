import { createHash } from "node:crypto";
import { z } from "zod";

const digest = z.string().regex(/^[a-f0-9]{64}$/);
const classes = z.string().trim().min(1);
const provenanceSchema = z.object({
  schema: z.literal("loomex/frontend-design-system/v3"),
  frontendRevision: z.string().regex(/^[a-f0-9]{40,64}$/),
  compiler: z.object({ name: z.literal("@tailwindcss/node"), version: z.string().regex(/^\d+\.\d+\.\d+$/) }).strict(),
  sources: z.object({
    "packages/ui/src/styles.css": digest,
    "packages/ui/src/components/Button.tsx": digest,
    "packages/ui/src/components/StatusBadge.tsx": digest,
    "packages/ui/src/components/forms.tsx": digest,
    "packages/ui/src/components/Pagination.tsx": digest,
    "packages/ui/src/components/Select.tsx": digest,
    "packages/theme/src/brandTokens.ts": digest,
    "packages/theme/src/neutralThemeOptions.ts": digest,
    "pnpm-lock.yaml": digest,
  }).strict(),
  statusClasses: z.object({ low: classes, unknown: classes, failed: classes }).catchall(classes),
  candidatesSha256: digest,
  consumerSourcesSha256: digest,
  // v1 included the plugin template hash. v2 deliberately keeps plugin
  // artifact integrity in ui-artifacts.json so source checks can run against
  // a frontend checkout without coupling to plugin template edits.
  templateSha256: digest.optional(),
  cssSha256: digest,
}).strict();

const artifactSchema = z.object({
  schema: z.literal("loomex/plugin-ui-assets/v2"),
  templateSha256: digest,
  foundationSha256: digest,
  browserCodeSha256: digest,
}).strict();

export function validateDesignSystem(snapshot: unknown, template: string, foundation: string, artifact?: unknown, browserCode = "", browserAsset = browserCode) {
  const provenance = provenanceSchema.parse(snapshot);
  const hash = (value: string) => createHash("sha256").update(value).digest("hex");
  if (hash(foundation) !== provenance.cssSha256 ||
      (provenance.templateSha256 !== undefined && hash(template) !== provenance.templateSha256) ||
      /<\/style|@import\s|url\(/i.test(foundation) ||
      template.split("__LOOMEX_DESIGN_SYSTEM__").length !== 2 ||
      (template.split("__LOOMEX_STATUS_CLASSES__").length !== 2 && template.split("__LOOMEX_APPLICATION__").length !== 2)) {
    throw new Error("Invalid or stale packaged frontend design system. Run npm run design:sync.");
  }
  if (artifact !== undefined) {
    const assets = artifactSchema.parse(artifact);
    if (hash(template) !== assets.templateSha256 || hash(foundation) !== assets.foundationSha256 ||
        hash(browserCode) !== assets.browserCodeSha256 ||
        hash(browserAsset) !== assets.browserCodeSha256) {
      throw new Error("Invalid or stale packaged UI assets. Run npm run ui:sync.");
    }
  }
  return provenance;
}
