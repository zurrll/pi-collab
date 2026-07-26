/**
 * Configuration parsing from environment variables.
 */

export interface CollabConfig {
  /** Name for this peer. Set via PI_COLLAB_NAME env or /collab rename. */
  name: string;
  /** System prompt override for this peer. */
  systemPrompt?: string;
  /** Model override for spawned peers. */
  model?: string;
  /** Max turns for delegated tasks. */
  defaultMaxTurns: number;
  /** Seconds before a conversation between peers times out. */
  conversationTimeoutMs: number;
  /** Seconds between heartbeat writes. */
  heartbeatIntervalMs: number;
}

const DEFAULT_NAME = `peer-${process.pid}`;
const DEFAULT_MAX_TURNS = 20;
const DEFAULT_CONVERSATION_TIMEOUT_MS = 120_000;
const DEFAULT_HEARTBEAT_INTERVAL_MS = 5_000;

export function parseConfig(): CollabConfig {
  return {
    name: process.env.PI_COLLAB_NAME || DEFAULT_NAME,
    systemPrompt: process.env.PI_COLLAB_SYSTEM_PROMPT || undefined,
    model: process.env.PI_COLLAB_MODEL || undefined,
    defaultMaxTurns: parseOptionalInt(process.env.PI_COLLAB_MAX_TURNS, DEFAULT_MAX_TURNS),
    conversationTimeoutMs: parseOptionalInt(
      process.env.PI_COLLAB_CONVERSATION_TIMEOUT_MS,
      DEFAULT_CONVERSATION_TIMEOUT_MS,
    ),
    heartbeatIntervalMs: parseOptionalInt(
      process.env.PI_COLLAB_HEARTBEAT_INTERVAL_MS,
      DEFAULT_HEARTBEAT_INTERVAL_MS,
    ),
  };
}

function parseOptionalInt(value: string | undefined, fallback: number): number {
  if (value === undefined) return fallback;
  const parsed = Number.parseInt(value, 10);
  return Number.isNaN(parsed) ? fallback : parsed;
}
