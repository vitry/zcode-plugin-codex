# Manual cleanup after uninstall

ZCode has no plugin uninstall lifecycle hook. Uninstalling the plugin files alone leaves its stable plugin data and the Codex configuration leaves created by setup. There is intentionally no `$zcode:uninstall` command: cleanup must remain receipt-gated so a stale or foreign Role is never deleted by name alone.

For a reinstall or upgrade, do not clean up first. Replace the plugin source, let Codex load it, and run `$zcode:setup` once in each workspace that needs setup. That run safely overwrites or reconciles state proved by the receipt. The writable-root bootstrap is the only separate restart case: if setup reports `plugin-data-root-added` / `restart-required`, restart Codex and run setup once more. Role installation, an owned Role upgrade, and proven numeric-v1 migration do not themselves require a restart.

## Before permanent cleanup

1. Before uninstalling the plugin, use `$zcode:status --all` and the owner-scoped `$zcode:status`, `$zcode:result`, and `$zcode:cancel` commands to settle or cancel all active jobs. Removing state does not stop a remote ZCode session or a detached process.
2. Find the actual stable data root. An installed plugin normally uses `$CODEX_HOME/plugins/data/zcode-<marketplace>/` (for example, `zcode-vitry`); a source checkout normally uses `$CODEX_HOME/plugins/data/zcode/`. `ZCODE_DATA_ROOT` can override both.
3. Back up the data root and selected Codex user configuration before editing either one.

If the plugin was already uninstalled or removed before jobs were settled, temporarily reinstall a trusted, version-compatible source with the same plugin identity. Then resume the exact original owning Codex session in the canonical workspace and use owner-scoped `$zcode:status`, `$zcode:result`, and `$zcode:cancel` from that resumed session. A new Codex session is insufficient because it does not own those jobs. If the original owning session cannot be resumed, use only a verified external ZCode control path that can identify and settle the exact remote sessions, and retain all uncertain recovery state. Do not delete plugin state while ownership or activity remains uncertain.

## Prove ownership before deleting configuration or the Role

Inspect `<plugin-data-root>/agent-roles/zcode-rescue.receipt.json`. Stop if it is absent, malformed, or inconsistent. Before deleting anything, verify all of the following against current bytes and the selected user configuration layer:

- `roleName` is exactly `zcode-rescue`, and `plugin.identity` is the exact installed marketplace identity (normally `zcode@vitry`).
- `configTarget.filePath` is the user configuration file you intend to edit; do not substitute a project or other layer.
- `role.path` is exactly `<plugin-data-root>/agent-roles/zcode-rescue.toml`.
- SHA-256 of the current Role file bytes equals `role.sha256` in the receipt.
- The selected layer's `agents.zcode-rescue` registration points `config_file` to that exact `role.path` and otherwise matches the managed registration. The effective Role must not be a foreign or project-layer definition.

If every check succeeds, remove only the proven `agents.zcode-rescue` registration from `configTarget.filePath`, then remove the matching Role file and receipt. A stale `zcode-rescue.transaction.json` and `agent-roles/lock/` are transaction/lock state; remove them only after all jobs and setup processes have stopped and the same receipt, Role bytes, and registration establish ownership.

ZCode does not own the Codex host setting `features.multi_agent_v2.hide_spawn_agent_metadata`. Remove an exact target-layer `features.multi_agent_v2.hide_spawn_agent_metadata = false` only when a valid numeric-v1 receipt plus the matching plugin identity, `configTarget.filePath`, Role path, Role SHA-256, and exact `agents.zcode-rescue` registration prove that this older ZCode setup wrote that leaf. Never remove `true`, a project-layer value, a foreign value, or any unproven value. A current `"1.0.0"` receipt is not legacy metadata ownership evidence.

## Other setup configuration residuals

Setup may also leave these values in the selected Codex user configuration:

- the exact plugin-data-root entry inside `sandbox_workspace_write.writable_roots`;
- the shared `features.hooks = true` switch; and
- plugin hook trust entries beneath `hooks.state`.

The current Role receipt has no prior-value ownership record for these shared leaves, so it does not prove their previous state and does not authorize automatic deletion. Consider removing only the plugin-specific writable-root entry or a plugin hook trust entry when its current value exactly matches this installation and no other consumer depends on it. If identity, value, or consumers cannot be proved, leave it unchanged. `features.hooks` stays enabled unless the user independently determines that hooks are unused by every plugin and other configuration consumer; ZCode ownership evidence alone is insufficient.

## Data retained by default

Durable jobs and their history are retained by default so results and diagnostics remain inspectable after uninstall. This includes each `workspaces/<workspace-hash>/` tree and, where present:

- `jobs/`, `job-owners/`, and `job-specs/` job records;
- `prompts/` and `results/` artifacts;
- persisted progress previews inside job records, plus diagnostic logs/history represented by those records and artifacts; and
- `config/models.json` workspace model policy, if it should be retained for a later reinstall.

## Selective runtime-state cleanup while retaining history

After all jobs and plugin processes have stopped, you may selectively remove the following workspace runtime state while retaining `jobs/`, `job-owners/`, `job-specs/`, `prompts/`, `results/`, persisted progress, and diagnostic logs/history:

- `identity/` authorization records, `hook-state/` session/executor/notification records, and pending `invocations/`;
- `broker/` process identity, endpoint, and session-ownership control state, only after proving no broker or ZCode process still uses it;
- `gate-runs/` review-gate run/deduplication state;
- `cancel-attempts/`, `cancel-attempt-locks/`, `cancel-locks/`, and `worker-leases/`;
- `.state.lock`, `.artifacts.lock`, and the lock files inside the directories above; and
- `config/review-gate.json`, which is the plugin's review-gate setup preference and readiness state, not a lock and not job history.

Deleting these paths disables authorization, recovery, notification, broker control, and review-gate continuity represented by them. Perform this selective cleanup only after activity is conclusively settled.

For full data erasure, after jobs are settled and after making any required backup, you may additionally remove the proven plugin-owned workspace directories under `<plugin-data-root>/workspaces/`. Removing a whole workspace directory permanently deletes its prompts, results, progress, logs/history, model policy, job ownership, and recovery evidence. Remove the plugin-data root itself only after proving it is the ZCode marketplace namespace and contains no data you want to retain.

---

# 卸载后的手动清理

ZCode 没有插件卸载生命周期 hook。只卸载插件文件会留下稳定 plugin data 和 setup 写入的 Codex 配置叶。项目刻意不提供 `$zcode:uninstall` 命令：清理必须由收据证明所有权，不能仅凭名称删除可能已陈旧或属于外部的 Role。

重新安装或升级时无需先清理。替换插件源、让 Codex 加载新插件，然后在每个需要配置的工作区运行一次 `$zcode:setup`；它会安全覆写或协调收据能够证明归属的状态。仅 writable-root bootstrap 是单独的重启情形：如果 setup 返回 `plugin-data-root-added` / `restart-required`，重启 Codex 后再运行一次 setup。Role 安装、受管 Role 升级和已证明归属的 numeric-v1 迁移本身不要求重启。

## 永久清理前

1. 卸载前，使用 `$zcode:status --all` 以及 owner-scoped 的 `$zcode:status`、`$zcode:result`、`$zcode:cancel` 结束或取消所有活动任务。删除本地状态不会停止远端 ZCode session 或 detached process。
2. 找到实际稳定数据根目录。安装版通常使用 `$CODEX_HOME/plugins/data/zcode-<marketplace>/`（例如 `zcode-vitry`）；源码 checkout 通常使用 `$CODEX_HOME/plugins/data/zcode/`；`ZCODE_DATA_ROOT` 可以覆盖二者。
3. 修改前备份数据根目录和目标 Codex user configuration。

如果尚未结算任务就已经卸载或移除了插件，请从可信且版本兼容的源临时重新安装具有相同插件 identity 的插件。随后恢复精确的原 owning Codex session，并确认它位于同一个 canonical workspace；只能从这个已恢复 session 使用 owner-scoped 的 `$zcode:status`、`$zcode:result` 和 `$zcode:cancel`。新的 Codex session 不足以处理这些任务，因为它不是任务 owner。如果无法恢复原 owning session，只能使用能够识别并结算精确远端 session 的外部已验证的 ZCode 控制路径，并保留所有不确定的恢复状态。ownership 或活动状态仍不确定时不要删除插件状态。

## 删除配置或 Role 前先证明所有权

检查 `<plugin-data-root>/agent-roles/zcode-rescue.receipt.json`。如果它缺失、格式无效或内容不一致，请停止。删除任何内容前，必须对当前文件字节和选定 user configuration 层验证：

- `roleName` 必须精确为 `zcode-rescue`，`plugin.identity` 必须是已安装插件的精确 marketplace identity（通常为 `zcode@vitry`）。
- `configTarget.filePath` 必须就是准备编辑的 user configuration 文件；不得替换成项目层或其他层。
- `role.path` 必须精确为 `<plugin-data-root>/agent-roles/zcode-rescue.toml`。
- 当前 Role 文件字节的 SHA-256 必须等于收据中的 `role.sha256`。
- 选定层的 `agents.zcode-rescue` 注册必须把 `config_file` 指向该精确 `role.path`，其余内容也必须匹配受管注册；有效 Role 不能是外部或项目层定义。

全部验证成功后，只移除 `configTarget.filePath` 中已证明归属的 `agents.zcode-rescue` 注册，再移除匹配的 Role 文件和收据。陈旧的 `zcode-rescue.transaction.json` 与 `agent-roles/lock/` 属于事务/锁状态；仅当所有任务和 setup 进程均已停止，且同一收据、Role 字节及注册能证明归属时才移除。

ZCode 不拥有 Codex host 设置 `features.multi_agent_v2.hide_spawn_agent_metadata`。只有当有效 numeric-v1 收据连同匹配的插件 identity、`configTarget.filePath`、Role 路径、Role SHA-256 和精确 `agents.zcode-rescue` 注册证明旧版 ZCode setup 写入了该目标层配置叶时，才可移除精确的 `features.multi_agent_v2.hide_spawn_agent_metadata = false`。绝不删除 `true`、项目层值、外部值或任何无法证明归属的值。当前 `"1.0.0"` 收据不能作为旧 metadata 的所有权证据。

## 其他 setup 配置残留

Setup 还可能在选定的 Codex user configuration 中留下：

- `sandbox_workspace_write.writable_roots` 内精确的 plugin-data-root 条目；
- 共享开关 `features.hooks = true`；
- `hooks.state` 下本插件的 hook trust 条目。

当前 Role 收据没有记录这些共享配置叶的先前值所有权，因此无法证明其原值，也不授权自动删除。只有当前值与本次安装精确匹配且没有其他消费者依赖它时，才考虑移除插件专属的 writable-root 条目或 hook trust 条目。无法证明 identity、值或消费者情况时应保持不变。`features.hooks` 必须保留，除非用户独立确认所有插件和其他配置消费者都不再使用 hooks；仅凭 ZCode 所有权证据并不足够。

## 默认保留的数据

持久 job 及其历史默认保留，便于卸载后继续检查结果和诊断信息。其中包括每个 `workspaces/<workspace-hash>/` 树，以及存在时的：

- `jobs/`、`job-owners/` 和 `job-specs/` 任务记录；
- `prompts/` 与 `results/` artifact；
- job 记录中的持久 progress preview，以及这些记录和 artifact 所代表的诊断 logs/history；
- 如需供以后重新安装使用，可保留 `config/models.json` 工作区 model policy。

## 保留历史时选择性清理运行状态

所有任务和插件进程都已停止后，可以选择性移除以下工作区运行状态，同时保留 `jobs/`、`job-owners/`、`job-specs/`、`prompts/`、`results/`、持久 progress 和诊断 logs/history：

- `identity/` authorization 记录、`hook-state/` session/executor/notification 记录，以及待处理的 `invocations/`；
- `broker/` process identity、endpoint 和 session-ownership 控制状态；必须先证明没有 broker 或 ZCode 进程仍在使用；
- `gate-runs/` review-gate 运行/去重状态；
- `cancel-attempts/`、`cancel-attempt-locks/`、`cancel-locks/` 和 `worker-leases/`；
- `.state.lock`、`.artifacts.lock` 以及上述目录内的锁文件；
- `config/review-gate.json`：这是本插件的 review-gate setup 偏好与 readiness 状态，不是锁，也不是 job 历史。

删除这些路径会同时删除其代表的 authorization、恢复、通知、broker 控制和 review-gate 连续性。只有在活动已经明确结算后才执行这种选择性清理。

如果需要彻底清除数据，请先结束任务并完成必要备份，然后可以额外移除 `<plugin-data-root>/workspaces/` 下已证明属于本插件的工作区目录。删除整个工作区目录会永久删除其中的 prompts、results、progress、logs/history、model policy、job ownership 与恢复证据。仅当确认整个 plugin-data root 是 ZCode 的 marketplace namespace，且其中没有需要保留的数据时，才移除该根目录。
