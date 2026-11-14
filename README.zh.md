# dsh-pi-loop

[English](README.md) | 中文 | [Português (BR)](README.pt-BR.md) | [日本語](README.ja.md) | [Español](README.es.md)

> **Note:** this translation follows an older revision of the README; the canonical text is [README.md](README.md).

把 [Pi coding agent](https://github.com/earendil-works/pi)（npm 包 [`@earendil-works/pi-coding-agent`](https://www.npmjs.com/package/@earendil-works/pi-coding-agent)）作为 agent loop 跑在 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)（npm 包 [`@deepseek-ai/dsh`](https://www.npmjs.com/package/@deepseek-ai/dsh)）里：一个 DSH `Agent` 插件，驱动无头模式的 `pi --mode rpc` 子进程，DSH 前端（会话日志、hooks、preset、Web UI）无需任何改动即可使用。

> **在找以下任何一个？**
> - *“怎么在 DeepSeek Harness / DSH 里用 pi？”* —— 来对地方了。
> - *“把 DSH 的 agent-loop 换成 pi coding agent 的 loop？”* —— 本插件用 `pi --mode rpc` 子进程替换工厂。
> - *“给 pi 配一个 Web UI / 浏览器前端？”* —— dsh-pi-loop + 官方 DSH web app 给 pi 完整的 Web 界面：会话持久化、hooks、preset、模型切换。
> - *“在 DSH 里用极简纯净的提示词？”* —— pi 引擎保持 ~300 token 系统提示词和四工具，DSH 的提示词组装永远到不了模型面前。零提示词注入。
> - *“DSH 里能不能像接 Claude Code / Codex 那样接 pi？”* —— 可以，本插件就是把 pi 加为同等的引擎选项。

```
DSH 前端（会话、hooks、preset、SQLite 持久化、Web UI）
        │
dsh-pi-loop（本插件：AgentFactory + 事件翻译 + 历史衔接）
        │  spawn 子进程 + stdio 上的 JSONL 协议
        │  命令：set_model / prompt / steer / abort
        ▼
pi --mode rpc --session <重建的历史>（原汁原味的 Pi agent loop）
```

每次 create/resume 时，插件都会从 DSH 的持久化事件日志重建 Pi 会话文件并用 `--session` 启动子进程——新子进程的上下文窗口里已经装着完整对话，包括切换前在 DSH 原生 loop 下跑的轮次（见[中途衔接](#中途衔接)）。

## 为什么

Pi 是一个极简 harness：~300 token 的系统提示词、四个工具（`read`/`bash`/`edit`/`write`）、会话中途零注入。DSH 是一个插件化平台：持久会话、策略、审批链和完整的提示词组装注册表。

本插件让你同时拥有两者：**DSH 的工程外壳 + Pi 的纯净内核**。插件激活时，模型看到的内容与在同一目录直接运行 `pi` 完全一致——没有额外的提示词段落、没有额外的工具、没有隐藏的 reminder。DSH 自己的提示词组装（`dsh-system-prompt`）和工具面在由此工厂驱动的会话中被完全绕过。

它同时是一个干净的 A/B 实验：同一前端、同一会话格式，开关本插件即可对比 DSH 原生 loop 与裸 Pi loop 的表现。

## 改变与不改变

| 层面 | 行为 |
| --- | --- |
| 系统提示词 / 工具 / 上下文 | **原封不动**——与在同一目录运行 `pi` 完全一致（`AGENTS.md` 等上下文文件由 Pi 自行加载） |
| 模型路由 | 每会话 `set_model`；被委派的 subagent 请求的模型优先于工厂默认值。只给模型不给 provider 时借用默认的 provider——provider 位永远不会拿到模型 id。Pi 拒绝的路由会让该轮明确失败，而不是悄悄跑在 Pi 的默认模型上 |
| 多个模型 | 会话跑在前端选择器里选定的模型上（`pinModel: false`）。DSH 的 provider 名与 Pi 的 provider 名相同，所以路由不需转换就能跨过进程边界；harness 自己的 `deepseek-official` 路由映射到 Pi 的 `deepseek` provider。DSH 配置声明的网关（`tencent`、`bailian-tpp`）需要在 Pi 的模型配置里有同样的端点 —— `node tools/sync-pi-providers.mjs <profile>` 会写入 |
| 转向（steering） | DSH 的 `send(..., 'next-turn' \| 'next-step')` 映射为 Pi 的 `steer`——可在运行中途插入指令，且指令只会被投递一次；Pi 从未注入的一批会被取回，作为独立的一步交付，而不是被丢弃 |
| 队列 | 前端的队列面板读取 `inbox` 会话投影，该投影本属于原生 loop；Pi loop 自己注册它，因此排队项和转向项始终可见 |
| 会话持久化 | DSH 的会话事件始终是持久化的唯一事实源；每次 create/resume 都从它重建 Pi 会话文件，子进程启动即带完整历史。重建遵守字节预算（`contextBudgetBytes`，默认 1 MB）：较旧的消息会被丢弃，就像 native loop 的压缩那样，且工具结果绝不会比它所回应的工具调用活得更久 |
| 模型失败 | 提供方拒绝调用时（上下文窗口放不下、请求被拒），会在实时边界上报并以错误原因结束该轮——绝不会变成一条空回复 |
| 审批 / 权限 | 适用 Pi 的本地信任模型——Pi 的工具调用不经过 DSH 的审批链 |
| 回退 | 禁用本插件条目，DSH 自己的 `dsh-agent-loop` 立即恢复生效 |

## 边界映射

桥接层把 Pi 的内部结构翻译到 DSH 的轮次/步骤模型：

| DSH | Pi |
| --- | --- |
| 一个 turn | 一条 `prompt` 命令（一次 Pi run） |
| 一个 step | 一条 assistant 消息（一次模型调用 + 它请求的工具执行） |
| step 边界 | Pi 的 `turn_end` 事件（该轮 assistant 回复结束） |
| next-step 输入 | Pi 的 `steer` 命令（在下一次 LLM 调用前送达） |

一个 turn 在 Pi 报告 `agent_settled` 时关闭——而不是 `agent_end`，后者只结束一次底层 run，重试、压缩恢复和排队任务都可能紧随其后。

## DSH agent hooks

插件实现了前端与策略链依赖的 agent 事件：

| 事件 | 行为 |
| --- | --- |
| `agent/status` | `idle` ⇄ `running`，每次切换都会镜像 |
| `agent/inbox/inserted` / `claimed` / `discarded` | 待处理输入进入步骤时被 **claim**（绝不会记成取消） |
| `agent/pre-step` | 每个 step 前派发；`reject` 会封掉该 turn（`turn/end` 原因为 `blocked`），且不会向 Pi 发 prompt |
| `agent/turn-stopping` | 在 turn 的停止边界派发；在那里注入的转向会在同一 turn 内再跑一个 step |
| `agent/session-start` | 新会话为 `source: 'startup'`，从持久化恢复为 `'resume'` |
| `agent/error` | 在存活边界上报；turn 仍以 error 原因关闭 |

有两个 agent 事件 **不会** 派发，因为它们的语义无法跨进程边界成立：`agent/request` 与 `agent/request-error` 包裹的是模型调用本身，而模型调用发生在 Pi 子进程内部。需要影响模型调用的监听方应改用 Pi 自己的扩展。

## 中途衔接

会话不一定要“出生在 Pi 下”才能被 Pi 驱动。如果某个会话已经在 DSH 原生 loop 下跑了几轮（或在一个更早的 Pi 子进程下跑过），通过本插件恢复它就能无缝续接：DSH 的事件日志（`user/message`、`assistant/message`、`tool/call`、`tool/result`）会被转换成 Pi 会话文件，新子进程用 `--session` 加载它——完整历史（包括切换前 DSH 原生轮的对话）直接进入上下文窗口。

- DSH 始终是唯一事实源；Pi 文件只是重建的快照，每次 create/resume 重新生成（无漂移、无重复）。
- DSH 消息块原生映射：`text` → `text`、`reasoning` → `thinking`、`tool-call` → `toolCall`（arguments 重新解析）、`tool/result` → `toolResult`（工具名从调用日志恢复）。
- 图片块当前跳过（attachment 引用需要运行时附件服务）；文本历史足以承载上下文。
- 重建后的文件保持稳定的会话身份（由 DSH 会话 id 推导），因此衔接是“续写”而不是“另起一个会话”。
- 会话文件落在 `~/.dsh/pi-sessions/<session-id>.jsonl`，便于审计。

```
DSH 标准模式：  第 1 轮 ── 第 2 轮 ── 第 3 轮        （原生 loop）
                                    │
        通过本插件 resume ─────────┘  从 DSH 日志重建 Pi 会话
                                    ▼
Pi 模式：         [历史已加载] ── 第 4 轮 ── …  （Pi loop，完整上下文）
```

## Subagent 也走 Pi

与主 loop 分离配置：provider 插件是独立的 profile 行，两个引擎可独立开关——主 loop 用 pi + sub 用原生、主 loop 用原生 + sub 用 pi、或两者都用 pi，任意组合。

```yaml
# Subagent 委派走 Pi 引擎（与主 loop 行互不影响）：
- insert:
    - id: subagent-pi
      name: 'dsh-pi-loop/subagent'
      config:
        providerName: pi
        piPath: 'pi'                  # 默认从 PATH 查找
        model: 'provider/model'      # 省略则用 pi 自己配置的默认模型
        timeoutMs: 600000

    - id: tool-subagent
      name: '@deepseek-ai/dsh-tool-subagent'
      config:
        provider: pi                  # 换回 'spawn'/'fork' 即 DSH 原生子代理
        toolName: subagent
        backgroundMode: one-shot
        maxDepth: 'provider-managed'
```

每次委派在父会话的工作目录里 spawn 一个全新的 `pi -p <任务>`：纯 Pi 系统提示词、自己的工具、自己发现 `AGENTS.md`。父会话的对话、人格、工具面一概不出进程边界——`inheritsParentContext: false`，零提示词碰撞。

## 依赖

- Node.js ≥ 20
- [`pi`](https://www.npmjs.com/package/@earendil-works/pi-coding-agent)（`npm i -g @earendil-works/pi-coding-agent`）在 `PATH` 上（或传入 `piPath`）
- [DSH](https://www.npmjs.com/package/@deepseek-ai/dsh)（`npm i -g @deepseek-ai/dsh`），profile 需暴露 `sessions` 与 `agents` 服务（标准前端装配）
- peer 依赖：`@deepseek-ai/cordis`、`@deepseek-ai/dsh-agent`、`@deepseek-ai/dsh-llm`、`@deepseek-ai/dsh-scope`、`@deepseek-ai/dsh-session`

## 安装

```bash
# 链接本地工作树：profile 始终运行你的检出（重新构建后重启 DSH 即可）。这是开发用的方式。
dsh plugin --profile desktop add link:/path/to/dsh-pi-loop

# 或安装目录副本（等同于 npm pack 的产物）。
dsh plugin --profile desktop add file:/path/to/dsh-pi-loop
```

该包不在 npm registry 上——此前发布的 `dsh-pi-loop` 版本已被 unpublish——因此请直接从 GitHub 安装。

每个 release 也会附带打包好的 tarball：[github.com/danalec/dsh-pi-loop/releases](https://github.com/danalec/dsh-pi-loop/releases)。

## 使用

在 profile patch 层（`cordis.patch.yml`）挂载：

```yaml
# 所有新会话使用 Pi loop。
- insert:
    - id: pi-loop
      name: 'dsh-pi-loop'
      config:
        piPath: 'pi'                      # 或绝对路径
        cwd: '/path/to/your/project'      # Pi 会话的工作目录
        model: 'anthropic/claude-sonnet-4-5'  # provider/model 路由
        debug: false

# 回退到 DSH 自有 loop：禁用此条目并重新启用 agent-loop。
# - id: pi-loop
#   disabled: true
```

### 配置

| 键 | 类型 | 默认值 | 说明 |
| --- | --- | --- | --- |
| `piPath` | `string` | `'pi'` | Pi 可执行文件；从 `PATH` 解析 |
| `cwd` | `string` | `process.cwd()` | Pi 会话的工作目录 |
| `model` | `string` | — | Pi 模型路由（`provider/model`） |
| `debug` | `boolean` | `false` | 将协议诊断追加到 `<tmpdir>/dsh-pi-loop.log` |

## 平台说明

- **Windows**：Pi 以命令 shim 形式安装。插件会解析出 shim（`.exe`/`.com`/`.cmd`/`.bat`），并通过 `cmd.exe` 启动 `.cmd`/`.bat`，每个参数都做引号包裹，因此 `pi.cmd` 开箱即用。若 shim 不在 `PATH` 上，用 `piPath` 指定它。
- **POSIX**：shim 是可执行脚本，直接 spawn。
- 诊断日志位于平台临时目录（`os.tmpdir()`），各平台均可写。

## 调试

设置 `debug: true`：每条 RPC 命令、事件、子进程退出和工厂生命周期步骤都会追加到 `<tmpdir>/dsh-pi-loop.log`（Windows 为 `%TEMP%`，其他平台为 `/tmp`）。Pi 自身的 stderr 也转发到同一日志。`debug` 关闭时完全不安装任何 sink——协议层不格式化任何诊断信息，也不碰磁盘。

## 开发

```bash
npm install
npm run typecheck   # tsc --noEmit
npm test            # 先构建，再跑 node:test 测试套件
```

测试运行器需要 Node ≥ 21（其 glob 支持）；库本身在 Node ≥ 20.11 上运行。

测试覆盖历史重建（块映射、停止原因、会话身份）、Pi 事件翻译（工具结果、流式工具调用 id、settle、取消、inbox claim），以及用一个会讲真实 JSONL 协议的假 `pi` 可执行文件驱动的 RPC 客户端。

## 许可证

二选一授权：**MIT** 或 **Apache-2.0**（`MIT OR Apache-2.0`）。两者都是完整且免费的开源授权。

在企业级再分发场景中 Apache-2.0 更合适：除广泛的著作权许可外，它还授予专利许可（第 3 条），若你对著作权人提起专利诉讼，该专利许可即终止。MIT 是两者中更宽松的一个：条款更短，没有明确的专利授予，也不需要 NOTICE 文件。

支持、担保与赔偿不包含在任何一种授权之内。这属于与著作权人另行签订的协议，而非第三种授权选项。

完整文本：[`LICENSE`](LICENSE)、[`LICENSE-MIT`](LICENSE-MIT)、[`LICENSE-APACHE`](LICENSE-APACHE)。
