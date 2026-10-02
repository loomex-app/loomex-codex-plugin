import { z } from "zod";
import { FingerprintDiagnosticsSchema } from "../runner-diagnostics.js";
export const DIAGNOSTIC_CHECK_IDS = ["install_paths", "receipt", "package_inventory", "launcher", "packaged_mcp", "visual_resources", "socket", "runner_compatibility", "runner_build", "daemon_build", "fingerprint", "codex_config", "direct_routing", "backend_destination", "frontend_destination", "native_rendering"] as const;
const Observation = z.object({
    path: z.string().max(4096).optional(), version: z.string().max(80).optional(),
    count: z.number().int().nonnegative().optional(), namespaces: z.array(z.string().max(200)).max(500).optional(),
    enabled: z.boolean().optional(), profile: z.string().max(80).optional(), optimizationLevel: z.string().max(8).optional(),
    debugAssertions: z.boolean().optional(), classification: z.enum(["development", "production"]).optional(),
    fingerprint: FingerprintDiagnosticsSchema.optional(),
    url: z.string().url().max(4096).optional(), loopback: z.boolean().optional(), resourceUris: z.array(z.string().max(300)).max(20).optional(),
}).strict();
export const DiagnosticCheckSchema = z.object({
    id: z.enum(DIAGNOSTIC_CHECK_IDS), state: z.enum(["verified", "failed", "unknown"]),
    code: z.enum(["verified", "not_installed", "invalid_paths", "invalid_receipt", "inventory_mismatch", "invalid_launcher", "mcp_unavailable", "mcp_mismatch", "resource_unavailable", "socket_unavailable", "runner_unavailable", "runner_incompatible", "runner_diagnostics_unavailable", "metrics_unavailable", "config_missing", "config_unreadable", "config_invalid", "routing_missing", "routing_invalid", "destination_unknown", "destination_invalid", "rendering_not_checked", "CREDENTIAL_FREE_BUILD_METADATA_UNAVAILABLE", "CREDENTIAL_FREE_DESTINATION_UNAVAILABLE"]),
    observation: Observation.optional(),
}).strict().refine(check => (check.state === "verified") === (check.code === "verified"), "Verified checks require the verified code");
export type DiagnosticCheck = z.infer<typeof DiagnosticCheckSchema>;
export const DiagnosticsReportSchema = z.object({
    schema: z.literal("app.loomex.plugin.diagnostics/v1"), pluginVersion: z.string().max(80),
    checks: z.array(DiagnosticCheckSchema).length(DIAGNOSTIC_CHECK_IDS.length).refine(checks => new Set(checks.map(check => check.id)).size === DIAGNOSTIC_CHECK_IDS.length, "Every check must be present exactly once"),
    configInspectionOnly: z.literal(true), nativeRenderingVerified: z.literal(false),
    guidance: z.array(z.enum(["merge_direct_namespace_preserving_settings", "use_supported_machine_install", "loopback_requires_local_service"])).max(3),
}).strict();
export type DiagnosticsReport = z.infer<typeof DiagnosticsReportSchema>;
