# pi-collab

Multi-agent collaboration extension for pi. Enables multiple pi instances on the
same host to communicate and collaborate on shared tasks.

## Install

```bash
# From npm
pi install npm:pi-collab

# From GitHub
pi install git:github.com/zurrll/pi-collab@v0.1.0
```

Or for development, load directly without installing:

```bash
pi -e ./path/to/pi-collab/extensions/pi-collab/index.ts
```

## Quick Start

Open two terminal windows in the same project.

**Terminal 1:**
```bash
pi -e ./path/to/pi-collab/extensions/pi-collab/index.ts
/collab rename architect
```

**Terminal 2:**
```bash
pi -e ./path/to/pi-collab/extensions/pi-collab/index.ts
/collab rename reviewer
```

**Terminal 1 — verify peers are discovered:**
```
/collab list
```

**Terminal 1 — delegate a task:**
```
Ask the reviewer to review the file package.json. Focus on correctness.
```

## Tools

| Tool | Description |
|------|-------------|
| `delegate_to_colleague` | Send a task to a named colleague and wait for the result. Supports multi-round discussion via optional `conversationId` parameter. |
| `broadcast_to_colleagues` | Discover peer status (OOB probe, zero context cost) |
| `review_by_colleague` | Ask a colleague to review code with structured feedback |
| `ask_colleague` | (For use by colleagues) Ask a clarifying question back to the delegating peer |

### Multi-Round Discussions

Pass a `conversationId` (any short string, e.g. `"auth-refactor"`) to `delegate_to_colleague`.
The colleague's session persists across calls — they see full history. Continue calling with
the same ID until the discussion is resolved.

```
Round 1: delegate_to_colleague { colleague: "reviewer", task: "...", conversationId: "auth-refactor" }
Round 2: delegate_to_colleague { colleague: "reviewer", task: "...", conversationId: "auth-refactor" }
```

### Message Annotation

Tasks injected to a colleague's agent loop include a strong ASCII box header marking them as
"INCOMING TASK FROM COLLEAGUE AGENT" with explicit rules: no greetings, no sign-offs,
response goes to the colleague, not the user. Prevents LLM from confusing colleague messages
with user prompts.

## Commands

| Command | Description |
|---------|-------------|
| `/collab spawn <name>` | Start a headless peer with the given name |
| `/collab list` | List all registered peers |
| `/collab stop <name>` | Remove a peer from the registry |
| `/collab rename <name>` | Rename the current peer |
| `/collab status [name]` | Show detailed status for a peer |
| `/collab delegate <name> <task>` | Manually delegate a task to a colleague |
| `/collab token` | Show this peer's auth token (share with trusted peers) |

## Authentication

Every peer generates a 256-bit random auth token at startup, stored in its
filesystem registry entry. Before any message exchange, callers must present
the target's token as an `auth` envelope. This proves filesystem read access
to the target's PeerRecord, establishing same-user trust.

- Ping is exempt (pure connectivity check)
- All other messages (request, probe) require prior auth
- Use `/collab token` to reveal this peer's token for manual sharing

## Platform Support

| Platform | Transport |
|----------|-----------|
| Linux / macOS | Unix domain sockets |
| Windows 10+ (Build 17063+) | Windows named pipes |

## Architecture

```
Transport (Unix sockets / Windows named pipes)
    ↓ JSONL envelopes
Protocol (request, response, question, answer, probe, ping)
    ↓
Tools (delegate, broadcast, review, ask)
    ↓
Agent Bridge (injectTask, agent_settled capture)
```

Probe messages are handled out-of-band at the transport layer — they never
reach the LLM context window, making peer discovery free.

## Limitations (Phase 1)

- Same-host only
- `delegate_to_colleague` is blocking; colleague's questions are answered via natural
  language in the response (next round), not synchronously
- Message source annotation is text-level, not protocol-level (mitigated by strong
  ASCII box markers)
- No tool-set syncing between peers
