/**
 * Remote peer registry for cross-host collaboration via SSH.
 *
 * When a user adds a remote peer (`/collab remote add reviewer user@host`),
 * we fetch the remote peer's PeerRecord over SSH and cache a RemotePeer
 * entry locally. The local socket path (from the SSH tunnel) is stored
 * so the transport layer can connect to it like a local socket.
 */

import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { randomUUID } from "node:crypto";

export interface RemotePeer {
  /** Name of the remote peer, e.g. "reviewer". */
  name: string;
  /** SSH target, e.g. "user@host". */
  sshTarget: string;
  /** Peer ID of the remote peer. */
  peerId: string;
  /** Remote absolute socket path (on the remote machine). */
  remoteSocketPath: string;
  /** Auth token of the remote peer (fetched from its PeerRecord). */
  authToken: string;
  /** Model reported by the remote peer. */
  model?: string;
  /** Capabilities reported by the remote peer. */
  capabilities?: string[];
  /** ISO timestamp when this remote entry was created. */
  addedAt: string;
}

const REMOTES_DIR = join(homedir(), ".pi", "collab", "remotes");

function ensureDir(): void {
  mkdirSync(REMOTES_DIR, { recursive: true });
}

function remotePath(name: string): string {
  return join(REMOTES_DIR, `${name}.json`);
}

function atomicWrite(path: string, data: string): void {
  const tmp = `${path}.${randomUUID()}.tmp`;
  writeFileSync(tmp, data, "utf-8");
  renameSync(tmp, path);
}

export function addRemote(peer: RemotePeer): void {
  ensureDir();
  atomicWrite(remotePath(peer.name), JSON.stringify(peer, null, 2));
}

export function removeRemote(name: string): boolean {
  const path = remotePath(name);
  if (!existsSync(path)) return false;
  try { unlinkSync(path); } catch { /* best effort */ }
  return true;
}

export function getRemote(name: string): RemotePeer | undefined {
  const path = remotePath(name);
  if (!existsSync(path)) return undefined;
  try {
    return JSON.parse(readFileSync(path, "utf-8")) as RemotePeer;
  } catch {
    return undefined;
  }
}

export function listRemotes(): RemotePeer[] {
  ensureDir();
  const remotes: RemotePeer[] = [];
  let entries: string[];
  try {
    entries = readdirSync(REMOTES_DIR);
  } catch {
    return [];
  }
  for (const entry of entries) {
    if (!entry.endsWith(".json")) continue;
    const name = entry.replace(".json", "");
    const r = getRemote(name);
    if (r) remotes.push(r);
  }
  return remotes;
}

export { REMOTES_DIR };
