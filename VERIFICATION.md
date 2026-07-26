# pi-collab Verification Guide

## Prerequisites

- **Linux / macOS**: Unix domain sockets.
- **Windows 10+ (Build 17063+)**: Windows named pipes via `\\.\pipe\`.
  Earlier Windows builds may not support the required IPC.
- Two terminal windows open to the same working directory.

## Platform Differences

| Aspect | Linux / macOS | Windows |
|--------|--------------|---------|
| Transport | Unix domain socket (`.sock` file) | Windows named pipe (`\\.\pipe\pi-collab-*`) |
| Registry | `~/.pi/collab/peers/` | `C:\Users\<user>\.pi\collab\peers\` |
| Socket path | `~/.pi/collab/socks/<uuid>.sock` | `\\.\pipe\pi-collab-<short-id>` |
| Cleanup | Unlink `.sock` file on shutdown | OS auto-cleans named pipes |
| Spawn signal | `SIGTERM` | `childProcess.kill()` (registry cleanup) |

## Quick Start: Two Interactive Sessions

### Terminal 1 — "Architect"

```bash
cd /path/to/pi-main
./pi-test.sh -e .pi/extensions/pi-collab/index.ts
```

Wait for pi to start, then rename the peer:

```
/collab rename architect
```

Expected output: `pi-collab: Registered as "architect"` then `Renamed from "peer-XXXXX" to "architect"`

### Terminal 2 — "Reviewer"

```bash
cd /path/to/pi-main
./pi-test.sh -e .pi/extensions/pi-collab/index.ts
```

```
/collab rename reviewer
```

### Verify Discovery

In Terminal 1:

```
/collab list
```

Expected: shows both peers:

```
* architect (me) — idle — ?/claude-sonnet-4-20250514
  reviewer — idle — ?/claude-sonnet-4-20250514
```

### Delegate a Task

In Terminal 1, send a task to the reviewer:

```
Ask the reviewer to review the file packages/coding-agent/docs/multi-agent-collaboration.md. Tell them to focus on clarity and completeness.
```

The agent in Terminal 1 should call `delegate_to_colleague` with `{ colleague: "reviewer", task: "..." }`. The agent in Terminal 2 should process the request and return a review. Terminal 1 should display the review result.

### Debugging

If something goes wrong:

1. Check the peer is listed: `/collab list`
2. Check a peer's details: `/collab status reviewer`
3. Check the filesystem registry directly:

```bash
ls ~/.pi/collab/peers/by-id/
ls ~/.pi/collab/peers/by-name/
cat ~/.pi/collab/peers/by-name/reviewer.json
cat ~/.pi/collab/peers/by-id/*.json
```

4. Check stderr from the second pi process for error messages (socket bind failures, etc.).

---

## Spawning a Headless Peer

Instead of two interactive sessions, you can spawn a headless peer from one session:

```bash
cd /path/to/pi-main
./pi-test.sh -e .pi/extensions/pi-collab/index.ts
```

Then:

```
/collab spawn reviewer --model anthropic/claude-sonnet-4-20250514
```

This starts a new pi process in `--mode rpc` (headless, JSONL stdin/stdout). The peer registers itself in the filesystem registry. After ~2 seconds:

```
/collab list
```

Should show the spawned reviewer.

Then delegate as above.

To stop the spawned peer:

```
/collab stop reviewer
```

---

## What to Expect

### Happy Path

1. Both peers register in `~/.pi/collab/peers/`.
2. `delegate_to_colleague` connects from the caller to the target's Unix socket.
3. The target receives the task, injects it via `agentCtx.injectTask()`, processes it, and sends the response back.
4. The caller's tool returns the result as tool output text.
5. Peers heartbeat every 5 s; stale peers (>30 s) are pruned.

### Known Limitations

- **Blocking delegation only**: `delegate_to_colleague` is fire-and-wait. If the remote peer calls `ask_colleague` (a clarifying question), the caller responds with a generic "cannot answer during blocking delegation" message. Use two interactive sessions with explicit `/collab` commands for multi-turn consultation.
- **Same-host only**: Phase 1. Cross-host needs Radius WebSocket relay (not yet built).
- **No tool set syncing**: Each peer uses its own tools. The caller does not know what tools the target has.
- **Windows**: Unix domain sockets on Windows require Build 17063+. The path format in `registry.ts` may need `\\\\.\\pipe\\` prefix adaptation.

---

## Directory Layout After Running

**Linux/macOS:**

```
~/.pi/collab/
├── peers/
│   ├── by-id/
│   │   └── <uuid>.json
│   └── by-name/
│       └── <name>.json   # { "peerId": "..." }
└── socks/
    └── <uuid>.sock
```

**Windows:**

```
C:\Users\<user>\.pi\collab\
└── peers/
    ├── by-id/
    │   └── <uuid>.json
    └── by-name/
        └── <name>.json    # { "peerId": "..." }
# No socks/ directory — named pipes live in kernel space
```

---

## Troubleshooting

### "Colleague not found"

The peer hasn't registered yet. Check:
- Is the other pi process running with the extension?
- Run `/collab list` to see registered peers.
- Check `~/.pi/collab/peers/by-name/` for the expected entry.

### "Failed to bind socket"

- A stale socket file from a previous run may exist. Delete it:
  ```bash
  rm -rf ~/.pi/collab/socks/
  ```
- Check permissions on `~/.pi/collab/`.

### "Connection refused / peer unreachable"

- The target peer's socket server may have crashed. Check stderr of the target pi process.
- Run `/collab status <name>` to check the peer's status.
- Try `/collab stop <name>` followed by respawning/reconnecting.
- On Windows: named pipes are kernel objects. If the listening process exits, the pipe is destroyed automatically. Check that the target pi process is still running.

### Windows-specific issues

- **Spawned peer doesn't appear**: The spawned `--mode rpc` process may fail silently.
  Check if the pi binary resolves correctly (try running the same command manually).
- **Pipe name too long**: Named pipe paths are limited to ~256 characters.
  Peer IDs are truncated to 8 chars in the pipe name.
- **Killing spawned peers**: `/collab stop` removes the registry entry. On Windows,
  use Task Manager or `taskkill /PID <pid>` / `taskkill /IM node.exe` to force-kill
  hung spawned processes.

### Extension not loading

- Verify the path: `ls -la .pi/extensions/pi-collab/index.ts`
- Load explicitly: `./pi-test.sh -e .pi/extensions/pi-collab/index.ts`
- Check for TypeScript errors in the pi stderr output.
