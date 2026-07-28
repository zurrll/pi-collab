# pi-collab

Multi-agent collaboration extension for pi. Enables multiple pi instances on the
same host to communicate and collaborate on shared tasks.

## Install

```bash
# From npm
pi install npm:pi-collab

# From GitHub
pi install git:github.com/zurrll/pi-collab@v0.2.0
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

Each tool includes `promptSnippet` and `promptGuidelines` so the LLM receives
clear guidance on when and how to use them. Tools also have custom TUI rendering
(`renderCall` / `renderResult`) showing colleague name, task preview, token
usage, and expandable details.

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
| `/collab spawn <name\|template>` | Start a headless peer. If `<name>` matches a colleague template, loads model/prompt from it. Accepts `--model`, `--prompt`, `--name` flags. |
| `/collab list` | List all registered peers with status, model, and heartbeat |
| `/collab stop <name>` | Remove a peer from the registry |
| `/collab rename <name>` | Rename the current peer |
| `/collab status [name]` | Show detailed status for a peer (without auth token) |
| `/collab delegate <name> <task>` | Manually delegate a task to a colleague |
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
/collab spawn reviewer                      # Uses template's model + system prompt
/collab spawn reviewer --name code-checker  # Override the display name
/collab spawn reviewer --model openai/gpt-5 # Override the model
/collab templates                           # List all available templates
```

## Peer Status Widget

A TUI widget above the editor displays the current mesh state, updated in real-time:

```
── Peers ──
● architect (me)  claude-sonnet-4
◉ reviewer        gpt-5.2          ← busy (processing)
● dev             deepseek-v3
```

Status icons: `● idle` (green), `◉ busy` (yellow), `○ unreachable` (dim).

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
Auth (token verification via filesystem trust anchor)
    ↓
Protocol (request, response, question, answer, probe, ping)
    ↓
Agent Bridge (injectTask, agent_settled capture, activeAskCount guard)
    ↓
Tools (delegate, broadcast, review, ask_colleague) + Colleague Templates
    ↓
TUI (peer status widget, custom tool rendering)
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
- Single inbound request at a time (`pendingTask` single-slot; concurrent requests
  queue via the socket accept loop)
