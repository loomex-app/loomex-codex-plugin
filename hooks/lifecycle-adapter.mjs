import { createHash, randomUUID } from "node:crypto";
import { lstat, realpath } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, isAbsolute, join } from "node:path";
import { createConnection } from "node:net";
import { fileURLToPath } from "node:url";

const PROTOCOL = "loomex.local-control/v2";
const MAX_FRAME_BYTES = 1024 * 1024;
const ADAPTER_TIMEOUT_MS = 5_000;
const LIFECYCLE_CAPABILITY = "follow.session.lifecycle/v1";
const LIFECYCLE_SCHEMA_VERSION = "loomex.follow-session.lifecycle/v1";
const DECISION_SCHEMA_VERSION = "loomex.follow-session.decision/v1";
const CONTINUATION_SCHEMA_VERSION = "loomex.follow-session.continuation/v1";
const TOOL_ASSOCIATION_SCHEMA_VERSION = "loomex.follow-session.tool-association/v1";
const FOLLOW_COMMAND = "$loomex-runs";
const FOLLOW_EXISTING_RUN_INTENT = "follow-existing-run";
const FOLLOW_GENERATED_FORMAT_VERSION = "loomex-runs-follow-existing-run-continuation/v2";
const FOLLOW_RUN_ID = "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}";
const FOLLOW_RECEIPT = "[A-Za-z0-9_-]{16,2048}";
const FOLLOW_INSTRUCTIONS = [
  "Follow the exact existing Loomex run identified above: first call `loomex_run_get` with this run ID, then follow its authoritative `nextAction`.",
  "While the fresh authoritative `nextAction` is `loomex_run_wait` or `loomex_run_events`, do not final-answer: drain required event pages, then call the next action. Active progress, provider activity, and quiet timeouts require another bounded wait. Hooks and schedules are not prerequisites.",
  "Final-answer only after presenting verified user input, retrieving the complete authoritative terminal result, an actionable observation failure, or an explicit user stop. Each wait is bounded; do not add hidden indefinite waits or UI polling.",
  "Do not start another run or resubmit an accepted response.",
];
const PREVIOUS_FOLLOW_INSTRUCTIONS = [
  "Follow the exact existing Loomex run identified above: first call `loomex_run_get` with this run ID, then follow its authoritative `nextAction`.",
  "Do not start another run or resubmit an accepted response.",
];
const escapeRegex = (value) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const GENERATED_FOLLOW = new RegExp(
  `^${escapeRegex(FOLLOW_COMMAND)} ${escapeRegex(FOLLOW_EXISTING_RUN_INTENT)} (${FOLLOW_RUN_ID})\\n\\n<!-- ${escapeRegex(FOLLOW_GENERATED_FORMAT_VERSION)} receipt=(${FOLLOW_RECEIPT}) -->\\n\\n(?:${[FOLLOW_INSTRUCTIONS, PREVIOUS_FOLLOW_INSTRUCTIONS].map((instructions) => instructions.map(escapeRegex).join("\\n\\n")).join("|")})$`,
  "i",
);
const LEGACY_GENERATED_FOLLOW = new RegExp(
  `^\\$loomex-follow (${FOLLOW_RUN_ID})\\n\\n<!-- loomex-follow-continuation/v1 receipt=(${FOLLOW_RECEIPT}) -->\\n\\n${[
    "Follow this exact Loomex run: first call `loomex_run_get` with this run ID, then follow its authoritative `nextAction`.",
    "Do not start another run or resubmit an accepted response.",
  ].map(escapeRegex).join("\\n\\n")}$`,
  "i",
);
const ASSOCIATED_RUN_TOOLS = new Set([
  "mcp__loomex__loomex_run_get",
  "mcp__loomex__loomex_run_wait",
  "mcp__loomex__loomex_run_events",
  "mcp__loomex__loomex_run_result",
  "mcp__loomex__loomex_run_view",
  "mcp__loomex__loomex_run_cancel",
  "mcp__loomex__loomex_run_delete",
]);
const ASSOCIATED_INTERACTION_TOOLS = new Set([
  "mcp__loomex__loomex_interaction_get",
  "mcp__loomex__loomex_interaction_view",
]);

// Codex hosts have emitted both the fully-qualified bridge name and the MCP
// server-local tool name. Normalize only the documented Loomex spellings so a
// harmless host representation change cannot strand a verified UI handoff.
// The runner still verifies the exact request and response identities.
const LOCAL_TOOL_NAMES = new Set([
  "loomex_run_events",
  "loomex_run_wait",
  "loomex_run_get",
  "loomex_interaction_view",
  "loomex_interaction_get",
  "loomex_run_result",
]);

function canonicalToolName(name) {
  if (ASSOCIATED_RUN_TOOLS.has(name) || ASSOCIATED_INTERACTION_TOOLS.has(name)) return name;
  if (LOCAL_TOOL_NAMES.has(name)) return `mcp__loomex__${name}`;
  return undefined;
}
const SUPPORTED_EVENTS = new Set([
  "SessionStart",
  "UserPromptSubmit",
  "PostToolUse",
  "Stop",
  "Interrupt",
]);

class LifecycleError extends Error {
  constructor(code) {
    super(code);
    this.code = code;
  }
}

function safeString(value, maximum = 512) {
  if (typeof value !== "string") return undefined;
  const normalized = value.trim();
  return normalized.length > 0 && normalized.length <= maximum ? normalized : undefined;
}

function exactRunId(value) {
  const runId = safeString(value, 64);
  return runId !== undefined && new RegExp(`^${FOLLOW_RUN_ID}$`, "i").test(runId)
    ? runId.toLowerCase()
    : undefined;
}

function exactRequestId(value) {
  return exactRunId(value);
}

/**
 * Give a retried host delivery the same idempotency identity without hashing a
 * prompt, workspace path, tool payload, transcript, or runner response. UUID version 8
 * denotes this application-defined SHA-256 derivation.
 */
export function lifecycleEventId({ event, sessionId, turnId, toolUseId }) {
  const stableTurnId = safeString(turnId);
  const stableToolUseId = safeString(toolUseId);
  const stable = event === "SessionStart" || stableTurnId !== undefined || stableToolUseId !== undefined;
  if (!stable) {
    // Codex supplied no delivery-unique identity beyond the session. The hook
    // sends once and never retries after the request is written, so this UUID
    // intentionally has no cross-process retry/deduplication guarantee.
    return randomUUID();
  }
  const material = JSON.stringify({
    schemaVersion: "loomex.follow-session.event-id/v1",
    event,
    sessionId,
    turnId: stableTurnId ?? "",
    toolUseId: stableToolUseId ?? "",
  });
  const bytes = createHash("sha256").update(material, "utf8").digest().subarray(0, 16);
  bytes[6] = (bytes[6] & 0x0f) | 0x80;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = bytes.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/** Only full, canonical continuation messages can trigger a lifecycle follow. */
export function parseFollowContinuation(value) {
  if (typeof value !== "string" || value.length > 4096) return undefined;
  const generated = value.match(GENERATED_FOLLOW) ?? value.match(LEGACY_GENERATED_FOLLOW);
  if (generated?.[1] !== undefined && generated[2] !== undefined) {
    return {
      schemaVersion: CONTINUATION_SCHEMA_VERSION,
      source: "generated_markdown",
      runId: generated[1].toLowerCase(),
      receipt: generated[2],
    };
  }
  return undefined;
}

function object(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value : undefined;
}

function nestedRunId(value) {
  const source = object(value);
  if (source === undefined) return undefined;
  return exactRunId(source.runId)
    ?? exactRunId(source.executionId)
    ?? exactRunId(object(source.execution)?.id)
    ?? exactRunId(object(source.data)?.runId)
    ?? exactRunId(object(source.data)?.executionId)
    ?? exactRunId(object(object(source.data)?.execution)?.id)
    ?? exactRunId(object(object(source.data)?.humanRequest)?.executionId)
    ?? exactRunId(object(object(object(source.data)?.humanRequest)?.execution)?.id)
    ?? exactRunId(object(object(source.structuredContent)?.data)?.runId)
    ?? exactRunId(object(object(source.structuredContent)?.data)?.executionId)
    ?? exactRunId(object(object(object(source.structuredContent)?.data)?.execution)?.id)
    ?? exactRunId(object(object(object(source.structuredContent)?.data)?.humanRequest)?.executionId)
    ?? exactRunId(object(object(object(object(source.structuredContent)?.data)?.humanRequest)?.execution)?.id);
}

function nestedRequestId(value) {
  const source = object(value);
  if (source === undefined) return undefined;
  return exactRequestId(source.requestId)
    ?? exactRequestId(object(source.humanRequest)?.id)
    ?? exactRequestId(object(source.data)?.requestId)
    ?? exactRequestId(object(object(source.data)?.humanRequest)?.id)
    ?? exactRequestId(object(object(source.structuredContent)?.data)?.requestId)
    ?? exactRequestId(object(object(object(source.structuredContent)?.data)?.humanRequest)?.id);
}

/**
 * tool_input and tool_response may be large and untrusted. Associate only
 * minimal verified identities for the small run-scoped Loomex tool set. The
 * interaction inputs are strictly requestId-only, so their response supplies
 * the run identity and the runner verifies that request-to-run binding.
 */
function toolAssociation(input, name) {
  const canonical = canonicalToolName(name);
  if (canonical === undefined) return undefined;
  if (ASSOCIATED_INTERACTION_TOOLS.has(canonical)) {
    const requestId = nestedRequestId(input.tool_input);
    const responseRequestId = nestedRequestId(input.tool_response);
    const responseRunId = nestedRunId(input.tool_response);
    if (requestId === undefined || responseRequestId === undefined || requestId !== responseRequestId || responseRunId === undefined) return undefined;
    return {
      schemaVersion: TOOL_ASSOCIATION_SCHEMA_VERSION,
      runId: responseRunId,
      requestId,
      request: { requestId },
      response: { runId: responseRunId, requestId: responseRequestId },
    };
  }
  const requestRunId = nestedRunId(input.tool_input);
  const responseRunId = nestedRunId(input.tool_response);
  if (requestRunId === undefined || responseRunId === undefined || requestRunId !== responseRunId) return undefined;
  return {
    schemaVersion: TOOL_ASSOCIATION_SCHEMA_VERSION,
    runId: requestRunId,
    request: { runId: requestRunId },
    response: { runId: responseRunId },
  };
}

function diagnostic(event, status) {
  if (process.env.LOOMEX_HOOK_DIAGNOSTICS !== "1") return;
  // Do not log prompts, tool payloads, paths, identities, or runner responses.
  process.stderr.write(`[loomex-hook] event=${event} status=${status}\n`);
}

function socketPath() {
  const stateDir = process.env.LOOMEX_STATE_DIR
    ?? join(homedir(), ".local", "share", "loomex", "runner");
  if (!isAbsolute(stateDir)) throw new LifecycleError("runner unavailable");
  return join(stateDir, "control.sock");
}

async function assertOwnerCheckedSocket(path) {
  const uid = process.geteuid?.();
  if (uid === undefined) throw new LifecycleError("runner unavailable");
  try {
    const [parent, socket] = await Promise.all([lstat(dirname(path)), lstat(path)]);
    if (!parent.isDirectory() || !socket.isSocket()) throw new LifecycleError("runner unavailable");
    if (parent.uid !== uid || socket.uid !== uid) throw new LifecycleError("runner unavailable");
    if ((parent.mode & 0o077) !== 0 || (socket.mode & 0o077) !== 0) {
      throw new LifecycleError("runner unavailable");
    }
  } catch (error) {
    if (error instanceof LifecycleError) throw error;
    throw new LifecycleError("runner unavailable");
  }
}

function readHookInput(timeoutMs) {
  return new Promise((resolve, reject) => {
    let input = "";
    const timer = setTimeout(() => reject(new LifecycleError("hook time budget exhausted")), timeoutMs);
    timer.unref();
    const fail = (error) => {
      clearTimeout(timer);
      reject(error);
    };
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (chunk) => {
      input += chunk;
      if (Buffer.byteLength(input) > 64 * 1024) fail(new LifecycleError("invalid hook input"));
    });
    process.stdin.once("error", () => fail(new LifecycleError("invalid hook input")));
    process.stdin.once("end", () => {
      try {
        const parsed = JSON.parse(input);
        if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
          throw new LifecycleError("invalid hook input");
        }
        clearTimeout(timer);
        resolve(parsed);
      } catch {
        fail(new LifecycleError("invalid hook input"));
      }
    });
  });
}

function lifecycleParams(input) {
  const event = safeString(input.hook_event_name, 64);
  const sessionId = safeString(input.session_id);
  if (!SUPPORTED_EVENTS.has(event) || sessionId === undefined) {
    throw new LifecycleError("invalid hook input");
  }
  const turnId = safeString(input.turn_id);
  const toolUseId = event === "PostToolUse" ? safeString(input.tool_use_id) : undefined;
  if (event === "PostToolUse" && toolUseId === undefined) throw new LifecycleError("invalid hook input");
  const params = {
    schemaVersion: LIFECYCLE_SCHEMA_VERSION,
    event,
    eventId: lifecycleEventId({ event, sessionId, turnId, toolUseId }),
    session: {
      id: sessionId,
      ...(turnId === undefined ? {} : { turnId }),
    },
  };
  if (event === "UserPromptSubmit") {
    const prompt = input.prompt;
    if (typeof prompt !== "string" || prompt.length > 4096) throw new LifecycleError("invalid hook input");
    const continuation = parseFollowContinuation(prompt);
    if (continuation !== undefined) params.continuation = continuation;
  }
  if (event === "PostToolUse") {
    const name = safeString(input.tool_name);
    if (name === undefined) throw new LifecycleError("invalid hook input");
    const association = toolAssociation(input, name);
    params.tool = association === undefined
      ? { name, useId: toolUseId }
      : { name: canonicalToolName(name), useId: toolUseId, association };
  }
  return params;
}

function frame(value) {
  const encoded = `${JSON.stringify(value)}\n`;
  if (Buffer.byteLength(encoded) > MAX_FRAME_BYTES) throw new LifecycleError("invalid request");
  return encoded;
}

/**
 * Consume exactly one newline-delimited response frame. Keeping the remainder
 * allows a Unix socket read to contain a negotiation response and an action
 * response, or only the beginning of the next frame.
 */
export function extractNextFrame(buffer) {
  const newline = buffer.indexOf(0x0a);
  if (newline < 0) return undefined;
  return {
    text: buffer.subarray(0, newline).toString("utf8"),
    remaining: buffer.subarray(newline + 1),
    byteLength: newline + 1,
  };
}

function responseFor(frameText, requestId) {
  let parsed;
  try {
    parsed = JSON.parse(frameText);
  } catch {
    throw new LifecycleError("malformed runner response");
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)
    || parsed.protocol !== PROTOCOL || parsed.id !== requestId) {
    throw new LifecycleError("malformed runner response");
  }
  if (Object.prototype.hasOwnProperty.call(parsed, "error")) {
    throw new LifecycleError("runner rejected lifecycle update");
  }
  const result = parsed.result;
  if (result === null || typeof result !== "object" || Array.isArray(result)
    || Object.keys(result).length !== 2
    || result.schemaVersion !== DECISION_SCHEMA_VERSION
    || (result.decision !== "continue" && result.decision !== "allow")) {
    throw new LifecycleError("malformed runner response");
  }
  return result.decision;
}

function callRunner(params, timeoutMs) {
  return new Promise(async (resolve, reject) => {
    let socket;
    let settled = false;
    let phase = "negotiation";
    let received = Buffer.alloc(0);
    const negotiationId = randomUUID();
    const requestId = randomUUID();
    const finish = (callback) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket?.destroy();
      callback();
    };
    const fail = (code) => finish(() => reject(new LifecycleError(code)));
    const timer = setTimeout(() => fail("runner time budget exhausted"), timeoutMs);
    timer.unref();
    try {
      const path = socketPath();
      await assertOwnerCheckedSocket(path);
      const negotiation = frame({
        protocol: PROTOCOL,
        id: negotiationId,
        method: "protocol.negotiate",
        params: {
          supportedProtocols: [PROTOCOL],
          requiredCapabilities: [LIFECYCLE_CAPABILITY],
        },
      });
      const action = frame({
        protocol: PROTOCOL,
        id: requestId,
        method: "follow.session.lifecycle",
        params,
      });
      socket = createConnection(path);
      socket.setNoDelay(true);
      socket.once("connect", () => socket?.write(negotiation));
      socket.once("error", () => fail("runner unavailable"));
      socket.once("end", () => {
        if (!settled) fail("runner unavailable");
      });
      socket.on("data", (chunk) => {
        received = Buffer.concat([received, chunk]);
        while (!settled) {
          const next = extractNextFrame(received);
          if (next === undefined) {
            if (received.byteLength > MAX_FRAME_BYTES) fail("malformed runner response");
            return;
          }
          if (next.byteLength > MAX_FRAME_BYTES) return fail("malformed runner response");
          const item = next.text;
          received = next.remaining;
          try {
            if (phase === "negotiation") {
              const response = JSON.parse(item);
              const result = response?.result;
              if (response?.protocol !== PROTOCOL || response?.id !== negotiationId
                || result?.selectedProtocol !== PROTOCOL || result?.maxFrameBytes !== MAX_FRAME_BYTES
                || !Array.isArray(result?.capabilities) || !result.capabilities.includes(LIFECYCLE_CAPABILITY)) {
                throw new LifecycleError("runner unavailable");
              }
              phase = "action";
              socket?.write(action);
              continue;
            }
            const decision = responseFor(item, requestId);
            // A complete third frame is unsolicited. A partial remainder stays
            // buffered, because read boundaries do not define frame boundaries.
            if (extractNextFrame(received) !== undefined) {
              throw new LifecycleError("malformed runner response");
            }
            finish(() => resolve(decision));
          } catch (error) {
            fail(error instanceof LifecycleError ? error.code : "malformed runner response");
          }
          return;
        }
      });
    } catch (error) {
      fail(error instanceof LifecycleError ? error.code : "runner unavailable");
    }
  });
}

function stopOutput(decision) {
  if (decision === "continue") {
    return { decision: "block", reason: "Loomex follow session requested continuation." };
  }
  return undefined;
}

async function main() {
  const startedAt = Date.now();
  let input;
  try {
    input = await readHookInput(ADAPTER_TIMEOUT_MS);
  } catch (error) {
    diagnostic("unknown", "invalid_input");
    return;
  }
  const isStop = input.hook_event_name === "Stop";
  const event = safeString(input.hook_event_name, 64) ?? "unknown";
  try {
    const params = lifecycleParams(input);
    const decision = await callRunner(params, Math.max(1, ADAPTER_TIMEOUT_MS - (Date.now() - startedAt)));
    const output = isStop ? stopOutput(decision) : undefined;
    if (output !== undefined) process.stdout.write(`${JSON.stringify(output)}\n`);
    diagnostic(event, decision === "continue" ? "continue" : "allow");
  } catch (error) {
    diagnostic(event, error instanceof LifecycleError ? error.code.replaceAll(" ", "_") : "failed");
    if (isStop) {
      // Fail open. Stop recognizes a block decision only; emitting no JSON
      // avoids an unsupported allow shape on hosts with stricter hook schemas.
    }
  }
}

async function invokedAsMain() {
  if (process.argv[1] === undefined) return false;
  try {
    return (await realpath(fileURLToPath(import.meta.url))) === (await realpath(process.argv[1]));
  } catch {
    return false;
  }
}

void invokedAsMain().then((isMain) => {
  if (isMain) return main();
  return undefined;
});
