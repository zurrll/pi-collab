# pi-collab 设计与实现

多 Agent 协作扩展的完整设计文档。覆盖设计理念、架构分层、协议细节、
关键决策、功能清单和已知限制。

---

## 一、项目概述

pi-collab 是 pi 的多 Agent 协作扩展。让同一主机上的多个 pi 实例以**对等节点**
方式互相通信、委派任务、协同解决复杂问题。纯 Extension API 实现，对 pi 核心零侵入。

### 与 subagent 的区别

| | subagent | pi-collab |
|---|---|---|
| 进程生命周期 | 每次调用 spawn，任务完成即退出 | 持久 peer，跨 turn 存活 |
| 通信 | 单向 stdin/stdout JSONL | 双向 Unix socket JSONL |
| 身份 | 匿名一次性调用 | 命名、可发现、持久 |
| 多轮 | 单次输入→输出 | 多轮讨论（conversationId） |
| 认证 | 无 | 256-bit token 认证 |

pi-collab 不是 subagent 的替代，而是持久化双向通用化版本。

---

## 二、借鉴来源

### subagent 扩展
- 进程隔离：每个 Agent 独立进程，独立上下文窗口
- JSONL 通信模式
- Agent 发现：从静态配置文件升级为动态注册表
- `getPiInvocation()`：开发/生产环境兼容的进程启动

### orchestrator
- Unix socket JSONL 协议：transport 层 1:1 复用
- 跨平台路径处理：`transport/paths.ts`

### RPC Mode
- `pi.sendUserMessage()` + `agent_settled` 模式实现"内部 RPC"
- `extension_ui_request` 子协议启发 OOB probe/ping 机制

### ssh 扩展
- Transport 接口可替换：Phase 2 换 WebSocket 只需写新实现

---

## 三、设计理念

### 3.1 Agent 是对等节点

- 无中心调度器
- 每个 peer 既是 client 也是 server
- 任何 Agent 都可向任何其他 Agent 发起请求
- 发现是去中心化的（文件系统注册表）

### 3.2 分层可替换

```
┌──────────────────────────────────────────────┐
│  TUI 层     peer 状态 widget, 工具渲染       │
├──────────────────────────────────────────────┤
│  Tool 层    delegate, broadcast, review,     │
│             ask_colleague + Colleague 模板   │
├──────────────────────────────────────────────┤
│  Protocol 层  envelope, conversation 状态机  │
├──────────────────────────────────────────────┤
│  Auth 层    token 验证（文件系统信任锚）      │
├──────────────────────────────────────────────┤
│  Transport 层  Unix socket / named pipe      │
├──────────────────────────────────────────────┤
│  Discovery 层  文件系统注册表                │
└──────────────────────────────────────────────┘
```

每层可独立替换。Phase 2 换 Transport + Discovery 即可跨主机，上层零改动。

### 3.3 OOB 优先

发现/探测操作（probe/ping/pong）在 transport 层直接处理，**不进入 LLM 上下文**，
零 token 消耗。

### 3.4 最小可行 Agent 桥接

pi 的 Extension API 不提供同步"注入任务并等待结果"。桥接层用一个模块级
`pendingTask` + `agent_settled` 监听器实现 Promise 配对：

```typescript
let pendingTask: PendingTask | undefined;

pi.on("agent_settled", (_event, ctx) => {
  if (!pendingTask) return;
  if (pendingTask.activeAskCount > 0) return;  // question 往返中不 resolve
  const text = extractNewAssistantText(ctx);
  pendingTask.resolve(text);
  pendingTask = undefined;
});

function injectTask(prompt, askQuestion, timeoutMs) {
  return new Promise((resolve, reject) => {
    // 包装 askQuestion 跟踪 activeAskCount
    pendingTask = { resolve, reject, askQuestion: wrapped, activeAskCount: 0 };
    pi.sendUserMessage(prompt);
  });
}
```

### 3.5 文件系统信任锚（认证）

Peer 的 auth token 存储在 `~/.pi/collab/peers/by-id/<uuid>.json`。
该文件仅同用户可读。任何能出示正确 token 的进程证明它有该文件的读权限 →
同用户进程。单机上不依赖 PKI 的最强认证。

### 3.6 错误 LLM 友好化

所有错误使用结构化 `CollabError`，携带稳定错误码和 LLM 可执行提示：

| 错误码 | LLM 提示 |
|--------|---------|
| `peer_not_found` | 用 `/collab list` 看可用的 peer |
| `peer_unreachable` | 对方可能已崩溃，cleanup 后重试 |
| `peer_busy` | 稍等或换人 |
| `auth_failed` | 对方已重启，需要新 token |
| `timeout` | 拆分任务或增加 maxTurns |
| `cancelled` | 用户取消了，重试即可 |

---

## 四、核心架构

### 4.1 Transport 层（`transport/`）

```typescript
interface PeerTransport {
  connect(peer: { socketPath, peerId }): Promise<PeerConnection>;
  listen(socketPath): Promise<PeerListener>;
  ping(socketPath, timeoutMs): Promise<boolean>;
}

interface PeerConnection {
  send(envelope): Promise<void>;
  receive: AsyncIterable<Envelope>;
  close(): Promise<void>;
}
```

`QueueConnection` 用 promise 队列读 JSONL 行，天然支持背压。
同一实现覆盖 Unix domain socket 和 Windows named pipe——Node.js `net` 模块
对两者使用相同 API，仅路径格式不同。

### 4.2 Auth 层

每个 peer 启动时生成 256-bit 随机 token（hex 64 字符），写入 PeerRecord。

**认证流程：**

```
Caller: 读 target PeerRecord → 获得 authToken
  → connect → 第一条消息: auth { token, peerId }

Target: 和本地 authToken 比对
  → 匹配 → auth_result { ok: true } → 继续正常消息
  → 不匹配 → auth_result { ok: false, reason } → 关闭连接
```

**ping 豁免认证**（纯连通性检测）。

**Token 可见性**：`/collab list` 和 `/collab status` 不显示 token。
仅 `/collab token` 显示完整 token（带安全警告）。

### 4.3 Protocol 层（`protocol/`）

**Envelope 结构：**

```typescript
interface Envelope {
  v: "1";                  // 协议版本
  id: string;              // 消息 UUID
  source: string;          // 发送者 peer ID
  target: string;          // 接收者 peer ID
  conversationId: string;  // 会话 ID
  type: "auth" | "auth_result" | "request" | "response"
      | "question" | "answer" | "error" | "ping" | "pong"
      | "probe" | "probe_response";
  inReplyTo?: string;
  payload: Payload;
}
```

**服务端路由：**

```
handleInboundConnection():
  读第一个 envelope →
    ping    → [豁免] 回复 pong
    auth    → 验证 token →
               通过后读第二条消息:
                 probe   → [OOB] handleProbe() → 能力匹配 → probe_response
                 request → handleInboundConversationPreRead() →
                             injectTask → agent loop → response
   其他     → [拒绝] 必须先 auth
```

### 4.4 Discovery 层（`discovery/registry.ts`）

文件系统注册表，无锁设计：

```
~/.pi/collab/peers/
├── by-id/<uuid>.json       # 完整 PeerRecord（含 authToken, capabilities）
└── by-name/<name>.json     # { "peerId": "..." }
```

- **写入**：原子写（temp file + rename），避免读撕裂
- **清理**：stale peer（30s 无心跳）自动 prune
- **跨平台**：Linux/macOS 用 `.sock` 文件，Windows 用 named pipe（无文件）

**PeerRecord 字段：**

```typescript
interface PeerRecord {
  peerId: string;          // UUID
  name: string;            // 人类可读名称
  socketPath: string;      // socket 路径
  pid: number;
  cwd: string;
  model: string;           // 如 "anthropic/claude-sonnet-4-20250514"
  status: "idle" | "busy" | "unreachable";
  capabilities?: string[]; // 工具名 + 手动标签
  registeredAt: string;    // ISO 8601
  lastHeartbeatAt: string; // ISO 8601
  authToken?: string;      // 256-bit hex
}
```

### 4.5 Agent Bridge 层（`agent-context.ts`）

```typescript
setup(pi): void                                    // 注册 agent_settled
injectTask(prompt, askQuestion, timeout): Promise<string>  // 注入任务
getActiveAskQuestion(): ((q) => Promise<string>) | undefined  // ask_colleague 用
```

**并发安全：** `activeAskCount` 计数器防止 `agent_settled` 在 question/answer 往返
中错误 resolve。`ask_colleague` 工具调用时计数器 +1，返回时 -1。

### 4.6 Tool 层

| 工具 | 角色 | 说明 |
|------|------|------|
| `delegate_to_colleague` | 调用方 | 认证→连接→runConversation→阻塞等待 response |
| `broadcast_to_colleagues` | 调用方 | 遍历 peer→probePeer(OOB 过滤)→返回列表+能力 |
| `review_by_colleague` | 调用方 | 包裹审查 prompt 模板，同 delegate |
| `ask_colleague` | 被调用方 | 仅在 inbound request 上下文有效，调 askQuestion 回调 |

每个工具包含：
- `promptSnippet` / `promptGuidelines`：LLM 系统提示中的使用指南
- `renderCall` / `renderResult`：TUI 自定义渲染（名称、预览、用量、展开详情）

### 4.7 TUI 层

**Peer 状态 Widget**（编辑器上方）：

```
── Peers ──
● architect (me)  claude-sonnet-4
◉ reviewer        gpt-5.2          ← 忙碌
● dev             deepseek-v3
```

更新时机：turn 边界 + 心跳间隔（每 5s），新 peer 自动出现。

**工具渲染**：折叠态显示简摘要，展开态显示完整结果 + token 用量。

### 4.8 Colleague 模板（`colleagues.ts`）

可复用的 peer 配置，`.md` 文件 + frontmatter：

```markdown
---
name: reviewer
description: 代码审查者
model: anthropic/claude-sonnet-4-20250514
tools: read, bash, edit, write, grep, find, ls
---

你是代码审查者...
```

**位置**：`~/.pi/agent/colleagues/`（全局）或 `.pi/colleagues/`（项目级）。
项目模板覆盖同名全局模板。

**使用**：`/collab spawn reviewer` 自动加载模板的 model + system prompt + tools。

### 4.9 能力广播

每个 peer 自动聚合能力标签：
- **自动**：`pi.getActiveTools()` 获取所有活跃工具名
- **手动**：`PI_COLLAB_CAPABILITIES="code-review,security"`

合并后写入 `PeerRecord.capabilities`。`broadcast_to_colleagues { capability: "security" }`
在 probe 时做关键词匹配，只返回匹配的 peer。`/collab status` 和广播结果中展示能力列表。

---

## 五、通信协议详解

### 5.1 完整 delegate 流程

```
Agent A (调用方)                          Agent B (被调用方)
     │                                          │
     │ 1. resolveName("reviewer")               │
     │    → 读取 PeerRecord → 获得 authToken    │
     │                                          │
     │ 2. connect(socketPath)                   │
     │ ──────────────────────────────────────►  │
     │                                          │
     │ 3. auth { token }                        │
     │ ──────────────────────────────────────►  │ 验证 token
     │ ◄──────────────────────────────────────  │ auth_result { ok: true }
     │                                          │
     │ 4. request { operation, task }           │
     │ ──────────────────────────────────────►  │ 5. handleRequest()
     │                                          │    → getPeerById(source) → 获取调用方名称
     │                                          │    → buildTaskPrompt(payload, callerName)
     │                                          │    → injectTask(taskPrompt, askQuestion)
     │                                          │    → pi.sendUserMessage(taskPrompt)
     │                                          │
     │                                          │ 6. [Agent loop 处理]
     │                                          │    可调用 ask_colleague →
     │                                          │    askQuestion() →
     │                                          │    send question →
     │                                          │    ← onQuestion 回 stock answer
     │                                          │
     │                                          │ 7. agent_settled → resolve(text)
     │                                          │
     │ ◄──────────────────────────────────────  │ 8. response { result, usage }
     │                                          │
     │ 9. close()                               │
```

### 5.2 Probe 流程（OOB）

```
Agent A                          Agent B
     │                              │
     │ 1. connect → auth            │
     │ ────────────────────────────►│ 验证
     │ ◄────────────────────────────│ auth_result ok
     │                              │
     │ 2. probe { capability? }     │
     │ ────────────────────────────►│ 3. handleProbe(OOB!)
     │ ◄────────────────────────────│ probe_response { matched, peer, capabilities }
     │                              │
     │ 全程不碰 LLM                 │
```

---

## 六、命令清单

| 命令 | 说明 |
|------|------|
| `/collab spawn <name\|template>` | 启动无头 peer。支持 `--model`、`--prompt`、`--name`、`--tools` |
| `/collab list` | 列出所有已注册 peer |
| `/collab status [name]` | 详细信息（含能力标签，不含 token） |
| `/collab stop <name>` | 删除注册。对自己：完全下线（关 listener + 停心跳） |
| `/collab start` | 重新上线当前 peer（注册+绑 socket+启心跳） |
| `/collab rename <name>` | 重命名 |
| `/collab delegate <name> <task>` | 手动委托（不经过 LLM） |
| `/collab templates` | 列出同事模板 |
| `/collab token` | 显示 auth token（带安全警告） |

所有命令支持 Tab 补全。

---

## 七、环境变量

| 变量 | 说明 |
|------|------|
| `PI_COLLAB_NAME` | Peer 显示名称（默认 `peer-<pid>`） |
| `PI_COLLAB_SYSTEM_PROMPT` | 额外系统提示 |
| `PI_COLLAB_MODEL` | 模型（如 `anthropic/claude-sonnet-4-20250514`） |
| `PI_COLLAB_CAPABILITIES` | 手动能力标签（逗号分隔） |
| `PI_COLLAB_MAX_TURNS` | 委托任务最大 turn（默认 20） |
| `PI_COLLAB_CONVERSATION_TIMEOUT_MS` | 对话超时（默认 120000） |
| `PI_COLLAB_HEARTBEAT_INTERVAL_MS` | 心跳间隔（默认 5000） |
| `PI_BINARY` | pi 可执行文件路径（spawn 用） |

---

## 八、文件结构

```
pi-collab/
├── extensions/pi-collab/
│   ├── index.ts              # 扩展入口：工具/命令/事件/networking
│   ├── types.ts              # 所有类型定义
│   ├── config.ts             # 环境变量解析
│   ├── errors.ts             # CollabError 结构化错误
│   ├── agent-context.ts      # Agent loop 桥接（injectTask / agent_settled）
│   ├── colleagues.ts         # 同事模板系统
│   ├── protocol/
│   │   ├── envelope.ts       # JSONL envelope 编解码
│   │   └── conversation.ts   # 对话状态机
│   ├── transport/
│   │   ├── index.ts          # PeerTransport 接口
│   │   ├── unix-socket.ts    # Unix socket / named pipe 实现
│   │   └── paths.ts          # 跨平台路径
│   └── discovery/
│       └── registry.ts       # 文件系统注册表
├── package.json
├── README.md / README.zh.md
└── VERIFICATION.md
```

---

## 九、已知限制（Phase 1）

| 限制 | 说明 | 缓解措施 |
|------|------|---------|
| 仅同主机 | Transport + Discovery 限于单机 | Phase 2: WebSocket + Radius |
| 阻塞 delegate | 同事的提问通过自然语言异步回答 | `/collab delegate` 手动模式 |
| 文本级消息标注 | 来源是 prompt 文字而非 protocol 字段 | 强 ASCII 框 + 调用方名称 |
| 无工具集同步 | peer 不知道对方的工具列表 | 能力广播（自动工具名 + 手动标签） |
| 单入站请求 | `pendingTask` 单槽位 | 并发请求通过 socket accept 排队 |

---

## 十、未来方向（Phase 2+）

| 特性 | 描述 |
|------|------|
| 跨主机通信 | WebSocket transport + Radius 服务发现 |
| 非阻塞 delegation | `pi.sendUserMessage(msg, { deliverAs: "steer" })` |
| 对话持久化 | 协议层 message 记录到 disk |
| 跨 session 持久 peer | `/collab spawn` 的进程完全独立于父 session |
| delegate 超时自动重试 | 指数退避 + 重试次数配置 |
