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
 * - SSH key-based auth to the remote host (no password prompts)
 * - The remote peer must be running pi-collab (its socket exists)
 *
 * Windows note: Win32-OpenSSH does NOT support Unix socket forwarding.
 * This transport targets Linux/macOS. Windows users should use the
 * WebSocket relay transport (Phase 2).
 */

import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

const SSH_DIR = join(homedir(), ".pi", "collab", "ssh");

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
   * @param name        peer name (used as the local socket filename)
   * @param sshTarget   e.g. "user@host"
   * @param remotePath  absolute path of the remote peer's socket
   */
  async ensureTunnel(name: string, sshTarget: string, remotePath: string): Promise<string> {
    const existing = this.tunnels.get(name);
    if (existing) {
      // Verify the tunnel process is still alive; if not, recreate
      if (existing.proc.exitCode === null) {
        return existing.localPath;
      }
      this.tunnels.delete(name);
    }

    // Clean up stale local socket file from a previous tunnel
    const localPath = join(SSH_DIR, `${name}.sock`);
    if (existsSync(localPath)) {
      try { const { unlinkSync } = await import("node:fs"); unlinkSync(localPath); } catch { /* ignore */ }
    }
    mkdirSync(SSH_DIR, { recursive: true });

    return new Promise<string>((resolve, reject) => {
      const proc = spawn(
        "ssh",
        ["-N", "-L", `${localPath}:${remotePath}`, sshTarget],
        { stdio: ["ignore", "ignore", "pipe"] },
      );

      let settled = false;
      let stderr = "";

      proc.stderr?.on("data", (d) => {
        stderr += d.toString();
      });

      // Wait briefly for the tunnel to establish or fail.
      // Exit quickly with code 0 means the tunnel is up.
      proc.once("error", (err) => {
        if (!settled) {
          settled = true;
          reject(new Error(`SSH tunnel failed: ${err.message}`));
        }
      });

      proc.once("spawn", () => {
        // Give the SSH handshake a moment; a live process at this point
        // generally means the tunnel is being established. Connection
        // failures surface as exit shortly after.
        setTimeout(() => {
          if (settled) return;
          if (proc.exitCode !== null) {
            settled = true;
            reject(new Error(`SSH tunnel exited early: ${stderr.trim() || "unknown error"}`));
            return;
          }
          settled = true;
          this.tunnels.set(name, { localPath, proc });
          resolve(localPath);
        }, 500);
      });

      proc.once("exit", (code) => {
        this.tunnels.delete(name);
        if (!settled && code !== 0) {
          settled = true;
          reject(new Error(`SSH tunnel exited with code ${code}: ${stderr.trim()}`));
        }
        // If the tunnel dies after successful establishment, the entry
        // is removed; next ensureTunnel call recreates it.
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
