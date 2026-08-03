# pi-collab

Multi-agent collaboration extension for pi. Enables multiple pi instances on the
same host to communicate and collaborate on shared tasks.

## Install

```bash
# From npm
pi install npm:pi-collab

# From GitHub
pi install git:github.com/zurrll/pi-collab@v0.2.1
```

Or for development, load directly without installing:/

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
| `broadcast_to_colleagues` | Discover peer status and capabilities (OOB probe, zero context cost). Filter by `capability` keyword. |
| `review_by_colleague` | Ask a colleague to review code with structured, severity-rated feedback. |
| `ask_colleague` | (For use by colleagues) Ask a clarifying question back to the delegating peer. |

Each tool includes `promptSnippet` and `promptGuidelines` so the LLM receives
clear guidance on when and how to use them. Tools also have custom TUI rendering
showing colleague name, task preview, token usage, and expandable details.

### Multi-Round Discussions

Pass a `conversationId` (any short string, e.g. `"auth-refactor"`) to `delegate_to_colleague`.
The colleague's session persists across calls — they see full history including
who sent each message. Continue calling with the same ID until resolved.

```
Round 1: delegate_to_colleague { colleague: "reviewer", task: "...", conversationId: "auth-refactor" }
Round 2: delegate_to_colleague { colleague: "reviewer", task: "...", conversationId: "auth-refactor" }
```

### Message Annotation

Tasks injected to a colleague's agent loop include a strong ASCII box header:

```
┌─────────────────────────────────────────────┐
│  INCOMING TASK FROM reviewer               │
│  → This is NOT from your user              │
│  → Your response goes to the colleague     │
│  → Be concise and technical                │
│  → No greetings, no sign-offs              │
│  → Use ask_colleague tool if you need info │
└─────────────────────────────────────────────┘
```

The header includes the **caller's name** (resolved from the peer registry) so the
LLM can identify and tailor responses to specific colleagues.  The six rules
prevent the LLM from confusing colleague messages with user prompts.

### Error Handling

All errors use structured error codes with **LLM-actionable hints**:

| Code | Hint |
|------|------|
| `peer_not_found` | Try `/collab list` to see active peers, or `/collab spawn` to start one. |
| `peer_unreachable` | Peer may have crashed. Try `/collab stop` to clean up, then respawn. |
| `peer_busy` | Wait and retry, or delegate to a different colleague. |
| `auth_failed` | Peer has restarted (new token). Use `/collab token` to get the new token. |
| `timeout` | Task too complex or model too slow. Split into smaller pieces. |
| `cancelled` | User pressed Escape. Retry when ready. |

## Commands

| Command | Description |
|---------|-------------|
| `/collab spawn <name\|template>` | Start a headless peer. Supports templates, `--model`, `--prompt`, `--name`, `--tools` flags. |
| `/collab list` | List all registered peers with status, model, and heartbeat |
| `/collab status [name]` | Show detailed status including capabilities (without auth token) |
| `/collab stop <name>` | Remove a peer from the registry. On self: full offline (stops listener + heartbeat). |
| `/collab start` | Re-enable the current peer after `/collab stop` (re-registers, rebinds socket, restarts heartbeat) |
| `/collab rename <name>` | Rename the current peer |
| `/collab delegate <name> <task>` | Manually delegate a task to a colleague (bypasses LLM middleman) |
| `/collab templates` | List available colleague templates |
| `/collab token` | Show this peer's auth token (share with trusted peers) |

All commands support tab-completion for subcommands, peer names, and template names.

## Colleague Templates

Define reusable peer configurations as `.md` files with frontmatter:

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
- `.pi/colleagues/*.md` — project-local, shared with your team

Project templates override global templates with the same name.

**Usage:**
```
/collab spawn reviewer                        # Uses template's model + system prompt
/collab spawn reviewer --name code-checker    # Override the display name
/collab spawn reviewer --model openai/gpt-5   # Override the model
/collab spawn reviewer --tools read,bash      # Restrict tool set
/collab templates                             # List all available templates
```

## Capability Broadcasting

Peers automatically publish their capabilities — a union of their active tool
names and optional manual tags from the `PI_COLLAB_CAPABILITIES` environment
variable.  This enables skill-based peer discovery.

```bash
# Mark a peer with manual capability tags
PI_COLLAB_CAPABILITIES="code-review,typescript,security" pi -e pi-collab
```

**Filtering by capability:**

```
broadcast_to_colleagues { capability: "security" }
→ returns only peers whose capabilities (tools + tags) match "security"
```

Capabilities are shown in `/collab status` and in broadcast results:
```
- **reviewer**  idle  claude-sonnet-4  `/project`  [read, bash, edit, grep, code-review, security]
```

## Peer Status Widget

A TUI widget above the editor displays the current mesh state:

```
── Peers ──
● architect (me)  claude-sonnet-4
◉ reviewer        gpt-5.2          ← busy (processing)
● dev             deepseek-v3
```

Status icons: `● idle` (green), `◉ busy` (yellow), `○ unreachable` (dim).

The widget updates on turn boundaries **and** on the heartbeat interval (every 5 s),
so newly spawned peers appear automatically without needing `/collab list`.

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
| Linux / macOS (remote) | SSH Unix socket forwarding |
| Windows 10+ (Build 17063+) | Windows named pipes |

## Cross-Host Collaboration (SSH)

Connect to peers on other machines via SSH. Works by forwarding the remote
peer's Unix socket to a local path (`ssh -L`), so the existing protocol and
tools work unchanged.

**Requirements:**
- Local machine: OpenSSH 6.7+ (Unix socket forwarding) — Linux/macOS
- SSH key-based auth to the remote host (no password prompts)
- The remote machine is running pi with pi-collab loaded

**Setup (on the caller side):**
```
/collab remote add reviewer user@remote-host
```

This fetches the remote peer's record over SSH, caches it locally, and
establishes a persistent tunnel. You can now `delegate_to_colleague`,
`review_by_colleague`, or `broadcast_to_colleagues` to `reviewer` as if
it were local.

**Manage:**
```
/collab remote list              # show configured remote peers + tunnel status
/collab remote remove reviewer   # remove entry and close tunnel
/collab stop reviewer            # also works for remote peers
```

**Notes:**
- The remote peer must be reachable by name on the remote machine
  (it must have registered with pi-collab there)
- Auth uses the remote peer's token fetched via SSH — same-user trust
- Tunnels are closed automatically on exit
- Windows does not support this transport yet (Win32-OpenSSH lacks
  Unix socket forwarding); use a WebSocket relay instead (Phase 2)

## Architecture

```
Transport (Unix sockets / Windows named pipes)
    ↓ JSONL envelopes
Auth (token verification via filesystem trust anchor)
    ↓
Protocol (request, response, question, answer, probe, ping)
    ↓
Agent Bridge (injectTask, agent_settled capture, activeAskCount guard)
    ↓
Tools (delegate, broadcast, review, ask_colleague) + Colleague Templates
    ↓
TUI (peer status widget, custom tool rendering, capability display)
```

Probe messages are handled out-of-band at the transport layer — they never
reach the LLM context window, making peer discovery free.

## Limitations (Phase 1)

- Same-host only
- `delegate_to_colleague` is blocking; colleague's questions are answered via natural
  language in the response (next round), not synchronously
- Message source annotation is text-level, not protocol-level (mitigated by strong
  ASCII box markers and caller name display)
- No tool-set syncing between peers
- Single inbound request at a time (`pendingTask` single-slot; concurrent requests
  queue via the socket accept loop)
