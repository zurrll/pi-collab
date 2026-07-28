/**
 * Filesystem-based peer registry for Phase 1 same-host discovery.
 *
 * Peers are registered in ~/.pi/collab/peers/:
 *
 *   ~/.pi/collab/peers/
 *   ├── by-id/
 *   │   └── <peer-uuid>.json       # Full PeerRecord
 *   └── by-name/
 *       └── <name>.json             # { "peerId": "..." }
 *
 * Reading is lock-free (json files are written atomically via temp file + rename).
 * Name mappings are small pointer files (no symlinks, cross-platform).
 * Stale peers (no heartbeat for STALE_THRESHOLD_MS) are filtered on read.
 */

import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import type { PeerRecord, PeerStatus } from "../types.ts";
import { byIdDir, byNameDir, getPeerSocketPath, isWindows } from "../transport/paths.ts";

const STALE_THRESHOLD_MS = 30_000;

interface NamePointer {
  peerId: string;
}

function ensureDirs(): void {
  for (const dir of [byIdDir(), byNameDir()]) {
    mkdirSync(dir, { recursive: true });
  }
  // Unix needs a socks directory; Windows named pipes don't use filesystem
  if (!isWindows) {
    const socksDir = join(byIdDir(), "..", "socks");
    mkdirSync(socksDir, { recursive: true });
  }
}

function getPeerPath(peerId: string): string {
  return join(byIdDir(), `${peerId}.json`);
}

function getNameLink(name: string): string {
  return join(byNameDir(), `${name}.json`);
}

function atomicWrite(path: string, data: string): void {
  const tmp = `${path}.${randomUUID()}.tmp`;
  writeFileSync(tmp, data, "utf-8");
  renameSync(tmp, path);
}

// ─── Public API ──────────────────────────────────────────────────────────────

export function getSocketPath(peerId: string): string {
  return getPeerSocketPath(peerId);
}

export function registerPeer(record: PeerRecord): void {
  ensureDirs();
  atomicWrite(getPeerPath(record.peerId), JSON.stringify(record, null, 2));

  // Try to claim the name
  const nameLink = getNameLink(record.name);
  try {
    if (existsSync(nameLink)) {
      const existing = resolveName(record.name);
      if (existing && existing.peerId !== record.peerId) {
        throw new Error(`Name "${record.name}" is already taken by peer ${existing.peerId}`);
      }
    }
    const pointer: NamePointer = { peerId: record.peerId };
    atomicWrite(nameLink, JSON.stringify(pointer));
  } catch (err: unknown) {
    if (err instanceof Error && err.message.startsWith("Name ")) throw err;
    // Non-critical: peer still registered by ID even if name claim fails
  }
}

export function unregisterPeer(peerId: string, name: string): void {
  // Remove name mapping if owned by this peer
  const nameLink = getNameLink(name);
  try {
    if (existsSync(nameLink)) {
      const resolved = resolveName(name);
      if (resolved && resolved.peerId === peerId) {
        unlinkSync(nameLink);
      }
    }
  } catch { /* best effort */ }

  // Remove peer record
  try {
    const peerPath = getPeerPath(peerId);
    if (existsSync(peerPath)) unlinkSync(peerPath);
  } catch { /* best effort */ }

  // Remove socket file (Unix only — Windows named pipes are kernel objects)
  if (!isWindows) {
    try {
      const sockPath = getPeerSocketPath(peerId);
      if (existsSync(sockPath)) unlinkSync(sockPath);
    } catch { /* best effort */ }
  }
}

export function updatePeerStatus(peerId: string, status: PeerStatus): void {
  const record = getPeerById(peerId);
  if (!record) return;
  record.status = status;
  record.lastHeartbeatAt = new Date().toISOString();
  atomicWrite(getPeerPath(peerId), JSON.stringify(record, null, 2));
}

export function updatePeerModel(peerId: string, model: string): void {
  const record = getPeerById(peerId);
  if (!record) return;
  record.model = model;
  record.lastHeartbeatAt = new Date().toISOString();
  atomicWrite(getPeerPath(peerId), JSON.stringify(record, null, 2));
}

export function heartbeatPeer(peerId: string): void {
  const record = getPeerById(peerId);
  if (!record) return;
  record.lastHeartbeatAt = new Date().toISOString();
  if (record.status === "unreachable") {
    record.status = "idle";
  }
  atomicWrite(getPeerPath(peerId), JSON.stringify(record, null, 2));
}

export function getPeerById(peerId: string): PeerRecord | undefined {
  const path = getPeerPath(peerId);
  if (!existsSync(path)) return undefined;
  try {
    return JSON.parse(readFileSync(path, "utf-8")) as PeerRecord;
  } catch {
    return undefined;
  }
}

export function resolveName(name: string): PeerRecord | undefined {
  const link = getNameLink(name);
  if (!existsSync(link)) return undefined;
  try {
    const pointer = JSON.parse(readFileSync(link, "utf-8")) as NamePointer;
    return getPeerById(pointer.peerId);
  } catch {
    return undefined;
  }
}

export interface ListPeersOptions {
  includeStale?: boolean;
  status?: PeerStatus;
}

export function listPeers(options: ListPeersOptions = {}): PeerRecord[] {
  ensureDirs();

  const peers: PeerRecord[] = [];
  let entries: string[];
  try {
    entries = readdirSync(byIdDir());
  } catch {
    return [];
  }

  const now = Date.now();

  for (const entry of entries) {
    if (!entry.endsWith(".json")) continue;
    const pid = entry.replace(".json", "");
    const record = getPeerById(pid);
    if (!record) continue;

    const age = now - new Date(record.lastHeartbeatAt).getTime();
    const stale = age > STALE_THRESHOLD_MS;

    if (stale && !options.includeStale) continue;
    if (options.status && record.status !== options.status) continue;

    peers.push({
      ...record,
      status: stale ? "unreachable" : record.status,
    });
  }

  return peers;
}

export function pruneStalePeers(): number {
  let pruned = 0;
  const stale = listPeers({ includeStale: true }).filter((p) => p.status === "unreachable");
  for (const peer of stale) {
    unregisterPeer(peer.peerId, peer.name);
    pruned += 1;
  }
  return pruned;
}
