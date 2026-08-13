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
| `$zcode:result [job-id]` | 读取完整的已存储结果。 |
| `$zcode:cancel [job-id]` | 取消当前 Codex 会话拥有的排队或运行任务。 |
| `$zcode:setup [--enable-review-gate \| --disable-review-gate]` | 诊断环境并控制可选 review gate。 |

公开命令不提供无限制执行捷径。两个 Review 始终只读。Rescue 可以修改工作区，但 ZCode permission 请求受发起 Codex turn 的权限快照约束：缺失或未知状态采用更严格策略，高风险操作只在 Codex `bypassPermissions` 模式下允许。后台 worker 继承预留时的权限，后续 turn 不能提升它。

## 隔离的 Rescue Role 与检查方式

`$zcode:setup` 在稳定的 plugin data 根目录下管理一个带 digest 收据的 `zcode-rescue` Role，而不是把它写进带版本号的插件缓存。Setup 只写精确的 user-config Role 注册项，并在一次 setup 中完成首次安装或受管升级；具有完整所有权证据的 numeric-v1 收据也在同一次运行中迁移。ZCode 不拥有 `hide_spawn_agent_metadata`；Codex host 负责协作工具 schema，包括是否提供 `agent_type`。只有 numeric-v1 收据、Role 字节和精确注册能证明旧版 ZCode setup 写入了目标层 `false` 时，setup 才移除该旧配置叶。Setup 不会接管或覆盖冲突：外部 `zcode-rescue` 注册、同名项目 Role、或更高优先级 override 都会 fail closed 并给出 setup 诊断。收据、Role 文件和有效注册必须精确一致。

前台 Rescue 只在一个原生子线程中运行常量 forwarder。host 支持 `agent_type` 时，Codex 选择具名 `zcode-rescue` Role。generic child 只是 host-only 兼容回退：仅当当前 spawn schema 缺少 `agent_type`，或能证明该字段在任何 child 启动前已被拒绝时才允许；Role 缺失、被 shadow、漂移或属于外部配置时绝不回退。父线程只运行只读 Role preflight、显示原生生命周期并返回 child 的最终公开 stdout；它不会 inline 执行 Rescue，也不会把 child stderr、工具输出、原始 conversation frame 或中间进度复制到父线程。

使用 `/agent` 或 `/subagents` 选择 Rescue child 并查看它的 transcript。`/ps` 含义不同：它只列出当前活动线程拥有的后台 terminal，所以若一个耗时 child terminal 已 yield，应先切换到 child；短命令可能在出现在列表前就已结束。操作系统的 `ps` 只能显示进程和 argv，不能显示 Codex 模型活动或线程 transcript。非交互 qualification harness 不暴露这些 TUI event，因此会输出机器可读的作用域观测 `{ "observed": false, "code": "tui-evidence-not-exposed", "qualificationScope": "tui" }`。该观测不是资格结果，也不会声称 UI 已通过或失败。

ZCode 支持时，child 会订阅 online conversation progress。allowlist 内的工具活动可以带一行、去控制字符、最长 96 字符的命令或搜索 query 预览。截断不是秘密脱敏：如果秘密本来就在命令或 query 中，它仍可能出现在 child transcript 和持久 status 预览里。原始输出、文件内容、推理、assistant draft、环境值和授权材料都不是进度字段。subscription 或可选进度 sink 失败时，Rescue 会降级到生命周期消息与 20 秒心跳；带 revision guard 的终态结果仍是权威结果。

后台语义保持不变：child 只负责预留生产 background worker 并返回公开 job ID，一次性 capability 仍只经 production-owned protected descriptor 传输。持久恢复继续使用 `$zcode:status`、`$zcode:result` 和 `$zcode:cancel`。普通 steering、等待超时或父/child 丢失都不授权替代执行。

Codex 0.147 是本次发布唯一被固定并纳入原生 Rescue installed-host qualification suite 的版本线。只有严格认证套件完整成功的 build 才算 qualified；默认的机器可读 `unqualified` 结果不是兼容性证据。其他 Codex 版本在各自的 installed qualification 成功前不宣称兼容。uninstall 插件不会自动删除稳定私有数据、受管 Role 收据/文件、job 历史或精确 user-config 配置叶。请先结束或取消 owner job，再按[手动卸载与残留状态清理指南](docs/manual-uninstall.md)审查并移除能证明属于本插件的条目；绝不能删除有冲突的用户或项目 Role。

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

每次运行都会先建立持久、带 owner 的 job。已安装插件的状态保存在 `$CODEX_HOME/plugins/data/zcode-<marketplace>/workspaces/<workspace-hash>/`，使用私有权限；prompt、result、session ID 和日志都不会写进仓库或插件缓存。后续 turn 仍可使用 `$zcode:status`、`$zcode:result`、`$zcode:cancel`，但 sibling Codex session 无法接管任务。

`SessionEnd` 会对结束会话的可写 Rescue 执行 best-effort 结算。已 claim 的 queued reservation 在其 worker lease 仍被持有时保持不变。若进程在结算完成前退出，后续 Rescue 会执行预留时的崩溃回退，并可结算可证明的孤儿可写 job；结算不会转移 ownership，仍只有原 owner 能读取其结果。在这个预留时的崩溃回退中，仍被持有的精确 worker lease 会保留 writable guard。当精确 worker lease 已释放且现存 broker 控制通道不可用时，`SessionEnd` 或下一次 Rescue 会把孤儿归档为 `failed` 并释放 writable guard。这表示插件放弃追踪，不代表远端停止已确认。broker 仍可连接时，未确认的 `session/stop` 仍会保留 writable guard。其他会话只能通过 `$zcode:status --all` 查看脱敏后的 workspace 信息。

前台运行会把 ZCode 活动流式显示在当前终端。如果没有新活动，则每 20 秒输出一次心跳，让耗时较长的模型请求或工具调用仍然可见。同一份安全活动也会持久化到 job；`$zcode:status <job-id>` 会显示阶段、最后活动时间和近期进度预览。例如：

```text
$zcode:rescue --wait 修复失败的测试
[zcode] ZCode started a tool call.
[zcode] Still waiting for ZCode; last activity 20s ago.

$zcode:status <job-id>
Status: running
Phase: running
Progress:
  - ZCode started a tool call.
```

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
