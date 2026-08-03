# pi-collab

pi 多 Agent 协作扩展。让同一主机上的多个 pi 实例互相通信、协同解决任务。

## 安装

```bash
# npm 安装
pi install npm:pi-collab

# GitHub 安装
pi install git:github.com/zurrll/pi-collab@v0.2.4
```

开发时也可以不安装，直接加载：

```bash
pi -e ./path/to/pi-collab/extensions/pi-collab/index.ts
```

## 快速上手

在同一项目的两个终端窗口中分别启动。

**终端 1：**
```bash
pi -e ./path/to/pi-collab/extensions/pi-collab/index.ts
/collab rename architect
```

**终端 2：**
```bash
pi -e ./path/to/pi-collab/extensions/pi-collab/index.ts
/collab rename reviewer
```

**终端 1 — 确认双方已发现：**
```
/collab list
```

**终端 1 — 委托任务：**
```
请 reviewer 审查 package.json 文件，关注正确性和完整性。
```

Agent 会自动调用 `delegate_to_colleague` 工具，将任务发给 reviewer。reviewer 在自己的上下文中独立处理，完成后结果返回。

## LLM 工具

| 工具 | 说明 |
|------|------|
| `delegate_to_colleague` | 将任务委托给指定同事，等待返回结果。支持通过可选 `conversationId` 参数进行多轮讨论。 |
| `broadcast_to_colleagues` | 探测 peer 状态和能力（OOB 探测，零上下文消耗）。支持 `capability` 关键词过滤。 |
| `review_by_colleague` | 请同事审查代码或设计，返回带严重等级的结构化反馈。 |
| `ask_colleague` | （供被委托方使用）处理任务时向委托方回问澄清问题。 |

每个工具都包含 `promptSnippet` 和 `promptGuidelines`，让 LLM 更准确地判断何时使用。
工具还带有自定义 TUI 渲染，展示同事名称、任务预览、token 用量和可展开的详情。

### 多轮讨论

调用 `delegate_to_colleague` 时传入 `conversationId`（任意短字符串，如 `"auth-refactor"`）。
同事的 session 在多次调用之间保持——他们能看到完整历史（含发送者名称）。用同一个 ID 持续调用，直到讨论结束。

```
第一轮: delegate_to_colleague { colleague: "reviewer", task: "...", conversationId: "auth-refactor" }
第二轮: delegate_to_colleague { colleague: "reviewer", task: "...", conversationId: "auth-refactor" }
```

### 消息标注

注入到同事 Agent loop 中的任务会带有醒目的 ASCII 框头：

```
┌─────────────────────────────────────────────┐
│  INCOMING TASK FROM reviewer               │
│  → 这不是用户的指令                         │
│  → 你的回复会发给该同事                     │
│  → 保持简洁、技术化                         │
│  → 不要客套，不要签名                       │
│  → 如需更多信息，使用 ask_colleague 工具    │
└─────────────────────────────────────────────┘
```

框头包含**调用方名称**（从 peer 注册表反查），让 LLM 能识别不同同事并针对性回复。
6 条规则防止 LLM 将同事消息与用户提示混淆。

### 错误处理

所有错误使用结构化错误码，附带 **LLM 可执行提示**：

| 错误码 | 提示 |
|--------|------|
| `peer_not_found` | 用 `/collab list` 查看可用 peer，或 `/collab spawn` 启动新的 |
| `peer_unreachable` | 对方可能已崩溃。用 `/collab stop` 清理后重新 spawn |
| `peer_busy` | 稍等片刻重试，或委托给其他同事 |
| `auth_failed` | 对方已重启（token 更新）。用 `/collab token` 获取新 token |
| `timeout` | 任务太复杂或模型太慢。拆分成小块再试 |
| `cancelled` | 用户按了 Escape。准备好后重试即可 |

## 命令

| 命令 | 说明 |
|------|------|
| `/collab spawn <name\|template>` | 启动无头 peer。支持模板、`--model`、`--prompt`、`--name`、`--tools` 参数 |
| `/collab list` | 列出所有已注册 peer，含名称、状态、模型 |
| `/collab status [name]` | 查看 peer 详细信息，含能力标签（不含 auth token） |
| `/collab stop <name>` | 删除 peer 注册信息。对自己：完全下线（关 listener + 停心跳） |
| `/collab start` | `/collab stop` 后重新上线当前 peer（重新注册、绑 socket、启心跳） |
| `/collab rename <name>` | 重命名当前 peer |
| `/collab delegate <name> <task>` | 手动委托任务给同事（不经过 LLM 中转） |
| `/collab templates` | 列出可用的同事模板 |
| `/collab token` | 显示当前 peer 的认证 token（仅分享给信任的 peer） |

所有命令支持 Tab 补全：子命令、peer 名称、模板名称。

## 同事模板

将可复用的 peer 配置定义为带 frontmatter 的 `.md` 文件：

```markdown
---
name: reviewer
description: 专注正确性和安全性的代码审查者
model: anthropic/claude-sonnet-4-20250514
tools: read, bash, edit, write, grep, find, ls
---

你是一个代码审查者。关注：
- 正确性和边界情况
- 安全漏洞
- 性能影响

提供带严重等级的结构化反馈。
```

**存放位置：**
- `~/.pi/agent/colleagues/*.md` — 全局，所有项目可用
- `.pi/colleagues/*.md` — 项目级，可与团队共享

项目模板覆盖同名的全局模板。

**使用方式：**
```
/collab spawn reviewer                        # 使用模板的 model + system prompt
/collab spawn reviewer --name code-checker    # 覆盖显示名称
/collab spawn reviewer --model openai/gpt-5   # 覆盖模型
/collab spawn reviewer --tools read,bash      # 限制工具集
/collab templates                             # 列出所有可用模板
```

## 能力广播

每个 peer 自动发布自己的能力——活跃工具名称加上可选的 `PI_COLLAB_CAPABILITIES`
环境变量中的手动标签。这使得可以按技能发现 peer。

```bash
# 给 peer 标注手动能力标签
PI_COLLAB_CAPABILITIES="code-review,typescript,security" pi -e pi-collab
```

**按能力过滤：**

```
broadcast_to_colleagues { capability: "security" }
→ 仅返回能力标签（工具名 + 手动标签）匹配 "security" 的 peer
```

能力标签在 `/collab status` 和广播结果中显示：
```
- **reviewer**  idle  claude-sonnet-4  `/project`  [read, bash, edit, grep, code-review, security]
```

## Peer 状态 Widget

编辑器上方显示当前 mesh 状态：

```
── Peers ──
● architect (me)  claude-sonnet-4
◉ reviewer        gpt-5.2          ← 忙碌中
● dev             deepseek-v3
```

状态图标：`● 空闲`（绿色）、`◉ 忙碌`（黄色）、`○ 不可达`（灰色）。

Widget 在 turn 边界**和**心跳间隔（每 5 秒）刷新，新 spawn 的 peer 自动出现，无需手动 `/collab list`。

## 认证

每个 peer 启动时生成 256-bit 随机认证 token，存储在文件系统注册表中。连接建立后，
调用方必须先发送 `auth` 信封出示目标 peer 的 token，验证通过后才能进行任何消息交换。
这证明了调用方对目标 PeerRecord 有文件系统读权限，从而建立同用户信任。

- ping 豁免认证（纯连通性检测）
- 其他所有消息（request、probe）必须先认证
- 使用 `/collab token` 查看当前 peer 的 token，仅分享给信任的 peer

## 平台支持

| 平台 | 传输方式 |
|------|---------|
| Linux / macOS | Unix domain socket |
| Linux / macOS（远程） | SSH Unix socket 转发 |
| Windows 10+ (Build 17063+) | Windows named pipe |

> **v0.2.4 修复：** Linux/macOS 的 socket 绑定现在会正确创建
> `~/.pi/collab/socks/` 目录（旧版本创建了错误目录，导致 Unix 上
> 报 "Failed to bind socket"）。

## 跨主机协作（SSH）

通过 SSH 连接其他机器上的 peer。原理是把远程 peer 的 Unix socket 转发到本地
路径（`ssh -L`），现有协议和工具零改动即可工作。

**要求：**
- 本地：OpenSSH 6.7+（支持 Unix socket 转发）——Linux/macOS
- 到远程主机使用 SSH 密钥认证（密码提示已禁用以保护 TUI；
  用 `ssh-keygen` + `ssh-copy-id` 配置密钥）
- 远程机器上运行了带 pi-collab 的 pi

**注册单个远程 peer：**
```
/collab remote add reviewer user@remote-host
```

这会通过 SSH 拉取远程 peer 的记录、缓存到本地并建立持久隧道。之后就可以像
本地 peer 一样对它调用 `delegate_to_colleague`、`review_by_colleague`、
`broadcast_to_colleagues`。

**批量注册主机上的所有 peer（不写名字）：**
```
/collab remote add user@remote-host
```

列出远程注册表，逐个添加所有正在运行的 peer 并为每个建立隧道，
逐个报告成功/失败。

**管理：**
```
/collab remote list              # 查看远程 peer + 隧道状态
/collab remote refresh <name>    # 重新拉取记录（重启后 token/路径变了）
/collab remote remove <name>     # 删除条目并关闭隧道
/collab remote prune             # 清理无活跃隧道的条目
/collab stop <name>              # 对远程 peer 同样有效
```

**注意：**
- 如果没配置 SSH 密钥，扩展会快速失败并给出 `ssh-keygen` / `ssh-copy-id`
  操作指引，而不是弹密码框（会破坏 TUI）
- 远程 peer 必须在远程机器上已注册（那里也运行着 pi-collab）
- 认证使用通过 SSH 获取的远程 peer token——同用户信任
- 退出时自动关闭所有隧道
- Windows 暂不支持此传输（Win32-OpenSSH 无 Unix socket 转发）；
  后续用 WebSocket relay 解决（Phase 2）

## 架构

```
Transport 层  (Unix socket / Windows named pipe)
    ↓ JSONL 信封
Auth 层      (token 验证，文件系统信任锚)
    ↓
Protocol 层  (auth, request, response, question, answer, probe, ping, pong)
    ↓
Agent Bridge (injectTask, agent_settled 捕获, activeAskCount 守卫)
    ↓
Tool 层      (delegate, broadcast, review, ask_colleague) + Colleague 模板 + 能力广播
    ↓
TUI 层       (peer 状态 widget, 自定义工具渲染, 错误提示)
```

Probe 消息在 Transport 层 OOB 处理——不进入 LLM 上下文窗口，peer 发现零消耗。

## 限制（Phase 1）

- 仅同主机
- `delegate_to_colleague` 是阻塞式；同事的提问通过自然语言在返回结果中异步回答（下一轮），而非同步
- 消息来源标注是文本级别而非协议级别（通过强 ASCII 框标记 + 调用方名称缓解）
- peer 之间无工具集同步（通过能力广播部分缓解——可发现对方有哪些工具）
- 同一时间只能处理一个入站请求（`pendingTask` 单槽位；并发请求通过 socket accept 排队）
