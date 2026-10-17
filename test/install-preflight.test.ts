import { test } from "node:test";
import * as assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { gzipSync } from "node:zlib";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, lstatSync, readlinkSync, rmSync, realpathSync, symlinkSync, renameSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
const digest = (value: Buffer) => createHash("sha256").update(value).digest("hex");
const canonical = (value: unknown): Buffer => { const stable = (item: any): any => Array.isArray(item) ? item.map(stable) : item && typeof item === "object" ? Object.fromEntries(Object.keys(item).sort().map(key => [key, stable(item[key])])) : item; return Buffer.from(JSON.stringify(stable(value)) + "\n"); };
function release(root: string, suffix = "", version = "0.1.0") {
  mkdirSync(root); const files: Record<string, Buffer> = {
    "plugin/.codex-plugin/plugin.json": canonical({ name: "loomex", version }),
    ".agents/plugins/marketplace.json": canonical({ name: "loomex-private", plugins: [{ name: "loomex", version, source: { source: "local", path: "./plugin" } }] }),
  };
  for (const path of ["runtime/bin/node", "dist/server.js", "dist/lifecycle.mjs", "dist/compatibility-export.mjs", "dist/compatibility-check.mjs", "hooks/lifecycle-adapter.mjs", ".mcp.template.json"]) files[`plugin/${path}`] = Buffer.from("fixture" + suffix);
  const tar: Buffer[] = []; const inventory = Object.keys(files).sort().map(path => {
    const body = files[path]!; const header = Buffer.alloc(512); header.write(path); header.write("0000644\0", 100); header.write(body.length.toString(8).padStart(11, "0") + "\0", 124); header.write("0", 156); tar.push(header, body, Buffer.alloc((512 - body.length % 512) % 512)); return { path, sha256: digest(body), size: body.length, mode: 0o644 };
  });
  const archive = gzipSync(Buffer.concat([...tar, Buffer.alloc(1024)])); writeFileSync(join(root, "payload.tar.gz"), archive);
  const source = canonical({ schema: "app.loomex.source-content/v1", sourceRevision: "test", files: [] }); writeFileSync(join(root, "source.json"), source);
  writeFileSync(join(root, "manifest.json"), canonical({ schema: "app.loomex.release/v1", project: "loomex-plugin", platform: "darwin-arm64", version, sourceRevision: "test", developmentOnly: true, sourceContent: { file: "source.json", sha256: digest(source), files: 0 }, payload: { file: "payload.tar.gz", sha256: digest(archive), files: inventory } }));
}
function snapshot(root: string): unknown { return readdirSync(root).sort().map(name => { const path = join(root, name); const st = lstatSync(path); return [name, st.mode, st.isSymbolicLink() ? readlinkSync(path) : st.isDirectory() ? snapshot(path) : digest(readFileSync(path))]; }); }
const manager = process.env.LOOMEX_TEST_LIFECYCLE_MANAGER ?? resolve("dist/lifecycle.mjs");
function run(action: string, base: string, candidate: string, extra: string[] = [], env: Record<string, string> = {}) { return spawnSync(process.execPath, [manager, action, "--release", candidate, "--install-base", base, "--allow-unsigned-development", ...extra], { encoding: "utf8", env: { ...process.env, LOOMEX_ALLOW_UNSAFE_DEV_INSTALL: "1", ...env } }); }
test("install preflight is read-only for fresh, pending, unsafe and conflicting states", () => {
  const fixture = realpathSync(mkdtempSync(join(tmpdir(), "loomex-preflight-")));
  try {
    const candidate = join(fixture, "release"); release(candidate); const base = join(fixture, "install");
    const before = snapshot(fixture); const good = run("preflight", base, candidate); assert.equal(good.status, 0, good.stderr); assert.equal(JSON.parse(good.stdout).activation.state, "fresh"); assert.equal(JSON.parse(good.stdout).hostRegistration.verified, false); assert.deepEqual(snapshot(fixture), before);
    mkdirSync(base); symlinkSync(candidate, join(base, "versions")); const unsafe = snapshot(fixture); assert.notEqual(run("preflight", base, candidate).status, 0); assert.deepEqual(snapshot(fixture), unsafe); rmSync(join(base, "versions"));
    // Create a real pending owner journal through the existing fault boundary.
    const interrupted = run("install", base, candidate, [], { LOOMEX_PLUGIN_INSTALL_FAIL_PHASE: "prepared" }); assert.notEqual(interrupted.status, 0);
    const pending = snapshot(fixture); const recovery = run("preflight", base, candidate); assert.equal(recovery.status, 0, recovery.stderr); assert.equal(JSON.parse(recovery.stdout).pendingRecovery.required, true); assert.deepEqual(snapshot(fixture), pending);
    const changed = join(fixture, "changed"); release(changed, "different"); const mismatch = snapshot(fixture); assert.notEqual(run("preflight", base, changed).status, 0); assert.deepEqual(snapshot(fixture), mismatch);
    const manifestPath = join(candidate, "manifest.json"); const originalManifest = readFileSync(manifestPath); writeFileSync(manifestPath, canonical({ ...JSON.parse(originalManifest.toString()), sourceDateEpoch: 2 })); const replaced = snapshot(fixture); assert.notEqual(run("preflight", base, candidate).status, 0); assert.deepEqual(snapshot(fixture), replaced); writeFileSync(manifestPath, originalManifest);
    const journal = join(base, "lifecycle.json"); const data = JSON.parse(readFileSync(journal, "utf8")); data.operation = "uninstall"; data.target = data.installRoot; data.targets = [data.target]; writeFileSync(journal, canonical(data)); const conflict = snapshot(fixture); assert.notEqual(run("preflight", base, candidate).status, 0); assert.deepEqual(snapshot(fixture), conflict);
    const status = spawnSync(process.execPath, [manager, "status", "--install-base", base], { encoding: "utf8" }); assert.equal(JSON.parse(status.stdout).operation.recoveryRequired, true);
  } finally { rmSync(fixture, { recursive: true, force: true }); }
});
test("preflight validates installed inventory/helper and same-version immutable identity", () => {
  const fixture = realpathSync(mkdtempSync(join(tmpdir(), "loomex-preflight-owned-")));
  try {
    const candidate = join(fixture, "release"); release(candidate); const base = join(fixture, "install");
    const installed = run("install", base, candidate); assert.equal(installed.status, 0, installed.stderr);
    const goodBefore = snapshot(fixture); const good = run("preflight", base, candidate); assert.equal(good.status, 0, good.stderr); assert.equal(JSON.parse(good.stdout).activation.state, "already-installed"); assert.deepEqual(snapshot(fixture), goodBefore);
    const changed = join(fixture, "changed"); release(changed, "different"); const mismatch = snapshot(fixture); const refused = run("preflight", base, changed); assert.notEqual(refused.status, 0); assert.equal(JSON.parse(refused.stdout).error.category, "OWNER_BINDING_MISMATCH"); assert.deepEqual(snapshot(fixture), mismatch);
    writeFileSync(join(base, ".lifecycle-runtime/lifecycle.mjs"), "modified helper"); const helper = snapshot(fixture); assert.notEqual(run("preflight", base, candidate).status, 0); assert.notEqual(run("install", base, candidate).status, 0); assert.deepEqual(snapshot(fixture), helper);
    writeFileSync(join(base, "versions/0.1.0/plugin/dist/server.js"), "modified inventory"); const inventory = snapshot(fixture); assert.notEqual(run("preflight", base, candidate).status, 0); assert.deepEqual(snapshot(fixture), inventory);
  } finally { rmSync(fixture, { recursive: true, force: true }); }
});
test("resume accepts a switched current link before its bytes journal advances", () => {
  const fixture = realpathSync(mkdtempSync(join(tmpdir(), "loomex-switch-window-")));
  try {
    const candidate = join(fixture, "release"); release(candidate); const base = join(fixture, "install");
    assert.notEqual(run("install", base, candidate, [], { LOOMEX_PLUGIN_INSTALL_FAIL_PHASE: "bytes" }).status, 0);
    symlinkSync(join(base, "versions/0.1.0"), join(base, "current"));
    const before = snapshot(fixture); const observed = run("preflight", base, candidate); assert.equal(observed.status, 0, observed.stderr); assert.deepEqual(snapshot(fixture), before);
    // A second interruption can leave current/marketplace published while the
    // fresh install has not written a receipt yet. oldTarget can now be self.
    const journal = join(base, "lifecycle.json"); const state = JSON.parse(readFileSync(journal, "utf8")); state.phase = "current"; state.oldTarget = state.installRoot; writeFileSync(journal, canonical(state));
    mkdirSync(join(base, ".agents/plugins"), { recursive: true }); writeFileSync(join(base, ".agents/plugins/marketplace.json"), canonical({ name: "loomex-private", plugins: [{ name: "loomex", version: "0.1.0", source: { source: "local", path: "./current/plugin" } }] }));
    const published = snapshot(fixture); const publishedCheck = run("preflight", base, candidate); assert.equal(publishedCheck.status, 0, publishedCheck.stderr); assert.deepEqual(snapshot(fixture), published);
    const resumed = run("resume", base, candidate); assert.equal(resumed.status, 0, resumed.stderr); assert.equal(JSON.parse(spawnSync(process.execPath, [manager, "status", "--install-base", base], { encoding: "utf8" }).stdout).operation, null);
  } finally { rmSync(fixture, { recursive: true, force: true }); }
});
test("resume repairs only an expected partial helper from verified extracted payload", () => {
  const fixture = realpathSync(mkdtempSync(join(tmpdir(), "loomex-helper-window-")));
  try {
    const candidate = join(fixture, "release"); release(candidate); const base = join(fixture, "install");
    assert.notEqual(run("install", base, candidate, [], { LOOMEX_PLUGIN_INSTALL_FAIL_PHASE: "moved" }).status, 0);
    renameSync(join(base, "versions/0.1.0"), join(base, ".stage-0.1.0/payload")); rmSync(join(base, ".lifecycle-runtime/lifecycle.mjs"));
    const before = snapshot(fixture); const observed = run("preflight", base, candidate); assert.equal(observed.status, 0, observed.stderr); assert.deepEqual(snapshot(fixture), before);
    writeFileSync(join(base, ".lifecycle-runtime/node"), "tampered"); const damaged = snapshot(fixture); assert.notEqual(run("preflight", base, candidate).status, 0); assert.deepEqual(snapshot(fixture), damaged); writeFileSync(join(base, ".lifecycle-runtime/node"), "fixture");
    const resumed = run("resume", base, candidate); assert.equal(resumed.status, 0, resumed.stderr);
  } finally { rmSync(fixture, { recursive: true, force: true }); }
});
test("post-extraction resume uses verified journal bytes after release removal", () => {
  const fixture = realpathSync(mkdtempSync(join(tmpdir(), "loomex-release-window-")));
  try {
    const candidate = join(fixture, "release"); release(candidate); const base = join(fixture, "install");
    assert.notEqual(run("install", base, candidate, [], { LOOMEX_PLUGIN_INSTALL_FAIL_PHASE: "moved" }).status, 0); rmSync(candidate, { recursive: true });
    const before = snapshot(fixture); assert.notEqual(run("preflight", base, candidate).status, 0); assert.deepEqual(snapshot(fixture), before);
    const resumed = run("resume", base, candidate); assert.equal(resumed.status, 0, resumed.stderr);
  } finally { rmSync(fixture, { recursive: true, force: true }); }
});
test("upgrade resumes a switched current with prior owned metadata and mixed expected helper", () => {
  const fixture = realpathSync(mkdtempSync(join(tmpdir(), "loomex-upgrade-window-")));
  try {
    const previous = join(fixture, "previous"); release(previous); const candidate = join(fixture, "release"); release(candidate, "new", "0.1.1"); const base = join(fixture, "install");
    assert.equal(run("install", base, previous).status, 0);
    assert.notEqual(run("install", base, candidate, [], { LOOMEX_PLUGIN_INSTALL_FAIL_PHASE: "moved" }).status, 0);
    // First helper copy has published candidate node; the old manager remains.
    writeFileSync(join(base, ".lifecycle-runtime/lifecycle.mjs"), "fixture");
    const partial = snapshot(fixture); const checked = run("preflight", base, candidate); assert.equal(checked.status, 0, checked.stderr); assert.deepEqual(snapshot(fixture), partial);
    // Advance through the verified bytes boundary, then model switchCurrent's
    // rename completing before the next durable journal save.
    const journal = join(base, "lifecycle.json"); const state = JSON.parse(readFileSync(journal, "utf8")); state.phase = "bytes"; state.oldTarget = join(base, "versions/0.1.0"); writeFileSync(journal, canonical(state));
    writeFileSync(join(base, ".lifecycle-runtime/lifecycle.mjs"), "fixturenew"); rmSync(join(base, "current")); symlinkSync(join(base, "versions/0.1.1"), join(base, "current"));
    const switched = snapshot(fixture); const observed = run("preflight", base, candidate); assert.equal(observed.status, 0, observed.stderr); assert.deepEqual(snapshot(fixture), switched);
    const resumed = run("resume", base, candidate); assert.equal(resumed.status, 0, resumed.stderr);
  } finally { rmSync(fixture, { recursive: true, force: true }); }
});
for (const phase of ["marketplace", "receipt", "complete"]) {
    for (const damage of ["missing-marketplace", "wrong-marketplace", ...(phase === "marketplace" ? [] : ["missing-receipt", "wrong-receipt"])]) test(`published checkpoints ${phase}/${damage}`, () => {
      const fixture = realpathSync(mkdtempSync(join(tmpdir(), "loomex-metadata-window-")));
      try {
        const candidate = join(fixture, "release"); release(candidate); const base = join(fixture, "install");
        assert.notEqual(run("install", base, candidate, [], { LOOMEX_PLUGIN_INSTALL_FAIL_PHASE: phase }).status, 0);
        const marketplace = join(base, ".agents/plugins/marketplace.json"); const receipt = join(base, "install-receipt.json");
        if (damage === "missing-marketplace") rmSync(marketplace);
        if (damage === "wrong-marketplace") { const data = JSON.parse(readFileSync(marketplace, "utf8")); data.plugins[0].version = "0.0.1"; writeFileSync(marketplace, canonical(data)); }
        if (damage === "missing-receipt") rmSync(receipt);
        if (damage === "wrong-receipt") { const data = JSON.parse(readFileSync(receipt, "utf8")); data.versions["0.1.0"].releaseManifestSha256 = "0".repeat(64); writeFileSync(receipt, canonical(data)); }
        const before = snapshot(fixture); const checked = run("preflight", base, candidate); assert.notEqual(checked.status, 0, `${phase}/${damage}: preflight accepted changed metadata`); assert.deepEqual(snapshot(fixture), before);
        const resumed = run("resume", base, candidate); assert.notEqual(resumed.status, 0, `${phase}/${damage}: resume accepted changed metadata`); assert.deepEqual(snapshot(fixture), before);
        const status = spawnSync(process.execPath, [manager, "status", "--install-base", base], { encoding: "utf8" }); assert.equal(JSON.parse(status.stdout).operation.recoveryRequired, true);
      } finally { rmSync(fixture, { recursive: true, force: true }); }
    });
  }
for (const phase of ["marketplace", "receipt", "complete"]) test(`published checkpoint ${phase} rejects prior owned marketplace`, () => {
  const fixture = realpathSync(mkdtempSync(join(tmpdir(), "loomex-stale-marketplace-")));
  try {
    const previous = join(fixture, "previous"); release(previous); const candidate = join(fixture, "release"); release(candidate, "new", "0.1.1"); const base = join(fixture, "install");
    const installed = run("install", base, previous); assert.equal(installed.status, 0, installed.stderr); const marketplace = join(base, ".agents/plugins/marketplace.json"); const prior = readFileSync(marketplace);
    assert.notEqual(run("install", base, candidate, [], { LOOMEX_PLUGIN_INSTALL_FAIL_PHASE: phase }).status, 0); writeFileSync(marketplace, prior);
    const before = snapshot(fixture); assert.notEqual(run("preflight", base, candidate).status, 0); assert.deepEqual(snapshot(fixture), before); assert.notEqual(run("resume", base, candidate).status, 0); assert.deepEqual(snapshot(fixture), before);
  } finally { rmSync(fixture, { recursive: true, force: true }); }
});

for (const phase of ["prepared", "moved", "receipt"]) for (const missing of ["partial", "missing"]) test(`staged preflight verifies exact pending cache restoration ${phase}/${missing}`, () => {
  const fixture = realpathSync(mkdtempSync(join(tmpdir(), "loomex-cache-preflight-")));
  try {
    const stable = join(fixture, "stable"); release(stable); const staged = join(fixture, "staged"); release(staged); const base = join(fixture, "install");
    assert.notEqual(run("install", base, stable, [], { LOOMEX_PLUGIN_INSTALL_FAIL_PHASE: phase }).status, 0);
    if (missing === "missing") rmSync(stable, { recursive: true }); else rmSync(join(stable, "payload.tar.gz"));
    const before = snapshot(fixture); const checked = run("preflight", base, staged, ["--expected-release-path", stable]);
    assert.equal(checked.status, 0, checked.stderr); assert.equal(JSON.parse(checked.stdout).pendingRecovery.cacheRestoreRequired, true); assert.deepEqual(snapshot(fixture), before);
    assert.notEqual(run("preflight", base, staged, ["--expected-release-path", join(fixture, "other")]).status, 0); assert.deepEqual(snapshot(fixture), before);
    for (const action of ["install", "resume", "repair", "uninstall", "status"]) { assert.notEqual(run(action, base, staged, ["--expected-release-path", stable]).status, 0); assert.deepEqual(snapshot(fixture), before); }
    const changed = join(fixture, "changed"); release(changed, "different"); const changedBefore = snapshot(fixture);
    assert.notEqual(run("preflight", base, changed, ["--expected-release-path", stable]).status, 0); assert.deepEqual(snapshot(fixture), changedBefore);
    const journal = join(base, "lifecycle.json"); const original = readFileSync(journal); const data = JSON.parse(original.toString()); data.releaseManifestSha256 = "0".repeat(64); writeFileSync(journal, canonical(data));
    const invalid = snapshot(fixture); assert.notEqual(run("preflight", base, staged, ["--expected-release-path", stable]).status, 0); assert.deepEqual(snapshot(fixture), invalid); writeFileSync(journal, original);
    const linked = join(fixture, "linked"); symlinkSync(staged, linked); const linkBefore = snapshot(fixture); assert.notEqual(run("preflight", base, linked, ["--expected-release-path", stable]).status, 0); assert.deepEqual(snapshot(fixture), linkBefore);
    mkdirSync(join(base, ".lifecycle.lock")); const locked = snapshot(fixture); assert.notEqual(run("preflight", base, staged, ["--expected-release-path", stable]).status, 0); assert.deepEqual(snapshot(fixture), locked);
  } finally { rmSync(fixture, { recursive: true, force: true }); }
});
test("staged cache preflight reports no restoration authority without pending owner and rejects journal schema", () => {
  const fixture = realpathSync(mkdtempSync(join(tmpdir(), "loomex-cache-authority-")));
  try {
    const staged = join(fixture, "staged"); release(staged); const stable = join(fixture, "stable"); const base = join(fixture, "install");
    const before = snapshot(fixture); const fresh = run("preflight", base, staged, ["--expected-release-path", stable]); assert.equal(fresh.status, 0, fresh.stderr); assert.equal(JSON.parse(fresh.stdout).pendingRecovery.cacheRestoreRequired, false); assert.deepEqual(snapshot(fixture), before);
    assert.notEqual(run("install", base, staged, [], { LOOMEX_PLUGIN_INSTALL_FAIL_PHASE: "prepared" }).status, 0);
    const journal = join(base, "lifecycle.json"); const original = readFileSync(journal); const data = JSON.parse(original.toString());
    data.operation = "uninstall"; data.target = data.installRoot; data.targets = [data.installRoot]; writeFileSync(journal, canonical(data));
    const competing = snapshot(fixture); assert.notEqual(run("preflight", base, staged, ["--expected-release-path", staged]).status, 0); assert.deepEqual(snapshot(fixture), competing);
    writeFileSync(journal, original); data.operation = "install"; data.schema = "unknown"; writeFileSync(journal, canonical(data)); const invalid = snapshot(fixture);
    assert.notEqual(run("preflight", base, staged, ["--expected-release-path", staged]).status, 0); assert.deepEqual(snapshot(fixture), invalid);
  } finally { rmSync(fixture, { recursive: true, force: true }); }
});

test("staged preflight preserves installed immutable receipt checks without pending authority", () => {
  const fixture = realpathSync(mkdtempSync(join(tmpdir(), "loomex-cache-receipt-")));
  try {
    const stable = join(fixture, "stable"); release(stable); const base = join(fixture, "install");
    assert.equal(run("install", base, stable).status, 0); rmSync(stable, { recursive: true });
    const staged = join(fixture, "staged"); release(staged); const before = snapshot(fixture);
    const checked = run("preflight", base, staged, ["--expected-release-path", stable]); assert.equal(checked.status, 0, checked.stderr); assert.equal(JSON.parse(checked.stdout).pendingRecovery.cacheRestoreRequired, false); assert.deepEqual(snapshot(fixture), before);
    const manifest = join(staged, "manifest.json"); const original = readFileSync(manifest); writeFileSync(manifest, canonical({ ...JSON.parse(original.toString()), bootstrap: { lifecycle: { sha256: "0".repeat(64) } } }));
    const changed = snapshot(fixture); assert.notEqual(run("preflight", base, staged, ["--expected-release-path", stable]).status, 0); assert.deepEqual(snapshot(fixture), changed);
  } finally { rmSync(fixture, { recursive: true, force: true }); }
});

test("preflight failures preserve fixed typed categories without outputting exception bodies or mutating files", () => {
 const fixture=realpathSync(mkdtempSync(join(tmpdir(),"loomex-preflight-failure-")));
 try {
  const candidate=join(fixture,"private-release-sentinel");release(candidate);const base=join(fixture,"install");mkdirSync(base);symlinkSync(candidate,join(base,"versions"));
  const before=snapshot(fixture);const unsafe=run("preflight",base,candidate);assert.equal(unsafe.status,1);assert.deepEqual(snapshot(fixture),before);
  const report=JSON.parse(unsafe.stdout);assert.equal(report.schema,"app.loomex.plugin.install-preflight/v1");assert.equal(report.artifact.eligible,false);assert.equal(report.activation.eligible,false);assert.equal(report.error.category,"OWNER_STATE_UNSAFE");assert.equal(report.reasonCode,"OWNER_STATE_UNSAFE");assert.equal(report.nextAction,"inspect_lifecycle_status");assert.deepEqual(report.owner,{kind:"plugin_lifecycle",schemaVersion:"app.loomex.plugin.lifecycle/v2"});assert.ok(!unsafe.stdout.includes(fixture));assert.ok(!unsafe.stderr.includes(fixture));
  rmSync(join(base,"versions"));writeFileSync(join(base,"lifecycle.json"),canonical({schema:"future-schema",operation:"install",operationId:"x",phase:"prepared"}));
  const invalid=snapshot(fixture);const unsupported=run("preflight",base,candidate);assert.equal(unsupported.status,1);assert.equal(JSON.parse(unsupported.stdout).error.category,"OWNER_SCHEMA_UNSUPPORTED");assert.deepEqual(snapshot(fixture),invalid);
  const missing=run("preflight",join(fixture,"fresh"),join(fixture,"missing-secret-sentinel"));assert.equal(missing.status,1);assert.equal(JSON.parse(missing.stdout).error.category,"OWNER_STATE_UNREADABLE");assert.ok(!missing.stdout.includes("sentinel"));assert.ok(!missing.stderr.includes("sentinel"));
 } finally {rmSync(fixture,{recursive:true,force:true});}
});
