/**
 * Conversation state machine for multi-turn peer exchanges.
 *
 * Tracks the lifecycle of a single conversation between the local peer
 * and a remote peer. Handles question/answer interleaving during consult
 * operations.
 */

import type { Envelope, RequestPayload, ResponsePayload, QuestionPayload, AnswerPayload, ErrorPayload } from "../../types.ts";
import type { PeerConnection } from "../../transport/index.ts";
import {
  createRequestEnvelope,
  createResponseEnvelope,
  createQuestionEnvelope,
  createAnswerEnvelope,
  createErrorEnvelope,
  createPongEnvelope,
} from "./envelope.ts";

export interface ConversationCallbacks {
  onQuestion: (question: string, needsLlmInput: boolean) => Promise<string>;
  onProgress?: (text: string) => void;
}

export interface ConversationResult {
  result?: {
    text: string;
    usage?: { input: number; output: number; turns: number; cost: number };
    toolCalls?: Array<{ tool: string; input: unknown; outputSnippet: string }>;
  };
  error?: { code: string; message: string };
}

export interface InboundRequestPayload {
  operation: string;
  task: string;
  maxTurns?: number;
  context?: { files?: Array<{ path: string; content: string }>; messages?: string };
  focusAreas?: string[];
}

export interface InboundRequestResult {
  result: string;
  usage?: { input: number; output: number; turns: number; cost: number };
  toolCalls?: Array<{ tool: string; input: unknown; outputSnippet: string }>;
}

// ─── Caller-side: initiate and drive a conversation ──────────────────────────

export async function runConversation(
  conn: PeerConnection,
  conversationId: string,
  sourcePeerId: string,
  targetPeerId: string,
  operation: string,
  task: string,
  options: {
    maxTurns?: number;
    context?: { files?: Array<{ path: string; content: string }>; messages?: string };
    focusAreas?: string[];
  },
  callbacks: ConversationCallbacks,
  signal?: AbortSignal,
): Promise<ConversationResult> {
  const request = createRequestEnvelope(sourcePeerId, targetPeerId, conversationId, {
    operation,
    task,
    maxTurns: options.maxTurns,
    context: options.context,
    focusAreas: options.focusAreas,
  } as RequestPayload);
  await conn.send(request);

  const reader = conn.receive[Symbol.asyncIterator]();

  try {
    for (;;) {
      if (signal?.aborted) {
        try { await conn.send(createErrorEnvelope(
          sourcePeerId, targetPeerId, conversationId, request.id, "cancelled", "Aborted",
        )); } catch { /* ignore */ }
        return { error: { code: "cancelled", message: "Aborted" } };
      }

      let next: IteratorResult<Envelope>;
      try { next = await reader.next(); } catch (err: unknown) {
        return { error: { code: "peer_unreachable", message: String(err) } };
      }

      if (next.done) {
        return { error: { code: "peer_unreachable", message: "Connection closed before response" } };
      }

      const env = next.value;

      switch (env.type) {
        case "response": {
          const payload = env.payload as ResponsePayload;
          return { result: { text: payload.result, usage: payload.usage, toolCalls: payload.toolCalls } };
        }
        case "question": {
          const payload = env.payload as QuestionPayload;
          const answer = await callbacks.onQuestion(payload.question, payload.needsLlmInput);
          await conn.send(createAnswerEnvelope(sourcePeerId, targetPeerId, conversationId, env.id, answer));
          break;
        }
        case "error": {
          const payload = env.payload as ErrorPayload;
          return { error: { code: payload.code, message: payload.message } };
        }
        case "ping": {
          await conn.send(createPongEnvelope(sourcePeerId, targetPeerId, env.id));
          break;
        }
        default:
          break;
      }
    }
  } finally {
    try { await conn.close(); } catch { /* ignore */ }
  }
}

// ─── Listener-side: handle an inbound conversation ───────────────────────────

/**
 * Handle a conversation as the listener. Reads the first envelope from
 * the connection (must be a request), processes it via `onRequest`, and
 * sends the response.
 */
export async function handleInboundConversation(
  conn: PeerConnection,
  localPeerId: string,
  onRequest: (payload: InboundRequestPayload, askQuestion: (question: string) => Promise<string>) => Promise<InboundRequestResult>,
  signal?: AbortSignal,
): Promise<void> {
  const reader = conn.receive[Symbol.asyncIterator]();
  const firstResult = await reader.next();
  if (firstResult.done || !firstResult.value) return;
  return handleInboundConversationPreRead(conn, firstResult.value, localPeerId, onRequest, reader, signal);
}

/**
 * Variant for when the first envelope has already been peeked from the
 * connection (e.g. by a routing layer that handles probes OOB).
 */
export async function handleInboundConversationPreRead(
  conn: PeerConnection,
  first: Envelope,
  localPeerId: string,
  onRequest: (payload: InboundRequestPayload, askQuestion: (question: string) => Promise<string>) => Promise<InboundRequestResult>,
  reader?: AsyncIterator<Envelope>,
  signal?: AbortSignal,
): Promise<void> {
  const iter = reader ?? conn.receive[Symbol.asyncIterator]();

  try {
    const sourcePeerId = first.source;
    const conversationId = first.conversationId;

    if (first.type !== "request") {
      await conn.send(createErrorEnvelope(
        localPeerId, sourcePeerId, conversationId,
        first.id, "invalid_request", "Expected a request envelope",
      ));
      return;
    }

    if (signal?.aborted) return;

    const reqPayload = first.payload as RequestPayload;

    // askQuestion: sends a question to the remote caller and waits for the answer
    const askQuestion = async (question: string): Promise<string> => {
      const qEnv = createQuestionEnvelope(localPeerId, sourcePeerId, conversationId, first.id, question, true);
      await conn.send(qEnv);
      for (;;) {
        const next = await iter.next();
        if (next.done) throw new Error("Connection closed while waiting for answer");
        const env = next.value;
        if (env.type === "answer") return (env.payload as AnswerPayload).answer;
        if (env.type === "error") throw new Error((env.payload as ErrorPayload).message);
      }
    };

    const { result, usage, toolCalls } = await onRequest(reqPayload, askQuestion);

    await conn.send(createResponseEnvelope(
      localPeerId, sourcePeerId, conversationId, first.id,
      { result, usage, toolCalls } as ResponsePayload,
    ));
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    try { await conn.send(createErrorEnvelope(localPeerId, "", "", undefined, "peer_error", message)); } catch { /* ignore */ }
  } finally {
    try { await conn.close(); } catch { /* ignore */ }
  }
}
