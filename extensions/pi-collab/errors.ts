/**
 * Structured error types for pi-collab.
 *
 * Each error carries a stable `code` for programmatic inspection and a
 * `llmHint` for the LLM to decide what to do next. The `message` field
 * contains the raw technical detail.
 */

export type CollabErrorCode =
  | "peer_not_found"
  | "peer_unreachable"
  | "peer_busy"
  | "auth_failed"
  | "timeout"
  | "cancelled"
  | "peer_error"
  | "protocol_error"
  | "internal";

const LLM_HINTS: Record<CollabErrorCode, string> = {
  peer_not_found:
    "The colleague name is not in the registry. Available peers are listed. " +
    "Try /collab list to see active peers, or /collab spawn to start a new one.",
  peer_unreachable:
    "The colleague is registered but not responding (stale heartbeat or connection refused). " +
    "They may have crashed or been stopped. Try /collab stop <name> to clean up, then respawn.",
  peer_busy:
    "The colleague is currently processing another request. " +
    "Wait a moment and retry, or delegate to a different colleague.",
  auth_failed:
    "The auth token does not match. This usually means the target peer has restarted " +
    "(new token generated). The caller should reconnect and re-read the PeerRecord. " +
    "Try /collab token on the target peer and share the new token.",
  timeout:
    "The colleague did not respond within the time limit. " +
    "The task may be too complex or the colleague's model may be slow. " +
    "Try splitting the task into smaller pieces, or increase maxTurns.",
  cancelled:
    "The delegation was cancelled by the user (Escape / abort). " +
    "No action needed — retry the delegation when ready.",
  peer_error:
    "The colleague encountered an error while processing the task. " +
    "Check the error details for the specific issue on their side.",
  protocol_error:
    "The communication protocol was violated (unexpected message type, early close). " +
    "This is likely a bug or version mismatch between peers.",
  internal:
    "An unexpected internal error occurred in the collab extension. " +
    "Check the console / stderr for details.",
};

export class CollabError extends Error {
  constructor(
    public readonly code: CollabErrorCode,
    details: string,
  ) {
    const hint = LLM_HINTS[code];
    super(`${details}\n\n[Hint: ${hint}]`);
    this.name = "CollabError";
  }

  /** Short label for TUI notifications. */
  get label(): string {
    const base = this.message.split("\n\n[Hint:")[0];
    return `${this.code}: ${base}`;
  }
}

/**
 * Parse a protocol-level error code into a CollabErrorCode.
 */
export function fromProtocolCode(code: string): CollabErrorCode {
  switch (code) {
    case "timeout": return "timeout";
    case "peer_unreachable": return "peer_unreachable";
    case "auth_error": return "auth_failed";
    case "cancelled": return "cancelled";
    case "peer_error": return "peer_error";
    default: return "peer_error";
  }
}
