# pi-collab

Multi-agent collaboration extension for pi. Enables multiple pi instances to
communicate and collaborate on shared tasks — multiple terminals on the same
host, or pi instances on remote machines over SSH.

> **Scope (v0.2.5):** local collaboration works on Linux/macOS/Windows;
> **remote (SSH) collaboration currently requires Linux/macOS** — Windows
> awaits the future WebSocket relay.

---

## Table of Contents

- [Install](#install)
- [Quick Start: Two Local Terminals](#quick-start-two-local-terminals)
- [Concepts & Design](#concepts--design)
- [Commands](#commands)
- [LLM Tools](#llm-tools)
- [Colleague Templates](#colleague-templates)
- [Capability Broadcasting](#capability-broadcasting)
- [Peer Status Widget](#peer-status-widget)
- [Cross-Host Collaboration (SSH)](#cross-host-collaboration-ssh)
- [Authentication](#authentication)
- [Environment Variables](#environment-variables)
- [Error Handling](#error-handling)
- [Platform Support](#platform-support)
- [File Structure](#file-structure)
- [Limitations (Phase 1)](#limitations-phase-1)

---

## Install

```bash
# From npm
pi install npm:pi-collab

# From GitHub (pinned version)
pi install git:github.com/zurrll/pi-collab@v0.2.5
```

For development, load directly without installing:

```bash
pi -e /path/to/pi-collab/extensions/pi-collab/index.ts
```

---

## Quick Start: Two Local Terminals

Open two terminals in the same directory.

**Terminal 1:**
```bash
pi -e pi-collab
/collab rename architect
```

**Terminal 2:**
```bash
pi -e pi-collab
/collab rename reviewer
```

**Terminal 1 — verify discovery:**
```
/collab list
```

**Terminal 1 — delegate a task:**
```
Have reviewer review package.json, focusing on correctness and completeness.
```

The agent automatically calls the `delegate_to_colleague` tool to send the task
to reviewer. Reviewer processes it in its own isolated context window and
returns the result.

---

## Concepts & Design

### Core Concepts

| Term | Meaning |
|------|---------|
| **Peer** | A pi instance running pi-collab |
| **Colleague** | A peer's human-readable name, e.g. `reviewer`, `architect` |
| **Mesh** | The set of all currently reachable peers |
| **Envelope** | A JSONL message exchanged between two peers |
| **Conversation** | A multi-turn exchange between two peers |

### Architecture Layers

```
┌──────────────────────────────────────────────┐
│  TUI layer    peer status widget, tool render│
├──────────────────────────────────────────────┤
│  Tool layer   delegate, broadcast, review,   │
│               ask_colleague + templates      │
├──────────────────────────────────────────────┤
│  Protocol     envelope, conversation state   │
├──────────────────────────────────────────────┤
│  Auth         token verification (fs anchor) │
├──────────────────────────────────────────────┤
│  Transport    Unix socket / SSH tunnel       │
├──────────────────────────────────────────────┤
│  Discovery    filesystem registry (+remote)  │
└──────────────────────────────────────────────┘
```

Each layer is independently replaceable. Cross-host support swaps only
Transport + Discovery; the upper layers are untouched.

### Design Notes

- **Peer-to-peer**: no central scheduler; every peer is both client and server
- **OOB probing**: `probe`/`ping`/`pong` are handled at the transport layer,
  never entering the LLM context — zero token cost
- **Filesystem trust anchor**: a peer's auth token lives in a registry file;
  being able to read the file implies same-user trust (see [Authentication](#authentication))
- **Message annotation**: tasks injected into a colleague's agent carry an
  ASCII box header naming the caller, so the LLM never confuses colleague
  messages with user prompts

---

## Commands

All commands support tab-completion (subcommands, peer names, template names).

| Command | Description |
|---------|-------------|
| `/collab spawn <name\|template>` | Start a headless peer. Supports `--model`, `--prompt`, `--name`, `--tools` |
| `/collab list` | List all peers (local + remote + tunnel status) |
| `/collab status [name]` | Show detailed peer info (incl. capabilities, not token) |
| `/collab stop <name>` | Stop a peer. Self: full offline. Remote: remove entry + close tunnel |
| `/collab start` | Re-enable the current peer after `/collab stop` |
| `/collab rename <name>` | Rename the current peer |
| `/collab delegate <name> <task>` | Manually delegate a task (bypasses LLM) |
| `/collab templates` | List available colleague templates |
| `/collab token` | Show this peer's auth token (share only with trusted peers) |
| `/collab remote ...` | Manage remote SSH peers (see [Cross-Host Collaboration](#cross-host-collaboration-ssh)) |

### spawn Options

```
/collab spawn reviewer                          # from a colleague template
/collab spawn reviewer --model anthropic/claude-sonnet-4-20250514  # pick model
/collab spawn reviewer --prompt "You are a code reviewer"          # system prompt
/collab spawn reviewer --name code-checker      # override display name
/collab spawn reviewer --tools read,bash,edit   # restrict tool set
```

---

## LLM Tools

| Tool | Role | Description |
|------|------|-------------|
| `delegate_to_colleague` | caller | Delegate a task to a named colleague and wait. Multi-round via `conversationId` |
| `broadcast_to_colleagues` | caller | Probe all reachable peers' status/capabilities (OOB, zero cost) |
| `review_by_colleague` | caller | Structured code review with severity ratings |
| `ask_colleague` | colleague | Ask a clarifying question back to the delegating peer |

Each tool has `promptSnippet`/`promptGuidelines` so the LLM knows when to use
it, plus custom TUI rendering (tool name, task preview, token usage, expandable
details).

### Multi-Round Discussions

Keep a colleague's session memory with `conversationId`:

```
Round 1: delegate_to_colleague { colleague: "reviewer", task: "...", conversationId: "auth-refactor" }
Round 2: delegate_to_colleague { colleague: "reviewer", task: "...", conversationId: "auth-refactor" }
```

The colleague's session persists across calls, including caller identity.

### Capability-Filtered Broadcast

```
broadcast_to_colleagues { capability: "security" }
→ only peers whose capabilities match "security" (tool names + tags)
```

---

## Colleague Templates

Reusable peer configs as `.md` files with frontmatter:

```markdown
---
name: reviewer
description: Code reviewer focused on correctness and security
model: anthropic/claude-sonnet-4-20250514
tools: read, bash, edit, write, grep, find, ls
---

You are a code reviewer. Focus on:
- Correctness and edge cases
- Security vulnerabilities
- Performance implications

Provide structured feedback with severity ratings.
```

**Locations:**
- `~/.pi/agent/colleagues/*.md` — global, available in all projects
- `.pi/colleagues/*.md` — project-local, shareable with your team

Project templates override global templates with the same name.

**Usage:**
```
/collab spawn reviewer                        # use template model + prompt
/collab spawn reviewer --name code-checker    # override display name
/collab spawn reviewer --model openai/gpt-5   # override model
/collab templates                             # list all templates
```

---

## Capability Broadcasting

Each peer publishes its capabilities — **active tool names** + **manual tags**:

```bash
# Manual tags
PI_COLLAB_CAPABILITIES="code-review,typescript,security" pi -e pi-collab
```

Capabilities appear in:
- `/collab status` output
- `broadcast_to_colleagues` results
- `capability` filter in probe

---

## Peer Status Widget

A widget above the editor shows the mesh in real time:

```
── Peers ──
● architect (me)  claude-sonnet-4
◉ reviewer        gpt-5.2          ← busy
● dev             deepseek-v3
```

Icons: `● idle` (green), `◉ busy` (yellow), `○ unreachable` (dim).

The widget refreshes on turn boundaries and the heartbeat interval (5s), so
new peers appear automatically. Remote peers show only while their tunnel is
active (no ghost entries).

---

## Cross-Host Collaboration (SSH)

Forwards a remote peer's Unix socket to a local path (`ssh -L`), so the
protocol and tools work unchanged.

### Prerequisites

1. **Local machine**: OpenSSH 6.7+ (Unix socket forwarding) — Linux/macOS
2. **SSH key auth**: password prompts are disabled (they corrupt the TUI).
   Set up keys:

```bash
# Generate a key if you don't have one
ssh-keygen -t ed25519

# Copy your public key to the remote
ssh-copy-id <remote-user>@<remote-host>

# Verify passwordless login (must succeed without a prompt)
ssh <remote-user>@<remote-host> "echo ok"
```

3. **Remote**: a pi with pi-collab running, and at least one registered peer

### Register a Remote Peer

**One peer:**
```
/collab remote add reviewer <remote-user>@<remote-host>
```

**All peers (no name):**
```
/collab remote add <remote-user>@<remote-host>
```

Bulk mode lists the remote registry, adds every peer, establishes tunnels,
and reports per-peer results:

```
Remote sync from user@host: 2 added, 1 failed. Failed: dev
```

### Two-Way Registration (recommended)

Registration is **unidirectional** by default: whoever runs `add` can reach
the other side. To make both sides see and reach each other, use `add-both`:

```
/collab remote add-both <local-user>@<local-address> <remote-user>@<remote-host>
```

Flow:
1. Register all remote peers locally
2. Push this peer's record to the remote's `~/.pi/collab/remotes/` over SSH
3. The remote's `/collab list` immediately shows this peer, and it can
   delegate back (building its own reverse tunnel on demand)

> **Note:** the reverse direction requires the remote to also SSH back to
> your machine (sshd enabled, address reachable). If your machine is behind
> NAT without a public address, the reverse direction won't work — that's a
> network limitation, pending the Phase 2 WebSocket relay.

### Managing Remote Peers

```
/collab remote list              # show remote peers + tunnel status
/collab remote refresh <name>    # re-fetch record (new token/path after restart)
/collab remote remove <name>     # remove entry and close tunnel
/collab remote prune             # remove entries with no active tunnel
/collab stop <name>              # also works for remote peers
```

### Troubleshooting

**"SSH key auth failed"** → no keys configured. Follow the `ssh-keygen` +
`ssh-copy-id` steps above.

**"remote peer not found"** → pi-collab isn't running on the remote, or the
peer isn't registered. Run `/collab list` on the remote first.

**"tunnel not functional"** → the remote socket doesn't exist or the tunnel
failed. Confirm the remote peer is online, then `/collab remote refresh <name>`.

**Remote unreachable after restart** → a peer restart generates a new
token/path. Run `/collab remote refresh <name>`.

---

## Authentication

Each peer generates a 256-bit random token at startup, stored in
`~/.pi/collab/peers/by-id/<peerId>.json`. A caller must present the target
peer's token (`auth` envelope) before any message exchange. Being able to read
that file implies same-user trust.

- **Ping is exempt** (pure connectivity check)
- All other messages (request, probe) require prior auth
- `/collab token` reveals this peer's token — share only with trusted peers
- Remote peer tokens are fetched over SSH (already authenticated by SSH itself)

---

## Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `PI_COLLAB_NAME` | `peer-<pid>` | Peer display name |
| `PI_COLLAB_SYSTEM_PROMPT` | — | Extra system prompt |
| `PI_COLLAB_MODEL` | — | Model, e.g. `anthropic/claude-sonnet-4-20250514` |
| `PI_COLLAB_CAPABILITIES` | — | Manual capability tags, comma-separated |
| `PI_COLLAB_MAX_TURNS` | `20` | Max turns for delegated tasks |
| `PI_COLLAB_CONVERSATION_TIMEOUT_MS` | `120000` | Conversation timeout (ms) |
| `PI_COLLAB_HEARTBEAT_INTERVAL_MS` | `5000` | Heartbeat interval (ms) |
| `PI_COLLAB_DIR` | `~/.pi/collab` | Data directory override |

---

## Error Handling

All errors carry a structured code + an LLM-actionable hint:

| Code | Meaning | Hint |
|------|---------|------|
| `peer_not_found` | name not in registry | run `/collab list` for available peers |
| `peer_unreachable` | peer offline or tunnel down | clean up and retry, or refresh |
| `peer_busy` | processing another request | wait and retry, or pick someone else |
| `auth_failed` | token mismatch | remote restarted — run refresh |
| `timeout` | processing timed out | split the task or raise maxTurns |
| `cancelled` | user aborted | just retry |

The TUI shows a short label; the LLM sees the full hint.

---

## Platform Support

| Platform | Local transport | Remote transport |
|----------|-----------------|------------------|
| Linux / macOS | Unix domain socket | SSH Unix socket forwarding |
| Windows 10+ (17063+) | Windows named pipe | Not yet (WebSocket relay planned) |

---

## File Structure

```
extensions/pi-collab/
├── index.ts              # entry: tools/commands/events/networking
├── types.ts              # type definitions
├── config.ts             # env var parsing
├── errors.ts             # CollabError structured errors
├── agent-context.ts      # agent loop bridge (injectTask/agent_settled)
├── colleagues.ts         # colleague template system
├── protocol/
│   ├── envelope.ts       # JSONL envelope encode/decode
│   └── conversation.ts   # conversation state machine
├── transport/
│   ├── index.ts          # PeerTransport interface
│   ├── unix-socket.ts    # Unix socket / named pipe
│   ├── ssh.ts            # SSH tunnel + key preflight
│   └── paths.ts          # cross-platform paths
└── discovery/
    ├── registry.ts       # local filesystem registry
    └── remotes.ts        # remote peer cache
```

Data directory `~/.pi/collab/`:

```
~/.pi/collab/
├── peers/
│   ├── by-id/<peerId>.json    # peer records (token, capabilities)
│   └── by-name/<name>.json    # name → peerId mapping
├── remotes/<name>.json        # remote peer cache (SSH)
└── socks/<peerId>.sock        # Unix sockets (Linux/macOS)
```

---

## Limitations (Phase 1)

- `delegate_to_colleague` is blocking: colleague questions are answered
  asynchronously in the next round
- No central registry: cross-host discovery relies on manual SSH registration
  (`remote add` / `add-both`)
- One inbound request at a time (`pendingTask` single-slot; concurrent
  requests queue)
- Windows does not yet support the SSH remote transport
- Planned: WebSocket relay (cross-NAT without public addresses),
  non-blocking delegation
