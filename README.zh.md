# pi-collab

pi 多 Agent 协作扩展。让同一主机上的多个 pi 实例互相通信、协同解决任务。

## 安装

```bash
# npm 安装
pi install npm:pi-collab

# GitHub 安装
pi install git:github.com/zurrll/pi-collab@v0.1.0
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
| `broadcast_to_colleagues` | 探测所有在线的 peer 状态（OOB 探测，零上下文消耗） |
| `review_by_colleague` | 请同事审查代码或设计，返回结构化反馈 |
| `ask_colleague` | （供被委托方使用）处理任务时向委托方回问澄清问题 |

每个工具都包含 `promptSnippet` 和 `promptGuidelines`，让 LLM 更准确地判断何时使用。
工具还带有自定义 TUI 渲染（`renderCall` / `renderResult`），展示同事名称、任务预览、
token 用量和可展开的详情。

### 多轮讨论

调用 `delegate_to_colleague` 时传入 `conversationId`（任意短字符串，如 `"auth-refactor"`）。
同事的 session 在多次调用之间保持——他们能看到完整历史。用同一个 ID 持续调用，直到讨论结束。

```
第一轮: delegate_to_colleague { colleague: "reviewer", task: "...", conversationId: "auth-refactor" }
第二轮: delegate_to_colleague { colleague: "reviewer", task: "...", conversationId: "auth-refactor" }
```

### 消息标注

注入到同事 Agent loop 中的任务会带有醒目的 ASCII 框头，明确标注
"INCOMING TASK FROM COLLEAGUE AGENT"，并附 6 条规则：这是同事的委托而非用户指令、
回复会发给同事而非用户、不要客套话、不要签名。防止 LLM 将同事消息与用户提示混淆。

## 命令

| 命令 | 说明 |
|------|------|
| `/collab spawn <name\|template>` | 启动无头 peer。如果名称匹配同事模板，自动加载其 model/prompt。支持 `--model`、`--prompt`、`--name` 参数。 |
| `/collab list` | 列出所有已注册 peer，含名称、状态、模型 |
| `/collab stop <name>` | 从注册表删除指定 peer |
| `/collab rename <name>` | 重命名当前 peer |
| `/collab status [name]` | 查看 peer 详细信息（不含 auth token） |
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
/collab spawn reviewer                      # 使用模板的 model + system prompt
/collab spawn reviewer --name code-checker  # 覆盖显示名称
/collab spawn reviewer --model openai/gpt-5 # 覆盖模型
/collab templates                           # 列出所有可用模板
```

## Peer 状态 Widget

编辑器上方显示当前 mesh 状态，实时更新：

```
── Peers ──
● architect (me)  claude-sonnet-4
◉ reviewer        gpt-5.2          ← 忙碌中
● dev             deepseek-v3
```

状态图标：`● 空闲`（绿色）、`◉ 忙碌`（黄色）、`○ 不可达`（灰色）。

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
| Windows 10+ (Build 17063+) | Windows named pipe |

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
Tool 层      (delegate, broadcast, review, ask_colleague) + Colleague 模板
    ↓
TUI 层       (peer 状态 widget, 自定义工具渲染)
```

Probe 消息在 Transport 层 OOB 处理——不进入 LLM 上下文窗口，peer 发现零消耗。

## 限制（Phase 1）

- 仅同主机
- `delegate_to_colleague` 是阻塞式；同事的提问通过自然语言在返回结果中异步回答（下一轮），而非同步
- 消息来源标注是文本级别而非协议级别（通过强 ASCII 框标记缓解）
- peer 之间无工具集同步
- 同一时间只能处理一个入站请求（`pendingTask` 单槽位；并发请求通过 socket accept 排队）
