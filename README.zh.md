# pi-collab

pi 多 Agent 协作扩展。让多个 pi 实例互相通信、协同解决任务——同一主机上开多个
终端，或通过 SSH 连接远程机器上的 pi。

本 README 面向 Linux/macOS 用户。

---

## 目录

- [安装](#安装)
- [快速上手：本地双终端协作](#快速上手本地双终端协作)
- [概念与原理](#概念与原理)
- [命令总览](#命令总览)
- [LLM 工具](#llm-工具)
- [同事模板](#同事模板)
- [能力广播](#能力广播)
- [Peer 状态 Widget](#peer-状态-widget)
- [跨主机协作（SSH）](#跨主机协作ssh)
- [认证机制](#认证机制)
- [环境变量](#环境变量)
- [错误处理](#错误处理)
- [平台支持](#平台支持)
- [文件结构](#文件结构)
- [限制（Phase 1）](#限制phase-1)

---

## 安装

```bash
# npm 安装
pi install npm:pi-collab

# GitHub 安装（指定版本）
pi install git:github.com/zurrll/pi-collab@v0.2.4
```

开发时直接加载（不安装）：

```bash
pi -e /path/to/pi-collab/extensions/pi-collab/index.ts
```

---

## 快速上手：本地双终端协作

打开两个终端，进入同一目录。

**终端 1：**
```bash
pi -e pi-collab
/collab rename architect
```

**终端 2：**
```bash
pi -e pi-collab
/collab rename reviewer
```

**终端 1 — 确认双方被发现：**
```
/collab list
```

**终端 1 — 委托任务：**
```
让 reviewer 审查 package.json，关注正确性和完整性。
```

agent 会自动调用 `delegate_to_colleague` 工具，把任务发给 reviewer。reviewer
在自己的独立上下文窗口中处理，完成后结果返回终端 1。

---

## 概念与原理

### 核心概念

| 术语 | 含义 |
|------|------|
| **Peer** | 一个运行了 pi-collab 的 pi 实例 |
| **同事 (Colleague)** | peer 的可读名字，如 `reviewer`、`architect` |
| **Mesh** | 当前所有可达的 peer 集合 |
| **Envelope** | 两个 peer 之间传输的消息信封（JSONL） |
| **会话 (Conversation)** | 两个 peer 之间的一次多轮交换 |

### 架构分层

```
┌──────────────────────────────────────────────┐
│  TUI 层       peer 状态 widget, 工具渲染     │
├──────────────────────────────────────────────┤
│  Tool 层      delegate, broadcast, review,   │
│               ask_colleague + 同事模板       │
├──────────────────────────────────────────────┤
│  Protocol 层  envelope, 会话状态机           │
├──────────────────────────────────────────────┤
│  Auth 层      token 验证（文件系统信任锚）   │
├──────────────────────────────────────────────┤
│  Transport 层  Unix socket / SSH 隧道        │
├──────────────────────────────────────────────┤
│  Discovery 层  文件系统注册表（+ 远程缓存）  │
└──────────────────────────────────────────────┘
```

每一层可独立替换。例如跨主机只换 Transport + Discovery，上层零改动。

### 设计要点

- **对等节点**：无中心调度器，每个 peer 既是 client 也是 server
- **OOB 探测**：`probe`/`ping`/`pong` 在传输层直接处理，不进入 LLM 上下文，
  零 token 消耗
- **文件系统信任锚**：peer 的 auth token 存在注册表文件里，能读到文件 =
  同用户进程（详见[认证机制](#认证机制)）
- **消息标注**：注入到同事 agent 的任务带 ASCII 框头，标注来源同事名称，
  防止 LLM 把同事消息当成用户指令

---

## 命令总览

所有命令支持 Tab 补全（子命令、peer 名称、模板名称）。

| 命令 | 说明 |
|------|------|
| `/collab spawn <name\|template>` | 启动一个无头 peer。支持 `--model`、`--prompt`、`--name`、`--tools` |
| `/collab list` | 列出所有 peer（本地 + 远程 + 隧道状态） |
| `/collab status [name]` | 查看 peer 详细信息（含能力标签，不含 token） |
| `/collab stop <name>` | 停止 peer。对自己：完全下线；对远程：删除条目并关隧道 |
| `/collab start` | `/collab stop` 后重新上线当前 peer |
| `/collab rename <name>` | 重命名当前 peer |
| `/collab delegate <name> <task>` | 手动委托任务（不经过 LLM） |
| `/collab templates` | 列出可用同事模板 |
| `/collab token` | 显示当前 peer 的认证 token（仅分享给信任的 peer） |
| `/collab remote ...` | 管理远程 SSH peer（见[跨主机协作](#跨主机协作ssh)） |

### spawn 命令详解

```
/collab spawn reviewer                          # 用同事模板启动
/collab spawn reviewer --model anthropic/claude-sonnet-4-20250514  # 指定模型
/collab spawn reviewer --prompt "你是一个代码审查者"                # 指定系统提示
/collab spawn reviewer --name code-checker      # 覆盖显示名称
/collab spawn reviewer --tools read,bash,edit   # 限制工具集
```

---

## LLM 工具

| 工具 | 角色 | 说明 |
|------|------|------|
| `delegate_to_colleague` | 调用方 | 把任务委托给指定同事，等待结果。支持多轮讨论 |
| `broadcast_to_colleagues` | 调用方 | 探测所有可达 peer 的状态和能力（OOB，零消耗） |
| `review_by_colleague` | 调用方 | 请同事做结构化代码审查（带严重等级） |
| `ask_colleague` | 被调用方 | 处理委托任务时，向委托方回问澄清问题 |

每个工具都带 `promptSnippet`/`promptGuidelines`，让 LLM 知道何时使用；
以及自定义 TUI 渲染（工具名、任务预览、token 用量、展开详情）。

### 多轮讨论

用 `conversationId` 保持同事的会话记忆：

```
第一轮: delegate_to_colleague { colleague: "reviewer", task: "...", conversationId: "auth-refactor" }
第二轮: delegate_to_colleague { colleague: "reviewer", task: "...", conversationId: "auth-refactor" }
```

同事的 session 跨调用持久，能看到完整历史（含发送者名称）。

### 能力过滤广播

```
broadcast_to_colleagues { capability: "security" }
→ 只返回能力匹配 "security" 的 peer（工具名 + PI_COLLAB_CAPABILITIES 标签）
```

---

## 同事模板

可复用的 peer 配置，`.md` 文件 + frontmatter：

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

项目模板覆盖同名全局模板。

**使用：**
```
/collab spawn reviewer                        # 使用模板的 model + system prompt
/collab spawn reviewer --name code-checker    # 覆盖显示名称
/collab spawn reviewer --model openai/gpt-5   # 覆盖模型
/collab templates                             # 列出所有模板
```

---

## 能力广播

每个 peer 自动发布能力——**活跃工具名** + **手动标签**：

```bash
# 手动标签
PI_COLLAB_CAPABILITIES="code-review,typescript,security" pi -e pi-collab
```

能力标签出现在：
- `/collab status` 输出
- `broadcast_to_colleagues` 结果
- probe 的 `capability` 过滤条件

---

## Peer 状态 Widget

编辑器上方实时显示 mesh 状态：

```
── Peers ──
● architect (me)  claude-sonnet-4
◉ reviewer        gpt-5.2          ← 忙碌
● dev             deepseek-v3
```

图标：`● 空闲`（绿）、`◉ 忙碌`（黄）、`○ 不可达`（灰）。

widget 在 turn 边界 + 心跳间隔（5s）刷新，新 peer 自动出现。远程 peer 只在
隧道活跃时显示（死条目不刷屏）。

---

## 跨主机协作（SSH）

通过 SSH 把远程 peer 的 Unix socket 转发到本地（`ssh -L`），协议和工具零改动。

### 前提条件

1. **本机**：OpenSSH 6.7+（Unix socket 转发）——Linux/macOS
2. **SSH 密钥认证**：密码提示已被禁用（会破坏 TUI），必须配密钥：

```bash
# 本机生成密钥（如果还没有）
ssh-keygen -t ed25519

# 把公钥复制到远程
ssh-copy-id <远程用户>@<远程主机>

# 验证免密登录（不需要密码即成功）
ssh <远程用户>@<远程主机> "echo ok"
```

3. **远程**：机器上运行着带 pi-collab 的 pi，且 peer 已注册

### 注册远程 peer

**单个注册：**
```
/collab remote add reviewer <远程用户>@<远程主机>
```

**批量注册（不带名字 = 注册远程所有 peer）：**
```
/collab remote add <远程用户>@<远程主机>
```

批量模式列出远程注册表，逐个添加 + 建立隧道，逐个报告成功/失败：

```
Remote sync from user@host: 2 added, 1 failed. Failed: dev
```

### 双向注册（推荐）

默认是**单向**的：谁 add 谁就能联系对方。要双方互相可见、互相联系，
用 `add-both`：

```
/collab remote add-both <本机用户>@<本机地址> <远程用户>@<远程主机>
```

流程：
1. 注册远程所有 peer 到本机
2. 把**本机 peer 的记录**通过 SSH 写入远程的 `~/.pi/collab/remotes/`
3. 远程 `/collab list` 立即可见本机，也能 delegate 给本机

> **注意：** 反向联系要求远程机器也能免密 SSH 回本机（本机要开 sshd、
> 地址对远程可达）。如果本机在 NAT 后面无公网地址，反向不通——这是网络
> 环境限制，需等 Phase 2 的 WebSocket relay。

### 管理远程 peer

```
/collab remote list              # 查看远程 peer + 隧道状态
/collab remote refresh <name>    # 重新拉取记录（远程重启后 token/路径变了）
/collab remote remove <name>     # 删除条目并关闭隧道
/collab remote prune             # 清理所有无活跃隧道的条目
/collab stop <name>              # 对远程 peer 同样有效
```

### 常见问题

**"SSH key auth failed"** → 没配密钥。按上面 `ssh-keygen` + `ssh-copy-id` 配置。

**"remote peer not found"** → 远程机器上 pi-collab 没跑，或 peer 没注册。
先在远程 `/collab list` 确认。

**"tunnel not functional"** → 远程 socket 不存在或隧道建立失败。
确认远程 peer 在线，然后 `/collab remote refresh <name>`。

**远程重启后连不上** → peer 重启会生成新 token/路径。`/collab remote refresh <name>`。

---

## 认证机制

每个 peer 启动时生成 256-bit 随机 token，存在注册表文件
`~/.pi/collab/peers/by-id/<peerId>.json`。连接时调用方必须先出示目标 peer
的 token（`auth` envelope）。能读到该文件 = 同用户进程 = 信任。

- **ping 豁免认证**（纯连通性检测）
- 其他所有消息（request、probe）必须先认证
- `/collab token` 显示当前 peer 的 token，仅分享给信任的 peer
- 远程 peer 的 token 通过 SSH 拉取（SSH 本身已认证）

---

## 环境变量

| 变量 | 默认值 | 说明 |
|------|--------|------|
| `PI_COLLAB_NAME` | `peer-<pid>` | peer 显示名称 |
| `PI_COLLAB_SYSTEM_PROMPT` | 无 | 附加系统提示 |
| `PI_COLLAB_MODEL` | 无 | 模型，如 `anthropic/claude-sonnet-4-20250514` |
| `PI_COLLAB_CAPABILITIES` | 无 | 手动能力标签，逗号分隔 |
| `PI_COLLAB_MAX_TURNS` | `20` | 委托任务最大 turn |
| `PI_COLLAB_CONVERSATION_TIMEOUT_MS` | `120000` | 对话超时（毫秒） |
| `PI_COLLAB_HEARTBEAT_INTERVAL_MS` | `5000` | 心跳间隔（毫秒） |
| `PI_COLLAB_DIR` | `~/.pi/collab` | 数据目录（覆盖默认路径） |

---

## 错误处理

所有错误带结构化错误码 + LLM 可执行提示：

| 错误码 | 含义 | 提示 |
|--------|------|------|
| `peer_not_found` | 名字不在注册表 | 用 `/collab list` 看可用的 peer |
| `peer_unreachable` | peer 离线或隧道不通 | 清理后重试或 refresh |
| `peer_busy` | 正在处理其他请求 | 稍等重试或换人 |
| `auth_failed` | token 不匹配 | 远程重启过，用 refresh |
| `timeout` | 处理超时 | 拆分任务或增加 maxTurns |
| `cancelled` | 用户取消了 | 重试即可 |

TUI 显示简短标签，LLM 看到完整 hint。

---

## 平台支持

| 平台 | 本地传输 | 远程传输 |
|------|---------|---------|
| Linux / macOS | Unix domain socket | SSH Unix socket 转发 |
| Windows 10+ (17063+) | Windows named pipe | 暂不支持（等 WebSocket relay） |

---

## 文件结构

```
extensions/pi-collab/
├── index.ts              # 扩展入口：工具/命令/事件/网络
├── types.ts              # 类型定义
├── config.ts             # 环境变量解析
├── errors.ts             # CollabError 结构化错误
├── agent-context.ts      # agent loop 桥接（injectTask/agent_settled）
├── colleagues.ts         # 同事模板系统
├── protocol/
│   ├── envelope.ts       # JSONL 信封编解码
│   └── conversation.ts   # 会话状态机
├── transport/
│   ├── index.ts          # PeerTransport 接口
│   ├── unix-socket.ts    # Unix socket / named pipe
│   ├── ssh.ts            # SSH 隧道 + 密钥预检
│   └── paths.ts          # 跨平台路径
└── discovery/
    ├── registry.ts       # 本地文件系统注册表
    └── remotes.ts        # 远程 peer 缓存
```

数据目录 `~/.pi/collab/`：

```
~/.pi/collab/
├── peers/
│   ├── by-id/<peerId>.json    # peer 记录（含 token、能力）
│   └── by-name/<name>.json    # 名字 → peerId 映射
├── remotes/<name>.json        # 远程 peer 缓存（SSH）
└── socks/<peerId>.sock        # Unix socket（Linux/macOS）
```

---

## 限制（Phase 1）

- `delegate_to_colleague` 是阻塞式：同事的提问通过自然语言在结果中异步回答
- 无中心注册表：跨主机发现靠 SSH 手动注册（`remote add` / `add-both`）
- 同一时间只能处理一个入站请求（`pendingTask` 单槽位，并发请求排队）
- Windows 暂不支持 SSH 远程传输
- 后续计划：WebSocket relay（跨 NAT 无需公网地址）、非阻塞委托
