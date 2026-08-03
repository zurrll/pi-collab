/**
 * SSH tunnel transport for cross-host peer collaboration.
 *
 * Uses OpenSSH Unix socket forwarding (`ssh -L local_sock:remote_sock`) to
 * expose a remote peer's Unix socket at a LOCAL path. The caller then
 * connects to the local path using the same QueueConnection logic as the
 * local transport — zero protocol changes.
 *
 * Requirements:
 * - OpenSSH 6.7+ on the local machine (Unix socket forwarding support)
 * - SSH KEY-based auth to the remote host. Password auth is explicitly
 *   disabled (`-o BatchMode=yes`) because interactive password prompts
 *   would fight with the pi TUI for terminal input.
 * - The remote peer must be running pi-collab (its socket exists)
 *
 * Windows note: Win32-OpenSSH does NOT support Unix socket forwarding.
 * This transport targets Linux/macOS. Windows users should use the
 * WebSocket relay transport (Phase 2).
 */

import { spawn, type ChildProcess } from "node:child_process";
import { createConnection } from "node:net";
import { existsSync, mkdirSync, unlinkSync } from "node:fs";
import { dirname, join } from "node:path";
import { homedir } from "node:os";
import { randomUUID } from "node:crypto";

const SSH_DIR = join(homedir(), ".pi", "collab", "ssh");

// BatchMode=yes: never prompt for passwords — fail fast instead.
// This is critical: interactive password prompts would corrupt the TUI.
const SSH_BASE_ARGS = [
  "-o", "BatchMode=yes",
  "-o", "ConnectTimeout=10",
  "-o", "ExitOnForwardFailure=yes",
];

interface TunnelEntry {
  localPath: string;
  proc: ChildProcess;
}

export class SshTunnelManager {
  private tunnels = new Map<string, TunnelEntry>();

  /**
   * Ensure a persistent SSH tunnel to a remote peer's socket.
   * Returns the LOCAL socket path to connect to.
   *
   * The tunnel is only considered established after a real ping round-trip
   * through the local socket succeeds, so a dead or password-stuck ssh
   * process can never be reported as "up".
   */
  async ensureTunnel(name: string, sshTarget: string, remotePath: string): Promise<string> {
    const existing = this.tunnels.get(name);
    if (existing) {
      if (existing.proc.exitCode === null) {
        return existing.localPath;
      }
      this.tunnels.delete(name);
    }

    const localPath = join(SSH_DIR, `${name}.sock`);
    if (existsSync(localPath)) {
      try { unlinkSync(localPath); } catch { /* ignore */ }
    }
    mkdirSync(dirname(localPath), { recursive: true });

    const proc = spawn(
      "ssh",
      [...SSH_BASE_ARGS, "-N", "-L", `${localPath}:${remotePath}`, sshTarget],
      { stdio: ["ignore", "ignore", "pipe"] },
    );

    let stderr = "";
    proc.stderr?.on("data", (d) => { stderr += d.toString(); });

    try {
      // Wait for the tunnel to become functional: poll-connect to the local
      // socket and do a ping round-trip. Give it up to ~6s.
      const deadline = Date.now() + 6_000;
      for (;;) {
        if (proc.exitCode !== null) {
          throw new Error(`SSH tunnel exited (${proc.exitCode}): ${stderr.trim() || "unknown error"}`);
        }
        if (await this.pingThrough(localPath)) {
          this.tunnels.set(name, { localPath, proc });
          return localPath;
        }
        if (Date.now() > deadline) {
          proc.kill("SIGTERM");
          throw new Error(
            `SSH tunnel not functional within 6s. ` +
            (stderr.trim() ? `stderr: ${stderr.trim()}` : "Check that the remote socket exists and key auth is set up."),
          );
        }
        await new Promise((r) => setTimeout(r, 200));
      }
    } catch (err) {
      try { proc.kill("SIGTERM"); } catch { /* ignore */ }
      throw err;
    }
  }

  /**
   * Connect to a local socket path and do a ping/pong round-trip through
   * the tunnel. Returns true only if a pong envelope comes back.
   */
  private pingThrough(localPath: string): Promise<boolean> {
    return new Promise((resolve) => {
      const sock = createConnection(localPath);
      const timer = setTimeout(() => { sock.destroy(); resolve(false); }, 800);
      sock.once("error", () => { clearTimeout(timer); sock.destroy(); resolve(false); });
      sock.once("connect", () => {
        // Send a ping envelope (same shape as the transport's ping).
        const env = {
          v: "1",
          id: randomUUID(),
          source: "",
          target: "",
          conversationId: "",
          type: "ping",
          payload: { timestamp: new Date().toISOString() },
        };
        sock.write(`${JSON.stringify(env)}\n`, () => { /* wait for pong */ });
        // Any reply line = the remote peer is alive and talking.
        let gotReply = false;
        sock.on("data", () => { gotReply = true; clearTimeout(timer); sock.destroy(); resolve(true); });
        sock.on("end", () => { if (!gotReply) { clearTimeout(timer); sock.destroy(); resolve(false); } });
      });
    });
  }

  /**
   * Close the tunnel for a peer name.
   */
  closeTunnel(name: string): void {
    const entry = this.tunnels.get(name);
    if (!entry) return;
    try { entry.proc.kill("SIGTERM"); } catch { /* ignore */ }
    this.tunnels.delete(name);
  }

  /**
   * Close all tunnels (called on session_shutdown).
   */
  async closeAll(): Promise<void> {
    for (const [name, entry] of this.tunnels) {
      try { entry.proc.kill("SIGTERM"); } catch { /* ignore */ }
      this.tunnels.delete(name);
    }
  }

  /** Number of active tunnels. */
  get size(): number {
    return this.tunnels.size;
  }

  /** Names of active tunnels. */
  get names(): string[] {
    return Array.from(this.tunnels.keys());
  }
}

export const sshTunnelManager = new SshTunnelManager();

/**
 * Run a command on a remote host over SSH with key-only auth.
 * Fails fast with a clear error if password auth is needed.
 */
export function sshExec(sshTarget: string, command: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn("ssh", [...SSH_BASE_ARGS, sshTarget, command], {
      stdio: ["ignore", "pipe", "pipe"],
    });
    const chunks: Buffer[] = [];
    const errChunks: Buffer[] = [];
    child.stdout.on("data", (d) => chunks.push(d));
    child.stderr.on("data", (d) => errChunks.push(d));
    child.on("error", (err) => reject(new Error(`SSH error: ${err.message}`)));
    child.on("close", (code) => {
      if (code !== 0) {
        const errText = Buffer.concat(errChunks).toString().trim();
        reject(new Error(`SSH command failed (${code}): ${errText || "no stderr"}`));
      } else {
        resolve(Buffer.concat(chunks).toString().trim());
      }
    });
  });
}
