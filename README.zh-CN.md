# ZCode for Codex

ZCode for Codex 是原生 Codex marketplace 插件：由 Codex 保持用户交互与权限控制，把独立审查、修复和会话交接委派给 ZCode。

[English](README.md)

## 环境与安装

- 支持原生插件与 hooks 的 Codex。
- 已安装 ZCode CLI `>=0.16.1`，并至少为一个模型完成认证。
- Node.js `>=18.18.0`；插件包内自带生产环境原生锁依赖。

在 Codex Settings 中把 `https://github.com/vitry/zcode-plugin-codex` 添加为 marketplace source，从该 marketplace 安装 **ZCode for Codex**，重启 Codex，然后在目标工作区运行 `$zcode:setup`。不要把 hooks 从插件缓存复制到别处。

插件依次检查 `ZCODE_PATH`、`PATH` 中的 `zcode`、平台目录，以及 macOS 内置路径 `/Applications/ZCode.app/Contents/Resources/glm/zcode.cjs`。Setup 会报告缺失、版本过低、未认证或 hook 不可信，但不会下载 ZCode，也不会代替用户登录。

## 命令

| Skill | 用途 |
|---|---|
| `$zcode:review [--wait \| --background] [--base <ref>] [--scope auto\|working-tree\|branch]` | 始终只读的代码审查。 |
| `$zcode:adversarial-review ... [focus...]` | 只读地挑战实现假设、取舍与隐蔽失败。 |
| `$zcode:rescue [--background \| --wait] [--resume \| --fresh] [--model <model>] [--effort <level>] <task...>` | 委派调查或修改，默认前台。 |
| `$zcode:transfer [--source <codex-thread-id>]` | 把可见 Codex 对话导入可恢复的 ZCode 会话。 |
| `$zcode:status [job-id] [--wait] [--timeout-ms <milliseconds>] [--all]` | 查看持久任务；等待默认 240 秒。 |
| `$zcode:result [job-id]` | 读取完整的已存储结果。 |
| `$zcode:cancel [job-id]` | 取消当前 Codex 会话拥有的排队或运行任务。 |
| `$zcode:setup [--enable-review-gate \| --disable-review-gate]` | 诊断环境并控制可选 review gate。 |

公开命令不提供无限制执行捷径。两个 Review 始终只读。Rescue 可以修改工作区，但 ZCode permission 请求受发起 Codex turn 的权限快照约束：缺失或未知状态采用更严格策略，高风险操作只在 Codex `bypassPermissions` 模式下允许。后台 worker 继承预留时的权限，后续 turn 不能提升它。

## 模型

`--model` 可使用 ZCode 公布的 `provider/model`、唯一的精确 model ID 或已配置 alias。启动 Codex 前通过 `ZCODE_MODEL_ALIASES` 配置 JSON，例如：

```json
{"fast":{"providerId":"provider","modelId":"model"}}
```

插件不会静默改变模型；无效 alias、model ID 或 effort 会明确失败。

## 任务、Transfer 与 review gate

每次运行都会先建立持久、带 owner 的 job。状态保存在 `${PLUGIN_DATA}/workspaces/<workspace-hash>/`，使用私有权限；prompt、result、session ID 和日志都不会写进仓库。后续 turn 仍可使用 `$zcode:status`、`$zcode:result`、`$zcode:cancel`，但 sibling Codex session 无法接管任务。

Transfer 通过 `codex app-server` 读取持久 Codex thread，只导入按顺序排列、用户可见的 user/assistant 文本；不转移隐藏推理、工具状态、permission 或 job ownership。

可选 Stop review gate 只会在用户驱动的父 turn 确实改变工作区后执行有界、前台、只读审查。用 `$zcode:setup` 开关，可能需要重启 Codex。ZCode 缺失、过旧或未认证时会附 setup 指引并 fail open；一旦审查会话已启动，畸形、失败或超时输出会保守阻止结束。

## 排障与平台状态

- `ZCODE_NOT_FOUND` / `ZCODE_VERSION_UNSUPPORTED`：安装或升级 ZCode，必要时设置 `ZCODE_PATH`，再运行 `$zcode:setup`。
- `INTERNAL_AUTHORIZATION_INVALID`：重启 Codex，确认 hooks 已启用且可信，再运行 setup；不要手工复制 caller-context。
- Authentication 不可用：在 ZCode 自身完成认证，再重新 setup。
- 后台任务：按输出使用 `$zcode:status <job-id> --wait`、`$zcode:result <job-id>` 或 `$zcode:cancel <job-id>`。
- Hook trust / restart required：只让 setup 信任当前安装插件的精确 hook hash，重启后再次检查。

macOS 已用 ZCode Desktop 3.6.5 与 CLI 0.16.1+ 做 real-CLI qualification。Linux and Windows are code-supported but are not real-CLI qualified yet；两者当前由 fake-protocol CI 覆盖。

## 许可证与来源

本项目采用 Apache-2.0。OpenAI Codex、`codex-plugin-cc`、Sendbird/ZCode adapter 与 `zcode-plugin-cc` 的来源说明见 [LICENSE](LICENSE) 和 [NOTICE](NOTICE)。
