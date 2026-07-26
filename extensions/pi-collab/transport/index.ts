/**
 * Peer transport abstraction.
 *
 * Transport implementations handle the actual I/O of connecting to peers
 * and exchanging JSONL envelopes. Phase 1 ships a Unix domain socket
 * transport. Phase 2 can add Radius relay and direct WebSocket transports
 * behind the same interface.
 */

import type { Envelope } from "../types.ts";

/**
 * A full-duplex stream of envelopes between two peers.
 *
 * Call `send()` to push an envelope to the remote peer.
 * Iterate over the async iterable to receive envelopes.
 * Call `close()` when the conversation is done.
 *
 * The transport guarantees ordering within a single connection
 * but does not guarantee delivery (the remote may crash).
 */
export interface PeerConnection {
  /** Send an envelope. Returns after the write is flushed. */
  send(envelope: Envelope): Promise<void>;
  /** Async iterable of inbound envelopes from this connection. */
  receive: AsyncIterable<Envelope>;
  /** Close the connection. Safe to call multiple times. */
  close(): Promise<void>;
}

/**
 * Transport layer for peer-to-peer messaging.
 */
export interface PeerTransport {
  /**
   * Connect to a peer identified by the peer record.
   *
   * Returns a bidirectional connection or throws if the peer
   * is unreachable. The caller is responsible for calling `close()`
   * when finished.
   */
  connect(peer: { socketPath: string; peerId: string }): Promise<PeerConnection>;

  /**
   * Start listening for inbound connections.
   *
   * Returns an async iterable that yields connections as they arrive.
   * The server calls `close()` on the transport to stop listening.
   */
  listen(socketPath: string): Promise<PeerListener>;

  /**
   * Check whether a peer is reachable at its socket path.
   */
  ping(socketPath: string, timeoutMs: number): Promise<boolean>;
}

export interface PeerListener {
  /** Async iterable of inbound connections. */
  connections: AsyncIterable<PeerConnection>;
  /** Stop listening. */
  close(): Promise<void>;
}
