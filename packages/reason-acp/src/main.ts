#!/usr/bin/env node
// @effect-diagnostics nodeBuiltinImport:off globalFetch:off globalTimers:off globalDate:off - A zero-dependency stdio agent; it uses Node and fetch directly, like dev-replay-agent.
/**
 * ACP agent that runs each T3 thread as a Reason Machines Session over the Reason HTTP API,
 * on this computer in the project folder (or Reason cloud with REASON_TARGET=cloud).
 * Env: REASON_API_KEY or REASON_API_KEY_REF (1Password ref), REASON_API_URL, REASON_TARGET,
 * REASON_DEVICE_ID, REASON_ID, REASON_MODEL, REASON_ALLOW_MODEL_ROLLOVER, REASON_ACP_STATE.
 */
import * as NodeChildProcess from "node:child_process";
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeReadline from "node:readline";

type Json = null | boolean | number | string | Json[] | { [key: string]: Json };
type JsonObject = { [key: string]: Json };

interface StoredSession {
  cwd: string;
  reasonSessionId: string | null;
  cursor: number;
  modelId: string | null;
  url: string | null;
}

interface LiveTurn {
  aborted: boolean;
  wake: (() => void) | null;
}

const API_URL = (process.env.REASON_API_URL ?? "https://api.reasonmachines.com").replace(
  /\/+$/,
  "",
);
const TARGET = process.env.REASON_TARGET === "cloud" ? "cloud" : "device";
const ALLOW_ROLLOVER = process.env.REASON_ALLOW_MODEL_ROLLOVER !== "false";
const STATE_FILE =
  process.env.REASON_ACP_STATE ?? NodePath.join(NodeOS.homedir(), ".reason-acp", "sessions.json");
const TERMINAL_STATUSES = new Set(["exit", "error", "suspended"]);
const TOOL_OUTPUT_MAX = 8000;
/** A follow-up that never starts a run (rejected, held) must not hang the turn forever. */
const START_GRACE_MS = 90_000;

function send(message: JsonObject): void {
  process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", ...message })}\n`);
}

function notify(method: string, params: JsonObject): void {
  send({ method, params });
}

function log(...parts: unknown[]): void {
  // stderr is the agent log; stdout is reserved for the protocol.
  process.stderr.write(`[reason-acp] ${parts.map(String).join(" ")}\n`);
}

class RpcError extends Error {
  readonly code: number;
  readonly data: Json | undefined;
  constructor(code: number, message: string, data?: Json) {
    super(message);
    this.code = code;
    this.data = data;
  }
}

let apiKey: string | null = null;
function readApiKey(): string {
  if (apiKey) return apiKey;
  const direct = process.env.REASON_API_KEY?.trim();
  if (direct) return (apiKey = direct);
  const ref = process.env.REASON_API_KEY_REF?.trim();
  if (ref) {
    try {
      apiKey = NodeChildProcess.execFileSync("op", ["read", ref], { encoding: "utf8" }).trim();
      if (apiKey) return apiKey;
    } catch (error) {
      log("op read failed:", (error as Error).message);
    }
  }
  throw new RpcError(
    -32000,
    "No Reason API key. Set REASON_API_KEY (or REASON_API_KEY_REF to a 1Password reference) on this provider in T3 Code settings. Create a key at https://reasonmachines.com/customize?tab=api.",
  );
}

async function api<T = JsonObject>(
  method: "GET" | "POST",
  path: string,
  body?: JsonObject,
): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    const response = await fetch(`${API_URL}${path}`, {
      method,
      redirect: "error",
      headers: {
        Authorization: `Bearer ${readApiKey()}`,
        ...(body ? { "content-type": "application/json" } : {}),
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    if (response.status === 429 && attempt < 5) {
      const retryAfter = Number(response.headers.get("retry-after") ?? "2");
      await sleep(Math.min(30, Math.max(1, retryAfter)) * 1000);
      continue;
    }
    const text = await response.text();
    let parsed: unknown = undefined;
    try {
      parsed = text ? JSON.parse(text) : {};
    } catch {
      parsed = { raw: text.slice(0, 500) };
    }
    if (!response.ok) {
      const error = (parsed as { error?: unknown; detail?: unknown; message?: unknown }) ?? {};
      const detail =
        typeof error.detail === "string"
          ? error.detail
          : typeof error.message === "string"
            ? error.message
            : typeof error.error === "string"
              ? error.error
              : JSON.stringify(error.error ?? parsed).slice(0, 300);
      throw new RpcError(
        -32000,
        `Reason API ${method} ${path.split("?")[0]} → ${response.status}: ${detail}`,
      );
    }
    return parsed as T;
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

let orgIdPromise: Promise<string> | null = null;
function orgId(): Promise<string> {
  orgIdPromise ??= api<{ org_id?: string; organization?: { id?: string } }>("GET", "/v3/self").then(
    (self) => {
      const id = self.org_id ?? self.organization?.id;
      if (!id) throw new RpcError(-32000, "GET /v3/self returned no organization id");
      return id;
    },
  );
  orgIdPromise.catch(() => (orgIdPromise = null));
  return orgIdPromise;
}

/** This computer's device in the key's workspace, as `reason connect` registered it. */
function localDeviceId(org: string): string {
  const configured = process.env.REASON_DEVICE_ID?.trim();
  if (configured) return configured;
  let status: {
    connection?: {
      workspaces?: Array<{ organization_id: string; device_id: string; state?: string }>;
    };
  };
  try {
    status = JSON.parse(
      NodeChildProcess.execFileSync("reason", ["status", "--json"], {
        encoding: "utf8",
        timeout: 15_000,
      }),
    );
  } catch (error) {
    throw new RpcError(
      -32000,
      `Could not read this computer's Reason connection (\`reason status --json\`): ${(error as Error).message}. Install the Reason CLI and run \`reason connect\`, set REASON_DEVICE_ID, or set REASON_TARGET=cloud.`,
    );
  }
  const workspace = status.connection?.workspaces?.find((w) => w.organization_id === org);
  if (!workspace) {
    throw new RpcError(
      -32000,
      `This computer is not connected to the API key's Reason workspace (${org}). Run \`reason connect\` for that workspace, set REASON_DEVICE_ID, or set REASON_TARGET=cloud.`,
    );
  }
  return workspace.device_id;
}

interface ReasonModel {
  id: string;
  name: string;
}
let modelsPromise: Promise<ReasonModel[]> | null = null;
function listModels(): Promise<ReasonModel[]> {
  modelsPromise ??= (async () => {
    try {
      const org = await orgId();
      const result = await api<{ data?: unknown[]; models?: unknown[] }>(
        "GET",
        `/v3/organizations/${org}/agent-auth/models`,
      );
      const rows = (result.data ?? result.models ?? []) as Array<Record<string, unknown>>;
      const models = rows
        .map((row) => ({
          id: String(row.id ?? row.model ?? ""),
          name: String(row.name ?? row.display_name ?? row.label ?? row.id ?? ""),
          available: row.available !== false && row.selectable !== false,
        }))
        .filter((m) => m.id && m.available)
        .map(({ id, name }) => ({ id, name }));
      return [{ id: "auto", name: "Workspace default" }, ...models];
    } catch (error) {
      // Model listing needs agent_auth:read; without it the workspace default still works.
      log("model list unavailable:", (error as Error).message);
      return [{ id: "auto", name: "Workspace default" }];
    }
  })();
  return modelsPromise;
}

function loadState(): Record<string, StoredSession> {
  try {
    return JSON.parse(NodeFS.readFileSync(STATE_FILE, "utf8"));
  } catch {
    return {};
  }
}
const sessions: Record<string, StoredSession> = loadState();
function saveState(): void {
  try {
    NodeFS.mkdirSync(NodePath.dirname(STATE_FILE), { recursive: true });
    NodeFS.writeFileSync(STATE_FILE, JSON.stringify(sessions, null, 2));
  } catch (error) {
    log("could not save state:", (error as Error).message);
  }
}
const liveTurns = new Map<string, LiveTurn>();

interface SessionEvent {
  id: string;
  seq: number;
  type: string;
  text: string | null;
  data: Record<string, unknown> | null;
}

const UNTRUSTED_PREAMBLE = /^\[Workspace output: untrusted data\][\s\S]*?\n\n/;

function toolKind(tool: string): string {
  const name = tool.toLowerCase();
  if (/(bash|shell|exec|command|terminal)/.test(name)) return "execute";
  if (/(edit|write|patch|replace|create_file)/.test(name)) return "edit";
  if (/(read|view|cat|open)/.test(name)) return "read";
  if (/(grep|glob|search|find|list|ls)/.test(name)) return "search";
  if (/(fetch|web|browse|http)/.test(name)) return "fetch";
  if (/(delete|remove|rm)/.test(name)) return "delete";
  if (/(think|plan)/.test(name)) return "think";
  return "other";
}

function parseInput(input: unknown): Json {
  if (typeof input !== "string") return (input ?? null) as Json;
  try {
    return JSON.parse(input);
  } catch {
    return input;
  }
}

function toolTitle(tool: string, input: Json): string {
  if (input && typeof input === "object" && !Array.isArray(input)) {
    const value =
      input.command ??
      input.cmd ??
      input.path ??
      input.file_path ??
      input.pattern ??
      input.query ??
      input.url;
    if (typeof value === "string" && value.length > 0) {
      const short = value.length > 160 ? `${value.slice(0, 157)}…` : value;
      return toolKind(tool) === "execute" ? short : `${tool} ${short}`;
    }
  }
  return tool;
}

class Translator {
  private readonly emitted = new Map<string, string>();
  private readonly startedTools = new Set<string>();

  private readonly acpSessionId: string;
  constructor(acpSessionId: string) {
    this.acpSessionId = acpSessionId;
  }

  private update(update: JsonObject): void {
    notify("session/update", { sessionId: this.acpSessionId, update });
  }

  private textDelta(event: SessionEvent): string {
    const text = event.text ?? "";
    const previous = this.emitted.get(event.id) ?? "";
    this.emitted.set(event.id, text);
    if (text.startsWith(previous)) return text.slice(previous.length);
    // The snapshot was rewritten; ACP chunks cannot retract, so append the new tail.
    return text.length > previous.length ? `\n${text}` : "";
  }

  /** Returns true if the event was conversation content (proof that the turn is moving). */
  handle(event: SessionEvent): boolean {
    switch (event.type) {
      case "assistant": {
        const delta = this.textDelta(event);
        if (delta)
          this.update({
            sessionUpdate: "agent_message_chunk",
            content: { type: "text", text: delta },
          });
        return true;
      }
      case "reasoning": {
        const delta = this.textDelta(event);
        if (delta)
          this.update({
            sessionUpdate: "agent_thought_chunk",
            content: { type: "text", text: delta },
          });
        return true;
      }
      case "tool_use": {
        const data = event.data ?? {};
        const toolCallId = String(data.tool_use_id ?? event.id);
        if (this.startedTools.has(toolCallId)) return true;
        this.startedTools.add(toolCallId);
        const tool = String(data.tool ?? event.text ?? "tool");
        const input = parseInput(data.input);
        this.update({
          sessionUpdate: "tool_call",
          toolCallId,
          title: toolTitle(tool, input),
          kind: toolKind(tool),
          status: "in_progress",
          rawInput: input,
        });
        return true;
      }
      case "tool_result": {
        const data = event.data ?? {};
        const toolCallId = String(data.tool_use_id ?? event.id);
        const tool = String(data.tool ?? "tool");
        if (!this.startedTools.has(toolCallId)) {
          this.startedTools.add(toolCallId);
          const input = parseInput(data.input);
          this.update({
            sessionUpdate: "tool_call",
            toolCallId,
            title: toolTitle(tool, input),
            kind: toolKind(tool),
            status: "in_progress",
            rawInput: input,
          });
        }
        const state = (event.text ?? "completed").toLowerCase();
        let output =
          typeof data.content === "string"
            ? data.content
            : data.content == null
              ? ""
              : JSON.stringify(data.content);
        output = output.replace(UNTRUSTED_PREAMBLE, "");
        if (output.length > TOOL_OUTPUT_MAX)
          output = `${output.slice(0, TOOL_OUTPUT_MAX)}\n… (truncated)`;
        this.update({
          sessionUpdate: "tool_call_update",
          toolCallId,
          status: /(fail|error|denied|refused)/.test(state) ? "failed" : "completed",
          ...(output
            ? { content: [{ type: "content", content: { type: "text", text: output } }] }
            : {}),
        });
        return true;
      }
      default:
        return false;
    }
  }
}

function promptText(blocks: unknown): string {
  if (!Array.isArray(blocks)) return "";
  const parts: string[] = [];
  for (const block of blocks as Array<Record<string, any>>) {
    if (block?.type === "text" && typeof block.text === "string") parts.push(block.text);
    else if (block?.type === "resource_link" && typeof block.uri === "string")
      parts.push(`@${block.uri}`);
    else if (block?.type === "resource" && block.resource) {
      const r = block.resource;
      parts.push(
        typeof r.text === "string" ? `<file uri="${r.uri}">\n${r.text}\n</file>` : `@${r.uri}`,
      );
    }
  }
  return parts.join("\n\n").trim();
}

async function runTurn(acpSessionId: string, prompt: string): Promise<JsonObject> {
  const stored = sessions[acpSessionId];
  if (!stored) throw new RpcError(-32602, `Unknown session ${acpSessionId}`);
  if (liveTurns.has(acpSessionId))
    throw new RpcError(-32000, "A turn is already running in this session.");
  const turn: LiveTurn = { aborted: false, wake: null };
  liveTurns.set(acpSessionId, turn);
  const translator = new Translator(acpSessionId);
  try {
    const org = await orgId();
    const model =
      stored.modelId && stored.modelId !== "auto" ? stored.modelId : process.env.REASON_MODEL;
    const modelField = model && model !== "auto" ? { model } : {};
    if (!stored.reasonSessionId) {
      const target =
        TARGET === "cloud"
          ? { kind: "cloud" }
          : {
              kind: "headless",
              device_id: localDeviceId(org),
              cwd: stored.cwd,
              isolation: "in_place",
            };
      const created = await api<{ session_id: string; url?: string }>(
        "POST",
        `/v3/organizations/${org}/sessions`,
        {
          prompt,
          idempotency_key: NodeCrypto.randomUUID(),
          target,
          allow_model_rollover: ALLOW_ROLLOVER,
          tags: ["t3code"],
          ...modelField,
          ...(process.env.REASON_ID ? { reason_id: process.env.REASON_ID } : {}),
        },
      );
      stored.reasonSessionId = created.session_id;
      stored.url = created.url ?? `https://reasonmachines.com/agents/${created.session_id}`;
      stored.cursor = -1;
      saveState();
      log(
        "created Reason session",
        stored.reasonSessionId,
        "on",
        TARGET === "cloud" ? "cloud" : `device in ${stored.cwd}`,
      );
      notify("session/update", {
        sessionId: acpSessionId,
        update: {
          sessionUpdate: "agent_thought_chunk",
          content: { type: "text", text: `Reason session: ${stored.url}\n` },
        },
      });
    } else {
      const sent = await api<{ continuation_session_id?: string | null; delivery?: string }>(
        "POST",
        `/v3/organizations/${org}/sessions/${stored.reasonSessionId}/messages`,
        {
          message: prompt,
          client_message_id: NodeCrypto.randomUUID(),
          delivery: "queue",
          allow_model_rollover: ALLOW_ROLLOVER,
          ...modelField,
        },
      );
      if (sent.continuation_session_id && sent.continuation_session_id !== stored.reasonSessionId) {
        stored.reasonSessionId = sent.continuation_session_id;
        saveState();
      }
      log("follow-up delivered:", sent.delivery);
    }
    return await streamUntilTurnEnds(org, stored, translator, turn);
  } finally {
    liveTurns.delete(acpSessionId);
  }
}

async function streamUntilTurnEnds(
  org: string,
  stored: StoredSession,
  translator: Translator,
  turn: LiveTurn,
): Promise<JsonObject> {
  const startedAt = Date.now();
  let sawActivity = false;
  for (;;) {
    if (turn.aborted) return { stopReason: "cancelled" };
    const page = await api<{
      session?: {
        status?: string;
        error_message?: string | null;
        outcome?: string | null;
        blocker?: unknown;
      };
      items?: SessionEvent[];
      next_seq?: number;
    }>(
      "GET",
      `/v3/organizations/${org}/sessions/${stored.reasonSessionId}/events?after_seq=${stored.cursor}&view=conversation&limit=500&wait_ms=20000`,
    );
    for (const event of page.items ?? []) {
      if (translator.handle(event)) sawActivity = true;
    }
    if (typeof page.next_seq === "number" && page.next_seq !== stored.cursor) {
      stored.cursor = page.next_seq;
      saveState();
    }
    const status = page.session?.status ?? "running";
    if (status === "running") sawActivity = true;
    if (turn.aborted) return { stopReason: "cancelled" };
    if (TERMINAL_STATUSES.has(status) && (page.items ?? []).length === 0) {
      if (!sawActivity && Date.now() - startedAt < START_GRACE_MS) {
        // A queued follow-up has not started its run yet; wait for it.
        await sleep(1000);
        continue;
      }
      if (status === "error") {
        throw new RpcError(-32000, page.session?.error_message ?? "The Reason session failed.", {
          url: stored.url,
        } as Json);
      }
      return { stopReason: status === "suspended" ? "cancelled" : "end_turn" };
    }
  }
}

async function modelState(stored: StoredSession): Promise<JsonObject> {
  const models = await listModels();
  return {
    availableModels: models.map((m) => ({ modelId: m.id, name: m.name })),
    currentModelId: stored.modelId ?? process.env.REASON_MODEL ?? "auto",
  };
}

async function handleRequest(method: string, params: Record<string, any>): Promise<Json> {
  switch (method) {
    case "initialize":
      return {
        protocolVersion: 1,
        agentCapabilities: {
          loadSession: true,
          promptCapabilities: { image: false, audio: false, embeddedContext: true },
          mcpCapabilities: { http: false, sse: false },
        },
        agentInfo: { name: "reason-acp", title: "Reason", version: "0.1.0" },
        authMethods: [],
      };
    case "authenticate":
      return {};
    case "session/new": {
      const sessionId = NodeCrypto.randomUUID();
      sessions[sessionId] = {
        cwd: String(params.cwd ?? process.cwd()),
        reasonSessionId: null,
        cursor: -1,
        modelId: null,
        url: null,
      };
      saveState();
      return { sessionId, models: await modelState(sessions[sessionId]) } as JsonObject;
    }
    case "session/load":
    case "session/resume": {
      const stored = sessions[params.sessionId];
      if (!stored) throw new RpcError(-32002, `Session ${params.sessionId} not found`);
      if (typeof params.cwd === "string") stored.cwd = params.cwd;
      return { models: await modelState(stored) } as JsonObject;
    }
    case "session/prompt": {
      const text = promptText(params.prompt);
      if (!text) throw new RpcError(-32602, "Empty prompt");
      return runTurn(String(params.sessionId), text);
    }
    case "session/set_model": {
      const stored = sessions[params.sessionId];
      if (!stored) throw new RpcError(-32002, `Session ${params.sessionId} not found`);
      stored.modelId = String(params.modelId);
      saveState();
      return {};
    }
    case "session/set_mode":
      return {};
    case "session/close":
      return {};
    default:
      throw new RpcError(-32601, `Method not found: ${method}`);
  }
}

async function handleNotification(method: string, params: Record<string, any>): Promise<void> {
  if (method !== "session/cancel") return;
  const sessionId = String(params.sessionId);
  const turn = liveTurns.get(sessionId);
  if (turn) turn.aborted = true;
  const stored = sessions[sessionId];
  if (stored?.reasonSessionId) {
    try {
      const org = await orgId();
      await api("POST", `/v3/organizations/${org}/sessions/${stored.reasonSessionId}/cancel`);
    } catch (error) {
      log("cancel failed:", (error as Error).message);
    }
  }
}

const lines = NodeReadline.createInterface({ input: process.stdin });
lines.on("line", (line) => {
  if (!line.trim()) return;
  let message: {
    id?: Json;
    method?: string;
    params?: Record<string, any>;
    result?: unknown;
    error?: unknown;
  };
  try {
    message = JSON.parse(line);
  } catch {
    send({ id: null, error: { code: -32700, message: "Parse error" } });
    return;
  }
  if (!message.method) return; // a response to a request we never send
  const params = message.params ?? {};
  if (message.id === undefined) {
    void handleNotification(message.method, params);
    return;
  }
  const id = message.id;
  handleRequest(message.method, params).then(
    (result) => send({ id, result }),
    (error: unknown) => {
      const rpc =
        error instanceof RpcError
          ? error
          : new RpcError(-32603, (error as Error)?.message ?? String(error));
      log(message.method, "failed:", rpc.message);
      send({
        id,
        error: {
          code: rpc.code,
          message: rpc.message,
          ...(rpc.data === undefined ? {} : { data: rpc.data }),
        },
      });
    },
  );
});
lines.on("close", () => process.exit(0));
