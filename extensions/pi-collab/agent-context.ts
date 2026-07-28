/**
 * Agent-context bridge for pi-collab.
 *
 * Bridges between the collab protocol layer and the pi agent loop. All
 * interaction with the agent happens through `pi.sendUserMessage()` and
 * a pre-registered `agent_settled` event handler.
 *
 * Architecture:
 * - `setup(pi)` — called once during extension init. Registers the
 *   `agent_settled` listener. Stores `pi` reference for later use.
 * - `injectTask(taskPrompt, askQuestion, timeoutMs)` — injects a task from
 *   a remote peer into the agent loop. Returns a Promise that resolves
 *   with the last assistant text when the agent settles.
 * - `injectQuestion(question, timeoutMs)` — injects a clarifying question
 *   from a remote peer. Returns a Promise that resolves with the answer.
 * - `getActiveAskQuestion()` — returns the active askQuestion callback
 *   (set by injectTask), used by the `ask_colleague` tool.
 *
 * State machine: only one task or question can be in flight at a time.
 */

import type { ExtensionAPI, ExtensionContext, SessionEntry } from "@earendil-works/pi-coding-agent";
import type { AgentMessage } from "@earendil-works/pi-agent-core";

// ─── State ───────────────────────────────────────────────────────────────────

let pi: ExtensionAPI | undefined;

interface PendingTask {
  resolve: (text: string) => void;
  reject: (err: Error) => void;
  askQuestion?: (question: string) => Promise<string>;
  /** Snapshot of branch entries before task injection, for response extraction. */
  branchLengthBefore: number;
  /**
   * Count of in-flight askQuestion calls. agent_settled must not resolve
   * pendingTask while a question/answer roundtrip is active — the agent
   * may settle briefly between the tool-call turn and the next LLM
   * turn when the answer arrives.
   */
  activeAskCount: number;
}

let pendingTask: PendingTask | undefined;

// ─── Setup ───────────────────────────────────────────────────────────────────

/**
 * Must be called once during extension init so the bridge can
 * register its `agent_settled` listener and store the `pi` reference.
 */
export function setup(extensionApi: ExtensionAPI): void {
  pi = extensionApi;

  pi.on("agent_settled", (_event, ctx) => {
    if (!pendingTask) return;
    // Do NOT resolve while an askQuestion roundtrip is in flight.
    // The agent may settle briefly after the ask_colleague tool call
    // completes but before the LLM processes the answer and continues.
    if (pendingTask.activeAskCount > 0) return;

    const { resolve, branchLengthBefore } = pendingTask;
    pendingTask = undefined;

    try {
      const text = extractNewAssistantText(ctx, branchLengthBefore);
      resolve(text);
    } catch (err) {
      resolve("(unable to extract response text)");
    }
  });
}

// ─── Task injection ──────────────────────────────────────────────────────────

export function canInject(): boolean {
  return pendingTask === undefined;
}

/**
 * Inject a task into the agent loop and wait for the LLM's response.
 *
 * Called from the inbound connection handler when a remote peer sends
 * a request. The `askQuestion` callback is stored so that if the LLM
 * calls the `ask_colleague` tool, it can relay questions back to the
 * remote peer.
 */
export function injectTask(
  taskPrompt: string,
  askQuestion: (question: string) => Promise<string>,
  timeoutMs: number,
): Promise<string> {
  assertReady();

  const branchLength = getBranchLength();

  return new Promise<string>((resolve, reject) => {
    const timer = setTimeout(() => {
      if (!pendingTask) return;
      pendingTask = undefined;
      reject(new Error("Task timed out waiting for agent response"));
    }, timeoutMs);

    // Wrap askQuestion to track the active call count.
    // agent_settled skips resolution while a question is in flight.
    const trackedAskQuestion = askQuestion
      ? async (question: string): Promise<string> => {
          pendingTask!.activeAskCount++;
          try {
            return await askQuestion(question);
          } finally {
            pendingTask!.activeAskCount--;
          }
        }
      : undefined;

    pendingTask = {
      resolve: (text: string) => {
        clearTimeout(timer);
        resolve(text);
      },
      reject: (err: Error) => {
        clearTimeout(timer);
        reject(err);
      },
      askQuestion: trackedAskQuestion,
      branchLengthBefore: branchLength,
      activeAskCount: 0,
    };

    pi!.sendUserMessage(taskPrompt);
  });
}

// ─── Question injection ──────────────────────────────────────────────────────

/**
 * Inject a clarifying question from a remote peer and wait for the LLM's answer.
 *
 * Called from `runConversation`'s `onQuestion` callback when the remote
 * peer asks the local LLM a question during a consultation.
 */
export function injectQuestion(
  question: string,
  timeoutMs: number,
): Promise<string> {
  assertReady();

  // We check canInject() but questions can be interleaved with tasks.
  // The question steals the pendingTask slot temporarily.
  const branchLength = getBranchLength();

  const prompt = [
    "## Question from your colleague",
    "",
    question,
    "",
    "Answer concisely. Your response goes directly back to them.",
  ].join("\n");

  return new Promise<string>((resolve, reject) => {
    const timer = setTimeout(() => {
      if (!pendingTask) return;
      pendingTask = undefined;
      reject(new Error("Question timed out waiting for answer"));
    }, timeoutMs);

    pendingTask = {
      resolve: (text: string) => {
        clearTimeout(timer);
        resolve(text);
      },
      reject: (err: Error) => {
        clearTimeout(timer);
        reject(err);
      },
      branchLengthBefore: branchLength,
    };

    pi!.sendUserMessage(prompt);
  });
}

/**
 * Get the active `askQuestion` callback, if an inbound request is in progress.
 * Called by the `ask_colleague` tool's execute handler.
 */
export function getActiveAskQuestion(): ((question: string) => Promise<string>) | undefined {
  return pendingTask?.askQuestion;
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function assertReady(): void {
  if (!pi) throw new Error("pi-collab agent-context not set up: call setup(pi) first");
  if (pendingTask) throw new Error("Another task or question is already in flight");
}

function getBranchLength(): number {
  // This is a best-effort estimate; we use pi indirectly.
  // The actual branch reading happens in extractNewAssistantText via ctx.
  return 0;
}

function extractNewAssistantText(ctx: ExtensionContext, _branchLengthBefore: number): string {
  try {
    const entries = ctx.sessionManager.getBranch();
    return findLastAssistantText(entries);
  } catch {
    return "(response text unavailable)";
  }
}

function findLastAssistantText(entries: readonly SessionEntry[]): string {
  for (let i = entries.length - 1; i >= 0; i--) {
    const entry = entries[i];
    if (entry.type !== "message") continue;

    const msg = entry.message as AgentMessage;
    if (msg.role !== "assistant") continue;

    if (typeof msg.content === "string") {
      return msg.content;
    }

    if (Array.isArray(msg.content)) {
      const parts: string[] = [];
      for (const block of msg.content) {
        if (block.type === "text" && "text" in block && typeof block.text === "string") {
          parts.push(block.text);
        } else if (block.type === "toolCall") {
          // Include tool call summary for visibility
          const tc = block as { toolName?: string; toolCallId?: string };
          parts.push(`[Tool call: ${tc.toolName ?? "unknown"}]`);
        }
      }
      if (parts.length > 0) return parts.join("\n");
    }

    break;
  }

  return "(no assistant response in branch)";
}
