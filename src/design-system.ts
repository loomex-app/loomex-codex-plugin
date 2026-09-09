import { createHash } from "node:crypto";
import { z } from "zod";

const digest = z.string().regex(/^[a-f0-9]{64}$/);
const classes = z.string().trim().min(1);
const provenanceSchema = z.object({
  schema: z.literal("loomex/frontend-design-system/v1"),
  frontendRevision: z.string().regex(/^[a-f0-9]{40,64}$/),
  compiler: z.object({ name: z.literal("@tailwindcss/node"), version: z.string().regex(/^\d+\.\d+\.\d+$/) }).strict(),
  sources: z.object({
    "packages/ui/src/styles.css": digest,
    "packages/ui/src/components/Button.tsx": digest,
    "packages/ui/src/components/StatusBadge.tsx": digest,
    "packages/ui/src/components/forms.tsx": digest,
    "packages/theme/src/brandTokens.ts": digest,
    "packages/theme/src/neutralThemeOptions.ts": digest,
    "pnpm-lock.yaml": digest,
  }).strict(),
  statusClasses: z.object({ low: classes, unknown: classes, failed: classes }).catchall(classes),
  candidatesSha256: digest,
  templateSha256: digest,
  cssSha256: digest,
}).strict();

export function validateDesignSystem(snapshot: unknown, template: string, foundation: string) {
  const provenance = provenanceSchema.parse(snapshot);
  const hash = (value: string) => createHash("sha256").update(value).digest("hex");
  if (hash(foundation) !== provenance.cssSha256 || hash(template) !== provenance.templateSha256 ||
      /<\/style|@import\s|url\(/i.test(foundation) ||
      template.split("__LOOMEX_DESIGN_SYSTEM__").length !== 2 ||
      template.split("__LOOMEX_STATUS_CLASSES__").length !== 2) {
    throw new Error("Invalid or stale packaged frontend design system. Run npm run design:sync.");
  }
  return provenance;
}
