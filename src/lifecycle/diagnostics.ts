import { lstat, readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";
import { parse as parseToml } from "smol-toml";
import { FingerprintDiagnosticsSchema } from "../runner-diagnostics.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import packageMetadata from "../../package.json" with { type: "json" };
import { LocalControlClient, LocalControlError, assertOwnerCheckedSocket, socketPath } from "../local-control.js";
import { TOOL_DEFINITIONS } from "../tool-catalog.js";
import { UI_RESOURCE_REGISTRY } from "../ui-resources.js";
import { DiagnosticsReportSchema, type DiagnosticCheck, type DiagnosticsReport } from "./diagnostics-contract.js";
const TIMEOUT_MS = 5000;
const check = (id: DiagnosticCheck["id"], state: DiagnosticCheck["state"], code: DiagnosticCheck["code"], observation?: DiagnosticCheck["observation"]): DiagnosticCheck => ({ id, state, code, ...(observation ? { observation } : {}) });
const record = (value: unknown): Record<string, unknown> | undefined => value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
/** Parse only the setting being inspected; never serialize the host configuration. */
export function inspectCodexConfig(source: string): {
    config: DiagnosticCheck;
    routing: DiagnosticCheck;
} {
    let config: Record<string, unknown>;
    try {
        config = parseToml(source, { integersAsBigInt: "asNeeded", unsafeKeyBehaviour: "throw" });
    }
    catch {
        return { config: check("codex_config", "failed", "config_invalid"), routing: check("direct_routing", "unknown", "config_invalid") };
    }
    const mode = record(record(config.features)?.code_mode);
    const namespaces = mode?.direct_only_tool_namespaces;
    const enabled = mode?.enabled;
    if (enabled !== undefined && typeof enabled !== "boolean" || namespaces !== undefined && (!Array.isArray(namespaces) || namespaces.length > 500 || namespaces.some(item => typeof item !== "string" || item.length > 200))) {
        return { config: check("codex_config", "verified", "verified"), routing: check("direct_routing", "failed", "routing_invalid") };
    }
    const list = Array.isArray(namespaces) ? namespaces as string[] : [];
    return { config: check("codex_config", "verified", "verified"), routing: check("direct_routing", list.includes("mcp__loomex") ? "verified" : "failed", list.includes("mcp__loomex") ? "verified" : "routing_missing", { namespaces: list, ...(typeof enabled === "boolean" ? { enabled } : {}) }) };
}
export function inspectDestination(id: "backend_destination" | "frontend_destination", value: unknown): DiagnosticCheck {
    if (value === undefined || value === null || value === "")
        return check(id, "unknown", "destination_unknown");
    if (typeof value !== "string")
        return check(id, "failed", "destination_invalid");
    try {
        const url = new URL(value);
        if (!["http:", "https:"].includes(url.protocol) || url.username || url.password)
            return check(id, "failed", "destination_invalid");
        // URLs can carry secrets in query/fragment. Report only their normalized service destination.
        url.search = "";
        url.hash = "";
        const host = url.hostname.toLowerCase();
        const loopback = host === "localhost" || host.endsWith(".localhost") || host === "[::1]" || /^127\./.test(host);
        return check(id, "verified", "verified", { url: url.href, loopback });
    }
    catch {
        return check(id, "failed", "destination_invalid");
    }
}
export interface InstalledDiagnosticsOptions {
    installBase: string;
    verifyReceipt: () => void;
    verifyInventory: () => void;
    currentTarget: () => string;
    configPath?: string;
}
/** Actual packaged process: descriptors and resources only, never tool invocation. */
export async function inspectPackagedMcp(command: string, args: string[]): Promise<{
    mcp: DiagnosticCheck;
    resources: DiagnosticCheck;
}> {
    const client = new Client({ name: "loomex-readonly-diagnostics", version: packageMetadata.version });
    const transport = new StdioClientTransport({ command, args, stderr: "pipe" });
    let verifiedMcp: DiagnosticCheck = check("packaged_mcp", "unknown", "mcp_unavailable");
    // Discard raw child diagnostics. They are not part of the safe report.
    transport.stderr?.on("data", () => undefined);
    try {
        await client.connect(transport, { timeout: TIMEOUT_MS });
        const version = client.getServerVersion()?.version;
        const tools = await client.listTools({}, { timeout: TIMEOUT_MS });
        if (tools.nextCursor || version !== packageMetadata.version || tools.tools.length !== TOOL_DEFINITIONS.length || new Set(tools.tools.map(tool => tool.name)).size !== tools.tools.length)
            return { mcp: check("packaged_mcp", "failed", "mcp_mismatch"), resources: check("visual_resources", "unknown", "mcp_mismatch") };
        for (const definition of TOOL_DEFINITIONS) {
            const tool = tools.tools.find(item => item.name === definition.name);
            if (!tool || definition.uiUri && (record(tool._meta?.ui)?.resourceUri !== definition.uiUri || tool._meta?.["openai/outputTemplate"] !== definition.uiUri))
                return { mcp: check("packaged_mcp", "failed", "mcp_mismatch"), resources: check("visual_resources", "unknown", "mcp_mismatch") };
        }
        const mcp = check("packaged_mcp", "verified", "verified", { version, count: tools.tools.length });
        verifiedMcp = mcp;
        const resources = await client.listResources({}, { timeout: TIMEOUT_MS });
        if (resources.nextCursor || resources.resources.length !== UI_RESOURCE_REGISTRY.length || UI_RESOURCE_REGISTRY.some(expected => !resources.resources.some(item => item.uri === expected.uri)))
            return { mcp, resources: check("visual_resources", "failed", "resource_unavailable") };
        for (const resource of UI_RESOURCE_REGISTRY) {
            const read = await client.readResource({ uri: resource.uri }, { timeout: TIMEOUT_MS });
            if (read.contents.length !== 1)
                return { mcp, resources: check("visual_resources", "failed", "resource_unavailable") };
            const content = read.contents[0];
            const ui = record(content?._meta?.ui);
            const csp = record(ui?.csp);
            if (!content || content.uri !== resource.uri || !("text" in content) || typeof content.text !== "string" || !content.text.includes("<!doctype html>") || content.mimeType !== "text/html;profile=mcp-app" || !["connectDomains", "resourceDomains", "frameDomains"].every(key => Array.isArray(csp?.[key]) && (csp![key] as unknown[]).length === 0))
                return { mcp, resources: check("visual_resources", "failed", "resource_unavailable") };
        }
        return { mcp, resources: check("visual_resources", "verified", "verified", { count: resources.resources.length, resourceUris: UI_RESOURCE_REGISTRY.map(item => item.uri) }) };
    }
    catch {
        return { mcp: verifiedMcp, resources: check("visual_resources", "unknown", verifiedMcp.state === "verified" ? "resource_unavailable" : "mcp_unavailable") };
    }
    finally {
        await client.close().catch(() => undefined);
        await transport.close().catch(() => undefined);
    }
}
export async function collectInstalledDiagnostics(options: InstalledDiagnosticsOptions): Promise<DiagnosticsReport> {
    const checks: DiagnosticCheck[] = [];
    let target: string | undefined;
    let launcher: {
        command: string;
        args: string[];
    } | undefined;
    try {
        target = options.currentTarget();
        checks.push(check("install_paths", "verified", "verified", { path: target }));
    }
    catch {
        checks.push(check("install_paths", "failed", "invalid_paths"));
    }
    let receipt = false;
    try {
        options.verifyReceipt();
        receipt = true;
        checks.push(check("receipt", "verified", "verified"));
    }
    catch {
        checks.push(check("receipt", "failed", "invalid_receipt"));
    }
    let inventory = false;
    try {
        options.verifyInventory();
        inventory = true;
        checks.push(check("package_inventory", "verified", "verified"));
    }
    catch {
        checks.push(check("package_inventory", "failed", "inventory_mismatch"));
    }
    try {
        if (!target)
            throw new Error("Unverified paths");
        const launcherPath = join(target, "plugin/.mcp.json");
        const launcherStat = await lstat(launcherPath);
        if (!launcherStat.isFile() || launcherStat.isSymbolicLink() || launcherStat.uid !== process.geteuid?.())
            throw new Error("Unverified launcher");
        const parsed = JSON.parse(await readFile(launcherPath, "utf8"));
        const value = record(record(parsed)?.mcpServers);
        const server = record(value?.loomex);
        const command = join(options.installBase, "current/plugin/runtime/bin/node");
        const args = [join(options.installBase, "current/plugin/dist/server.js")];
        if (!value || Object.keys(value).length !== 1 || !server || Object.keys(server).some(key => !["command", "args"].includes(key)) || server.command !== command || JSON.stringify(server.args) !== JSON.stringify(args))
            throw new Error("Unverified launcher");
        launcher = { command, args };
        checks.push(check("launcher", "verified", "verified", { path: join(target, "plugin/.mcp.json") }));
    }
    catch {
        checks.push(check("launcher", "failed", "invalid_launcher"));
    }
    const mcp = launcher && receipt && inventory ? await inspectPackagedMcp(launcher.command, launcher.args) : { mcp: check("packaged_mcp", "unknown", "invalid_launcher"), resources: check("visual_resources", "unknown", "invalid_launcher") };
    checks.push(mcp.mcp, mcp.resources);
    let socket = false;
    try {
        await assertOwnerCheckedSocket(socketPath());
        socket = true;
        checks.push(check("socket", "verified", "verified", { path: socketPath() }));
    }
    catch {
        checks.push(check("socket", "unknown", "socket_unavailable"));
    }
    const client = new LocalControlClient();
    let fingerprint: DiagnosticCheck = check("fingerprint", "unknown", "metrics_unavailable");
    if (socket) {
        try {
            const output = await client.call("status.get", { includeFingerprintDiagnostics: true }, { mutating: false, timeoutMs: TIMEOUT_MS });
            if (!output.ok)
                throw new Error("Unavailable");
            const metrics = FingerprintDiagnosticsSchema.safeParse(output.data?.fingerprint);
            if (metrics.success)
                fingerprint = check("fingerprint", "verified", "verified", { fingerprint: metrics.data });
            checks.push(check("runner_compatibility", "verified", "verified", { ...(typeof output.data?.version === "string" ? { version: output.data.version } : {}) }));
        }
        catch (error) {
            checks.push(check("runner_compatibility", error instanceof LocalControlError && error.code === "COMPATIBILITY_ERROR" ? "failed" : "unknown", error instanceof LocalControlError && error.code === "COMPATIBILITY_ERROR" ? "runner_incompatible" : "runner_unavailable"));
        }
    }
    else
        checks.push(check("runner_compatibility", "unknown", "socket_unavailable"));
    // Neither legacy CLI diagnostics nor connection.get is credential-free.
    // No safe canonical build/destination metadata is available in this projection.
    checks.push(check("runner_build", "unknown", "CREDENTIAL_FREE_BUILD_METADATA_UNAVAILABLE"), check("daemon_build", "unknown", "runner_diagnostics_unavailable"), fingerprint);
    const configuredHome = process.env.CODEX_HOME;
    const configPath = options.configPath ?? join(configuredHome && isAbsolute(configuredHome) ? configuredHome : join(homedir(), ".codex"), "config.toml");
    try {
        if (!options.configPath && configuredHome && !isAbsolute(configuredHome))
            throw new Error("Invalid Codex config path");
        if ((await lstat(configPath)).size > 1024 * 1024)
            throw new Error("Config exceeds inspection budget");
        const parsed = inspectCodexConfig(await readFile(configPath, "utf8"));
        checks.push({ ...parsed.config, observation: { path: configPath } }, parsed.routing);
    }
    catch (error) {
        const missing = record(error)?.code === "ENOENT";
        checks.push(check("codex_config", "unknown", missing ? "config_missing" : "config_unreadable", { path: configPath }), check("direct_routing", "unknown", missing ? "config_missing" : "config_unreadable"));
    }
    checks.push(inspectDestination("backend_destination", undefined));
    checks.push(check("frontend_destination", "unknown", "CREDENTIAL_FREE_DESTINATION_UNAVAILABLE"), check("native_rendering", "unknown", "rendering_not_checked"));
    const guidance: DiagnosticsReport["guidance"] = ["use_supported_machine_install"];
    if (checks.some(item => item.id === "direct_routing" && item.code === "routing_missing"))
        guidance.push("merge_direct_namespace_preserving_settings");
    if (checks.some(item => item.observation?.loopback))
        guidance.push("loopback_requires_local_service");
    return DiagnosticsReportSchema.parse({ schema: "app.loomex.plugin.diagnostics/v1", pluginVersion: packageMetadata.version, checks, configInspectionOnly: true, nativeRenderingVerified: false, guidance });
}
