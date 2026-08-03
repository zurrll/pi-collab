/**
 * Unix domain socket transport implementation (Phase 1).
 *
 * Each peer binds a socket at a well-known path. Connections are
 * established per conversation and torn down when the exchange completes.
 */

import { createConnection, createServer, type Server, type Socket } from "node:net";
import { randomUUID } from "node:crypto";
import { dirname } from "node:path";
import { existsSync, mkdirSync, unlinkSync } from "node:fs";
import type { Envelope } from "../../types.ts";
import { type PeerConnection, type PeerListener, type PeerTransport } from "./index.ts";

const JSONL_DELIMITER = "\n";

// ─── Envelope encoding ───────────────────────────────────────────────────────

function encode(env: Envelope): string {
  return `${JSON.stringify(env)}${JSONL_DELIMITER}`;
}

function decode(line: string): Envelope {
  return JSON.parse(line) as Envelope;
}

// ─── Shared message-queue connection ─────────────────────────────────────────

/**
 * A connection that buffers inbound JSONL lines into an async queue.
 * Used for both client-side outbound and server-side inbound connections.
 */
class QueueConnection implements PeerConnection {
  private socket: Socket;
  private buffer = "";
  private closed = false;
  private lineQueue: string[] = [];
  private errorQueue: Error[] = [];
  private resolveNext: ((line: string | undefined) => void) | undefined;

  constructor(socket: Socket) {
    this.socket = socket;
    socket.setEncoding("utf8");
    socket.on("data", (chunk: string) => this.handleData(chunk));
    socket.on("error", (err) => this.handleError(err));
    socket.on("close", () => this.handleClose());
  }

  private handleData(chunk: string): void {
    this.buffer += chunk;
    for (;;) {
      const idx = this.buffer.indexOf(JSONL_DELIMITER);
      if (idx === -1) break;
      const line = this.buffer.slice(0, idx).trim();
      this.buffer = this.buffer.slice(idx + 1);
      if (!line) continue;
      this.deliver(line);
    }
  }

  private handleError(err: Error): void {
    this.errorQueue.push(err);
    this.wakeWaiter(undefined);
  }

  private handleClose(): void {
    this.closed = true;
    this.wakeWaiter(undefined);
  }

  private deliver(line: string): void {
    if (this.resolveNext) {
      const r = this.resolveNext;
      this.resolveNext = undefined;
      r(line);
    } else {
      this.lineQueue.push(line);
    }
  }

  private wakeWaiter(value: string | undefined): void {
    if (this.resolveNext) {
      const r = this.resolveNext;
      this.resolveNext = undefined;
      r(value);
    }
  }

  private async nextLine(): Promise<string | undefined> {
    if (this.lineQueue.length > 0) {
      return this.lineQueue.shift()!;
    }
    if (this.errorQueue.length > 0) {
      throw this.errorQueue.shift()!;
    }
    if (this.closed) {
      return undefined;
    }
    return new Promise<string | undefined>((resolve) => {
      this.resolveNext = resolve;
    });
  }

  async send(envelope: Envelope): Promise<void> {
    if (this.closed) throw new Error("Connection closed");
    return new Promise<void>((resolve, reject) => {
      this.socket.write(encode(envelope), (err) => {
        if (err) reject(err);
        else resolve();
      });
    });
  }

  receive: AsyncIterable<Envelope> = {
    [Symbol.asyncIterator]: () => {
      const self = this;
      return {
        async next(): Promise<IteratorResult<Envelope>> {
          const line = await self.nextLine();
          if (line === undefined) {
            return { done: true, value: undefined };
          }
          return { done: false, value: decode(line) };
        },
      };
    },
  };

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    this.socket.destroy();
  }
}

// ─── Listener ────────────────────────────────────────────────────────────────

class QueueListener implements PeerListener {
  private server: Server;
  private connQueue: PeerConnection[] = [];
  private resolveConn: ((conn: PeerConnection) => void) | undefined;

  constructor(server: Server) {
    this.server = server;
    server.on("connection", (socket: Socket) => {
      const conn = new QueueConnection(socket);
      if (this.resolveConn) {
        const r = this.resolveConn;
        this.resolveConn = undefined;
        r(conn);
      } else {
        this.connQueue.push(conn);
      }
    });
  }

  connections: AsyncIterable<PeerConnection> = {
    [Symbol.asyncIterator]: () => {
      const self = this;
      return {
        async next(): Promise<IteratorResult<PeerConnection>> {
          if (self.connQueue.length > 0) {
            return { done: false, value: self.connQueue.shift()! };
          }
          return new Promise((resolve) => {
            self.resolveConn = (conn) => resolve({ done: false, value: conn });
          });
        },
      };
    },
  };

  async close(): Promise<void> {
    return new Promise<void>((resolve) => {
      this.server.close(() => resolve());
    });
  }
}

// ─── Transport ───────────────────────────────────────────────────────────────

export class UnixSocketTransport implements PeerTransport {
  async connect(peer: { socketPath: string; peerId: string }): Promise<PeerConnection> {
    return new Promise<PeerConnection>((resolve, reject) => {
      const sock = createConnection(peer.socketPath);
      const timer = setTimeout(() => {
        sock.destroy();
        reject(new Error(`Connection to ${peer.peerId} timed out`));
      }, 5000);

      sock.once("connect", () => {
        clearTimeout(timer);
        resolve(new QueueConnection(sock));
      });
      sock.once("error", (err) => {
        clearTimeout(timer);
        reject(new Error(`Failed to connect to ${peer.peerId} at ${peer.socketPath}: ${err.message}`));
      });
    });
  }

  async listen(socketPath: string): Promise<PeerListener> {
    // On Windows with named pipes, no filesystem cleanup needed.
    // On Unix, ensure the socket directory exists and remove stale socket file.
    if (!socketPath.startsWith("\\\\")) {
      try {
        mkdirSync(dirname(socketPath), { recursive: true });
      } catch { /* ignore */ }
      if (existsSync(socketPath)) {
        try { unlinkSync(socketPath); } catch { /* stale — bind will fail */ }
      }
    }

    return new Promise<PeerListener>((resolve, reject) => {
      const server = createServer();
      server.once("error", reject);
      server.listen(socketPath, () => {
        server.off("error", reject);
        resolve(new QueueListener(server));
      });
    });
  }

  async ping(socketPath: string, timeoutMs: number): Promise<boolean> {
    return new Promise<boolean>((resolve) => {
      const sock = createConnection(socketPath);
      const timer = setTimeout(() => { sock.destroy(); resolve(false); }, timeoutMs);

      sock.once("connect", () => {
        clearTimeout(timer);
        sock.write(
          encode({
            v: "1",
            id: randomUUID(),
            source: "",
            target: "",
            conversationId: "",
            type: "ping",
            payload: { timestamp: new Date().toISOString() },
          }),
          () => { sock.destroy(); resolve(true); },
        );
      });
      sock.once("error", () => { clearTimeout(timer); sock.destroy(); resolve(false); });
    });
  }
}
