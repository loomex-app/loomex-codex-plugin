import { test } from "node:test";
import { TOOL_NAMES } from "../src/tool-catalog.js";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import packageMetadata from "../package.json" with { type: "json" };
import * as assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { inspectCodexConfig, inspectDestination, inspectPackagedMcp, collectInstalledDiagnostics } from "../src/lifecycle/diagnostics.js";
import { DIAGNOSTIC_CHECK_IDS, DiagnosticsReportSchema } from "../src/lifecycle/diagnostics-contract.js";
import { timedOperatorStage, OperatorTimingSchema, type OperatorTiming } from "../src/operator-timings.js";
const configuration = `unrelated = "private-canary"\n[features.code_mode]\nenabled = false\ndirect_only_tool_namespaces = [\n  'mcp__other', # preserve me\n  "mcp__loomex",\n]\n`;
test("bundled lifecycle starts read-only without external dependencies or installation state", async () => {
    const dir = await mkdtemp(join(tmpdir(), "loomex-bundled-lifecycle-"));
    try {
        const { stdout } = await promisify(execFile)(process.execPath, [resolve("dist/lifecycle.mjs"), "status", "--install-base", join(dir, "absent")]);
        const status = JSON.parse(stdout);
        assert.equal(status.schema, "app.loomex.plugin.lifecycle-status/v1");
        assert.equal(status.current, null);
        assert.deepEqual(status.versions, []);
        assert.equal(status.operation, null);
        assert.deepEqual(await readdir(dir), []);
    } finally {
        await rm(dir, { recursive: true, force: true });
    }
});
test("TOML inspection accepts tables, quoted dotted keys and multiline arrays without rewriting or exposing config", () => {
    for (const source of [configuration, `features."code_mode" = { enabled = false, direct_only_tool_namespaces = ['mcp__other', 'mcp__loomex'] }`]) {
        const result = inspectCodexConfig(source);
        assert.equal(result.config.state, "verified");
        assert.equal(result.routing.state, "verified");
        assert.deepEqual(result.routing.observation, { namespaces: ["mcp__other", "mcp__loomex"], enabled: false });
        assert.ok(!JSON.stringify(result).includes("private-canary"));
    }
    assert.equal(inspectCodexConfig(`# features.code_mode.direct_only_tool_namespaces = ["mcp__loomex"]`).routing.code, "routing_missing");
    assert.equal(inspectCodexConfig(`[features.code_mode]\ndirect_only_tool_namespaces = "mcp__loomex"`).routing.code, "routing_invalid");
    assert.equal(inspectCodexConfig(`[features.code_mode]\ndirect_only_tool_namespaces = ['mcp__loomex']\ndirect_only_tool_namespaces = []`).config.code, "config_invalid");
    assert.equal(inspectCodexConfig(`features.__proto__.polluted = true`).config.code, "config_invalid");
});
test("destination checks distinguish unknown, invalid, configured and machine-local without leaking URL secrets", () => {
    assert.equal(inspectDestination("backend_destination", undefined).state, "unknown");
    assert.equal(inspectDestination("frontend_destination", "https://name:secret@example.test/").state, "failed");
    for (const url of ["http://localhost:8000/workspace?token=secret#canary", "http://127.0.0.2:8000", "http://[::1]:8000"]) {
        const result = inspectDestination("frontend_destination", url);
        assert.equal(result.observation?.loopback, true);
        assert.ok(!JSON.stringify(result).includes("secret"));
        assert.ok(!JSON.stringify(result).includes("canary"));
    }
    assert.equal(inspectDestination("frontend_destination", "https://example.test/workspace").observation?.loopback, false);
});
test("read-only report retains independently successful checks after receipt/socket failures and preserves every config byte", async () => {
    const dir = await mkdtemp(join(tmpdir(), "loomex-diagnostics-"));
    const configPath = join(dir, "config.toml");
    await writeFile(configPath, configuration);
    const original = process.env.LOOMEX_STATE_DIR;
    process.env.LOOMEX_STATE_DIR = join(dir, "offline");
    try {
        const report = await collectInstalledDiagnostics({ installBase: join(dir, "install"), configPath, currentTarget() { throw new Error("private-canary"); }, verifyReceipt() { throw new Error("private-canary"); }, verifyInventory() { throw new Error("private-canary"); } });
        assert.equal(DiagnosticsReportSchema.safeParse(report).success, true);
        assert.deepEqual(report.checks.map(check => check.id), DIAGNOSTIC_CHECK_IDS);
        assert.equal(report.checks.find(check => check.id === "receipt")?.state, "failed");
        assert.equal(report.checks.find(check => check.id === "runner_build")?.code, "CREDENTIAL_FREE_BUILD_METADATA_UNAVAILABLE");
        assert.equal(report.checks.find(check => check.id === "socket")?.state, "unknown");
        assert.equal(report.checks.find(check => check.id === "codex_config")?.state, "verified");
        assert.equal(report.nativeRenderingVerified, false);
        assert.ok(!JSON.stringify(report).includes("private-canary"));
        assert.equal(await readFile(configPath, "utf8"), configuration);
        assert.deepEqual(await readdir(dir), ["config.toml"]);
        assert.equal(DiagnosticsReportSchema.safeParse({ ...report, checks: [...report.checks.slice(1), report.checks[1]] }).success, false);
        assert.equal(DiagnosticsReportSchema.safeParse({ ...report, grants: ["automatic"] }).success, false);
        const missing = await collectInstalledDiagnostics({ installBase: dir, configPath: join(dir, "missing"), currentTarget() { throw 0; }, verifyReceipt() { throw 0; }, verifyInventory() { throw 0; } });
        assert.equal(missing.checks.find(check => check.id === "codex_config")?.code, "config_missing");
        assert.ok(!JSON.stringify(missing).includes("credential-canary"));
    }
    finally {
        if (original === undefined)
            delete process.env.LOOMEX_STATE_DIR;
        else
            process.env.LOOMEX_STATE_DIR = original;
        await rm(dir, { recursive: true, force: true });
    }
});
test("actual MCP resource diagnostics invokes only initialization, descriptor lists and fresh resource reads", async () => {
    const dir = await mkdtemp(join(tmpdir(), "loomex-diagnostics-mcp-"));
    const original = process.env.LOOMEX_STATE_DIR;
    process.env.LOOMEX_STATE_DIR = dir;
    try {
        const result = await inspectPackagedMcp(process.execPath, [resolve("dist/server.js")]);
        assert.equal(result.mcp.state, "verified");
        assert.equal(result.mcp.observation?.count, TOOL_NAMES.length);
        assert.equal(result.resources.state, "verified");
        assert.equal(result.resources.observation?.count, 9);
        assert.deepEqual(await readdir(dir), []);
    }
    finally {
        if (original === undefined)
            delete process.env.LOOMEX_STATE_DIR;
        else
            process.env.LOOMEX_STATE_DIR = original;
        await rm(dir, { recursive: true, force: true });
    }
});
test("operator timing is opt-in, monotonic, closed and never changes accepted results on a logging failure", async () => {
    const received: OperatorTiming[] = [];
    let now = 10;
    const result = { accepted: true, answer: "never-log-canary" };
    assert.equal(await timedOperatorStage({ stage: "preparation_review", method: "runs.prepare", enabled: true, clock: () => { now += 5; return now; }, sink: timing => received.push(timing), classify: () => "unknown" }, async () => result), result);
    assert.equal(received[0]?.durationMs, 5);
    assert.equal(received[0]?.outcome, "unknown");
    assert.ok(!JSON.stringify(received).includes("never-log-canary"));
    assert.equal(OperatorTimingSchema.safeParse({ ...received[0], body: "canary" }).success, false);
    assert.equal(await timedOperatorStage({ stage: "presentation_persistence", method: "runs.prepare", enabled: true, sink: () => { throw new Error("sink unavailable"); }, classify: () => "definitive_success" }, async () => result), result);
    const failure = new Error("raw-failure-canary");
    await assert.rejects(timedOperatorStage({ stage: "preparation_review", method: "runs.prepare", enabled: true, sink: timing => received.push(timing), classify: () => "unknown" }, async () => { throw failure; }), error => error === failure);
    assert.equal(received[1]?.outcome, "definitive_failure");
    assert.ok(!JSON.stringify(received).includes("raw-failure-canary"));
    await timedOperatorStage({ stage: "preparation_review", method: "runs.prepare", enabled: false, sink: () => assert.fail("disabled"), classify: () => "unknown" }, async () => result);
});
test("diagnostics never enters authentication or legacy CLI readers under either receipt outcome", async (t) => {
    const { FakeRunner } = await import("./fake-runner.js");
    const { LOCAL_PROTOCOL } = await import("../src/protocol.js");
    for (const validReceipt of [false, true]) await t.test(validReceipt ? "verified receipt" : "rejected receipt", async () => {
        let nativeReads = 0, callbackListeners = 0, cliReaders = 0;
        const runner = new FakeRunner((request, socket) => {
            if (request.method === "status.get") runner.respond(socket, request, { version: "0.4.0", protocol: LOCAL_PROTOCOL, activeJobs: 0, draining: false, updateDeferred: false });
            else if (request.method === "connection.get") {
                nativeReads += 1; callbackListeners += 1;
                runner.respond(socket, request, { schemaVersion: "loomex.runner.connection/v2", state: "signed_out", organization: { status: "organization_required", selected: null }, organizations: [], activeWork: 0, actions: [], login: null, webAppUrl: "http://localhost:3000/workspace?secret=canary" });
            } else { nativeReads += 1; assert.fail(`Unexpected operation ${request.method}`); }
        });
        await runner.start();
        const original = process.env.LOOMEX_STATE_DIR;
        process.env.LOOMEX_STATE_DIR = runner.stateDir;
        try {
            const legacyOptions = { installBase: runner.stateDir, configPath: join(runner.stateDir, "missing"), currentTarget() { return runner.stateDir; }, verifyReceipt() { if (!validReceipt) throw 0; }, verifyInventory() {}, async readRunnerDiagnostics() { cliReaders += 1; return {}; } };
            const result = await collectInstalledDiagnostics(legacyOptions);
            assert.equal(result.checks.find(check => check.id === "receipt")?.state, validReceipt ? "verified" : "failed");
            assert.equal(result.checks.find(check => check.id === "runner_compatibility")?.state, "verified");
            assert.deepEqual({ nativeReads, callbackListeners, cliReaders }, { nativeReads: 0, callbackListeners: 0, cliReaders: 0 });
            assert.equal(result.checks.find(check => check.id === "frontend_destination")?.state, "unknown");
            assert.equal(result.checks.find(check => check.id === "frontend_destination")?.code, "CREDENTIAL_FREE_DESTINATION_UNAVAILABLE");
            assert.equal(result.checks.find(check => check.id === "runner_build")?.code, "CREDENTIAL_FREE_BUILD_METADATA_UNAVAILABLE");
            assert.deepEqual(runner.requests.map(request => ({ method: request.method, params: request.params })), [{ method: "status.get", params: {} }]);
            assert.deepEqual(await readdir(runner.stateDir), ["control.sock"]);
            assert.ok(!JSON.stringify(result).includes("canary"));
        } finally {
            if (original === undefined) delete process.env.LOOMEX_STATE_DIR; else process.env.LOOMEX_STATE_DIR = original;
            await runner.stop();
        }
    });
});
test("optional operator statistics preserve the legacy status shape and reject arbitrary payload fields", async () => {
    const { resultSchemaFor } = await import("../src/result-schemas.js");
    const schema = resultSchemaFor("status.get")!;
    const legacy = { version: "0.4.0", protocol: "loomex.local-control/v1", activeJobs: 0, draining: false, updateDeferred: false };
    const fingerprint = { workerLimit: 2, activeWorkers: 0, peakWorkers: 1, started: 2, shared: 1, bytesHashed: 500, queueMicros: 2, hashMicros: 10, unavailable: 0, changed: 0, canceled: 0, inFlight: 0, queued: 0, completedCache: false, stageObservations: [{ operation: "preparation.create", stage: "hash", durationMicros: 10, byteCount: 500, provider: "codex", correlationReference: "0fcb147c-b9bd-4b83-a4d2-d33f7af040c3", outcome: "completed" }] };
    assert.equal(schema.safeParse(legacy).success, true);
    assert.equal(schema.safeParse({ ...legacy, fingerprint }).success, true);
    const drain = resultSchemaFor("daemon.drain")!;
    const unchangedDrain = { draining: false, activeJobs: 0, updateDeferred: false };
    assert.equal(drain.safeParse(unchangedDrain).success, true);
    assert.equal(drain.safeParse({ ...unchangedDrain, fingerprint }).success, false);
    for (const invalid of [{ ...fingerprint, completedCache: true }, { ...fingerprint, workerLimit: 3 }, { ...fingerprint, secret: "forbidden" }, { ...fingerprint, stageObservations: [{ ...fingerprint.stageObservations[0], answers: "forbidden" }] }, { ...fingerprint, stageObservations: [{ ...fingerprint.stageObservations[0], outcome: "verified" }] }])
        assert.equal(schema.safeParse({ ...legacy, fingerprint: invalid }).success, false);
});
test("new diagnostics strips its opt-in for older daemon and ordinary readiness stays empty for a capable daemon", async () => {
    const { FakeRunner } = await import("./fake-runner.js");
    const { LocalControlClient } = await import("../src/local-control.js");
    const legacy = { version: "0.4.0", protocol: "loomex.local-control/v1", activeJobs: 0, draining: false, updateDeferred: false };
    for (const supports of [false, true]) {
        const { REQUIRED_RUNNER_CAPABILITIES } = await import("../src/tool-catalog.js");
        const runner: InstanceType<typeof FakeRunner> = new FakeRunner((request, socket) => { runner.respond(socket, request, legacy); }, { capabilities: [...REQUIRED_RUNNER_CAPABILITIES, ...(supports ? ["diagnostics.fingerprint/v1"] : [])] });
        await runner.start();
        const original = process.env.LOOMEX_STATE_DIR;
        process.env.LOOMEX_STATE_DIR = runner.stateDir;
        try {
            const client = new LocalControlClient();
            await client.call("status.get", { includeFingerprintDiagnostics: true }, { mutating: false });
            await client.call("status.get", {}, { mutating: false });
            assert.deepEqual(runner.requests.map(request => request.params), [supports ? { includeFingerprintDiagnostics: true } : {}, {}]);
            assert.equal(runner.requests.length, 2);
        }
        finally {
            if (original === undefined)
                delete process.env.LOOMEX_STATE_DIR;
            else
                process.env.LOOMEX_STATE_DIR = original;
            await runner.stop();
        }
    }
});
test("resource failure preserves the independently verified MCP descriptors and never reports raw initialization/resource errors", async () => {
    const { TOOL_DEFINITIONS } = await import("../src/tool-catalog.js");
    const { UI_RESOURCE_REGISTRY } = await import("../src/ui-resources.js");
    const descriptors = TOOL_DEFINITIONS.map(tool => ({ name: tool.name, inputSchema: { type: "object" }, ...(tool.uiUri ? { _meta: { ui: { resourceUri: tool.uiUri }, "openai/outputTemplate": tool.uiUri } } : {}) }));
    const dir = await mkdtemp(join(tmpdir(), "loomex-resource-failure-"));
    const script = join(dir, "fixture.mjs");
    await writeFile(script, `import {createInterface} from 'node:readline';\nconst tools=${JSON.stringify(descriptors)},resources=${JSON.stringify(UI_RESOURCE_REGISTRY.map(resource => ({ name: resource.name, uri: resource.uri })))};\nfor await(const line of createInterface({input:process.stdin})){const request=JSON.parse(line);if(request.id===undefined)continue;let result;if(request.method==='initialize')result={protocolVersion:request.params.protocolVersion,capabilities:{tools:{},resources:{}},serverInfo:{name:'resource-error-fixture',version:${JSON.stringify(packageMetadata.version)}}};else if(request.method==='tools/list')result={tools};else if(request.method==='resources/list')result={resources};else{process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:request.id,error:{code:-32603,message:'private-resource-canary'}})+'\\n');continue;}process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:request.id,result})+'\\n');}`);
    try {
        const result = await inspectPackagedMcp(process.execPath, [script]);
        assert.equal(result.mcp.state, "verified");
        assert.equal(result.resources.state, "unknown");
        assert.equal(result.resources.code, "resource_unavailable");
        assert.ok(!JSON.stringify(result).includes("private-resource-canary"));
    }
    finally {
        await rm(dir, { recursive: true, force: true });
    }
});
