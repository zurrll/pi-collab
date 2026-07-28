/**
 * Core types for the pi-collab extension.
 *
 * Format follows JSON Schema-friendly conventions:
 * - type-only unions are expressed as string literal discriminators.
 * - Timestamps are ISO 8601 strings.
 */

// ─── Peer Identity ───────────────────────────────────────────────────────────

export interface PeerRecord {
  /** Stable UUID v7 for the peer process. */
  peerId: string;
  /** Human-readable name (not unique — first-writer-wins in the registry). */
  name: string;
  /** Absolute path to the Unix domain socket this peer listens on. */
  socketPath: string;
  /** OS process ID. */
  pid: number;
  /** Working directory of the peer. */
  cwd: string;
  /** Provider/model the peer is using, e.g. "anthropic/claude-sonnet-4-20250514". */
  model: string;
  /** Current status. */
  status: PeerStatus;
  /**
   * Aggregated capability tags: manual tags from PI_COLLAB_CAPABILITIES
   * plus the peer's active tool names. Used for probe-based discovery.
   */
  capabilities?: string[];
  /** ISO 8601 timestamp of initial registration. */
  registeredAt: string;
  /** ISO 8601 timestamp of last heartbeat write. */
  lastHeartbeatAt: string;
  /**
   * 256-bit random auth token (hex-encoded, 64 chars).
   * Generated at session start. Must be presented by connecting peers
   * as the first message after socket connect. Proves the caller has
   * read access to this PeerRecord (filesystem trust anchor).
   */
  authToken?: string;
}

export type PeerStatus = "idle" | "busy" | "unreachable";

// ─── Envelope ────────────────────────────────────────────────────────────────

export type EnvelopeType =
  | "request"
  | "response"
  | "question"
  | "answer"
  | "error"
  | "ping"
  | "pong"
  | "probe"
  | "probe_response"
  | "auth"
  | "auth_result";

export interface Envelope {
  /** Protocol version: "1" */
  v: string;
  /** Unique message ID (UUID). */
  id: string;
  /** Peer ID of the sender. */
  source: string;
  /** Peer ID of the intended recipient. */
  target: string;
  /** Conversation ID shared across all messages in one exchange. */
  conversationId: string;
  /** Message type discriminator. */
  type: EnvelopeType;
  /** For response/question/answer messages: the message ID this replies to. */
  inReplyTo?: string;
  /** Type-dependent payload. */
  payload: Payload;
}

// ─── Payloads ────────────────────────────────────────────────────────────────

export type Payload =
  | RequestPayload
  | ResponsePayload
  | QuestionPayload
  | AnswerPayload
  | ErrorPayload
  | PingPayload
  | ProbePayload
  | ProbeResponsePayload
  | AuthPayload
  | AuthResultPayload;

export interface RequestPayload {
  operation: "delegate" | "review" | "execute" | "broadcast" | "consult";
  /** The task description or prompt. */
  task: string;
  /** Maximum turns the peer should spend. */
  maxTurns?: number;
  /** Additional context: file contents or conversation snippets. */
  context?: RequestContext;
  /** For review operations: specific focus areas. */
  focusAreas?: string[];
}

export interface RequestContext {
  files?: Array<{ path: string; content: string }>;
  messages?: string;
}

export interface ResponsePayload {
  /** The final text output from the peer. */
  result: string;
  /** Token usage for this request. */
  usage?: PeerUsage;
  /** Summary of tool calls the peer made (for caller visibility). */
  toolCalls?: Array<{
    tool: string;
    input: unknown;
    outputSnippet: string;
  }>;
}

export interface QuestionPayload {
  /** The question the peer needs answered before proceeding. */
  question: string;
  /** If true, the caller should route this to its LLM. */
  needsLlmInput: boolean;
}

export interface AnswerPayload {
  /** The answer text from the caller's LLM. */
  answer: string;
}

export interface ErrorPayload {
  code: ErrorCode;
  message: string;
}

export type ErrorCode =
  | "timeout"
  | "peer_unreachable"
  | "peer_error"
  | "invalid_request"
  | "cancelled"
  | "name_conflict"
  | "auth_error";

export interface PingPayload {
  /** ISO 8601 timestamp of the ping. */
  timestamp: string;
}

// ─── Auth (connection-level authentication) ──────────────────────────────────

/**
 * Auth envelope: MUST be the first message after socket connect.
 * The token is the target peer's authToken, read from its PeerRecord.
 * Presenting the correct token proves filesystem read access to the
 * target's registry entry, which implies same-user trust on the host.
 */
export interface AuthPayload {
  /** The target peer's authToken (hex-encoded 64 chars). */
  token: string;
  /** Peer ID of the caller (for logging / audit). */
  peerId: string;
}

export interface AuthResultPayload {
  /** Whether authentication succeeded. */
  ok: boolean;
  /** Human-readable reason on failure. */
  reason?: string;
}

/**
 * A probe is an out-of-band discovery request handled entirely at the
 * transport layer. It never reaches the LLM — the transport server
 * responds with peer metadata directly.
 */
export interface ProbePayload {
  /** Optional capability keyword to match, e.g. "typescript", "review". */
  capability?: string;
  /** If provided, only peers with this status respond affirmatively. */
  status?: PeerStatus;
  /** Free-text query for human-readable matching. */
  query?: string;
}

export interface ProbeResponsePayload {
  /** Whether this peer matches the probe filter. */
  matched: boolean;
  /** Peer metadata snapshot at the moment of the probe. */
  peer: {
    name: string;
    model: string;
    status: PeerStatus;
    cwd: string;
    capabilities?: string[];
  };
}

// ─── Usage ───────────────────────────────────────────────────────────────────

export interface PeerUsage {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  cost: number;
  turns: number;
}

// ─── Conversation ────────────────────────────────────────────────────────────

export interface ConversationState {
  conversationId: string;
  peerId: string;
  peerName: string;
  startedAt: string;
  status: "active" | "awaiting_answer" | "completed" | "error";
  messages: Envelope[];
}
