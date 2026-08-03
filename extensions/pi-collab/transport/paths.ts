/**
 * Platform-specific socket path utilities.
 *
 * Linux/macOS: Unix domain socket file paths under ~/.pi/collab/socks/
 * Windows:     Named pipe paths under \\.\pipe\pi-collab\
 *
 * Both are accessed through the same Node.js `net` module API
 * (createServer / createConnection), only the path format differs.
 */

import { join } from "node:path";
import { homedir } from "node:os";

const isWindows = process.platform === "win32";

function collabDir(): string {
  const base = process.env.PI_COLLAB_DIR
    ?? join(homedir(), ".pi", "collab");
  return base;
}

/**
 * Path to the peer registry directory on disk (used for both platforms).
 */
export function peersDir(): string {
  return join(collabDir(), "peers");
}

/**
 * Path to the by-id subdirectory.
 */
export function byIdDir(): string {
  return join(peersDir(), "by-id");
}

/**
 * Path to the by-name subdirectory.
 */
export function byNameDir(): string {
  return join(peersDir(), "by-name");
}

/**
 * Path to the Unix socket directory (~/.pi/collab/socks).
 * Windows named pipes do not use the filesystem.
 */
export function socksDir(): string {
  return join(collabDir(), "socks");
}

/**
 * Transport-specific socket path for a peer.
 *
 * - Unix:  ~/.pi/collab/socks/<peerId>.sock
 * - Windows: \\.\pipe\pi-collab-<peerId>
 */
export function getPeerSocketPath(peerId: string): string {
  if (isWindows) {
    // Windows named pipe — max 256 chars for pipe name
    // Use short peerId prefix to stay within limits
    return `\\\\.\\pipe\\pi-collab-${peerId.slice(0, 8)}`;
  }
  const socksDirPath = socksDir();
  return join(socksDirPath, `${peerId}.sock`);
}

/**
 * Clean up any stale socket artifact before binding.
 *
 * - Unix: unlink the .sock file
 * - Windows: no-op (named pipes are auto-cleaned by the OS)
 */
export function cleanupSocketPath(_peerId: string): void {
  if (isWindows) return;
  // Unix cleanup is handled by the transport layer (unlinkSync)
}

export { isWindows };
