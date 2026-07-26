/**
 * Envelope encoding, decoding, and validation.
 */
import { randomUUID } from "node:crypto";
import type { Envelope, EnvelopeType, Payload, ProbePayload, ProbeResponsePayload, AuthPayload, AuthResultPayload } from "../types.ts";

const PROTOCOL_VERSION = "1";

export function createEnvelope(
  source: string,
  target: string,
  conversationId: string,
  type: EnvelopeType,
  payload: Payload,
  inReplyTo?: string,
): Envelope {
  return {
    v: PROTOCOL_VERSION,
    id: randomUUID(),
    source,
    target,
    conversationId,
    type,
    ...(inReplyTo ? { inReplyTo } : {}),
    payload,
  };
}

export function createRequestEnvelope(
  source: string,
  target: string,
  conversationId: string,
  payload: Payload & { operation: string; task: string },
): Envelope {
  return createEnvelope(source, target, conversationId, "request", payload);
}

export function createResponseEnvelope(
  source: string,
  target: string,
  conversationId: string,
  inReplyTo: string,
  payload: Payload,
): Envelope {
  return createEnvelope(source, target, conversationId, "response", payload, inReplyTo);
}

export function createQuestionEnvelope(
  source: string,
  target: string,
  conversationId: string,
  inReplyTo: string,
  question: string,
  needsLlmInput: boolean,
): Envelope {
  return createEnvelope(
    source,
    target,
    conversationId,
    "question",
    { question, needsLlmInput },
    inReplyTo,
  );
}

export function createAnswerEnvelope(
  source: string,
  target: string,
  conversationId: string,
  inReplyTo: string,
  answer: string,
): Envelope {
  return createEnvelope(source, target, conversationId, "answer", { answer }, inReplyTo);
}

export function createErrorEnvelope(
  source: string,
  target: string,
  conversationId: string,
  inReplyTo: string | undefined,
  code: string,
  message: string,
): Envelope {
  return createEnvelope(
    source,
    target,
    conversationId,
    "error",
    { code, message } as Payload,
    inReplyTo,
  );
}

export function createPingEnvelope(source: string, target: string): Envelope {
  return createEnvelope(source, target, "", "ping", {
    timestamp: new Date().toISOString(),
  });
}

export function createPongEnvelope(
  source: string,
  target: string,
  inReplyTo: string,
): Envelope {
  return createEnvelope(source, target, "", "pong", {
    timestamp: new Date().toISOString(),
  }, inReplyTo);
}

export function createProbeEnvelope(
  source: string,
  target: string,
  payload: ProbePayload,
): Envelope {
  return createEnvelope(source, target, "", "probe", payload);
}

export function createProbeResponseEnvelope(
  source: string,
  target: string,
  inReplyTo: string,
  payload: ProbeResponsePayload,
): Envelope {
  return createEnvelope(source, target, "", "probe_response", payload, inReplyTo);
}

export function createAuthEnvelope(
  source: string,
  target: string,
  token: string,
): Envelope {
  return createEnvelope(source, target, "", "auth", { token, peerId: source } as AuthPayload);
}

export function createAuthResultEnvelope(
  source: string,
  target: string,
  inReplyTo: string,
  ok: boolean,
  reason?: string,
): Envelope {
  return createEnvelope(source, target, "", "auth_result", { ok, reason } as AuthResultPayload, inReplyTo);
}

export function validateEnvelope(env: unknown): env is Envelope {
  if (typeof env !== "object" || env === null) return false;
  const e = env as Record<string, unknown>;
  return (
    typeof e.v === "string" &&
    typeof e.id === "string" &&
    typeof e.source === "string" &&
    typeof e.target === "string" &&
    typeof e.conversationId === "string" &&
    typeof e.type === "string" &&
    ["request", "response", "question", "answer", "error", "ping", "pong", "probe", "probe_response", "auth", "auth_result"].includes(e.type as string) &&
    typeof e.payload === "object" &&
    e.payload !== null
  );
}

export function encodeEnvelope(env: Envelope): string {
  return `${JSON.stringify(env)}\n`;
}

export function parseEnvelopeLine(line: string): Envelope {
  const parsed = JSON.parse(line) as Envelope;
  if (!validateEnvelope(parsed)) {
    throw new Error(`Invalid envelope: ${line.slice(0, 200)}`);
  }
  return parsed;
}
