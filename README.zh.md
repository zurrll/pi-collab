# pi-collab

pi 多 Agent 协作扩展。让同一主机上的多个 pi 实例互相通信、协同解决任务。

## 安装

```bash
pi install ./path/to/pi-collab
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
| `/collab spawn <name>` | 启动一个无头 peer，注册到文件系统 |
| `/collab list` | 列出所有已注册 peer，含名称、状态、模型 |
| `/collab stop <name>` | 从注册表删除指定 peer |
| `/collab rename <name>` | 重命名当前 peer |
| `/collab status [name]` | 查看 peer 详细信息（不含 auth token） |
| `/collab delegate <name> <task>` | 手动委托任务给同事（不经过 LLM 中转，直接发 request） |
| `/collab token` | 显示当前 peer 的认证 token（仅分享给信任的 peer） |

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
Protocol 层  (auth, request, response, question, answer, probe, ping, pong)
    ↓
Auth 层      (token 验证，文件系统信任锚)
    ↓
Agent Bridge (injectTask, agent_settled 捕获)
    ↓
Tool 层      (delegate, broadcast, review, ask_colleague)
```

Probe 消息在 Transport 层 OOB 处理——不进入 LLM 上下文窗口，peer 发现零消耗。

## 限制（Phase 1）

- 仅同主机
- `delegate_to_colleague` 是阻塞式；同事的提问通过自然语言在返回结果中异步回答（下一轮），而非同步
- 消息来源标注是文本级别而非协议级别（通过强 ASCII 框标记缓解）
- peer 之间无工具集同步
