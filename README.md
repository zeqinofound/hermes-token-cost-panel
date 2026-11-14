# Token 消耗面板

<p align="center"><strong>Hermes Agent 桌面插件</strong> — 在右侧边栏实时展示当前会话的 token 消耗、缓存命中率与费用。</p>

<p align="center"><em>A Hermes Agent desktop plugin that surfaces token usage, cache-hit ratio and cost for the focused session — right in the side pane.</em></p>

<p align="center">
  <a href="./LICENSE"><img src="https://img.shields.io/badge/license-MIT-111111" alt="MIT license"></a>
  <a href="https://github.com/zeqinofound/hermes-token-cost-panel/stargazers"><img src="https://img.shields.io/github/stars/zeqinofound/hermes-token-cost-panel?color=111111" alt="GitHub stars"></a>
  <a href="https://github.com/NousResearch/hermes-agent"><img src="https://img.shields.io/badge/built%20for-Hermes%20Agent-111111" alt="Built for Hermes Agent"></a>
  <img src="https://img.shields.io/badge/JavaScript-F7DF1E?logo=javascript&logoColor=black" alt="JavaScript">
</p>

`token-cost-panel` 是 Hermes Agent 桌面应用的一个**只读侧边栏插件**，把当前聚焦会话的 token 用量拆成四路（输入总量 / 输出 / 缓存命中 / 缓存未命中），并给出缓存命中率、会话费用、余额（手动登记）与用量汇总。它是一个单文件插件——无构建、无依赖安装，复制即用。

## 特性

- **四路 token 拆分**：输入总量、输出、缓存命中、缓存未命中——字段语义与 DeepSeek 官方口径对齐（见[字段语义](#字段语义)）。
- **缓存命中率**：进度条实时展示，口径与宿主 `cache_hit_pct` 一致（`缓存命中 ÷ 输入总量`）。
- **会话费用**：四路 token × 价目表本地计算（micros 整数累加 + 四舍五入）。
- **余额**：手动登记（Hermes 无通用余额接口），仅对照费用、不参与扣减。
- **用量汇总**：会话 token 总量、API 调用次数、生成速度、上下文占用。
- **零副作用**：纯只读，不调用任何模型，不产生任何额外 token（见[无副作用](#无副作用)）。

## 安装

**要求**：已安装可用的 Hermes Agent 桌面应用。

1. 克隆仓库：

   ```bash
   git clone https://github.com/zeqinofound/hermes-token-cost-panel
   ```

2. 把 `plugin.js` 放进 Hermes 桌面插件目录：

   ```
   <HERMES_HOME>/desktop-plugins/token-cost-panel/plugin.js
   ```

   `<HERMES_HOME>` 通常是 `~/.hermes`（macOS / Linux）或 `%LOCALAPPDATA%\hermes`（Windows）。

3. 重载桌面插件（`Ctrl+K` → “Reload desktop plugins”）或重启 Hermes 桌面应用。

加载后右侧边栏新增一个 **「Token 消耗」** 面板，设置 ▸ Plugins 下新增同名设置页。

## 面板内容

| 区块 | 内容 | 数据来源 |
| --- | --- | --- |
| 头部 | 当前模型、provider、刷新按钮 | `session.stats` |
| 四路 token | 输入总量 / 输出 / 缓存命中 / 缓存未命中 | `session.stats` |
| 缓存命中率 | 进度条 + 百分比 | 由四路 token 本地计算 |
| 费用 / 余额 | 会话费用（估算）、余额（手动登记） | 本地计算 + 插件存储 |
| 汇总 | 会话 token 总量、API 调用、生成速度、上下文占用 | `session.stats` + `focusedUsage` |

## 字段语义

`session.stats` 返回的是 Hermes 归一化后的 token 桶（见 `agent/usage_pricing.py` 的 `normalize_usage`）：

| 面板标签 | 字段 | 含义 |
| --- | --- | --- |
| 输入总量 | `prompt_tokens` | 总 prompt == 未命中 + 命中 + 缓存写（即 DeepSeek 的 `prompt_tokens`） |
| 缓存命中 | `cache_read_tokens` | 命中前缀缓存的 token（DeepSeek 的 `prompt_cache_hit_tokens`） |
| 缓存未命中 | `input_tokens` | 未缓存、按全价计费的输入（DeepSeek 的 `prompt_cache_miss_tokens`） |
| 缓存写 | `cache_write_tokens` | 写入 / 创建缓存（Anthropic / OpenAI 概念；DeepSeek 恒 0） |
| 输出 | `output_tokens` | 生成的输出 token |

> **常见误区**：把 `cache_write_tokens` 当成「缓存未命中」。Hermes 把未缓存的输入落在 `input_tokens` 里，
> `cache_write_tokens` 是「缓存写入 / 创建」，DeepSeek 不返回、恒 0。面板据此把「缓存未命中」映射为
> `input_tokens`（非零、真实），而非恒 0 的 `cache_write_tokens`。

- **命中率** = 缓存命中 ÷ 输入总量（`cache_read / prompt_tokens`），与宿主 `cache_hit_pct` 同口径，不含输出。
- **会话 token 总量** = 输入总量 + 输出（含缓存读 / 写）。

## 费用与定价

`session.stats` 不返回 cost，费用由本插件按四路 token × 价目表**本地计算**，是**演示估值、不是官方账单**。

- 想要真实金额，请用插件存储的 `pricing` 键覆盖价目表：
  `{ currency, models: { "<model>": { input, cache_write, cache_read, output } } }`。
- 余额为手动登记值，仅对照、不参与扣减。

## 无副作用

插件只读 `session.stats`（本地只读 RPC）与 `host.state.focusedUsage`（响应式状态）：

- **不调用任何模型**——不产生任何 token，不注入任何上下文 / 系统提示词；
- **不修改会话数据**——不写数据库、不改会话、不碰 Hermes core；
- **仅每 2 秒轮询一次**（仅在有聚焦会话时），会话切换即时刷新；
- **余额纯手动登记**——不自动扣减。

对日常任务无影响。

## 常见问题

### token 花销准确吗？

**token 数量准确**：四路 token 直接来自宿主权威桶 `session.stats`（输入总量 = `prompt_tokens`、命中 = `cache_read_tokens`、未命中 = `input_tokens`、输出 = `output_tokens`），插件不重复采集、不改写。

**费用是演示估值，不是真实账单**：`session.stats` 不返回 cost，费用由内置演示价目表本地计算。要真实金额，用插件存储的 `pricing` 键覆盖为官方价目表。

### 有没有副作用？

没有。插件只读 `session.stats` 与 `focusedUsage`，不调用模型、不写会话数据、不碰数据库，余额纯手动登记、不自动扣减。

### 会影响日常跑任务吗？token 会增多吗？

不影响、不增多。插件零次模型调用 → 零 token 消耗；不注入任何上下文 / 系统提示词；仅每 2 秒（有聚焦会话时）一次本地只读投影。

## 目录结构

```
hermes-token-cost-panel/
├── plugin.js      # 唯一交付物（自包含，无构建步骤）
├── README.md
├── LICENSE
└── .gitignore
```

## 与 Hermes Agent 的关系

[Hermes Agent](https://github.com/NousResearch/hermes-agent) 是 Nous Research 的开源项目。本插件是运行在 Hermes 桌面运行时之上的社区侧边栏面板，仅消费宿主已采集的 `session.stats` / `focusedUsage` 数据，不修改 Hermes core。

## License

[MIT](./LICENSE)
