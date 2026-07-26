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
import { join } from "node:path";
import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

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
import { isWindows } from "./transport/paths.ts";

// ─── Module-level state ──────────────────────────────────────────────────────

let config: CollabConfig;
let peerId: string;
let transport: PeerTransport;
let listener: PeerListener | undefined;
let heartbeatTimer: ReturnType<typeof setInterval> | undefined;
let currentModel = "unknown";
let authToken = "";

// ─── Helpers ─────────────────────────────────────────────────────────────────

function generateAuthToken(): string {
  return randomBytes(32).toString("hex"); // 256-bit, 64 hex chars
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

function resolvePiBinary(): string {
  // Check for a pi in PATH first
  if (process.env.PI_BINARY && existsSync(process.env.PI_BINARY)) {
    return process.env.PI_BINARY;
  }

  // Use the current node executable with the coding-agent entry
  return process.execPath;
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
    await handleInboundConversationPreRead(conn, msg, peerId, async (payload, askQuestion) => {
      const taskPrompt = buildTaskPrompt(payload);
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
  const record = resolveName(targetName) ?? getPeerById(targetPeerId);
  const token = record?.authToken;
  if (!token) {
    await conn.close();
    throw new Error(`No auth token available for "${targetName}"`);
  }

  await conn.send(createAuthEnvelope(peerId, targetPeerId, token));

  const reader = conn.receive[Symbol.asyncIterator]();
  const result = await reader.next();
  if (result.done || !result.value) {
    await conn.close();
    throw new Error("Connection closed during auth");
  }

  const env = result.value;
  if (env.type !== "auth_result") {
    await conn.close();
    throw new Error(`Expected auth_result, got ${env.type}`);
  }

  const payload = env.payload as AuthResultPayload;
  if (!payload.ok) {
    await conn.close();
    throw new Error(`Auth failed: ${payload.reason ?? "unknown"}`);
  }
}

/**
 * Respond to a probe OOB with local peer metadata.
 * Never touches the LLM context.
 */
async function handleProbe(conn: PeerConnection, probeEnv: Envelope): Promise<void> {
  const probePayload = probeEnv.payload as ProbePayload;

  // Get current peer state from the registry
  const self = getPeerById(peerId);
  const peerMeta = {
    name: config.name,
    model: currentModel,
    status: self?.status ?? "idle",
    cwd: process.cwd(),
  };

  // Match against probe filter (best-effort, transport-layer matching)
  let matched = true;
  if (probePayload.status && peerMeta.status !== probePayload.status) {
    matched = false;
  }
  if (probePayload.capability) {
    // Simple keyword match against model name and cwd
    const cap = probePayload.capability.toLowerCase();
    const searchable = `${peerMeta.model} ${peerMeta.cwd} ${peerMeta.name}`.toLowerCase();
    if (!searchable.includes(cap)) {
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

async function probePeer(targetName: string): Promise<{
  name: string;
  model: string;
  status: PeerStatus;
  cwd: string;
  matched: boolean;
}> {
  const record = resolveName(targetName);
  if (!record) {
    throw new Error(`Colleague "${targetName}" not found`);
  }

  const conn = await transport.connect({
    socketPath: record.socketPath,
    peerId: record.peerId,
  });

  try {
    await authenticateConnection(conn, record.peerId, targetName);

    const probe = createProbeEnvelope(peerId, record.peerId, {});
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

function buildTaskPrompt(payload: { operation: string; task: string; focusAreas?: string[] }): string {
  const header = [
    "┌─────────────────────────────────────────────┐",
    "│  INCOMING TASK FROM COLLEAGUE AGENT        │",
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
): Promise<DelegateResult> {
  const record = resolveName(targetName);
  if (!record) {
    const available = listPeers().map((p) => p.name).join(", ") || "none";
    throw new Error(`Colleague "${targetName}" not found. Available: ${available}`);
  }

  if (record.status === "unreachable") {
    throw new Error(`Colleague "${targetName}" is unreachable (last seen: ${record.lastHeartbeatAt})`);
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
    socketPath: record.socketPath,
    peerId: record.peerId,
  });

  await authenticateConnection(conn, record.peerId, targetName);

  const result = await runConversation(
    conn,
    protocolConvId,
    peerId,
    record.peerId,
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
    AbortSignal.timeout?.(config.conversationTimeoutMs),
  );

  if (result.error) {
    throw new Error(`Colleague "${targetName}" returned error: ${result.error.message} (${result.error.code})`);
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
            context.files.push({ path: fp, content: readFileSync(fp, "utf-8") });
          } catch { /* skip unreadable files */ }
        }
      }

      const result = await delegateToPeer(colleague, "delegate", task, { maxTurns, context, conversationId });

      return {
        content: [{ type: "text", text: result.text }],
        details: { colleague, usage: result.usage, toolCalls: result.toolCalls },
      };
    },
  });

  // ── broadcast_to_colleagues ──

  pi.registerTool({
    name: "broadcast_to_colleagues",
    label: "Broadcast to Colleagues",
    description:
      "Broadcast a message to all available colleagues and collect replies. " +
      "Uses out-of-band probes (zero context cost) to discover peer status first. " +
      "Replies contain each peer's name, model, status, and working directory.",
    parameters: Type.Object({
      message: Type.String({ description: "Message to broadcast." }),
      filter: Type.Optional(Type.Array(Type.String(), {
        description: "Only send to these names. Omit = all.",
      })),
      waitForReplies: Type.Optional(Type.Boolean({
        description: "Wait for replies? Default: true.",
      })),
    }),
    async execute(toolCallId, params, signal, onUpdate, ctx) {
      const { message, filter, waitForReplies } = params as {
        message: string;
        filter?: string[];
        waitForReplies?: boolean;
      };

      const targets = listPeers().filter((p) => {
        if (p.peerId === peerId) return false;
        if (filter?.length && !filter.includes(p.name)) return false;
        return p.status !== "unreachable";
      });

      if (targets.length === 0) {
        return { content: [{ type: "text", text: "No available colleagues." }] };
      }

      const shouldWait = waitForReplies !== false;

      if (!shouldWait) {
        // Fire-and-forget announcement — still uses OOB probe to avoid LLM cost
        for (const p of targets) {
          probePeer(p.name).catch((err) => {
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
        targets.map((p) => probePeer(p.name)),
      );

      const parts: string[] = [`Probed ${targets.length} colleague(s):\n`];
      for (let i = 0; i < targets.length; i++) {
        const r = probeResults[i];
        if (r.status === "fulfilled") {
          const { name, model, status: s, cwd } = r.value;
          parts.push(`- **${name}**  ${s}  ${model}  \`${cwd}\``);
        } else {
          parts.push(`- **${targets[i].name}**  unreachable`);
        }
      }
      parts.push("\nUse `delegate_to_colleague` to send a task to a specific colleague.");

      return { content: [{ type: "text", text: parts.join("\n") }] };
    },
  });

  // ── review_by_colleague ──

  pi.registerTool({
    name: "review_by_colleague",
    label: "Review by Colleague",
    description:
      "Ask a colleague to review code or a design and return structured feedback.",
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
          try { context.files.push({ path: fp, content: readFileSync(fp, "utf-8") }); } catch { /* skip */ }
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

      const result = await delegateToPeer(colleague, "review", reviewPrompt, { focusAreas, context });

      return {
        content: [{ type: "text", text: result.text }],
        details: { colleague, reviewOf: subject.slice(0, 100) },
      };
    },
  });

  // ── ask_colleague (used by the LLM during inbound request processing) ──

  pi.registerTool({
    name: "ask_colleague",
    label: "Ask Colleague",
    description:
      "Ask a clarifying question to the colleague who delegated this task. " +
      "Only available when processing a delegated request from another agent.",
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
    handler: async (args, ctx) => {
      const parts = args.trim().split(/\s+/);
      const sub = parts[0];
      const rest = parts.slice(1).join(" ");

      switch (sub) {
        case "spawn": return spawnPeerCommand(rest, ctx);
        case "list": return listPeersCommand(ctx);
        case "stop": return stopPeerCommand(rest, ctx);
        case "rename": return renamePeerCommand(rest, ctx);
        case "status": return statusPeerCommand(rest, ctx);
        case "delegate": return delegateCommand(rest, ctx);
        case "token": return tokenCommand(ctx);
        default:
          ctx.ui.notify(
            "Usage: /collab spawn|list|stop|rename|status|delegate|token",
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
    ctx.ui.notify(`Delegation failed: ${err instanceof Error ? err.message : String(err)}`, "error");
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
    ctx.ui.notify('Usage: /collab spawn <name> [--model provider/model] [--prompt "..."]', "warning");
    return;
  }

  const name = nameMatch[1];
  const modelMatch = args.match(/--model\s+(\S+)/);
  const promptMatch = args.match(/--prompt\s+"([^"]+)"/);

  ctx.ui.notify(`Spawning colleague "${name}"...`, "info");

  const extPath = resolveExtensionPath();
  if (!extPath) {
    ctx.ui.notify("Cannot resolve pi-collab extension path. Spawned peer won't have collab support.", "warning");
  }

  const env: Record<string, string> = {
    ...(process.env as Record<string, string>),
    PI_COLLAB_NAME: name,
  };
  if (promptMatch?.[1]) env.PI_COLLAB_SYSTEM_PROMPT = promptMatch[1];
  if (modelMatch?.[1]) env.PI_COLLAB_MODEL = modelMatch[1];

  const childProcess = spawn(resolvePiBinary(), ["--mode", "rpc", "--extension", extPath], {
    cwd: process.cwd(),
    env,
    stdio: ["pipe", "pipe", "pipe"],
    detached: true,
  });

  childProcess.on("error", (err) => {
    ctx.ui.notify(`Failed to spawn "${name}": ${err.message}`, "error");
  });

  // Give the peer time to start and register
  await new Promise((r) => setTimeout(r, 2000));

  const peer = resolveName(name);
  if (peer) {
    ctx.ui.notify(`Colleague "${name}" is online (${peer.peerId.slice(0, 8)}...)`, "info");
  } else {
    ctx.ui.notify(`Colleague "${name}" spawned but not yet registered. Check stderr for errors.`, "warning");
  }

  // Detach so the child outlives this session if needed.
  // On Windows, spawned processes ignore POSIX signals;
  // /collab stop cleans up the registry instead of killing.
  childProcess.unref();
}

function listPeersCommand(ctx: ExtensionCommandContext): void {
  const peers = listPeers();
  if (peers.length === 0) {
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
  ctx.ui.notify(lines.join("\n"), "info");
}

function stopPeerCommand(name: string, ctx: ExtensionCommandContext): void {
  if (!name) {
    ctx.ui.notify("Usage: /collab stop <name>", "warning");
    return;
  }

  const peer = resolveName(name);
  if (!peer) {
    ctx.ui.notify(`Colleague "${name}" not found.`, "error");
    return;
  }

  // Best-effort cleanup: remove registry entry and socket
  unregisterPeer(peer.peerId, peer.name);
  ctx.ui.notify(`Colleague "${name}" removed from registry.`, "info");
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
    `Name:       ${peer.name}`,
    `Peer ID:    ${peer.peerId}`,
    `Status:     ${peer.status}`,
    `Model:      ${peer.model}`,
    `CWD:        ${peer.cwd}`,
    `PID:        ${peer.pid}`,
    `Registered: ${peer.registeredAt}`,
    `Heartbeat:  ${peer.lastHeartbeatAt}`,
  ];
  ctx.ui.notify(lines.join("\n"), "info");
}

// ─── Extension Entry Point ───────────────────────────────────────────────────

export default async function (pi: ExtensionAPI): Promise<void> {
  config = parseConfig();
  peerId = randomUUID();
  transport = new UnixSocketTransport();

  // Set up the agent-context bridge (registers agent_settled listener)
  agentCtx.setup(pi);

  registerTools(pi);
  registerCommands(pi);

  // ── session_start: register peer, bind socket, start heartbeat ──
  pi.on("session_start", async (_event, ctx) => {
    try {
      const models = ctx.modelRegistry.getAvailable();
      if (models.length) {
        const active = models.find((m) => m.id === ctx.model?.id);
        currentModel = active ? `${active.provider}/${active.id}` : "unknown";
      }
    } catch { /* non-critical */ }

    // Generate a fresh auth token for this session
    authToken = generateAuthToken();

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

    heartbeatTimer = setInterval(() => heartbeatPeer(peerId), config.heartbeatIntervalMs);
    pruneStalePeers();

    ctx.ui.setTitle(`pi [${config.name}]`);
    ctx.ui.notify(`pi-collab: Registered as "${config.name}"`, "info");
  });

  // ── Turn boundaries: update peer status ──
  pi.on("turn_start", () => updatePeerStatus(peerId, "busy"));
  pi.on("turn_end", () => updatePeerStatus(peerId, "idle"));
  pi.on("agent_settled", () => updatePeerStatus(peerId, "idle"));

  // ── Shutdown: clean up ──
  pi.on("session_shutdown", async () => {
    if (heartbeatTimer) { clearInterval(heartbeatTimer); heartbeatTimer = undefined; }
    if (listener) { await listener.close(); listener = undefined; }
    authToken = "";
    unregisterPeer(peerId, config.name);
  });
}
