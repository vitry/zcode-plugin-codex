# ZCode for Codex

ZCode for Codex 是原生 Codex marketplace 插件：由 Codex 保持用户交互与权限控制，把独立审查、修复和会话交接委派给 ZCode。

[English](README.md)

## 环境与安装

- 支持原生插件与 hooks 的 Codex。
- 已安装 ZCode CLI `>=0.16.1`，并至少配置了一个模型。
- Node.js `>=22.13.0`；插件包内自带生产环境原生锁依赖。

从本仓库 `marketplace` 分支发布的生产快照安装；`main` 上的源码根目录本身不是 marketplace catalog：

```bash
codex plugin marketplace add vitry/zcode-plugin-codex --ref marketplace
codex plugin add zcode@vitry
```

发布 workflow 会在该分支生成 `.agents/plugins/marketplace.json` 和带生产依赖的 `plugins/zcode/`。安装后重启 Codex 以加载插件，再在目标工作区运行 `$zcode:setup`。Setup 通常在这一次运行中完成受管 Role 协调。首次运行也可能先把 marketplace 专属的数据目录加入 Codex writable roots；这个 writable-root bootstrap 是唯一独立的 setup 重启情形，若返回 `restart-required`，重启 Codex 后再次运行 `$zcode:setup`。不要把 hooks 从插件缓存复制到别处。

插件依次检查 `ZCODE_PATH`、`PATH` 中的 `zcode`、平台目录，以及 macOS 内置路径 `/Applications/ZCode.app/Contents/Resources/glm/zcode.cjs`。Setup 会报告缺失、版本过低、未配置、未认证或 hook 不可信，但不会下载 ZCode、配置 provider，也不会代替用户登录。

ZCode Desktop 与 ZCode CLI 分别保存 model provider 设置。运行 `$zcode:setup` 前，请在 ZCode CLI 自身配置 provider；仅在 Desktop 中配置并不足以供 `zcode app-server` 使用。如果 CLI 中已配置 API-key provider，则不需要 OAuth 登录。插件不会读取或复制 Desktop 的 provider 设置或 API key，也绝不会记录或持久化这些 key。

## 命令

| Skill | 用途 |
|---|---|
| `$zcode:review [--wait \| --background] [--base <ref>] [--scope auto\|working-tree\|branch]` | 始终只读的代码审查。 |
| `$zcode:adversarial-review [--wait \| --background] [--base <git-ref>] [--scope auto\|working-tree\|branch] [review focus...]` | 只读地挑战实现假设、取舍与隐蔽失败。 |
| `$zcode:rescue [--background \| --wait] [--resume \| --fresh] [--model <provider/model\|alias>] [--effort none\|minimal\|low\|medium\|high\|xhigh] <task...>` | 委派调查或修改，默认前台。 |
| `$zcode:transfer [--source <codex-thread-id>]` | 把可见 Codex 对话导入可恢复的 ZCode 会话。 |
| `$zcode:status [job-id] [--wait] [--timeout-ms <milliseconds>] [--all]` | 查看持久任务；等待默认 240 秒。 |
| `$zcode:result [job-id]` | 不提供 ID 时，读取当前工作区中由当前 Codex 会话拥有的最新已结束 outcome；仍支持精确 job ID。成功 job 返回精确存储的 result artifact，失败或取消 job 返回有界的已存储 outcome 或失败报告。 |
| `$zcode:cancel [job-id]` | 取消当前 Codex 会话拥有的排队或运行任务。 |
| `$zcode:setup [--enable-review-gate \| --disable-review-gate]` | 诊断环境并控制可选 review gate。 |

公开命令不提供无限制执行捷径。两个 Review 始终只读。Rescue 可以修改工作区，但 ZCode permission 请求受发起 Codex turn 的权限快照约束：缺失或未知状态采用更严格策略，高风险操作只在 Codex `bypassPermissions` 模式下允许。后台 worker 继承预留时的权限，后续 turn 不能提升它。

## 隔离的 Rescue Role 与检查方式

`$zcode:setup` 在稳定的 plugin data 根目录下管理一个带 digest 收据的 `zcode-rescue` Role，而不是把它写进带版本号的插件缓存。Setup 只写精确的 user-config Role 注册项，并在一次 setup 中完成首次安装或受管升级；具有完整所有权证据的 numeric-v1 收据也在同一次运行中迁移。ZCode 不拥有 `hide_spawn_agent_metadata`；Codex host 负责协作工具 schema，包括是否提供 `agent_type`。只有 numeric-v1 收据、Role 字节和精确注册能证明旧版 ZCode setup 写入了目标层 `false` 时，setup 才移除该旧配置叶。Setup 不会接管或覆盖冲突：外部 `zcode-rescue` 注册、同名项目 Role、或更高优先级 override 都会 fail closed 并给出 setup 诊断。收据、Role 文件和有效注册必须精确一致。

本次发布修改了受管 Role 字节，因此受管 Role digest 也会升级。`role-status rescue` 可能报告 `upgrade-required`；更新后请重新运行 `$zcode:setup`，先完成兼容的受管 Role 升级协调，再使用 Rescue。

source checkout 和已安装插件使用刻意隔离的命名空间：source development 默认使用 `zcode`，已安装的 marketplace 实例使用 `zcode-<marketplace>`。现有已安装数据和 source-development 数据保持不变并留在原位置。插件不会合并、搜索、重定向或复制已安装命名空间与 source 命名空间之间的状态；source checkout 仍可在自己的 hook lifecycle 已证明自己的 session 时正常工作。

在每个受管父 turn 中，受管 `UserPromptSubmit` hook 都会注入一条由执行该 hook 的精确插件实例机器渲染的 instance-bound launcher command。Root 和 Rescue 子 agent 原样复用这些精确字节，并且只追加固定 Rescue 参数。它们绝不从 cwd 或 Skill 文本构造路径，绝不调用直接 companion 形式 `node scripts/zcode-companion.mjs`，也绝不通过 PATH、全局包或 cache 搜索选择另一个插件实例。这样无需模型自行选择路径，同时不削弱实例或命名空间隔离。

Rescue 会区分对话的 origin workspace 与 execution workspace。Root 在同一个 parent turn 中创建或进入 linked worktree 时，第一次可信的 `prepare rescue` 会自动绑定到该 execution workspace，不需要手动 handoff。只有 origin 本身，或与它共享相同的 canonical Git common-dir 的 canonical linked-worktree 顶层目录才合格。目标在同一 turn 内不可变，因此其他 worktree 或无关仓库会被拒绝。Role inspection 只读，child 不能 claim 或更改目标。Root `Stop` 与新 prompt 会先撤销或替换 origin 和已绑定目标之间的授权；`SessionEnd` 只表示 runtime ownership 消失，会清理 runtime/preparation 状态但保留精确可恢复 binding。

`source-session-unproven` 对该 Rescue 路由是终态：应使用活动受管 lifecycle context 中的 launcher，但不要从未证明的 source checkout 运行 `$zcode:setup`、prepare、follow up 或 spawn。launcher error 由 shell-unsafe 安装路径触发时同样是终态，并给出固定的重新安装 remedy；请把插件重新安装到 shell-safe 路径，再从新的受管父 turn 重试。两种情况都不授权 fallback launcher 或自动重定向。

Rescue 有两种等价入口：显式 `$zcode:rescue` 是请求中字面且适用的入口；Root 也可以根据完整业务目标主动选择 Rescue。这就是自动路由，不提供 `--auto` 选项。显式 `--fresh` 或 `--resume` 始终权威；明确的主动续做会在 child 启动前物化为 resume，明确的独立工作会物化为 fresh。

`--resume` 仍是无参数的公开选择：它不接受 child、session、job、binding、operation 或 handle 参数。对于精确续做，Root 私下保留成功 `spawn_agent` 调用返回的精确 `task_name`，作为该 operation 不变的 canonical agent path。Root 发送 private version-3 preparation，其中只以 `continuationTarget: {"agentPath":"/root/..."}` 携带该 path；插件在精确 parent 的持久 child graph 内部解析 host child ID。canonical path 是只收窄选择的 selector，不是 authority：完整 child-ID/path binding、原始 session、permission 与 canonical workspace 验证仍全部是强制要求。private envelope version 2 的 child ID/path 对只保留对已创建 preparation 的读取兼容；新流程绝不发出它。不带 target 且存在多个可用 binding 的 resume 仍属歧义并 fail closed；插件绝不排序或替换 sibling。

Root 在 raw-capable TTY 上启动 `prepare rescue`。companion 先启用 raw mode，再输出精确且不含 task 的 readiness；readiness 是非终态。只有看到该行之后，Root 才通过私有 stdin 发送一行 JSON，并以 LF 结尾；不发送 EOF 或 U+0004。companion 消费这一帧、恢复 raw mode，并提交绑定精确 session、turn、workspace 和 executor 的 prepared state。非 TTY 或 raw mode 失败会在 task 交付前停止，且不会 spawn child。tool output 绝不包含或回显 payload；返回边界只有不含 task 的 readiness 和最终 prepared 确认。随后具名 Role 或 generic child 都只运行常量 `invoke-prepared rescue` forwarder，不接收 task、options、capability 或授权材料。若已经有活动的 `rescueChildId`，Root 会重新加入并等待这个精确的 Rescue child，不会重复 preflight、prepare、spawn 或 invoke。

Companion 只通过 app-server 的精确 parent relationship query 发现持久化 Codex children。已有 child 只有凭完整的 exact binding 才合格；host-only 或 jobs-only 历史绝不能被采用。惰性兼容迁移仅限唯一的精确 v1/v2 `closed/session-ended` binding。独立进程观测到 `notLoaded` 只有在 parent、child ID、精确 path、Role/type、canonical workspace、binding、jobs、operation、generation、permission 与原始非空 `zcodeSessionId` 全部一致时才可接受。因此 `/root/zcode_rescue_task_2` 仅在它是唯一合格 binding 时 resume 自己的 session。没有精确 private selector 时，两个可用 binding 属于歧义并 fail closed。base path、latest job/session、时间戳、列表顺序和后缀排序绝不选择候选。follow-up directive 仍是带固定 assignment 的 strict version two；spawn directive 仍是不含 assignment 的 strict version one。

durable Rescue binding 把同一个已停止的 Rescue child 绑定到一个精确 ZCode session。私有 `anchorJobId` 标识该操作，`currentJobId` 在每个续做 job 被持久预留并发布时前移，即使该 job 随后排队、失败或取消；两个标识都不会进入 child message。resume 会 follow up 同一 child，不产生第二次 `SubagentStart`，并对原始非空 `zcodeSessionId` 调用 `session/resume`，绝不创建或替代 session。`--fresh` 始终使用新规划并 spawn 的独立 Codex child 和一个新 ZCode session。pending fresh choice 会先返回精确 `parent-replan`，结束旧 child 的选择，再由 parent 重新 prepare 并 collision-free spawn 新 child。fresh 绝不执行同 child 替换、reactivate 或 follow up，并保持已有 sibling binding 不变。

普通前台 Rescue 的完成等待不设插件定义的墙钟截止时间。活动父 turn 的授权由生命周期而非时间绑定，因此明确续做可以 follow up 精确 child，并复用精确绑定的 ZCode session。caller credential 和每一代 preparation 仍以 30 分钟为界；该 TTL 只是一次性 capability 窗口，不是 Codex child、Rescue binding 或 ZCode operation 的生命期。Root `Stop`、替换性的 `UserPromptSubmit`、`$zcode:cancel`、`SIGINT` 和 `SIGTERM` 是终止或撤销边界；`SessionEnd` 不是 binding 撤销边界。

只有精确 v1/v2 `closed/session-ended` 兼容记录可以迁移；v3 记录走普通 exact resume。jobs-only 状态、host-only child、已撤销记录以及不完整或矛盾证据都不能迁移。显式 cancel 与 invalidation 仍是终态。任何不一致都会 fail closed，不会 base/latest fallback、fresh fallback、写状态或发出 ZCode RPC。

前台 Rescue 只在一个原生子线程中运行常量 forwarder。host 支持 `agent_type` 时，Codex 选择具名 `zcode-rescue` Role。generic child 只是 host-only 兼容回退：仅当当前 spawn schema 缺少 `agent_type`，或能证明该字段在任何 child 启动前已被拒绝时才允许；Role 缺失、被 shadow、漂移或属于外部配置时绝不回退。父线程只运行只读 Role preflight 和私有 prepare rollout、显示原生生命周期并返回 child 的最终公开 stdout；它不会 inline 执行 Rescue，也不会把 child stderr、工具输出、原始 conversation frame 或中间进度复制到父线程。

Role preflight 使用固定 readiness 词汇：`caller-unavailable` 要求从活动且受拥有的父 turn 重试，`inspection-unavailable` 要求仅重试检查而不修改 setup。install、upgrade、drift、conflict、restart 或真正 host `unsupported` 等受管状态会引导运行 `$zcode:setup`。由于本次 Role 字节发生变化，现有已拥有的受管 Role 安装需要按正常流程执行一次 `$zcode:setup` 升级。

Rescue child 使用与任务无关的原生显示基名 `zcode_rescue_task`；同级名称冲突时会添加有界序号。该 metadata 不编码业务目标或 task 文本。名称和路径只用于导航：符合 `zcode_rescue_*` 规范既不能证明 child 是 Rescue，也不会授予 Rescue 权限；显示名称不同也不会移除一个已由可信链路确认的 Rescue child 的权限。

使用 `/agent` 或 `/subagents` 选择 Rescue child 并查看它的 transcript。`/ps` 含义不同：它只列出当前活动线程拥有的后台 terminal，所以若一个耗时 child terminal 已 yield，应先切换到 child；短命令可能在出现在列表前就已结束。操作系统的 `ps` 只能显示进程和 argv，不能显示 Codex 模型活动或线程 transcript。非交互 qualification harness 不暴露这些 TUI event，因此会输出机器可读的作用域观测 `{ "observed": false, "code": "tui-evidence-not-exposed", "qualificationScope": "tui" }`。该观测不是资格结果，也不会声称 UI 已通过或失败。

ZCode 支持时，child 会订阅 online conversation progress，并用结构化结果探测该 subscription 是否真的持续提供可用的 online frame。allowlist 内的 online 工具活动可以带一行、去控制字符、最长 96 字符的命令或搜索 query 预览。截断不是秘密脱敏：如果秘密本来就在 online 命令或 query 中，它仍可能出现在 child transcript 和持久 status 预览里。

若已接受的 online frame 始终不可用，Rescue 可以按不高于心跳的频率回退读取已经通过 schema 校验的 session snapshot。该回退严格限定在已持久确认的当前 turn，只输出 allowlist 内的工具状态，不输出命令或 query。它绝不读取原始 ZCode 日志，也不输出 assistant 正文或推理、任意工具输入/输出、错误或 metadata、原始路径、文件或 patch 内容、标识符、环境值或授权材料。进度观测不具权威性：失败只会一次性降级为 lifecycle-only 更新，不改变 job 的成功结果。companion 完成后的独立、带 revision guard 的 session read 仍是权威终态结果。

被选中的 Rescue 子 agent 会从结构化 ZCode 事件显示 cc-style 语义进度。root 收到的是固定的粗粒度存活更新，而不是原始子 agent 输出。这些更新只用于保持对原子 agent 的等待，本身只具观察性：进度和 status 永远不能证明完成；只有原始前台进程的终态退出和最终 stdout 才能证明完成。原始 PTY 数据、工具输出、文件内容、reasoning、凭据和 capabilities 永远不会 relay 到 root。

仅在这个被选中的 Rescue 子 agent 内，精确去除首尾空白后的 `zcode status`、`$zcode:status` 和 `/zcode:status` 才会检查只绑定到该子 agent 的 job。这个 bound status sidecar 不接受 job ID 或选项，不能选择其他 job，也绝不会启动或替换原始前台执行。上表中的公开 `$zcode:status` 仍用于普通 durable job 的 owner-scoped 控制。

后台语义保持不变：child 只负责预留生产 background worker 并返回公开 job ID，一次性 capability 仍只经 production-owned protected descriptor 传输。持久恢复继续使用 `$zcode:status`、`$zcode:result` 和 `$zcode:cancel`。普通 steering、等待超时或父/child 丢失都不授权替代执行。

Codex 0.147 是本次发布唯一被固定并纳入原生 Rescue installed-host qualification suite 的版本线。默认 CI 会分别重放经过净化的 0.147 captured rollout，独立覆盖具名 Role 和 generic fallback，包括 yielded 前台执行及同一 child 的 choice continuation。带认证的 live 测试仍只记录 Codex 实际选择的一条路由；它不会声称一次 live turn 同时执行了两条路由。只有严格认证套件完整成功的 build 才算 qualified；默认的机器可读 `unqualified` 结果不是兼容性证据。其他 Codex 版本在各自的 installed qualification 成功前不宣称兼容。uninstall 插件不会自动删除稳定私有数据、受管 Role 收据/文件、job 历史或精确 user-config 配置叶。请先结束或取消 owner job，再按[手动卸载与残留状态清理指南](docs/manual-uninstall.md)审查并移除能证明属于本插件的条目；绝不能删除有冲突的用户或项目 Role。

## 模型

`--model` 可使用 ZCode 公布的 `provider/model`、唯一的精确 model ID 或已配置 alias。模型策略是私有配置，并按 canonical workspace 隔离。把 setup 变量放入启动 Codex 的环境，然后在 Codex 中调用 `$zcode:setup`：

```bash
ZCODE_SETUP_DEFAULT_MODEL=fast \
ZCODE_SETUP_MODEL_ALIASES_JSON='{"fast":{"providerId":"provider","modelId":"model","variant":"optional"}}' \
codex
# 进入 Codex session 后执行：$zcode:setup
```

Setup 会把以下 schema 写入 `$CODEX_HOME/plugins/data/zcode-<marketplace>/workspaces/<workspace-hash>/config/models.json`（hook 注入的 `PLUGIN_DATA` 会解析到同一目录）：

```json
{"version":1,"defaultModel":"fast","models":{"fast":{"providerId":"provider","modelId":"model","variant":"optional"}}}
```

解析优先级为：显式 `--model`、已持久化的 workspace 默认值、ZCode 自身默认值。运行阶段的旧变量 `ZCODE_MODEL_ALIASES` 会被忽略；alias 必须通过 setup 持久化。发送任务前，插件会校验 ZCode 返回的模型精确 tuple 和已公布的 effort，任何不一致都会明确失败。

验证时可重新运行 `$zcode:setup`，再执行 `$zcode:rescue --fresh --model fast <任务>`，并用 `$zcode:status <job-id>` 检查任务。

## 任务、Transfer 与 review gate

`SessionEnd` 表示 runtime ownership 消失。它只保留无活动 current attempt 的精确已完成 binding，以及精确 v1/v2 `closed/session-ended` candidate 作为可恢复状态。远端取消得到确认后，它可以只关闭该精确 active operation；未确认的 stop 会保留 writable guard。任何 bound `session/stop` 之前，过期 stop 的最终 guard 会重新检查 owner、可取消 job、binding operation/generation/current job 和 worker lease；过期 loser 不发送 stop，也不关闭 binding。

每次运行都会先建立持久、带 owner 的 job。已安装插件的状态保存在 `$CODEX_HOME/plugins/data/zcode-<marketplace>/workspaces/<workspace-hash>/`，使用私有权限；prompt、result、session ID 和日志都不会写进仓库或插件缓存。后续 turn 仍可使用 `$zcode:status`、`$zcode:result`、`$zcode:cancel`，但 sibling Codex session 无法接管任务。

`SessionEnd` 会对结束会话的可写 Rescue 执行 best-effort 结算。已 claim 的 queued reservation 在其 worker lease 仍被持有时保持不变。若进程在结算完成前退出，后续 Rescue 会执行预留时的崩溃回退，并可结算可证明的孤儿可写 job；结算不会转移 ownership，仍只有原 owner 能读取其结果。在这个预留时的崩溃回退中，仍被持有的精确 worker lease 会保留 writable guard。当精确 worker lease 已释放且现存 broker 控制通道不可用时，`SessionEnd` 或下一次 Rescue 会把孤儿归档为 `failed` 并释放 writable guard。这表示插件放弃追踪，不代表远端停止已确认。broker 仍可连接时，未确认的 `session/stop` 仍会保留 writable guard。其他会话只能通过 `$zcode:status --all` 查看脱敏后的 workspace 信息。

若 ZCode 可能已接受 turn 后前台或后台响应丢失，恢复会通过同一个 durable job 的 `$zcode:status`、`$zcode:result`、owned-job reconciliation、持久 session read 和 result artifact 完成。恢复保持一次 send：绝不自动重发 prompt、调用 `session/create`、回滚已接受 turn，或把响应丢失解释为 fresh。

前台运行会把 ZCode 活动流式显示在当前终端。如果没有新活动，则每 20 秒输出一次心跳，让耗时较长的模型请求或工具调用仍然可见。现有有界 pipeline 成功派发的每个已接受安全语义进度事件，也会追加到私有、持久、便于人阅读的 `workspaces/<workspace-hash>/jobs/<job-id>.log`，它与 `<job-id>.json` 相邻；job 的 `progressPreview` 仍只保留最近 4 条。精确 owner 的详细 `$zcode:status <job-id>` 会显示进度预览、阶段和最后活动时间，以及 `Log: <absolute-private-path>`。例如：

```text
$zcode:rescue --wait 修复失败的测试
[zcode] ZCode started a tool call.
[zcode] Still waiting for ZCode; last activity 20s ago.

$zcode:status <job-id>
Status: running
Phase: running
Progress:
  - ZCode started a tool call.
Log: <absolute-private-path>
```

每个 job 的日志还可以保存由现有精确 linkage 规则选出的当前 turn 的可见 assistant 文本，以及权威最终输出。原始命令 stdout/stderr、任意工具 payload（input/output/error/metadata）、原始推理、文件或 patch 内容、环境值、凭据、capabilities 和隐藏消息绝不直接摄取为日志源字段。此 allowlist 不是语义秘密脱敏边界：如果可见 assistant 或最终文本本身引用或转述了敏感材料，被选中的文本仍会保留。请勿让秘密进入可见模型文本，并相应保护私有日志。日志与进度只具观察性，不能建立或改变终态权威。

只有精确 owner 的详细 status 会暴露私有路径。紧凑列表、外部 `--all` 投影、同级 sibling session、绑定的 Rescue status sidecar、Root relay 和终态通知都不会暴露 `logFile` 或日志路径。status 语法仍为 `$zcode:status [job-id] [--wait] [--timeout-ms <milliseconds>] [--all]`：不提供 `--log` 选项或日志读取命令。日志沿用现有持久保留策略，在卸载或选择性 runtime 清理后仍保留；没有日志轮转、过期、裁剪、逐日志删除、导出或搜索功能。仅在删除已证明属于本插件的工作区数据时才删除这些日志。

后台任务有独立生命周期：启动它的前台命令或 Codex turn 结束时，后台任务不会自动取消。用 `$zcode:status <job-id>` 查看，用 `$zcode:cancel <job-id>` 显式取消；ownership 仍只属于预留该 job 的 Codex session。

在支持的前台路径上，插件会在安全协议边界处理 `SIGINT` 和 `SIGTERM`。ZCode session 尚未建立时，中断会取消排队中的预留；精确持久化的 ZCode session ID 一旦存在，插件只会对该 session 发送 `session/stop`。停止得到确认后，job 会持久标记为 cancelled；如果 `session/stop` 失败或超时，job 会保持 running，并通过 status 暴露取消错误，以便重试取消。这是刻意限定的 session 级边界：插件不声称停止或杀死 ZCode 或嵌套工具创建的任意 detached grandchildren。

Transfer 通过 `codex app-server` 读取持久 Codex thread，只导入按顺序排列、用户可见的 user/assistant 文本；不转移隐藏推理、工具状态、permission 或 job ownership。

可选 Stop review gate 只会在用户驱动的父 turn 确实改变工作区后执行有界、前台、只读审查。用 `$zcode:setup` 开关，可能需要重启 Codex。ZCode 缺失、过旧或未认证时会附 setup 指引并 fail open；一旦审查会话已启动，畸形、失败或超时输出会保守阻止结束。

## 排障与平台状态

- `ZCODE_NOT_FOUND` / `ZCODE_VERSION_UNSUPPORTED`：安装或升级 ZCode，必要时设置 `ZCODE_PATH`，再运行 `$zcode:setup`。
- `INTERNAL_AUTHORIZATION_INVALID`：重启 Codex，确认 hooks 已启用且可信，再运行 setup；不要手工复制 caller-context。
- `model_config_missing`：在 ZCode CLI 自身配置 model provider，再重新 setup。Desktop provider 设置与 CLI 分离；API-key provider 不要求 OAuth。
- 已配置的 CLI provider 无法认证：在 ZCode 自身完成认证，再重新 setup。
- 后台任务：按输出使用 `$zcode:status <job-id> --wait`、`$zcode:result <job-id>` 或 `$zcode:cancel <job-id>`。
- Hook trust / restart required：只让 setup 信任当前安装插件的精确 hook hash，重启后再次检查。
- `plugin-data-root-added`：setup 只把稳定数据目录加入 Codex 配置，尚未写入插件状态；重启 Codex 后再次运行 setup。

macOS + ZCode Desktop 3.6.5 + CLI 0.16.1+ 是发布资格目标。协议客户端可处理 CLI 0.16.1 发出的 string-ID runtime-preference server request。发布前必须在 CLI model provider 可用且 Codex 已认证并有额度的机器上运行完整严格命令：`ZCODE_CODEX_SKILLS_E2E=1 ZCODE_CODEX_RESCUE_E2E=1 ZCODE_REAL_E2E=1 ZCODE_REAL_E2E_MODEL='provider/model' npm run test:qualification-required`。`ZCODE_REAL_MODEL` 仅保留为 deprecated 别名；两个变量都有非空值时，只有去除首尾空白后的值完全相同才继续，否则资格检查会以冲突 fail closed。默认 `npm run test:qualified` 是 opt-in 诊断：结构化 `unqualified` skip 让普通 CI 可移植，但不能作为资格证据。严格脚本会把缺少 opt-in、provider 配置或认证、模型、额度及其他 unqualified runtime 结果转为非零失败；作用域 `tui-evidence-not-exposed` 观测不是 runtime 资格结果，也从不声称 UI 已通过资格。未知执行错误也会让测试失败。Linux and Windows are code-supported but are not real-CLI qualified yet；两者当前由 fake-protocol CI 覆盖。

## 许可证与来源

本项目采用 Apache-2.0。OpenAI Codex、`codex-plugin-cc`、Sendbird/ZCode adapter 与 `zcode-plugin-cc` 的来源说明见 [LICENSE](LICENSE) 和 [NOTICE](NOTICE)。
