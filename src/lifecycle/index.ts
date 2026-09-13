/*
 * The installer deliberately lives in the package.  Shell launchers only find
 * this bundle and the pinned runtime; all state transitions happen here.
 */
import { createHash, randomUUID, verify as verifySignature } from "node:crypto";
import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, readlinkSync, renameSync, rmSync, symlinkSync, unlinkSync, writeFileSync, fsyncSync, openSync, closeSync, copyFileSync, chmodSync } from "node:fs";
import { gunzipSync } from "node:zlib";
import { homedir, hostname } from "node:os";
import { basename, dirname, isAbsolute, join, normalize, relative, resolve, sep } from "node:path";
import { execFileSync } from "node:child_process";

const VERSION = /^\d+\.\d+\.\d+$/;
const LIFECYCLE_SCHEMA = "app.loomex.plugin.lifecycle/v2";
const RECEIPT_SCHEMA = "app.loomex.plugin.install-receipt/v2";
const LOCK_STALE_MS = 15 * 60 * 1000;
let lifecycleSaveCount = 0;

type Json = null | boolean | number | string | Json[] | { [key: string]: Json };
type Lifecycle = {
  schema: string; operation: "install" | "rollback" | "repair" | "uninstall";
  operationId: string; createdAt: string; updatedAt: string; phase: string;
  release?: string; version?: string; target?: string; targets?: string[];
  stage?: string; installRoot?: string; oldTarget?: string | null;
  recoveryHelper?: string;
  current: string; versions: string; marketplace: string; receipt: string;
  releaseManifestSha256?: string; payloadSha256?: string; payloadInventorySha256?: string; inventory?: Json[];
};
type Arguments = { action: string; release?: string; installBase?: string; publicKey?: string; allowDevelopment: boolean; version?: string };

function fail(message: string): never { throw new Error(message); }
function text(value: unknown): string { return typeof value === "string" ? value : fail("expected text"); }
function object(value: unknown): Record<string, unknown> { return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : fail("expected object"); }
function sha(path: string): string { return createHash("sha256").update(readFileSync(path)).digest("hex"); }
function canonical(value: Json): Buffer {
  const stable = (item: Json): Json => Array.isArray(item) ? item.map(stable) : item !== null && typeof item === "object" ? Object.fromEntries(Object.keys(item).sort().map(key => [key, stable(item[key] as Json)])) : item;
  return Buffer.from(`${JSON.stringify(stable(value))}\n`);
}
function equalJson(left: Json, right: Json): boolean { return canonical(left).equals(canonical(right)); }
function json(path: string): Record<string, unknown> {
  try { return object(JSON.parse(readFileSync(path, "utf8"))); } catch { return fail(`invalid JSON: ${path}`); }
}
function regular(path: string, message: string): void { if (!existsSync(path) || !lstatSync(path).isFile() || lstatSync(path).isSymbolicLink()) fail(message); }
function directory(path: string, message: string): void { if (!existsSync(path) || !lstatSync(path).isDirectory() || lstatSync(path).isSymbolicLink()) fail(message); }
function noLink(path: string, message: string): void { if (existsSync(path) && lstatSync(path).isSymbolicLink()) fail(message); }
function safeBase(raw: string | undefined): string {
  const base = resolve(raw ?? join(homedir(), "Library/Application Support/Loomex/plugin"));
  if (base === sep || base === resolve(homedir())) fail("unsafe install base");
  return base;
}
function inside(parent: string, child: string): boolean { const value = relative(parent, child); return value === "" || (!value.startsWith(`..${sep}`) && value !== ".."); }
function fsyncDirectory(path: string): void { const fd = openSync(path, "r"); try { fsyncSync(fd); } finally { closeSync(fd); } }
function atomicJson(path: string, value: Json): void {
  const temp = `${path}.${process.pid}.${randomUUID()}.new`;
  writeFileSync(temp, canonical(value), { flag: "wx", mode: 0o600 });
  const fd = openSync(temp, "r"); try { fsyncSync(fd); } finally { closeSync(fd); }
  renameSync(temp, path); fsyncDirectory(dirname(path));
}
function atomicCopy(source: string, destination: string, mode?: number): void {
  const temp = `${destination}.${process.pid}.${randomUUID()}.new`;
  copyFileSync(source, temp, 0); if (mode !== undefined) chmodSync(temp, mode);
  const fd = openSync(temp, "r"); try { fsyncSync(fd); } finally { closeSync(fd); }
  renameSync(temp, destination); fsyncDirectory(dirname(destination));
}
function removeFile(path: string): void { if (existsSync(path) || (() => { try { lstatSync(path); return true; } catch { return false; } })()) unlinkSync(path); }
function present(path: string): boolean { try { lstatSync(path); return true; } catch { return false; } }

function processStart(pid: number): string | null {
  // Darwin exposes a process start token through ps. It prevents PID reuse
  // from being treated as lock ownership. Failure means "do not steal".
  try {
    const output = execFileSync("/bin/ps", ["-p", String(pid), "-o", "lstart="], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
    return output.trim() || null;
  } catch { return null; }
}
type LockLiveness = "live" | "dead" | "unknown";
function lockLiveness(pid: number, started: string): LockLiveness {
  // A failed signal can mean permission denial, a sandbox boundary, or a
  // transient OS error.  Only ESRCH proves that this particular owner is gone.
  // Likewise, a missing start token must not be treated as PID reuse.
  if (process.env.LOOMEX_PLUGIN_LOCK_TEST_LIVENESS === "unknown") return "unknown";
  try { process.kill(pid, 0); }
  catch (error: unknown) {
    return typeof error === "object" && error !== null && (error as { code?: unknown }).code === "ESRCH" ? "dead" : "unknown";
  }
  const observed = processStart(pid);
  if (observed === null) return "unknown";
  return observed === started ? "live" : "dead";
}
class Lock {
  private readonly path: string;
  private readonly token = randomUUID();
  constructor(private readonly base: string, private readonly name = ".lifecycle.lock") {
    if (isAbsolute(name) || dirname(name) !== ".") fail("lifecycle lock name is invalid");
    this.path = join(base, name);
  }
  private owner(): Record<string, unknown> { return json(join(this.path, "owner.json")); }
  private ownerMatches(owner: Record<string, unknown>, token: unknown): boolean { return typeof token === "string" && owner.token === token; }
  private staleOwnerToken(owner: Record<string, unknown>): string | null {
    const host = owner.host; const pid = owner.pid; const started = owner.processStart; const created = owner.createdAt; const token = owner.token;
    if (owner.schema !== "app.loomex.plugin.lock/v1" || host !== hostname() || typeof pid !== "number" || !Number.isInteger(pid) || pid <= 0 || typeof started !== "string" || typeof created !== "string" || typeof token !== "string") return null;
    const age = Date.now() - Date.parse(created);
    if (!Number.isFinite(age) || age < LOCK_STALE_MS) return null;
    return lockLiveness(pid, started) === "dead" ? token : null;
  }
  private writePending(path: string, started: string | null): void {
    mkdirSync(path, { mode: 0o700 });
    atomicJson(join(path, "owner.json"), { schema: "app.loomex.plugin.lock/v1", token: this.token, pid: process.pid, processStart: started, host: hostname(), createdAt: new Date().toISOString() });
  }
  acquire(): void {
    const started = processStart(process.pid);
    const pending = `${this.path}.pending-${this.token}`;
    this.writePending(pending, started);
    if (process.env.LOOMEX_PLUGIN_LOCK_FAIL_PHASE === "before-publish") fail("fault injection: lifecycle lock before publish");
    try { renameSync(pending, this.path); fsyncDirectory(this.base); }
    catch {
      rmSync(pending, { recursive: true });
      if (!this.recoverStale()) fail("plugin lifecycle operation already in progress");
      // Publish a fully-described lock atomically after stale recovery.
      this.writePending(pending, started);
      try { renameSync(pending, this.path); fsyncDirectory(this.base); } catch { rmSync(pending, { recursive: true }); fail("plugin lifecycle operation already in progress"); }
    }
  }
  private recoverStale(): boolean {
    let owner: Record<string, unknown>;
    try { owner = this.owner(); } catch { return false; }
    const token = this.staleOwnerToken(owner);
    if (token === null) return false;
    // Recovery guards are lifecycle locks too.  If a process dies while it is
    // holding this guard, its own stale-lock recovery uses a nested guard.  A
    // future lifecycle operation can therefore recover a finite chain of
    // abandoned recovery attempts instead of remaining blocked forever.
    //
    // The guard remains held while the original owner is re-read and moved,
    // so a separate contender cannot replace that owner between validation
    // and rename.
    const recovery = new Lock(this.base, `${this.name}.recovery`);
    recovery.acquire();
    try {
      try { owner = this.owner(); } catch { return false; }
      if (!this.ownerMatches(owner, token) || this.staleOwnerToken(owner) !== token) return false;
      // Deterministic packaging-fixture hook: model a competing owner that
      // publishes after the first stale observation.  The second exact-owner
      // check below must leave it untouched.
      if (process.env.LOOMEX_PLUGIN_LOCK_TEST_REPLACE_OWNER_BEFORE_REREAD === "1") {
        atomicJson(join(this.path, "owner.json"), { schema: "app.loomex.plugin.lock/v1", token: "fixture-new-owner", pid: process.pid, processStart: processStart(process.pid), host: hostname(), createdAt: new Date().toISOString() });
      }
      try { owner = this.owner(); } catch { return false; }
      if (!this.ownerMatches(owner, token) || this.staleOwnerToken(owner) !== token) return false;
      // Rename preserves a forensic record and guarantees we only ever remove
      // the exact owner checked above, never a newly published lock.
      const stale = `${this.path}.stale-${this.token}`;
      renameSync(this.path, stale); fsyncDirectory(this.base);
      if (!this.ownerMatches(json(join(stale, "owner.json")), token)) fail("stale lifecycle lock ownership changed during recovery");
      rmSync(stale, { recursive: true }); fsyncDirectory(this.base);
      return true;
    } finally {
      // Do not hide a failed cleanup: callers receive a failed lifecycle
      // operation and the retained guard remains available for stale recovery.
      recovery.release();
    }
  }
  release(): void {
    const owner = this.owner();
    if (owner.token !== this.token) fail("lifecycle lock ownership changed before release");
    rmSync(this.path, { recursive: true }); fsyncDirectory(this.base);
  }
}

function paths(base: string) {
  const versions = join(base, "versions"); const current = join(base, "current");
  const marketplace = join(base, ".agents", "plugins", "marketplace.json");
  return { versions, current, marketplace, receipt: join(base, "install-receipt.json"), lifecycle: join(base, "lifecycle.json"), terminal: join(base, "lifecycle.terminal.json"), helper: join(base, ".lifecycle-runtime") };
}
function validateVersion(value: string): string { return VERSION.test(value) ? value : fail("invalid release version"); }
function currentTarget(current: string, versions: string): string {
  if (!existsSync(current) || !lstatSync(current).isSymbolicLink()) fail("current plugin target is missing");
  const raw = readlinkSync(current); const target = resolve(dirname(current), raw);
  if (!inside(versions, target) || dirname(target) !== versions || !VERSION.test(basename(target)) || lstatSync(target).isSymbolicLink()) fail("current target is not an installed version");
  directory(target, "current target is not an installed version"); return target;
}
function receiptData(p: ReturnType<typeof paths>, versions: Record<string, Json> = {}): Json { return { schema: RECEIPT_SCHEMA, currentPath: p.current, versionsPath: p.versions, marketplacePath: p.marketplace, versions }; }
function receiptVersions(p: ReturnType<typeof paths>): Record<string, Json> {
  if (!existsSync(p.receipt)) return {};
  const receipt = json(p.receipt); if (receipt.schema !== RECEIPT_SCHEMA || receipt.currentPath !== p.current || receipt.versionsPath !== p.versions || receipt.marketplacePath !== p.marketplace) fail("unexpected plugin ownership receipt");
  return object(receipt.versions) as Record<string, Json>;
}
function marketplaceData(template: string, version: string): Json {
  const data = json(template); const entries = data.plugins;
  if (data.name !== "loomex-private" || !Array.isArray(entries) || entries.length !== 1) fail("verified marketplace template has an unexpected identity or source");
  const entry = object(entries[0]); const source = object(entry.source);
  if (entry.name !== "loomex" || entry.version !== version || source.source !== "local" || source.path !== "./plugin") fail("verified marketplace template has an unexpected identity or source");
  source.path = "./current/plugin"; return data as Json;
}
function validatePayload(root: string, version: string, expectedRoot?: string): void {
  const plugin = join(root, "plugin"); directory(plugin, "release payload is missing plugin");
  const manifest = json(join(plugin, ".codex-plugin", "plugin.json"));
  if (manifest.name !== "loomex" || manifest.version !== version) fail("unexpected plugin identity");
  for (const file of [join(plugin, "runtime", "bin", "node"), join(plugin, "dist", "server.js"), join(plugin, "dist", "lifecycle.mjs"), join(plugin, "dist", "compatibility-export.mjs"), join(plugin, "dist", "compatibility-check.mjs"), join(plugin, "hooks", "lifecycle-adapter.mjs")]) regular(file, `plugin package is missing ${relative(plugin, file)}`);
  regular(join(plugin, ".mcp.template.json"), "MCP template is missing");
  const market = join(root, ".agents", "plugins", "marketplace.json"); regular(market, "private marketplace descriptor is missing");
  marketplaceData(market, version);
  for (const entry of readdirSync(root, { recursive: true })) {
    const parts = String(entry).split(/[\\/]/); if (parts.some(part => [".git", "node_modules", ".test-dist", ".cache", ".npm", "coverage", "__pycache__", ".DS_Store"].includes(part) || part.startsWith(".env") || /credential|secret/i.test(part))) fail(`forbidden packaged path: ${entry}`);
  }
  if (expectedRoot) {
    const launcher = json(join(plugin, ".mcp.json")); const server = object(object(launcher.mcpServers).loomex);
    const args = server.args; if (server.command !== join(expectedRoot, "plugin", "runtime", "bin", "node") || !Array.isArray(args) || args.length !== 1 || args[0] !== join(expectedRoot, "plugin", "dist", "server.js")) fail("MCP launcher paths must bind the installed current root");
  }
}
function renderMcp(root: string, stableCurrent: string): void {
  const plugin = join(root, "plugin"); const node = join(stableCurrent, "plugin", "runtime", "bin", "node"); const server = join(stableCurrent, "plugin", "dist", "server.js");
  regular(join(plugin, "runtime", "bin", "node"), "installed Node runtime is missing"); regular(join(plugin, "dist", "server.js"), "installed MCP entrypoint is missing");
  atomicJson(join(plugin, ".mcp.json"), { mcpServers: { loomex: { command: node, args: [server] } } });
}
function loadLifecycle(path: string): Lifecycle {
  const value = json(path) as Lifecycle;
  if (value.schema !== LIFECYCLE_SCHEMA || !["install", "rollback", "repair", "uninstall"].includes(value.operation) || typeof value.operationId !== "string" || typeof value.phase !== "string") fail("unsupported plugin lifecycle journal");
  return value;
}
function saveLifecycle(path: string, state: Lifecycle): void {
  lifecycleSaveCount += 1;
  if (process.env.LOOMEX_PLUGIN_LIFECYCLE_FAIL_WRITE === "after-first" && lifecycleSaveCount === 2) fail("fault injection: lifecycle durable write");
  state.updatedAt = new Date().toISOString(); atomicJson(path, state as unknown as Json);
}
function failPhase(operation: string, phase: string): void { if (process.env[`LOOMEX_PLUGIN_${operation.toUpperCase()}_FAIL_PHASE`] === phase) fail(`fault injection: ${operation} phase ${phase}`); }
function samePaths(state: Lifecycle, p: ReturnType<typeof paths>): boolean {
  return state.current === p.current && state.versions === p.versions && state.marketplace === p.marketplace && state.receipt === p.receipt;
}
function validateLifecycleBinding(state: Lifecycle, p: ReturnType<typeof paths>): void {
  if (!samePaths(state, p)) fail("plugin lifecycle journal belongs to a different installation");
  if (state.operation === "install") {
    const version = validateVersion(text(state.version)); const stage = text(state.stage); const installRoot = text(state.installRoot);
    if (!state.release || !isAbsolute(state.release) || dirname(installRoot) !== p.versions || !inside(dirname(p.current), stage) || dirname(stage) !== dirname(p.current) || basename(installRoot) !== version) fail("install lifecycle target mismatch");
    return;
  }
  if (state.recoveryHelper !== undefined && state.recoveryHelper !== join(dirname(p.helper), `.lifecycle-runtime.recovery-${state.operationId}`)) fail("plugin lifecycle recovery helper is invalid");
  const target = text(state.target);
  if (dirname(target) !== p.versions || !VERSION.test(basename(target))) fail("plugin lifecycle target mismatch");
  if (state.operation === "uninstall") {
    if (!Array.isArray(state.targets) || state.targets.length === 0 || state.targets.some(item => typeof item !== "string" || dirname(item) !== p.versions || !VERSION.test(basename(item)))) fail("uninstall lifecycle targets are invalid");
    if (!state.targets.includes(target)) fail("uninstall lifecycle current target is invalid");
  }
}
function lifecycleSummary(state: Lifecycle): Json {
  return { operation: state.operation, operationId: state.operationId, phase: state.phase, version: state.version ?? (state.target ? basename(state.target) : null), recoveryRequired: true };
}
function lifecycleResult(p: ReturnType<typeof paths>, action: string, status: "completed" | "pending" | "not-installed"): void {
  let current: string | null = null;
  try { if (present(p.current)) current = basename(currentTarget(p.current, p.versions)); } catch { current = "invalid"; }
  const operation = present(p.lifecycle) ? lifecycleSummary(loadLifecycle(p.lifecycle)) : null;
  console.log(JSON.stringify({ schema: "app.loomex.plugin.lifecycle-result/v1", action, status, installBase: dirname(p.current), current, operation }, null, 2));
}
function completeLifecycle(p: ReturnType<typeof paths>, state: Lifecycle, cleanup?: () => void): void {
  if (state.phase !== "complete") { state.phase = "complete"; saveLifecycle(p.lifecycle, state); }
  // The completed journal remains the recovery receipt until every required
  // cleanup succeeds.  If cleanup throws, a later resume observes the exact
  // same completed operation instead of reporting success.
  cleanup?.();
  unlinkSync(p.lifecycle); fsyncDirectory(dirname(p.lifecycle));
}
function lifecycleRuntime(root: string): void {
  directory(root, "lifecycle recovery helper is invalid");
  regular(join(root, "node"), "lifecycle recovery helper is invalid");
  regular(join(root, "lifecycle.mjs"), "lifecycle recovery helper is invalid");
}
function retainRecoveryHelper(p: ReturnType<typeof paths>, state: Lifecycle): void {
  const recovery = join(dirname(p.helper), `.lifecycle-runtime.recovery-${state.operationId}`);
  if (state.recoveryHelper === undefined) { state.recoveryHelper = recovery; saveLifecycle(p.lifecycle, state); }
  if (state.recoveryHelper !== recovery) fail("plugin lifecycle recovery helper is invalid");
  if (present(recovery)) { lifecycleRuntime(recovery); return; }
  if (!present(p.helper)) fail("lifecycle helper disappeared before recovery handoff");
  noLink(p.helper, "lifecycle helper path may not be a symlink"); noLink(recovery, "lifecycle recovery helper may not be a symlink");
  renameSync(p.helper, recovery); fsyncDirectory(dirname(p.helper)); lifecycleRuntime(recovery);
}
function terminalizeUninstall(p: ReturnType<typeof paths>, state: Lifecycle): void {
  if (present(p.terminal)) {
    const terminal = loadLifecycle(p.terminal); if (terminal.operationId !== state.operationId || terminal.operation !== "uninstall" || terminal.phase !== "complete") fail("unexpected terminal plugin lifecycle journal");
    return;
  }
  renameSync(p.lifecycle, p.terminal); fsyncDirectory(dirname(p.lifecycle));
}
function cleanupTerminalUninstall(p: ReturnType<typeof paths>, state: Lifecycle): void {
  const recovery = text(state.recoveryHelper);
  if (dirname(recovery) !== dirname(p.helper) || basename(recovery) !== `.lifecycle-runtime.recovery-${state.operationId}`) fail("plugin lifecycle recovery helper is invalid");
  failPhase("uninstall", "after-terminal-journal");
  if (present(recovery)) { lifecycleRuntime(recovery); rmSync(recovery, { recursive: true }); fsyncDirectory(dirname(recovery)); }
  failPhase("uninstall", "after-helper-delete");
  unlinkSync(p.terminal); fsyncDirectory(dirname(p.terminal));
}

function archiveMember(name: string): string {
  const normalized = name.endsWith("/") ? name.slice(0, -1) : name;
  if (!normalized || normalized.startsWith("/") || normalized.includes("\\") || normalized.split("/").some(part => part === ".." || part === "")) fail(`unsafe archive member: ${name}`);
  return normalized;
}
function octal(bytes: Buffer): number { const raw = bytes.toString("utf8").replace(/\0.*$/, "").trim(); return raw ? Number.parseInt(raw, 8) : 0; }
function extractVerified(release: string, target: string, publicKey: string | undefined, allowDevelopment: boolean): { version: string; developmentOnly: boolean; manifestSha256: string; payloadSha256: string; inventorySha256: string; inventory: Json[] } {
  const manifestPath = join(release, "manifest.json"); regular(manifestPath, "release manifest missing"); const manifestBytes = readFileSync(manifestPath); const manifest = json(manifestPath);
  if (!manifestBytes.equals(canonical(manifest as Json)) || manifest.schema !== "app.loomex.release/v1" || manifest.project !== "loomex-plugin" || manifest.platform !== "darwin-arm64") fail("release manifest provenance mismatch");
  const version = validateVersion(text(manifest.version)); const development = manifest.developmentOnly === true;
  if (development) { if (!allowDevelopment || process.env.LOOMEX_ALLOW_UNSAFE_DEV_INSTALL !== "1") fail("set LOOMEX_ALLOW_UNSAFE_DEV_INSTALL=1 for isolated development installs"); }
  else { if (!publicKey) fail("signed artifact and trusted public key are required"); regular(join(release, "manifest.sig"), "signed artifact and trusted public key are required"); if (!verifySignature("RSA-SHA256", manifestBytes, readFileSync(publicKey), readFileSync(join(release, "manifest.sig")))) fail("release manifest signature mismatch"); }
  const payload = object(manifest.payload); const archiveName = archiveMember(text(payload.file)); const archive = join(release, archiveName); regular(archive, "release payload missing"); if (sha(archive) !== text(payload.sha256)) fail("payload digest mismatch");
  const provenance = object(manifest.sourceContent); const sourceFile = join(release, archiveMember(text(provenance.file))); regular(sourceFile, "source content manifest missing"); if (sha(sourceFile) !== text(provenance.sha256)) fail("source content manifest digest mismatch");
  const source = json(sourceFile); if (!readFileSync(sourceFile).equals(canonical(source as Json)) || source.schema !== "app.loomex.source-content/v1" || source.sourceRevision !== manifest.sourceRevision || !Array.isArray(source.files) || source.files.length !== provenance.files) fail("source content manifest is invalid");
  if (existsSync(target)) fail("extraction destination already exists"); mkdirSync(target, { recursive: true, mode: 0o700 });
  const bytes = gunzipSync(readFileSync(archive)); let offset = 0;
  while (offset + 512 <= bytes.length) {
    const header = bytes.subarray(offset, offset + 512); if (header.every(byte => byte === 0)) break;
    const name = header.subarray(0, 100).toString("utf8").replace(/\0.*$/, ""); const prefix = header.subarray(345, 500).toString("utf8").replace(/\0.*$/, ""); const member = archiveMember(prefix ? `${prefix}/${name}` : name); const size = octal(header.subarray(124, 136)); const type = header.subarray(156, 157).toString("utf8") || "0"; const destination = join(target, member);
    if (!inside(target, destination)) fail(`unsafe archive member: ${member}`);
    const body = bytes.subarray(offset + 512, offset + 512 + size); if (body.length !== size) fail("truncated release archive");
    if (type === "5") { mkdirSync(destination, { recursive: true, mode: octal(header.subarray(100, 108)) || 0o755 }); }
    else if (type === "0" || type === "\0") { mkdirSync(dirname(destination), { recursive: true, mode: 0o700 }); writeFileSync(destination, body, { flag: "wx", mode: octal(header.subarray(100, 108)) || 0o644 }); }
    else fail(`unsupported archive member: ${member}`);
    offset += 512 + Math.ceil(size / 512) * 512;
  }
  const expected = payload.files; if (!Array.isArray(expected)) fail("payload inventory is invalid");
  const actual: Array<Record<string, Json>> = [];
  const walk = (dir: string): void => { for (const name of readdirSync(dir).sort()) { const file = join(dir, name); const stat = lstatSync(file); if (stat.isSymbolicLink()) fail("release payload may not contain symlinks"); if (stat.isDirectory()) walk(file); else if (stat.isFile()) actual.push({ path: relative(target, file).split(sep).join("/"), sha256: sha(file), size: stat.size, mode: stat.mode & 0o7777 }); else fail("unsupported release payload entry"); } };
  walk(target); actual.sort((a, b) => String(a.path) < String(b.path) ? -1 : String(a.path) > String(b.path) ? 1 : 0);
  if (!canonical(actual as Json).equals(canonical(expected as Json))) {
    const expectedList = expected as Json[];
    const index = actual.findIndex((entry, position) => !equalJson(entry, expectedList[position] as Json));
    fail(`payload inventory mismatch at ${index < 0 ? "unknown entry" : String(actual[index]?.path)}: actual=${JSON.stringify(actual[index])} expected=${JSON.stringify(expectedList[index])}`);
  }
  return { version, developmentOnly: development, manifestSha256: sha(manifestPath), payloadSha256: sha(archive), inventorySha256: createHash("sha256").update(canonical(expected as Json)).digest("hex"), inventory: expected as Json[] };
}

function installedInventory(root: string): Json[] {
  const result: Json[] = []; const walk = (dir: string): void => { for (const name of readdirSync(dir).sort()) { const file = join(dir, name); const stat = lstatSync(file); if (stat.isSymbolicLink()) fail("installed version contains a symlink"); if (stat.isDirectory()) walk(file); else if (stat.isFile()) { const path = relative(root, file).split(sep).join("/"); if (path !== "plugin/.mcp.json") result.push({ path, sha256: sha(file), size: stat.size, mode: stat.mode & 0o7777 }); } else fail("installed version contains an unsupported entry"); } }; walk(root); result.sort((a, b) => String(object(a).path) < String(object(b).path) ? -1 : String(object(a).path) > String(object(b).path) ? 1 : 0); return result;
}
function verifyRecordedVersion(p: ReturnType<typeof paths>, target: string): void {
  const version = basename(target); const record = object(receiptVersions(p)[version]); const inventory = record.inventory;
  if (typeof record.releaseManifestSha256 !== "string" || typeof record.payloadSha256 !== "string" || typeof record.payloadInventorySha256 !== "string" || !Array.isArray(inventory) || createHash("sha256").update(canonical(inventory as Json)).digest("hex") !== record.payloadInventorySha256 || !equalJson(installedInventory(target) as Json, inventory as Json)) fail("installed version does not match its verified release inventory");
}
function verifyJournaledInstallBytes(state: Lifecycle, installRoot: string): void {
  const inventory = state.inventory;
  if (!Array.isArray(inventory) || typeof state.payloadInventorySha256 !== "string" || typeof state.payloadSha256 !== "string" || typeof state.releaseManifestSha256 !== "string") fail("verified install metadata is missing");
  if (createHash("sha256").update(canonical(inventory as Json)).digest("hex") !== state.payloadInventorySha256) fail("install lifecycle inventory digest is invalid");
  if (!equalJson(installedInventory(installRoot) as Json, inventory as Json)) fail("installed version does not match the verified install lifecycle inventory");
}

function verifyOwnership(p: ReturnType<typeof paths>): string {
  directory(p.versions, "versions directory is missing"); noLink(p.versions, "versions directory may not be a symlink"); const metadataRoot = dirname(dirname(p.marketplace)); const marketplaceDirectory = dirname(p.marketplace); directory(metadataRoot, "marketplace metadata directories must be regular directories"); directory(marketplaceDirectory, "marketplace metadata directories must be regular directories"); noLink(metadataRoot, "marketplace metadata directories must be regular directories"); noLink(marketplaceDirectory, "marketplace metadata directories must be regular directories"); regular(p.receipt, "complete Loomex plugin ownership metadata is required"); regular(p.marketplace, "complete Loomex plugin ownership metadata is required");
  receiptVersions(p);
  const target = currentTarget(p.current, p.versions); const version = basename(target); const market = marketplaceData(join(target, ".agents", "plugins", "marketplace.json"), version);
  if (!equalJson(json(p.marketplace) as Json, market)) fail("unexpected installed marketplace metadata"); verifyRecordedVersion(p, target); return target;
}
function ensureHelper(p: ReturnType<typeof paths>, payload: string): void {
  noLink(p.helper, "lifecycle helper path may not be a symlink"); if (!existsSync(p.helper)) mkdirSync(p.helper, { mode: 0o700 }); directory(p.helper, "lifecycle helper path is invalid");
  atomicCopy(join(payload, "plugin", "runtime", "bin", "node"), join(p.helper, "node"), 0o755);
  atomicCopy(join(payload, "plugin", "dist", "lifecycle.mjs"), join(p.helper, "lifecycle.mjs"), 0o600);
}
function switchCurrent(p: ReturnType<typeof paths>, target: string): void { const next = join(dirname(p.current), `.current.${randomUUID()}.new`); symlinkSync(target, next); renameSync(next, p.current); fsyncDirectory(dirname(p.current)); }

function install(args: Arguments): void {
  if (!args.release) fail("usage: install RELEASE_DIR [--public-key FILE | --allow-unsigned-development] [--install-base DIR]");
  const release = resolve(args.release); const p = paths(safeBase(args.installBase)); mkdirSync(dirname(p.current), { recursive: true, mode: 0o700 }); noLink(p.versions, "versions directory may not be a symlink"); if (!existsSync(p.versions)) mkdirSync(p.versions, { mode: 0o700 }); directory(p.versions, "versions directory may not be a symlink");
  let state: Lifecycle; if (existsSync(p.lifecycle)) { state = loadLifecycle(p.lifecycle); validateLifecycleBinding(state, p); if (state.operation !== "install" || state.release !== release || !state.version) fail("unfinished plugin lifecycle is not this install"); } else {
    if (present(p.current)) verifyOwnership(p);
    else for (const candidate of [p.marketplace, `${p.marketplace}.new`, p.receipt, `${p.receipt}.new`]) if (present(candidate)) fail(`unowned marketplace metadata already exists: ${candidate}`);
    directory(release, "release directory missing"); const manifestPath = join(release, "manifest.json"); const manifest = json(manifestPath); const version = validateVersion(text(manifest.version)); const installRoot = join(p.versions, version); if (present(installRoot)) fail(`version ${version} is already installed; refusing to overwrite signed files`); const stage = join(dirname(p.current), `.stage-${version}`); state = { schema: LIFECYCLE_SCHEMA, operation: "install", operationId: randomUUID(), createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), phase: "prepared", release, version, stage, installRoot, oldTarget: null, current: p.current, versions: p.versions, marketplace: p.marketplace, receipt: p.receipt, releaseManifestSha256: sha(manifestPath) }; saveLifecycle(p.lifecycle, state);
  }
  const stage = text(state.stage); const installRoot = text(state.installRoot); const version = validateVersion(text(state.version));
  if (!["prepared", "extracted", "bytes", "current", "marketplace", "receipt", "complete"].includes(state.phase)) fail("unsupported install lifecycle phase");
  if (state.phase === "prepared") {
    failPhase("install", "prepared");
    directory(release, "release directory missing; resume requires the exact release until extraction is verified");
    if (!state.releaseManifestSha256 || sha(join(release, "manifest.json")) !== state.releaseManifestSha256) fail("release manifest changed; refusing to resume a different install package");
    if (existsSync(installRoot)) fail(`version ${version} is already installed; refusing to overwrite signed files`);
    // A stage is trusted only after this checkpoint has been atomically
    // committed. Interrupted extraction is removed and extracted again.
    if (existsSync(stage)) rmSync(stage, { recursive: true, force: true }); mkdirSync(stage, { mode: 0o700 });
    const verified = extractVerified(release, join(stage, "payload"), args.publicKey, args.allowDevelopment);
    if (verified.manifestSha256 !== state.releaseManifestSha256) fail("release manifest changed during verification");
    state.payloadSha256 = verified.payloadSha256; state.payloadInventorySha256 = verified.inventorySha256; state.inventory = verified.inventory; state.phase = "extracted"; saveLifecycle(p.lifecycle, state);
  }
  const payload = state.phase === "extracted" ? join(stage, "payload") : installRoot;
  if (state.phase === "extracted") {
    if (existsSync(installRoot)) {
      verifyJournaledInstallBytes(state, installRoot);
      state.phase = "bytes"; saveLifecycle(p.lifecycle, state);
    } else {
      validatePayload(payload, version); renderMcp(payload, p.current); validatePayload(payload, version, p.current); ensureHelper(p, payload); renameSync(payload, installRoot); failPhase("install", "moved"); state.phase = "bytes"; saveLifecycle(p.lifecycle, state);
    }
  }
  // The bytes checkpoint is the trust boundary for every later install
  // transition.  Do this before copying a helper, changing current, or
  // regenerating either metadata record; inventory includes file modes.
  verifyJournaledInstallBytes(state, installRoot);
  validatePayload(installRoot, version, p.current); ensureHelper(p, installRoot);
  if (state.phase === "bytes") { failPhase("install", "bytes"); if (!state.oldTarget) { try { state.oldTarget = currentTarget(p.current, p.versions); } catch { state.oldTarget = null; } saveLifecycle(p.lifecycle, state); } switchCurrent(p, installRoot); state.phase = "current"; saveLifecycle(p.lifecycle, state); }
  if (state.phase === "current") { failPhase("install", "current"); mkdirSync(dirname(p.marketplace), { recursive: true, mode: 0o700 }); atomicJson(p.marketplace, marketplaceData(join(installRoot, ".agents", "plugins", "marketplace.json"), version)); state.phase = "marketplace"; saveLifecycle(p.lifecycle, state); }
  if (state.phase === "marketplace") { failPhase("install", "marketplace"); const records = receiptVersions(p); if (!state.inventory || !state.releaseManifestSha256 || !state.payloadSha256 || !state.payloadInventorySha256) fail("verified install metadata is missing"); records[version] = { releaseManifestSha256: state.releaseManifestSha256, payloadSha256: state.payloadSha256, payloadInventorySha256: state.payloadInventorySha256, inventory: state.inventory }; atomicJson(p.receipt, receiptData(p, records)); state.phase = "receipt"; saveLifecycle(p.lifecycle, state); }
  if (state.phase === "receipt") { failPhase("install", "receipt"); state.phase = "complete"; saveLifecycle(p.lifecycle, state); }
  if (state.phase === "complete") { failPhase("install", "complete"); completeLifecycle(p, state, () => { if (present(stage)) { rmSync(stage, { recursive: true }); fsyncDirectory(dirname(stage)); } }); console.log(`Installed Loomex plugin ${version} at ${installRoot}`); console.log(`Private marketplace root: ${dirname(p.current)}`); }
}

function rollback(args: Arguments): void {
  const p = paths(safeBase(args.installBase)); const requested = validateVersion(text(args.version)); const target = join(p.versions, requested);
  if (existsSync(p.lifecycle)) { const state = loadLifecycle(p.lifecycle); validateLifecycleBinding(state, p); if (state.operation !== "rollback" || state.target !== target) fail("unfinished plugin lifecycle is not this rollback"); resume(args, p); return; }
  const previous = verifyOwnership(p); directory(target, "requested rollback version is not installed"); noLink(target, "requested rollback version is invalid"); validatePayload(target, requested, p.current); verifyRecordedVersion(p, target);
  const state: Lifecycle = { schema: LIFECYCLE_SCHEMA, operation: "rollback", operationId: randomUUID(), createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), phase: "prepared", target, oldTarget: previous, current: p.current, versions: p.versions, marketplace: p.marketplace, receipt: p.receipt }; saveLifecycle(p.lifecycle, state); resume(args, p);
}
function repair(args: Arguments): void {
  const p = paths(safeBase(args.installBase));
  if (existsSync(p.lifecycle)) { const state = loadLifecycle(p.lifecycle); validateLifecycleBinding(state, p); if (state.operation !== "repair") fail("unfinished plugin lifecycle is not this repair"); resume(args, p); return; }
  directory(p.versions, "versions directory is missing"); const target = currentTarget(p.current, p.versions); const version = basename(target); validatePayload(target, version); verifyRecordedVersion(p, target); const state: Lifecycle = { schema: LIFECYCLE_SCHEMA, operation: "repair", operationId: randomUUID(), createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), phase: "prepared", target, current: p.current, versions: p.versions, marketplace: p.marketplace, receipt: p.receipt }; saveLifecycle(p.lifecycle, state); resume(args, p);
}
function resume(args: Arguments, supplied?: ReturnType<typeof paths>): void {
  const p = supplied ?? paths(safeBase(args.installBase)); const journal = present(p.lifecycle) ? p.lifecycle : (present(p.terminal) ? p.terminal : null); if (!journal) return; const state = loadLifecycle(journal); validateLifecycleBinding(state, p);
  if (journal === p.terminal) {
    if (state.operation !== "uninstall" || state.phase !== "complete" || !state.recoveryHelper) fail("unexpected terminal plugin lifecycle journal");
    cleanupTerminalUninstall(p, state);
    return;
  }
  if (state.operation === "install") {
    if (!state.release) fail("install lifecycle release is missing");
    const resumed: Arguments = { action: "install", release: state.release, allowDevelopment: args.allowDevelopment };
    if (args.installBase) resumed.installBase = args.installBase;
    if (args.publicKey) resumed.publicKey = args.publicKey;
    install(resumed);
    return;
  }
  const target = text(state.target); const version = basename(target);
  if (state.operation === "rollback" || state.operation === "repair") {
    if (!["prepared", "current", "marketplace", "receipt", "complete"].includes(state.phase)) fail("unsupported lifecycle phase");
    // A retained package is the authority for rollback/repair.  Re-check it
    // on every resume so a modified version is never switched into current.
    verifyRecordedVersion(p, target);
    if (state.phase === "prepared") { validatePayload(target, version); renderMcp(target, p.current); switchCurrent(p, target); state.phase = "current"; saveLifecycle(p.lifecycle, state); }
    if (state.phase === "current") { mkdirSync(dirname(p.marketplace), { recursive: true, mode: 0o700 }); atomicJson(p.marketplace, marketplaceData(join(target, ".agents", "plugins", "marketplace.json"), version)); state.phase = "marketplace"; saveLifecycle(p.lifecycle, state); }
    if (state.phase === "marketplace") { atomicJson(p.receipt, receiptData(p, receiptVersions(p))); ensureHelper(p, target); state.phase = "receipt"; saveLifecycle(p.lifecycle, state); }
    if (state.phase === "receipt") { state.phase = "complete"; saveLifecycle(p.lifecycle, state); }
    if (state.phase === "complete") completeLifecycle(p, state);
    return;
  }
  if (state.operation !== "uninstall") fail("unsupported plugin lifecycle operation");
  if (!["prepared", "current", "payload", "metadata", "complete"].includes(state.phase)) fail("unsupported uninstall lifecycle phase");
  const targets = state.targets as string[];
  if (state.phase === "prepared") { failPhase("uninstall", "prepared"); if (existsSync(p.current) && lstatSync(p.current).isSymbolicLink()) unlinkSync(p.current); state.phase = "current"; saveLifecycle(p.lifecycle, state); }
  if (state.phase === "current") {
    failPhase("uninstall", "current");
    // Missing targets are expected after an interrupted delete.  Present
    // targets must still match the receipt; otherwise retain the journal for
    // inspection instead of deleting changed or unowned bytes.
    for (const item of targets) if (present(item)) { directory(item, "owned plugin version changed into an invalid path"); noLink(item, "owned plugin version changed into a symlink"); verifyRecordedVersion(p, item); rmSync(item, { recursive: true }); fsyncDirectory(p.versions); }
    state.phase = "payload"; saveLifecycle(p.lifecycle, state);
  }
  if (state.phase === "payload") { failPhase("uninstall", "payload"); for (const item of [p.marketplace, `${p.marketplace}.new`, p.receipt, `${p.receipt}.new`]) removeFile(item); state.phase = "metadata"; saveLifecycle(p.lifecycle, state); }
  if (state.phase === "metadata") { failPhase("uninstall", "metadata"); state.phase = "complete"; saveLifecycle(p.lifecycle, state); }
  if (state.phase === "complete") {
    failPhase("uninstall", "complete");
    // Record and atomically retire the active helper before the terminal
    // journal is removed.  If the process stops after this boundary,
    // lifecycle.sh/uninstall.sh discover the recovery runtime and can resume
    // the same completed journal; no journal is stranded without a callable
    // packaged manager.
    retainRecoveryHelper(p, state);
    failPhase("uninstall", "after-helper-retire");
    terminalizeUninstall(p, state);
    cleanupTerminalUninstall(p, state);
    console.log("Removed the Loomex plugin payload. Remove the loomex-private marketplace in Codex after disabling the plugin.");
  }
}
function uninstall(args: Arguments): void { const p = paths(safeBase(args.installBase)); if (!existsSync(dirname(p.current))) { console.log("Loomex plugin is not installed"); return; } if (existsSync(p.lifecycle) || existsSync(p.terminal)) { const state = loadLifecycle(existsSync(p.lifecycle) ? p.lifecycle : p.terminal); validateLifecycleBinding(state, p); if (state.operation !== "uninstall") fail("unfinished plugin lifecycle is not this uninstall"); resume(args, p); return; } const current = verifyOwnership(p); const records = receiptVersions(p); const targets = Object.keys(records).filter(name => VERSION.test(name)).map(name => join(p.versions, name)); if (targets.length === 0) fail("plugin ownership receipt contains no versions"); for (const target of targets) { directory(target, "owned plugin version is missing"); noLink(target, "owned plugin version is invalid"); verifyRecordedVersion(p, target); } const now = new Date().toISOString(); saveLifecycle(p.lifecycle, { schema: LIFECYCLE_SCHEMA, operation: "uninstall", operationId: randomUUID(), createdAt: now, updatedAt: now, phase: "prepared", target: current, targets, current: p.current, versions: p.versions, marketplace: p.marketplace, receipt: p.receipt }); resume(args, p); }
function status(args: Arguments): void {
  const p = paths(safeBase(args.installBase)); let current: string | null = null;
  try { if (present(p.current)) current = basename(currentTarget(p.current, p.versions)); } catch { current = "invalid"; }
  let operation: Json = null;
  const journal = present(p.lifecycle) ? p.lifecycle : (present(p.terminal) ? p.terminal : null);
  if (journal) { try { operation = { ...object(lifecycleSummary(loadLifecycle(journal))), terminal: journal === p.terminal }; } catch { operation = { state: "invalid-journal", recoveryRequired: true }; } }
  const versions = present(p.versions) && !lstatSync(p.versions).isSymbolicLink() && lstatSync(p.versions).isDirectory() ? readdirSync(p.versions).filter(name => VERSION.test(name)).sort() : [];
  console.log(JSON.stringify({ schema: "app.loomex.plugin.lifecycle-status/v1", installBase: dirname(p.current), current, versions, operation }, null, 2));
}
function parse(argv: string[]): Arguments {
  const [action, ...rest] = argv; if (!action) fail("usage: lifecycle ACTION [options]"); const result: Arguments = { action, allowDevelopment: false }; for (let index = 0; index < rest.length; index += 1) { const value = rest[index]; if (value === "--release") result.release = rest[++index] ?? fail("--release requires a value"); else if (value === "--install-base") result.installBase = rest[++index] ?? fail("--install-base requires a value"); else if (value === "--public-key") result.publicKey = rest[++index] ?? fail("--public-key requires a value"); else if (value === "--allow-unsigned-development") result.allowDevelopment = true; else if (value === "--version") result.version = rest[++index] ?? fail("--version requires a value"); else fail(`unknown argument: ${value}`); } return result;
}
function main(): void {
  const args = parse(process.argv.slice(2)); const p = paths(safeBase(args.installBase)); if (args.action === "status") return status(args);
  const installBase = dirname(p.current);
  if (present(p.terminal) && !["uninstall", "resume"].includes(args.action)) fail("terminal plugin lifecycle cleanup must be resumed first");
  let bootstrap: Lock | null = null;
  if (args.action === "install") {
    // Before the install root exists, serialize on a narrowly named sibling
    // anchor.  We only create its parent, never the installation root, until
    // this guard is held; then the regular in-root lifecycle lock takes over.
    const anchorParent = dirname(installBase); const anchorName = `.${basename(installBase)}.lifecycle.bootstrap.lock`;
    if (anchorParent === sep) fail("unsafe lifecycle bootstrap lock parent");
    mkdirSync(anchorParent, { recursive: true, mode: 0o700 }); directory(anchorParent, "lifecycle bootstrap lock parent is invalid"); noLink(anchorParent, "lifecycle bootstrap lock parent may not be a symlink");
    bootstrap = new Lock(anchorParent, anchorName); bootstrap.acquire();
    try { mkdirSync(installBase, { recursive: true, mode: 0o700 }); } catch (error) { bootstrap.release(); throw error; }
  } else if (!existsSync(installBase)) { if (args.action === "uninstall") { lifecycleResult(p, "uninstall", "not-installed"); return; } fail("Loomex plugin is not installed"); }
  const lock = new Lock(installBase);
  try { lock.acquire(); } finally { if (bootstrap) bootstrap.release(); }
  try {
    if (args.action === "install") install(args); else if (args.action === "resume") resume(args); else if (args.action === "rollback") rollback(args); else if (args.action === "repair") repair(args); else if (args.action === "uninstall") uninstall(args); else fail(`unknown lifecycle action: ${args.action}`);
    if (["resume", "rollback", "repair"].includes(args.action)) lifecycleResult(p, args.action, "completed");
  } finally { lock.release(); }
}
try { main(); } catch (error) { console.error(error instanceof Error ? error.message : String(error)); process.exitCode = 1; }
