/**
 * pi-collab — Multi-Agent Collaboration Extension
 *
 * Enables multiple pi agent instances on the same host to communicate
 * and collaborate on shared tasks via bidirectional peer-to-peer messaging.
 *
 * Phase 1: Same-host Unix domain socket transport + filesystem peer registry.
 *
 * Usage:
 *   pi --extension pi-collab
 *   /collab spawn reviewer --prompt "You are a code reviewer"
 *   Agent calls: delegate_to_colleague { colleague: "reviewer", task: "..." }
 */

import { randomUUID, randomBytes } from "node:crypto";
import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { basename } from "node:path";
import { join } from "node:path";
import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { Container, Spacer, Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";

import type { PeerRecord, Envelope, ProbePayload, ProbeResponsePayload, PeerStatus, AuthPayload, AuthResultPayload } from "./types.ts";
import { parseConfig, type CollabConfig } from "./config.ts";
import { UnixSocketTransport } from "./transport/unix-socket.ts";
import type { PeerTransport, PeerListener, PeerConnection } from "./transport/index.ts";
import {
  getPeerById,
  getSocketPath,
  registerPeer,
  unregisterPeer,
  updatePeerStatus,
  updatePeerModel,
  heartbeatPeer,
  listPeers,
  pruneStalePeers,
  resolveName,
} from "./discovery/registry.ts";
import {
  runConversation,
  handleInboundConversationPreRead,
} from "./protocol/conversation.ts";
import {
  createProbeEnvelope,
  createProbeResponseEnvelope,
  createPongEnvelope,
  createAuthEnvelope,
  createAuthResultEnvelope,
} from "./protocol/envelope.ts";
import * as agentCtx from "./agent-context.ts";
import {
  discoverColleagues,
  resolveColleague,
  formatColleagueList,
  type ColleagueTemplate,
} from "./colleagues.ts";
import { CollabError, fromProtocolCode } from "./errors.ts";
import { isWindows } from "./transport/paths.ts";
import { sshTunnelManager, sshExec } from "./transport/ssh.ts";
import {
  addRemote,
  getRemote,
  listRemotes,
  removeRemote,
  type RemotePeer,
} from "./discovery/remotes.ts";

// ─── Module-level state ──────────────────────────────────────────────────────

let config: CollabConfig;
let peerId: string;
let transport: PeerTransport;
let listener: PeerListener | undefined;
let heartbeatTimer: ReturnType<typeof setInterval> | undefined;
let widgetCtx: ExtensionContext | undefined;
let currentModel = "unknown";
let authToken = "";
let piApi: ExtensionAPI | undefined;

// ─── Widget keys ─────────────────────────────────────────────────────────────

const WIDGET_KEY = "pi-collab-peers";

// ─── Helpers ─────────────────────────────────────────────────────────────────

function generateAuthToken(): string {
  return randomBytes(32).toString("hex"); // 256-bit, 64 hex chars
}

function formatTokens(count: number): string {
  if (count < 1000) return count.toString();
  if (count < 10000) return `${(count / 1000).toFixed(1)}k`;
  return `${Math.round(count / 1000)}k`;
}

function formatUsage(usage: { input?: number; output?: number; turns?: number; cost?: number } | undefined): string {
  if (!usage) return "";
  const parts: string[] = [];
  if (usage.turns) parts.push(`${usage.turns} turn${usage.turns > 1 ? "s" : ""}`);
  if (usage.input) parts.push(`↑${formatTokens(usage.input)}`);
  if (usage.output) parts.push(`↓${formatTokens(usage.output)}`);
  if (usage.cost) parts.push(`$${usage.cost.toFixed(4)}`);
  return parts.join(" ");
}

// ─── Peer status widget ──────────────────────────────────────────────────────

function statusIcon(status: PeerStatus): string {
  switch (status) {
    case "busy": return "◉";
    case "unreachable": return "○";
    default: return "●";
  }
}

function buildPeerWidgetLines(ctx: ExtensionContext): string[] {
  const peers = listPeers();
  const self = peers.find((p) => p.peerId === peerId);
  const others = peers.filter((p) => p.peerId !== peerId);
  const remotes = listRemotes();

  const lines: string[] = [];
  const t = ctx.ui.theme;

  lines.push(t.fg("dim", "── Peers ──"));

  const colorForStatus = (status: PeerStatus) => {
    if (status === "busy") return t.fg("accent", statusIcon(status));
    if (status === "unreachable") return t.fg("dim", statusIcon(status));
    return t.fg("success", statusIcon(status));
  };

  if (self) {
    const icon = colorForStatus(self.status);
    lines.push(`${icon} ${t.bold(self.name)} ${t.fg("dim", "(me)")}  ${t.fg("muted", self.model)}`);
  }

  for (const p of others) {
    const icon = colorForStatus(p.status);
    lines.push(`${icon} ${p.name}  ${t.fg("muted", p.model)}`);
  }

  // Remote SSH peers — only show those with an active tunnel,
  // so failed/ghost entries don't clutter the widget.
  for (const r of remotes) {
    if (!sshTunnelManager.names.includes(r.name)) continue;
    const icon = t.fg("success", "●");
    lines.push(`${icon} ${r.name}  ${t.fg("muted", `ssh:${r.sshTarget}`)}`);
  }

  if (peers.length === 0 && remotes.length === 0) {
    lines.push(t.fg("dim", "  (no peers)"));
  }

  return lines;
}

function updatePeerWidget(ctx: ExtensionContext): void {
  if (ctx.mode !== "tui") return;
  const lines = buildPeerWidgetLines(ctx);
  ctx.ui.setWidget(WIDGET_KEY, lines, { placement: "aboveEditor" });
}

function clearPeerWidget(ctx: ExtensionContext): void {
  ctx.ui.setWidget(WIDGET_KEY, undefined);
}

// ─── Extension path resolution ───────────────────────────────────────────────

function resolveExtensionPath(): string {
  // Search standard locations for the pi-collab extension.
  // Extensions loaded via jiti have __filename available, but we
  // search well-known paths as a fallback for robustness.
  const home = process.env.HOME ?? process.env.USERPROFILE ?? "/tmp";
  const candidates = [
    join(home, ".pi", "agent", "extensions", "pi-collab", "index.ts"),
    join(process.cwd(), ".pi", "extensions", "pi-collab", "index.ts"),
  ];
  for (const c of candidates) {
    if (existsSync(c)) return c;
  }
  return "";
}

// ─── Resolve pi binary ───────────────────────────────────────────────────────

/**
 * Build the pi invocation command + args for spawning a peer process.
 *
 * Adapted from subagent's getPiInvocation(). When running via `node` + jiti
 * (development), `process.execPath` is just `node` and we must pass the
 * current script as the first argument. When pi is installed as a native
 * binary (production), `process.execPath` is the pi binary itself and
 * args can be passed directly.
 */
function getPiInvocation(extraArgs: string[]): { command: string; args: string[] } {
  const currentScript = process.argv[1];

  // Bun virtual script path — treat like native binary
  const isBunVirtualScript = currentScript?.startsWith("/$bunfs/root/");
  if (currentScript && !isBunVirtualScript && existsSync(currentScript)) {
    return { command: process.execPath, args: [currentScript, ...extraArgs] };
  }

  // If execPath looks like a native pi binary (not node/bun), use it directly
  const execName = basename(process.execPath).toLowerCase();
  const isGenericRuntime = /^(node|bun)(\.exe)?$/.test(execName);
  if (!isGenericRuntime) {
    return { command: process.execPath, args: extraArgs };
  }

  // Fallback: try the `pi` command on PATH
  return { command: "pi", args: extraArgs };
}

// ─── Server: inbound connection accept loop ──────────────────────────────────

async function startServer(): Promise<void> {
  const socketPath = getSocketPath(peerId);
  listener = await transport.listen(socketPath);

  void (async () => {
    try {
      for await (const conn of listener!.connections) {
        void handleInboundConnection(conn).catch((err) => {
          console.error("[pi-collab] Inbound connection error:", err);
        });
      }
    } catch (err) {
      console.error("[pi-collab] Server accept loop error:", err);
    }
  })();
}

/**
 * Route an inbound connection. All messages except ping require prior
 * authentication via an `auth` envelope presenting this peer's token.
 */
async function handleInboundConnection(conn: PeerConnection): Promise<void> {
  const reader = conn.receive[Symbol.asyncIterator]();
  const firstResult = await reader.next();
  if (firstResult.done || !firstResult.value) {
    await conn.close();
    return;
  }

  const first = firstResult.value;

  // Ping is a pure connectivity check — no auth required
  if (first.type === "ping") {
    await conn.send(createPongEnvelope(peerId, first.source, first.id));
    await conn.close();
    return;
  }

  // All other message types require authentication
  if (first.type !== "auth") {
    await conn.send(createAuthResultEnvelope(peerId, first.source, first.id, false,
      `First message must be auth, got ${first.type}`));
    await conn.close();
    return;
  }

  const authPayload = first.payload as AuthPayload;
  if (!authToken || authPayload.token !== authToken) {
    await conn.send(createAuthResultEnvelope(peerId, first.source, first.id, false,
      "Invalid auth token"));
    await conn.close();
    return;
  }

  // Auth OK — acknowledge
  await conn.send(createAuthResultEnvelope(peerId, first.source, first.id, true));

  // Now read the actual message
  const secondResult = await reader.next();
  if (secondResult.done || !secondResult.value) {
    await conn.close();
    return;
  }

  const msg = secondResult.value;

  if (msg.type === "probe") {
    await handleProbe(conn, msg);
    return;
  }

  if (msg.type === "request") {
    // Look up caller's name for task annotation
    const callerRecord = first.source ? getPeerById(first.source) : undefined;
    const callerName = callerRecord?.name ?? "unknown";
    await handleInboundConversationPreRead(conn, msg, peerId, async (payload, askQuestion) => {
      const taskPrompt = buildTaskPrompt(payload, callerName);
      return agentCtx.injectTask(taskPrompt, askQuestion, config.conversationTimeoutMs)
        .then((text) => ({ result: text }));
    }, reader);
    return;
  }

  // Unknown post-auth message type
  await conn.close();
}

// ─── Client: authenticate a connection before use ────────────────────────────

/**
 * Authenticate to a peer: send auth envelope, wait for auth_result.
 * Reads the target's auth token from its PeerRecord.
 */
async function authenticateConnection(
  conn: PeerConnection,
  targetPeerId: string,
  targetName: string,
): Promise<void> {
  // Token comes from local PeerRecord or the cached remote entry
  const record = resolveName(targetName) ?? getPeerById(targetPeerId);
  const remote = getRemote(targetName);
  const token = record?.authToken ?? remote?.authToken;
  if (!token) {
    await conn.close();
    throw new CollabError("auth_failed",
      `No auth token found for "${targetName}" in the registry. The peer may not be running.`);
  }

  await conn.send(createAuthEnvelope(peerId, targetPeerId, token));

  const reader = conn.receive[Symbol.asyncIterator]();
  const result = await reader.next();
  if (result.done || !result.value) {
    await conn.close();
    throw new CollabError("protocol_error", "Connection closed during auth handshake");
  }

  const env = result.value;
  if (env.type !== "auth_result") {
    await conn.close();
    throw new CollabError("protocol_error", `Expected auth_result, got ${env.type}`);
  }

  const payload = env.payload as AuthResultPayload;
  if (!payload.ok) {
    await conn.close();
    throw new CollabError("auth_failed", `Authentication rejected: ${payload.reason ?? "unknown"}`);
  }
}

/**
 * Resolve a peer name to connection info, checking the local registry
 * first, then remote SSH entries.
 *
 * For remote peers, ensures the SSH tunnel is up and returns the LOCAL
 * socket path (the tunnel endpoint) plus the cached auth token.
 */
async function resolvePeer(name: string): Promise<{
  kind: "local" | "remote";
  peerId: string;
  socketPath: string;
  token: string | undefined;
  record?: PeerRecord;
  remote?: RemotePeer;
}> {
  // 1. Local registry
  const record = resolveName(name);
  if (record) {
    return {
      kind: "local",
      peerId: record.peerId,
      socketPath: record.socketPath,
      token: record.authToken,
      record,
    };
  }

  // 2. Remote SSH entry
  const remote = getRemote(name);
  if (remote) {
    const localPath = await sshTunnelManager.ensureTunnel(remote.name, remote.sshTarget, remote.remoteSocketPath);
    return {
      kind: "remote",
      peerId: remote.peerId,
      socketPath: localPath,
      token: remote.authToken,
      remote,
    };
  }

  throw new CollabError("peer_not_found",
    `Colleague "${name}" not found locally or as a remote SSH peer.`);
}

/**
 * Get the available peers for display/broadcast: local peers + remote peers.
 * Returns display entries without the local socket path complications.
 */
function listAllPeers(): Array<{
  name: string;
  peerId: string;
  status: string;
  model: string;
  cwd?: string;
  capabilities?: string[];
  source: "local" | "remote";
}> {
  const local = listPeers().map((p) => ({
    name: p.name,
    peerId: p.peerId,
    status: p.status,
    model: p.model,
    cwd: p.cwd,
    capabilities: p.capabilities,
    source: "local" as const,
  }));
  const remote = listRemotes().map((r) => ({
    name: r.name,
    peerId: r.peerId,
    status: sshTunnelManager.names.includes(r.name) ? "idle" : "unreachable",
    model: r.model ?? "unknown",
    cwd: `ssh:${r.sshTarget}`,
    capabilities: r.capabilities,
    source: "remote" as const,
  }));
  return [...local, ...remote];
}

/**
 * Respond to a probe OOB with local peer metadata.
 * Never touches the LLM context.
 */
async function handleProbe(conn: PeerConnection, probeEnv: Envelope): Promise<void> {
  const probePayload = probeEnv.payload as ProbePayload;

  // Get current peer state from the registry
  const self = getPeerById(peerId);
  const caps = self?.capabilities ?? [];
  const peerMeta = {
    name: config.name,
    model: currentModel,
    status: self?.status ?? "idle",
    cwd: process.cwd(),
    capabilities: caps,
  };

  // Match against probe filter (best-effort, transport-layer matching)
  let matched = true;
  if (probePayload.status && peerMeta.status !== probePayload.status) {
    matched = false;
  }
  if (probePayload.capability) {
    // Case-insensitive keyword match against aggregated capabilities
    const needle = probePayload.capability.toLowerCase();
    const haystack = caps.join(" ").toLowerCase();
    if (!haystack.includes(needle)) {
      matched = false;
    }
  }

  const response = createProbeResponseEnvelope(peerId, probeEnv.source, probeEnv.id, {
    matched,
    peer: peerMeta,
  });

  await conn.send(response);
  await conn.close();
}

// ─── Client: send a probe to a peer (OOB, no LLM) ───────────────────────────

async function probePeer(targetName: string, capability?: string): Promise<{
  name: string;
  model: string;
  status: PeerStatus;
  cwd: string;
  capabilities?: string[];
  matched: boolean;
}> {
  let peer: Awaited<ReturnType<typeof resolvePeer>>;
  try {
    peer = await resolvePeer(targetName);
  } catch (err) {
    if (err instanceof CollabError && err.code === "peer_not_found") {
      throw new CollabError("peer_not_found", `Colleague "${targetName}" not found`);
    }
    throw err;
  }

  const conn = await transport.connect({
    socketPath: peer.socketPath,
    peerId: peer.peerId,
  });

  try {
    await authenticateConnection(conn, peer.peerId, targetName);

    const probe = createProbeEnvelope(peerId, peer.peerId, capability ? { capability } : {});
    await conn.send(probe);

    const reader = conn.receive[Symbol.asyncIterator]();
    const result = await reader.next();
    if (result.done || !result.value) {
      throw new Error("No probe response");
    }

    const env = result.value;
    if (env.type === "probe_response") {
      const payload = env.payload as ProbeResponsePayload;
      return { ...payload.peer, matched: payload.matched };
    }

    throw new Error(`Unexpected response type: ${env.type}`);
  } finally {
    try { await conn.close(); } catch { /* ignore */ }
  }
}

function buildTaskPrompt(payload: { operation: string; task: string; focusAreas?: string[] }, from?: string): string {
  const who = from ? `FROM ${from}` : "FROM COLLEAGUE AGENT";
  const header = [
    "┌─────────────────────────────────────────────┐",
    `│  INCOMING TASK ${who.padEnd(30)}│`,
    "│  → This is NOT from your user              │",
    "│  → Your response goes to the colleague     │",
    "│  → Be concise and technical                │",
    "│  → No greetings, no sign-offs              │",
    "│  → Use ask_colleague tool if you need info │",
    "└─────────────────────────────────────────────┘",
  ].join("\n");

  const lines: string[] = [header, ""];
  if (payload.focusAreas?.length) {
    lines.push(`Focus areas: ${payload.focusAreas.join(", ")}`);
    lines.push("");
  }
  lines.push(payload.task);
  lines.push("");
  lines.push("---");
  lines.push("REMEMBER: You are processing a task from another agent, not from your user.");
  lines.push("Your response will be sent directly back to that agent.");
  lines.push("Do not ask your user for input — use ask_colleague if needed.");
  return lines.join("\n");
}

// ─── Client: send a request to a peer ────────────────────────────────────────

interface DelegateOptions {
  maxTurns?: number;
  focusAreas?: string[];
  context?: { files?: Array<{ path: string; content: string }>; messages?: string };
  conversationId?: string;
}

interface DelegateResult {
  text: string;
  usage?: { input: number; output: number; turns: number; cost: number };
  toolCalls?: Array<{ tool: string; input: unknown; outputSnippet: string }>;
}

async function delegateToPeer(
  targetName: string,
  operation: string,
  task: string,
  options: DelegateOptions,
  signal?: AbortSignal,
): Promise<DelegateResult> {
  if (signal?.aborted) throw new CollabError("cancelled", "Delegate aborted by user before connecting");

  const peer = await resolvePeer(targetName);

  if (peer.kind === "local" && peer.record?.status === "unreachable") {
    throw new CollabError("peer_unreachable",
      `Colleague "${targetName}" has been unreachable for over 30s (last heartbeat: ${peer.record.lastHeartbeatAt})`);
  }

  const protocolConvId = randomUUID();

  // If this is a multi-round discussion, prefix the task with conversation context.
  // This helps B's LLM understand it's a continuation.
  let fullTask = task;
  if (options.conversationId) {
    fullTask = [
      `[DISCUSSION: ${options.conversationId}]  Round continuation.`,
      "Your session persists across rounds. See previous messages for context.",
      "If you have questions, write them in your response for the next round.",
      "",
      task,
    ].join("\n");
  } else {
    // For one-shot delegations: also add a brief header so the conversation
    // prefix doesn't depend on conversationId being set
    fullTask = [
      "[ONE-SHOT DELEGATION — single round, no follow-up expected]",
      task,
    ].join("\n");
  }

  const conn = await transport.connect({
    socketPath: peer.socketPath,
    peerId: peer.peerId,
  });

  await authenticateConnection(conn, peer.peerId, targetName);

  const result = await runConversation(
    conn,
    protocolConvId,
    peerId,
    peer.peerId,
    operation,
    fullTask,
    options,
    {
      onQuestion: async (question: string, _needsLlmInput: boolean) => {
        console.error(`[pi-collab] Remote peer asked: ${question.slice(0, 200)}`);
        return [
          "Cannot answer synchronously — this is a blocking delegation.",
          "Write your questions in your response. I will address them in the next round.",
          "Do NOT wait — produce your best answer with the information you have.",
        ].join(" ");
      },
    },
    signal ?? AbortSignal.timeout?.(config.conversationTimeoutMs),
  );

  if (result.error) {
    const code = fromProtocolCode(result.error.code);
    throw new CollabError(code, result.error.message);
  }

  return {
    text: result.result!.text,
    usage: result.result!.usage,
    toolCalls: result.result!.toolCalls,
  };
}

// ─── Tools ──────────────────────────────────────────────────────────────────

function registerTools(pi: ExtensionAPI): void {
  // ── delegate_to_colleague ──

  pi.registerTool({
    name: "delegate_to_colleague",
    label: "Delegate to Colleague",
    description:
      "Delegate a task to a named colleague agent. The colleague works " +
      "independently with its own tools and context window, then returns a " +
      "result. Use this to parallelise work or engage a specialist.\n\n" +
      "For MULTI-ROUND discussions: pass a `conversation_id` (any short " +
      "string you invent, like 'auth-refactor'). The colleague's session " +
      "persists across calls — they see full history. If they need more " +
      "info, they will write questions in their response for you to answer " +
      "in the next round. Continue calling with the same `conversation_id` " +
      "until the discussion is resolved.\n\n" +
      "Do NOT use for quick facts — only for substantial subtasks.",
    promptSnippet: "Delegate a substantial subtask to a named colleague agent and wait for the result",
    promptGuidelines: [
      "Use delegate_to_colleague for substantial subtasks that benefit from an independent context window.",
      "Do NOT use delegate_to_colleague for quick lookups — use grep/read/bash yourself instead.",
      "For multi-round discussions, reuse the same conversationId across calls so the colleague sees prior context.",
    ],
    parameters: Type.Object({
      colleague: Type.String({
        description: "Name of the colleague, e.g. 'reviewer', 'architect'.",
      }),
      task: Type.String({
        description: "Task description. Be specific and include file paths. " +
          "For multi-round: include any new info, answer their questions, " +
          "and state your updated position.",
      }),
      maxTurns: Type.Optional(Type.Number({
        description: "Max turns for the colleague. Default: 20.",
      })),
      includeFiles: Type.Optional(Type.Array(Type.String(), {
        description: "File paths to include as context for the colleague.",
      })),
      conversationId: Type.Optional(Type.String({
        description: "For multi-round discussions: a short identifier you " +
          "invent to track this conversation across calls (e.g. 'auth-refactor', " +
          "'bug-342'). Omit for one-shot delegations.",
      })),
    }),
    async execute(toolCallId, params, signal, onUpdate, ctx) {
      const { colleague, task, maxTurns, includeFiles, conversationId } = params as {
        colleague: string;
        task: string;
        maxTurns?: number;
        includeFiles?: string[];
        conversationId?: string;
      };

      const context: { files?: Array<{ path: string; content: string }> } = {};
      if (includeFiles?.length) {
        context.files = [];
        for (const fp of includeFiles) {
          try {
            const resolved = join(ctx.cwd, fp);
            context.files.push({ path: resolved, content: readFileSync(resolved, "utf-8") });
          } catch { /* skip unreadable files */ }
        }
      }

      const result = await delegateToPeer(colleague, "delegate", task, { maxTurns, context, conversationId }, signal);

      return {
        content: [{ type: "text", text: result.text }],
        details: { colleague, usage: result.usage, toolCalls: result.toolCalls },
      };
    },

    renderCall(args, theme, _context) {
      const colleague = args.colleague as string ?? "...";
      const task = (args.task as string) ?? "...";
      const preview = task.length > 80 ? `${task.slice(0, 80)}...` : task;
      let text = theme.fg("toolTitle", theme.bold("delegate_to_colleague "));
      text += theme.fg("accent", `→ ${colleague}`);
      if (args.conversationId) {
        text += theme.fg("dim", ` [${args.conversationId}]`);
      }
      text += `\n  ${theme.fg("dim", preview)}`;
      return new Text(text, 0, 0);
    },

    renderResult(result, { expanded }, theme, _context) {
      const details = result.details as { colleague?: string; usage?: { input: number; output: number; turns: number; cost: number }; toolCalls?: Array<{ tool: string }> } | undefined;
      const icon = result.isError ? theme.fg("error", "✗") : theme.fg("success", "✓");
      const name = details?.colleague ?? "colleague";
      const usageStr = formatUsage(details?.usage);
      const toolCount = details?.toolCalls?.length ?? 0;

      let header = `${icon} ${theme.fg("toolTitle", theme.bold(name))}`;
      if (usageStr) header += theme.fg("dim", `  ${usageStr}`);
      if (toolCount) header += theme.fg("dim", `  ${toolCount} tools`);

      if (!expanded) {
        const text = result.content[0];
        const preview = text?.type === "text" ? text.text.slice(0, 120) : "";
        if (preview) {
          return new Text(`${header}\n${theme.fg("toolOutput", preview)}`, 0, 0);
        }
        return new Text(header, 0, 0);
      }

      const container = new Container();
      container.addChild(new Text(header, 0, 0));
      const text = result.content[0];
      if (text?.type === "text") {
        container.addChild(new Spacer(1));
        container.addChild(new Text(text.text, 0, 0));
      }
      if (details?.toolCalls?.length) {
        container.addChild(new Spacer(1));
        const tools = details.toolCalls.map((tc) => tc.tool).join(", ");
        container.addChild(new Text(theme.fg("dim", `Tools used: ${tools}`), 0, 0));
      }
      return container;
    },
  });

  // ── broadcast_to_colleagues ──

  pi.registerTool({
    name: "broadcast_to_colleagues",
    label: "Broadcast to Colleagues",
    description:
      "Broadcast a message to all available colleagues and collect replies. " +
      "Uses out-of-band probes (zero context cost) to discover peer status first. " +
      "Replies contain each peer's name, model, status, working directory, and capabilities.\n\n" +
      "Pass a `capability` to filter peers by keyword (e.g. 'security', 'typescript', " +
      "'review'). Matching is case-insensitive against the peer's aggregated " +
      "capability tags (PI_COLLAB_CAPABILITIES env + active tool names).",
    promptSnippet: "Discover available colleague agents, their status, and capabilities (zero context cost)",
    promptGuidelines: [
      "Use broadcast_to_colleagues to check which colleagues are available before delegating work.",
      "broadcast_to_colleagues uses OOB probes — it never consumes LLM context tokens for discovery.",
      "Pass a capability keyword to find colleagues with specific skills, e.g. { capability: 'security' }.",
    ],
    parameters: Type.Object({
      message: Type.String({ description: "Message to broadcast." }),
      filter: Type.Optional(Type.Array(Type.String(), {
        description: "Only send to these names. Omit = all.",
      })),
      capability: Type.Optional(Type.String({
        description: "Filter peers by capability keyword (e.g. 'security', 'review'). " +
          "Case-insensitive match against peer's tool names and PI_COLLAB_CAPABILITIES tags.",
      })),
      waitForReplies: Type.Optional(Type.Boolean({
        description: "Wait for replies? Default: true.",
      })),
    }),
    async execute(toolCallId, params, signal, onUpdate, ctx) {
      const { message, filter, capability, waitForReplies } = params as {
        message: string;
        filter?: string[];
        capability?: string;
        waitForReplies?: boolean;
      };

      const targets = listAllPeers().filter((p) => {
        if (p.peerId === peerId) return false;
        if (filter?.length && !filter.includes(p.name)) return false;
        // Remote peers: always attempt — the tunnel is established lazily
        // inside probePeer/resolvePeer. Excluding by tunnel state would
        // make them invisible to the LLM.
        if (p.source === "remote") return true;
        return p.status !== "unreachable";
      });

      if (targets.length === 0) {
        return { content: [{ type: "text", text: "No available colleagues." }] };
      }

      const shouldWait = waitForReplies !== false;

      if (!shouldWait) {
        // Fire-and-forget announcement — still uses OOB probe to avoid LLM cost
        for (const p of targets) {
          probePeer(p.name, capability).catch((err) => {
            console.error(`[pi-collab] Broadcast probe to ${p.name} failed:`, err);
          });
        }
        return {
          content: [{
            type: "text",
            text: `Broadcast sent to ${targets.length} colleague(s): ${targets.map((p) => p.name).join(", ")}`,
          }],
        };
      }

      // Probe all peers OOB (no context cost) to discover their status
      const probeResults = await Promise.allSettled(
        targets.map((p) => probePeer(p.name, capability)),
      );

      const parts: string[] = [capability
        ? `Probed ${targets.length} colleague(s) for capability "${capability}":\n`
        : `Probed ${targets.length} colleague(s):\n`];
      for (let i = 0; i < targets.length; i++) {
        const r = probeResults[i];
        if (r.status === "fulfilled") {
          const { name, model, status: s, cwd, capabilities: caps } = r.value;
          const capStr = caps?.length ? `  [${caps.join(", ")}]` : "";
          parts.push(`- **${name}**  ${s}  ${model}  \`${cwd}\`${capStr}`);
        } else {
          parts.push(`- **${targets[i].name}**  unreachable`);
        }
      }
      parts.push("\nUse `delegate_to_colleague` to send a task to a specific colleague.");

      return { content: [{ type: "text", text: parts.join("\n") }] };
    },

    renderCall(args, theme, _context) {
      const count = (args.filter as string[])?.length ?? "all";
      let text = theme.fg("toolTitle", theme.bold("broadcast_to_colleagues "));
      text += theme.fg("accent", `→ ${count} peer(s)`);
      return new Text(text, 0, 0);
    },

    renderResult(result, _options, theme, _context) {
      const text = result.content[0];
      const content = text?.type === "text" ? text.text : "";
      const lines = content.split("\n");
      let out = theme.fg("success", "✓") + " " + theme.fg("toolTitle", theme.bold("broadcast"));
      for (const line of lines.slice(1, 8)) {
        if (line.trim()) out += `\n  ${theme.fg("dim", line.trim())}`;
      }
      return new Text(out, 0, 0);
    },
  });

  // ── review_by_colleague ──

  pi.registerTool({
    name: "review_by_colleague",
    label: "Review by Colleague",
    description:
      "Ask a colleague to review code or a design and return structured feedback.",
    promptSnippet: "Ask a colleague to review code or design with structured, severity-rated feedback",
    promptGuidelines: [
      "Use review_by_colleague before committing or merging significant changes.",
      "Specify focusAreas to narrow the review scope — e.g. ['security', 'performance', 'correctness'].",
    ],
    parameters: Type.Object({
      colleague: Type.String({ description: "Name of the reviewing colleague." }),
      subject: Type.String({ description: "What to review — describe or paste content." }),
      files: Type.Optional(Type.Array(Type.String(), {
        description: "File paths to include in the review.",
      })),
      focusAreas: Type.Optional(Type.Array(Type.String(), {
        description: "Focus areas, e.g. ['security', 'performance', 'correctness'].",
      })),
    }),
    async execute(toolCallId, params, signal, onUpdate, ctx) {
      const { colleague, subject, files, focusAreas } = params as {
        colleague: string;
        subject: string;
        files?: string[];
        focusAreas?: string[];
      };

      const context: { files?: Array<{ path: string; content: string }> } = {};
      if (files?.length) {
        context.files = [];
        for (const fp of files) {
          try {
            const resolved = join(ctx.cwd, fp);
            context.files.push({ path: resolved, content: readFileSync(resolved, "utf-8") });
          } catch { /* skip */ }
        }
      }

      const reviewPrompt = [
        "## Code Review Request",
        focusAreas?.length ? `Focus areas: ${focusAreas.join(", ")}` : "",
        "",
        "Provide a structured review with:",
        "- Summary (1-2 sentences)",
        "- Issues found (each with severity: critical/high/medium/low, file, and description)",
        "- Suggestions for improvement",
        "",
        "## Subject",
        subject,
      ].filter(Boolean).join("\n");

      const result = await delegateToPeer(colleague, "review", reviewPrompt, { focusAreas, context }, signal);

      return {
        content: [{ type: "text", text: result.text }],
        details: { colleague, reviewOf: subject.slice(0, 100) },
      };
    },

    renderCall(args, theme, _context) {
      const colleague = args.colleague as string ?? "...";
      const areas = (args.focusAreas as string[])?.join(", ") ?? "general";
      let text = theme.fg("toolTitle", theme.bold("review_by_colleague "));
      text += theme.fg("accent", `→ ${colleague}`);
      text += theme.fg("dim", `  [${areas}]`);
      return new Text(text, 0, 0);
    },

    renderResult(result, { expanded }, theme, _context) {
      const details = result.details as { colleague?: string; reviewOf?: string } | undefined;
      const icon = result.isError ? theme.fg("error", "✗") : theme.fg("success", "✓");
      const name = details?.colleague ?? "reviewer";

      let header = `${icon} ${theme.fg("toolTitle", theme.bold(name))}`;
      if (details?.reviewOf) {
        header += theme.fg("dim", `  re: ${details.reviewOf}`);
      }

      if (!expanded) {
        const text = result.content[0];
        const preview = text?.type === "text" ? text.text.split("\n").slice(0, 3).join("\n") : "";
        if (preview) {
          return new Text(`${header}\n${theme.fg("toolOutput", preview)}`, 0, 0);
        }
        return new Text(header, 0, 0);
      }

      const container = new Container();
      container.addChild(new Text(header, 0, 0));
      const text = result.content[0];
      if (text?.type === "text") {
        container.addChild(new Spacer(1));
        container.addChild(new Text(text.text, 0, 0));
      }
      return container;
    },
  });

  // ── ask_colleague (used by the LLM during inbound request processing) ──

  pi.registerTool({
    name: "ask_colleague",
    label: "Ask Colleague",
    description:
      "Ask a clarifying question to the colleague who delegated this task. " +
      "Only available when processing a delegated request from another agent.",
    promptSnippet: "Ask a clarifying question back to the delegating colleague (only during delegation)",
    promptGuidelines: [
      "Use ask_colleague only when you are actively processing an inbound delegated task.",
      "Ask specific, targeted questions — the calling agent will provide answers.",
    ],
    parameters: Type.Object({
      question: Type.String({
        description: "Your question. Be specific.",
      }),
    }),
    async execute(toolCallId, params, signal, onUpdate, ctx) {
      const askQ = agentCtx.getActiveAskQuestion();
      if (!askQ) {
        return {
          content: [{
            type: "text",
            text: "No active delegation. This tool is only available when processing a request from another agent.",
          }],
        };
      }

      const answer = await askQ(params.question as string);
      return { content: [{ type: "text", text: answer }] };
    },
  });
}

// ─── Commands ───────────────────────────────────────────────────────────────

function registerCommands(pi: ExtensionAPI): void {
  pi.registerCommand("collab", {
    description: "Manage collaboration peers",
    getArgumentCompletions: (prefix: string) => {
      const subcommands = ["spawn", "list", "stop", "start", "rename", "status", "delegate", "token", "templates", "remote"];
      const parts = prefix.trim().split(/\s+/);

      if (parts.length <= 1) {
        const matching = subcommands.filter((s) => s.startsWith(parts[0] ?? ""));
        if (matching.length > 0) return matching.map((s) => ({ value: s, label: s }));
      }

      // For spawn, suggest template names as second argument
      if (parts[0] === "spawn" && parts.length === 2) {
        const { templates } = discoverColleagues(process.cwd());
        const namePrefix = parts[1] ?? "";
        const matching = templates
          .filter((t) => t.name.startsWith(namePrefix))
          .map((t) => ({ value: t.name, label: `${t.name} — ${t.description}` }));
        if (matching.length > 0) return matching;
      }

      // For stop/status/delegate, suggest peer names as second argument
      if ((parts[0] === "stop" || parts[0] === "status" || parts[0] === "delegate") && parts.length === 2) {
        const peers = listPeers().filter((p) => p.peerId !== peerId);
        const namePrefix = parts[1] ?? "";
        const matching = peers
          .map((p) => p.name)
          .filter((n) => n.startsWith(namePrefix));
        if (matching.length > 0) return matching.map((n) => ({ value: n, label: n }));
      }

      return null;
    },
    handler: async (args, ctx) => {
      const parts = args.trim().split(/\s+/);
      const sub = parts[0];
      const rest = parts.slice(1).join(" ");

      switch (sub) {
        case "spawn": return spawnPeerCommand(rest, ctx);
        case "list": return listPeersCommand(ctx);
        case "stop": return stopPeerCommand(rest, ctx);
        case "start": return startPeerCommand(ctx);
        case "rename": return renamePeerCommand(rest, ctx);
        case "status": return statusPeerCommand(rest, ctx);
        case "delegate": return delegateCommand(rest, ctx);
        case "token": return tokenCommand(ctx);
        case "templates": return templatesCommand(ctx);
        case "remote": return remoteCommand(rest, ctx);
        default:
          ctx.ui.notify(
            "Usage: /collab spawn|list|stop|start|rename|status|delegate|token|templates|remote",
            "warning",
          );
      }
    },
  });
}

// ── /collab delegate <name> <task> ──────────────────────────────────────────

async function delegateCommand(args: string, ctx: ExtensionCommandContext): Promise<void> {
  const nameMatch = args.match(/^(\S+)\s+(.+)$/s);
  if (!nameMatch) {
    ctx.ui.notify("Usage: /collab delegate <name> <task description>", "warning");
    return;
  }

  const targetName = nameMatch[1];
  const task = nameMatch[2].trim();

  ctx.ui.notify(`Delegating to "${targetName}"...`, "info");

  try {
    const result = await delegateToPeer(targetName, "delegate", task, {});
    ctx.ui.notify(
      `${targetName} responded (${result.usage?.turns ?? "?"} turns, \$${(result.usage?.cost ?? 0).toFixed(4)}):\n${result.text.slice(0, 500)}`,
      "info",
    );
  } catch (err: unknown) {
    const msg = err instanceof CollabError ? err.label : (err instanceof Error ? err.message : String(err));
    ctx.ui.notify(`Delegation failed: ${msg}`, "error");
  }
}

// ── /collab token ───────────────────────────────────────────────────────────

function tokenCommand(ctx: ExtensionCommandContext): void {
  if (!authToken) {
    ctx.ui.notify("No auth token available (peer not registered?)", "error");
    return;
  }
  ctx.ui.notify(
    `Auth token: ${authToken}\n\nWARNING: Share this only with trusted peers. Anyone with this token can connect to your peer.`,
    "warning",
  );
}

// ── /collab spawn ───────────────────────────────────────────────────────────

async function spawnPeerCommand(args: string, ctx: ExtensionCommandContext): Promise<void> {
  const nameMatch = args.match(/^(\S+)/);
  if (!nameMatch) {
    ctx.ui.notify('Usage: /collab spawn <name> [--model provider/model] [--prompt "..."] [--tools tool1,tool2]', "warning");
    ctx.ui.notify('       /collab spawn <template> [--name peer-name]     (use a colleague template)', "info");
    return;
  }

  const nameOrTemplate = nameMatch[1];
  const remaining = args.slice(nameOrTemplate.length).trim();
  const modelMatch = remaining.match(/--model\s+(\S+)/);
  const promptMatch = remaining.match(/--prompt\s+"([^"]+)"/);
  const nameOverrideMatch = remaining.match(/--name\s+(\S+)/);
  const toolsMatch = remaining.match(/--tools\s+(\S+)/);

  // Resolve template if the name matches
  let template: ColleagueTemplate | undefined;
  try { template = resolveColleague(nameOrTemplate, process.cwd()); } catch { /* ignore */ }

  const peerName = nameOverrideMatch?.[1] ?? (template ? template.name : nameOrTemplate);
  const model = modelMatch?.[1] ?? template?.model;
  const systemPrompt = promptMatch?.[1] ?? template?.systemPrompt;

  ctx.ui.notify(`Spawning colleague "${peerName}"...`, "info");

  const extPath = resolveExtensionPath();
  if (!extPath) {
    ctx.ui.notify("Cannot resolve pi-collab extension path. Spawned peer won't have collab support.", "warning");
  }

  const env: Record<string, string> = {
    ...(process.env as Record<string, string>),
    PI_COLLAB_NAME: peerName,
  };
  if (systemPrompt) env.PI_COLLAB_SYSTEM_PROMPT = systemPrompt;
  if (model) env.PI_COLLAB_MODEL = model;

  const extraArgs = ["--mode", "rpc", "--extension", extPath];
  if (model) extraArgs.push("--model", model);
  if (toolsMatch?.[1]) extraArgs.push("--tools", toolsMatch[1]);

  const invocation = getPiInvocation(extraArgs);
  const childProcess = spawn(invocation.command, invocation.args, {
    cwd: process.cwd(),
    env,
    stdio: ["pipe", "pipe", "pipe"],
    detached: true,
  });

  childProcess.on("error", (err) => {
    ctx.ui.notify(`Failed to spawn "${peerName}": ${err.message}`, "error");
  });

  // Poll for peer registration (up to 10 s, checking every 200 ms)
  const deadline = Date.now() + 10_000;
  let peer = resolveName(peerName);
  while (!peer && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 200));
    peer = resolveName(peerName);
  }

  if (peer) {
    ctx.ui.notify(`Colleague "${peerName}" is online (${peer.peerId.slice(0, 8)}...)`, "info");
  } else {
    ctx.ui.notify(`Colleague "${peerName}" spawned but not yet registered after 10s. Check stderr for errors.`, "warning");
  }

  // Detach so the child outlives this session if needed.
  // On Windows, spawned processes ignore POSIX signals;
  // /collab stop cleans up the registry instead of killing.
  childProcess.unref();
}

function templatesCommand(ctx: ExtensionCommandContext): void {
  const { templates, projectColleaguesDir } = discoverColleagues(ctx.cwd);
  if (templates.length === 0) {
    const globalDir = `${getAgentDir()}/colleagues`;
    ctx.ui.notify(
      `No colleague templates found.\n\nCreate .md files in:\n  ${globalDir}\n  .pi/colleagues/\n\nSee README for format.`,
      "info",
    );
    return;
  }

  const lines: string[] = [`${templates.length} template(s) available:`];
  if (projectColleaguesDir) {
    lines.push(`Project: ${projectColleaguesDir}`);
  }
  lines.push(formatColleagueList(templates));
  lines.push("\nUse /collab spawn <template> to start a peer from a template.");
  ctx.ui.notify(lines.join("\n"), "info");
}

// ── /collab remote — cross-host SSH peers ────────────────────────────────────

async function fetchRemoteRecord(sshTarget: string, name: string): Promise<PeerRecord> {
  // Read the name pointer, then the full record. Escape the name for the shell.
  const safeName = name.replace(/[^\w.-]/g, "_");
  let pointerOut: string;
  try {
    pointerOut = await sshExec(sshTarget, `cat ~/.pi/collab/peers/by-name/${safeName}.json`);
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    if (/Permission denied|password|publickey|key/i.test(msg)) {
      throw new CollabError("auth_failed",
        `Cannot reach ${sshTarget}: SSH key auth required (password prompts are disabled to protect the TUI). ` +
        `Set up keys with: ssh-copy-id ${sshTarget}`);
    }
    throw new CollabError("peer_unreachable",
      `Cannot reach remote peer "${name}" on ${sshTarget}: ${msg}`);
  }
  let pointer: { peerId: string };
  try {
    pointer = JSON.parse(pointerOut);
  } catch {
    throw new CollabError("peer_not_found",
      `Remote peer "${name}" not found on ${sshTarget}. Is pi-collab running there?`);
  }
  const recordOut = await sshExec(sshTarget, `cat ~/.pi/collab/peers/by-id/${pointer.peerId}.json`);
  try {
    return JSON.parse(recordOut) as PeerRecord;
  } catch {
    throw new CollabError("peer_unreachable",
      `Remote peer "${name}" registered but its record is unreadable on ${sshTarget}.`);
  }
}

/**
 * Pre-flight check: verify SSH key-based auth works before any remote op.
 * Password prompts are disabled (BatchMode), so without keys this fails fast
 * with a clear message instead of corrupting the TUI.
 */
async function checkSshAccess(sshTarget: string): Promise<void> {
  try {
    await sshExec(sshTarget, "true");
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    if (/Permission denied|password|publickey|key/i.test(msg)) {
      throw new CollabError("auth_failed",
        `SSH key auth to ${sshTarget} failed. Password prompts are disabled to protect the TUI.\n` +
        `Set up keys:\n  ssh-keygen -t ed25519\n  ssh-copy-id ${sshTarget}\n` +
        `Then verify: ssh ${sshTarget} "echo ok"`);
    }
    throw new CollabError("peer_unreachable", `Cannot reach ${sshTarget}: ${msg}`);
  }
}

/**
 * Register ALL peers running on a remote host. Lists the remote registry's
 * by-name directory and adds every peer as a remote entry.
 */
async function addAllRemotes(sshTarget: string, ctx: ExtensionCommandContext): Promise<void> {
  await checkSshAccess(sshTarget);
  ctx.ui.notify(`Fetching all peers from ${sshTarget}...`, "info");

  let names: string[];
  try {
    const out = await sshExec(sshTarget, "ls ~/.pi/collab/peers/by-name/ 2>/dev/null | sed 's/\\.json$//'");
    names = out.split(/\n/).map((s) => s.trim()).filter(Boolean);
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new CollabError("peer_unreachable",
      `Cannot list peers on ${sshTarget}: ${msg}. Is pi-collab running there?`);
  }

  if (names.length === 0) {
    ctx.ui.notify(`No peers registered on ${sshTarget}.`, "warning");
    return;
  }

  const ok: string[] = [];
  const fail: string[] = [];

  for (const name of names) {
    try {
      const record = await fetchRemoteRecord(sshTarget, name);
      const remote: RemotePeer = {
        name,
        sshTarget,
        peerId: record.peerId,
        remoteSocketPath: record.socketPath,
        authToken: record.authToken ?? "",
        model: record.model,
        capabilities: record.capabilities,
        addedAt: new Date().toISOString(),
      };
      addRemote(remote);
      const localPath = await sshTunnelManager.ensureTunnel(name, sshTarget, record.socketPath);
      ok.push(name);
      ctx.ui.notify(`  ✓ ${name} — ${record.model} (${localPath})`, "info");
    } catch (err: unknown) {
      removeRemote(name);
      fail.push(name);
      ctx.ui.notify(`  ✗ ${name}: ${err instanceof Error ? err.message : String(err)}`, "error");
    }
  }

  ctx.ui.notify(
    `Remote sync from ${sshTarget}: ${ok.length} added, ${fail.length} failed.` +
    (fail.length ? ` Failed: ${fail.join(", ")}` : ""),
    fail.length ? "warning" : "info",
  );
}

async function remoteCommand(args: string, ctx: ExtensionCommandContext): Promise<void> {
  const parts = args.trim().split(/\s+/);
  const sub = parts[0];
  const rest = parts.slice(1).join(" ");

  switch (sub) {
    case "add": {
      if (isWindows) {
        ctx.ui.notify("SSH transport requires Unix socket forwarding — not supported on Windows yet.", "error");
        return;
      }

      const m = rest.match(/^(\S+)\s+(\S+)$/);
      if (!m) {
        // No <name> given — register ALL peers on the remote host.
        const sshTarget = rest.trim();
        if (!sshTarget) {
          ctx.ui.notify("Usage: /collab remote add <user@host>  (all peers)\n" +
            "       /collab remote add <name> <user@host>  (one peer)", "warning");
          return;
        }
        await addAllRemotes(sshTarget, ctx);
        return;
      }

      const name = m[1];
      const sshTarget = m[2];
      ctx.ui.notify(`Fetching remote peer "${name}" from ${sshTarget}...`, "info");
      try {
        await checkSshAccess(sshTarget);
        const record = await fetchRemoteRecord(sshTarget, name);
        const remote: RemotePeer = {
          name,
          sshTarget,
          peerId: record.peerId,
          remoteSocketPath: record.socketPath,
          authToken: record.authToken ?? "",
          model: record.model,
          capabilities: record.capabilities,
          addedAt: new Date().toISOString(),
        };
        addRemote(remote);
        // Establish tunnel immediately so the peer is reachable
        const localPath = await sshTunnelManager.ensureTunnel(name, sshTarget, record.socketPath);
        ctx.ui.notify(
          `Remote peer "${name}" added (${sshTarget}). Tunnel: ${localPath}\n` +
          `Model: ${record.model}  Capabilities: ${record.capabilities?.join(", ") ?? "none"}`,
          "info",
        );
      } catch (err: unknown) {
        // Roll back the cached entry if the tunnel couldn't be established,
        // so a failed add never leaves an unreachable ghost peer behind.
        removeRemote(name);
        const msg = err instanceof CollabError ? err.label : (err instanceof Error ? err.message : String(err));
        ctx.ui.notify(`Failed to add remote peer: ${msg}`, "error");
      }
      return;
    }

    case "remove": {
      const name = rest.trim();
      if (!name) {
        ctx.ui.notify("Usage: /collab remote remove <name>", "warning");
        return;
      }
      sshTunnelManager.closeTunnel(name);
      const removed = removeRemote(name);
      ctx.ui.notify(removed ? `Remote peer "${name}" removed.` : `Remote peer "${name}" not found.`, removed ? "info" : "warning");
      return;
    }

    case "refresh": {
      const name = rest.trim();
      const existing = getRemote(name);
      if (!name || !existing) {
        ctx.ui.notify("Usage: /collab remote refresh <name> — re-fetch a remote peer's record (new token/path).", "warning");
        return;
      }
      ctx.ui.notify(`Refreshing remote peer "${name}" from ${existing.sshTarget}...`, "info");
      try {
        const record = await fetchRemoteRecord(existing.sshTarget, name);
        const updated: RemotePeer = {
          ...existing,
          peerId: record.peerId,
          remoteSocketPath: record.socketPath,
          authToken: record.authToken ?? "",
          model: record.model,
          capabilities: record.capabilities,
        };
        addRemote(updated);
        // Re-establish the tunnel with the (possibly new) socket path
        sshTunnelManager.closeTunnel(name);
        const localPath = await sshTunnelManager.ensureTunnel(name, existing.sshTarget, record.socketPath);
        ctx.ui.notify(
          `Remote peer "${name}" refreshed. Tunnel: ${localPath}\n` +
          `Model: ${record.model}  Capabilities: ${record.capabilities?.join(", ") ?? "none"}`,
          "info",
        );
      } catch (err: unknown) {
        const msg = err instanceof CollabError ? err.label : (err instanceof Error ? err.message : String(err));
        ctx.ui.notify(`Failed to refresh remote peer: ${msg}`, "error");
      }
      return;
    }

    case "list": {
      const remotes = listRemotes();
      if (remotes.length === 0) {
        ctx.ui.notify("No remote peers configured. Use /collab remote add <name> <user@host>.", "info");
        return;
      }
      const lines = remotes.map((r) => {
        const active = sshTunnelManager.names.includes(r.name) ? "connected" : "tunnel down";
        return `  ${r.name} — ${r.sshTarget} — ${active} — ${r.model ?? "unknown"}`;
      });
      ctx.ui.notify(`${remotes.length} remote peer(s):\n${lines.join("\n")}`, "info");
      return;
    }

    case "prune": {
      const stale = listRemotes().filter((r) => !sshTunnelManager.names.includes(r.name));
      if (stale.length === 0) {
        ctx.ui.notify("No stale remote entries to prune.", "info");
        return;
      }
      for (const r of stale) {
        removeRemote(r.name);
      }
      ctx.ui.notify(`Pruned ${stale.length} unreachable remote entr${stale.length === 1 ? "y" : "ies"}: ` +
        stale.map((r) => r.name).join(", "), "info");
      return;
    }

    default:
      ctx.ui.notify(
        "Usage: /collab remote add|remove|refresh|list|prune\n" +
        "  add <user@host>             — register ALL peers on the host\n" +
        "  add <name> <user@host>      — register one named peer\n" +
        "  remove <name>               — unregister and close tunnel\n" +
        "  refresh <name>              — re-fetch record (new token/path)\n" +
        "  list                        — list configured remote peers\n" +
        "  prune                       — remove entries with no active tunnel",
        "warning",
      );
  }
}

function listPeersCommand(ctx: ExtensionCommandContext): void {
  const peers = listPeers();
  const remotes = listRemotes();
  if (peers.length === 0 && remotes.length === 0) {
    ctx.ui.notify("No registered peers.", "info");
    return;
  }

  const self = peers.find((p) => p.peerId === peerId);
  const others = peers.filter((p) => p.peerId !== peerId);

  const lines: string[] = [];
  if (self) lines.push(`* ${self.name} (me) — ${self.status} — ${self.model}`);
  for (const p of others) {
    lines.push(`  ${p.name} — ${p.status} — ${p.model}`);
  }
  for (const r of remotes) {
    const active = sshTunnelManager.names.includes(r.name) ? "connected" : "tunnel down";
    lines.push(`  ${r.name} — ${active} — ${r.model ?? "unknown"}  (ssh:${r.sshTarget})`);
  }
  ctx.ui.notify(lines.join("\n"), "info");
}

function stopPeerCommand(name: string, ctx: ExtensionCommandContext): void {
  if (!name) {
    ctx.ui.notify("Usage: /collab stop <name>", "warning");
    return;
  }

  const peer = resolveName(name);
  if (!peer) {
    // Maybe a remote peer
    const remote = getRemote(name);
    if (remote) {
      sshTunnelManager.closeTunnel(name);
      removeRemote(name);
      ctx.ui.notify(`Remote peer "${name}" removed and tunnel closed.`, "info");
      return;
    }
    ctx.ui.notify(`Colleague "${name}" not found.`, "error");
    return;
  }

  const isSelf = peer.peerId === peerId;
  unregisterPeer(peer.peerId, peer.name);

  if (isSelf) {
    // Stop accepting connections and heartbeat while offline
    if (heartbeatTimer) { clearInterval(heartbeatTimer); heartbeatTimer = undefined; }
    if (listener) { listener.close().catch(() => {}); listener = undefined; }
    authToken = "";
    updatePeerWidget(ctx);
    ctx.ui.notify(`Peer "${peer.name}" is now offline. Use /collab start to re-enable.`, "info");
  } else {
    ctx.ui.notify(`Colleague "${name}" removed from registry.`, "info");
  }
}

// ── /collab start — re-enable after /collab stop ──────────────────────────

async function startPeerCommand(ctx: ExtensionCommandContext): Promise<void> {
  const existing = getPeerById(peerId);
  if (existing) {
    ctx.ui.notify("Peer is already registered.", "info");
    return;
  }

  ctx.ui.notify("Re-registering peer...", "info");

  authToken = generateAuthToken();

  const toolNames = piApi!.getActiveTools();
  const manualTags = config.capabilities ?? [];
  const capabilities = [...new Set([...manualTags, ...toolNames])];

  const record: PeerRecord = {
    peerId,
    name: config.name,
    socketPath: getSocketPath(peerId),
    pid: process.pid,
    cwd: process.cwd(),
    model: currentModel,
    status: "idle",
    registeredAt: new Date().toISOString(),
    lastHeartbeatAt: new Date().toISOString(),
    capabilities,
    authToken,
  };

  try {
    registerPeer(record);
  } catch (err: unknown) {
    ctx.ui.notify(`Failed to register: ${String(err)}`, "error");
    return;
  }

  // Re-bind socket if it was closed
  if (!listener) {
    try {
      await startServer();
    } catch (err) {
      console.error("[pi-collab] Server restart failed:", err);
      ctx.ui.notify("Failed to bind socket", "error");
      unregisterPeer(peerId, config.name);
      return;
    }
  }

  // Restart heartbeat if stopped
  if (!heartbeatTimer) {
    heartbeatTimer = setInterval(() => {
      heartbeatPeer(peerId);
      if (widgetCtx) updatePeerWidget(widgetCtx);
    }, config.heartbeatIntervalMs);
  }

  updatePeerWidget(ctx);
  ctx.ui.notify(`Peer "${config.name}" is back online.`, "info");
}

function renamePeerCommand(newName: string, ctx: ExtensionCommandContext): void {
  if (!newName) {
    ctx.ui.notify("Usage: /collab rename <new-name>", "warning");
    return;
  }

  const existing = getPeerById(peerId);
  if (!existing) {
    ctx.ui.notify("Peer not registered. Cannot rename.", "error");
    return;
  }

  const oldName = existing.name;
  unregisterPeer(peerId, oldName);
  existing.name = newName;
  try {
    registerPeer(existing);
    config = { ...config, name: newName };
    ctx.ui.notify(`Renamed from "${oldName}" to "${newName}"`, "info");
  } catch (err: unknown) {
    existing.name = oldName;
    registerPeer(existing);
    config = { ...config, name: oldName };
    ctx.ui.notify(`Rename failed: ${String(err)}`, "error");
  }
}

function statusPeerCommand(name: string, ctx: ExtensionCommandContext): void {
  const peer = name ? resolveName(name) : getPeerById(peerId);
  if (!peer) {
    ctx.ui.notify(`Peer not found.`, "error");
    return;
  }

  const lines = [
    `Name:         ${peer.name}`,
    `Peer ID:      ${peer.peerId}`,
    `Status:       ${peer.status}`,
    `Model:        ${peer.model}`,
    `CWD:          ${peer.cwd}`,
    `PID:          ${peer.pid}`,
    `Capabilities: ${peer.capabilities?.join(", ") ?? "(not set)"}`,
    `Registered:   ${peer.registeredAt}`,
    `Heartbeat:    ${peer.lastHeartbeatAt}`,
  ];
  ctx.ui.notify(lines.join("\n"), "info");
}

// ─── Extension Entry Point ───────────────────────────────────────────────────

export default async function (pi: ExtensionAPI): Promise<void> {
  piApi = pi;
  config = parseConfig();
  peerId = randomUUID();
  transport = new UnixSocketTransport();

  // Set up the agent-context bridge (registers agent_settled listener)
  agentCtx.setup(pi);

  registerTools(pi);
  registerCommands(pi);

  // ── Inject peer system prompt (PI_COLLAB_SYSTEM_PROMPT) ──
  pi.on("before_agent_start", async (event) => {
    if (config.systemPrompt) {
      return { systemPrompt: event.systemPrompt + "\n\n" + config.systemPrompt };
    }
  });

  // ── Keep PeerRecord in sync when model changes ──
  pi.on("model_select", async (event) => {
    currentModel = `${event.model.provider}/${event.model.id}`;
    updatePeerModel(peerId, currentModel);
  });

  // ── Apply configured model (PI_COLLAB_MODEL) before peer registration ──
  pi.on("session_start", async (_event, ctx) => {
    if (config.model) {
      const [provider, ...modelParts] = config.model.split("/");
      const modelId = modelParts.join("/");
      if (provider && modelId) {
        const model = ctx.modelRegistry.find(provider, modelId);
        if (model) {
          const ok = await pi.setModel(model);
          if (ok) {
            currentModel = `${provider}/${modelId}`;
          }
        }
      }
    }
  });

  // ── session_start: resolve model, register peer, bind socket, heartbeat ──
  pi.on("session_start", async (_event, ctx) => {
    // If no model was configured via PI_COLLAB_MODEL, detect the active model
    if (currentModel === "unknown") {
      try {
        const models = ctx.modelRegistry.getAvailable();
        if (models.length) {
          const active = models.find((m) => m.id === ctx.model?.id);
          currentModel = active ? `${active.provider}/${active.id}` : "unknown";
        }
      } catch { /* non-critical */ }
    }

    // Generate a fresh auth token for this session
    authToken = generateAuthToken();

    // Build aggregated capabilities: manual tags + active tool names
    const toolNames = pi.getActiveTools();
    const manualTags = config.capabilities ?? [];
    const capabilities = [...new Set([...manualTags, ...toolNames])];

    const record: PeerRecord = {
      peerId,
      name: config.name,
      socketPath: getSocketPath(peerId),
      pid: process.pid,
      cwd: process.cwd(),
      model: currentModel,
      status: "idle",
      registeredAt: new Date().toISOString(),
      lastHeartbeatAt: new Date().toISOString(),
      capabilities,
      authToken,
    };

    try {
      registerPeer(record);
    } catch (err: unknown) {
      ctx.ui.notify(`pi-collab: Failed to register peer: ${String(err)}`, "error");
      return;
    }

    try {
      await startServer();
    } catch (err) {
      console.error("[pi-collab] Server start failed:", err);
      ctx.ui.notify("pi-collab: Failed to bind socket", "error");
      unregisterPeer(peerId, config.name);
      return;
    }

    // Store ctx for periodic widget refresh (picks up new peers from filesystem)
    widgetCtx = ctx;
    heartbeatTimer = setInterval(() => {
      heartbeatPeer(peerId);
      if (widgetCtx) updatePeerWidget(widgetCtx);
    }, config.heartbeatIntervalMs);
    pruneStalePeers();

    ctx.ui.setTitle(`pi [${config.name}]`);
    ctx.ui.notify(`pi-collab: Registered as "${config.name}"`, "info");
    updatePeerWidget(ctx);
  });

  // ── Turn boundaries: update peer status and widget ──
  pi.on("turn_start", async (_event, ctx) => {
    updatePeerStatus(peerId, "busy");
    updatePeerWidget(ctx);
  });
  pi.on("turn_end", async (_event, ctx) => {
    updatePeerStatus(peerId, "idle");
    updatePeerWidget(ctx);
  });
  pi.on("agent_settled", async (_event, ctx) => {
    updatePeerStatus(peerId, "idle");
    updatePeerWidget(ctx);
  });

  // ── Shutdown: clean up ──
  pi.on("session_shutdown", async (_event, ctx) => {
    if (heartbeatTimer) { clearInterval(heartbeatTimer); heartbeatTimer = undefined; }
    widgetCtx = undefined;
    if (listener) { await listener.close(); listener = undefined; }
    await sshTunnelManager.closeAll();
    authToken = "";
    clearPeerWidget(ctx);
    unregisterPeer(peerId, config.name);
  });
}
