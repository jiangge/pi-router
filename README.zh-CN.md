# pi-router

Pi 的智能路由层，提供多级故障转移与可观测性。

[English](./README.md) | 简体中文

## 目录

- [特性](#特性)
- [快速开始](#快速开始)
- [命令](#命令)
- [工作原理](#工作原理)
- [配置参考](#配置参考)
- [性能](#性能)
- [卸载](#卸载)
- [架构](#架构)
- [延伸阅读](#延伸阅读)
- [许可](#许可)

## 特性

- **Auto Router 模式** — 选择 `router/auto` 即可全自动路由
- 同一模型跨多个提供商的通道故障转移
- 模型降级与上下文迁移
- 按延迟、能力、成本或手动顺序的智能路由
- 熔断器与冷却保护
- **持久化粘性路由** — 记住上次成功的通道，重启后仍有效
- 决策日志、延迟追踪与健康监控
- 底部状态栏显示当前活跃的提供商通道
- 所有命令支持交互式菜单和 Tab 补全
- 交互式配置向导
- 延迟加载与缓存，快速启动

## 快速开始

### 1. 安装

```bash
# 从 npm 安装（发布后）
pi install npm:pi-router

# 或从 GitHub 安装
pi install git:github.com/jiangjilin/pi-router

# 或从本地目录安装（开发用）
pi install /path/to/pi-router
```

详见 [INSTALL.md](INSTALL.md)。

### 2. 配置

推荐：运行交互式向导。

```bash
/router config wizard
```

向导步骤：

1. 路由策略（`channelFirst` / `custom`）
2. 排序策略（`latency` / `capabilityFirst` / `cost` / `manual`）
3. 自动同步（`启用` / `禁用`）
4. 健康探测（`10 分钟` / `禁用`）
5. 粘性模式（`启用` / `禁用`）
6. 可选：调整通道顺序

**渠道分类**：向导会自动将渠道分为三类：

- 🔵 **OAuth**（官方）- AI 提供商的官方 API 端点（如 `api.anthropic.com`、`api.deepseek.com`）
- 🟡 **Aggregator**（第三方）- 第三方聚合服务
- 🟢 **Free**（本地）- 本地部署和免费服务

分类依据：
- `auth.json` 中的 OAuth 标记（`type: "oauth"`）
- 官方域名白名单（覆盖 40+ 提供商，包括 Anthropic、OpenAI、Google、DeepSeek、Qwen、GLM、Kimi 等）
- 本地 URL 检测（`localhost`、`127.0.0.1`）

配置文件路径：

```text
~/.pi/agent/pi-router.json
```

高级用户可直接编辑配置文件。同时会生成参考说明文件：

```text
~/.pi/agent/pi-router.README.md
```

参考配置示例见 [examples/router.config.json](examples/router.config.json)。

### 3. 使用

在 pi 中选择 Auto Router 模型：

```text
/model router/auto
```

所有请求将按你配置的策略和模型链自动路由。

也可以选择特定模型的路由版本：

```text
/model router/your-model-id
```

pi-router 会：

- 按策略顺序尝试通道
- 出错时自动故障转移
- 应用熔断器与冷却规则
- 可选降级到备用模型
- 记录健康状态和延迟信息
- 在底部状态栏显示活跃通道（如 `via anthropic`）
- 记住上次成功的路由，下次优先使用（粘性模式）

## 命令

直接运行 `/router` 打开交互式菜单，或使用 Tab 补全。

### 配置

```text
/router config wizard    # 交互式配置向导
/router config order     # 仅调整已有模型/渠道顺序
/router config show      # 显示当前配置
/router config reset     # 重置为默认配置
```

快捷方式：

```text
/router config w         # = wizard
/router config o         # = order
/router config s         # = show
/router config r         # = reset
```

### 监控

```text
/router status           # 显示配置摘要
/router list             # 列出已配置的路由模型
/router explain          # 显示故障、延迟、健康、熔断状态
/router decisions        # 显示最近的路由决策
/router probes           # 显示后台健康探测结果
/router pricing          # 显示各通道定价明细
```

### 粘性路由

```text
/router sticky           # 显示当前粘性路由记录
/router sticky clear     # 清除所有粘性记录（从头开始路由）
/router sticky clear <m> # 清除指定模型的粘性记录
```

### 管理

```text
/router sync             # 检查 models.json 变更
/router sync accept      # 应用检测到的变更
/router diff             # 预览配置差异
```

## 工作原理

### Auto Router（`router/auto`）

选择 `router/auto` 时，pi-router 管理完整的模型链：

```text
用户请求: router/auto
    ↓
检查粘性记录 → 找到 "model-X@channel-Y"？
    ↓ 是                     ↓ 否
优先尝试粘性路由          按策略顺序路由
    ↓ 失败                   ↓
清除粘性，回退到策略顺序
    ↓
channelFirst: Model-A[ch1,ch2,ch3] → Model-B[ch1,ch2] → ...
custom:       按 customOrder 中显式配置的 model@channel 顺序尝试
    ↓
成功: 更新粘性记录，流式返回响应
    ↓
底部状态栏显示: via <channel-name>
```

### 同模型，不同提供商

示例：

```text
尝试通道: Provider-A -> Provider-B -> Provider-C
```

典型流程：

```text
用户请求: router/example-model
    ↓
路由器拦截
    ↓
尝试 Provider-A -> Provider-B -> Provider-C
- 检查冷却
- 检查熔断器
- 转发到真实提供商
- 出错: 记录故障，尝试下一个
    ↓
所有通道失败，尝试备用模型
    ↓
流式返回事件给用户
```

### 粘性模式

粘性模式记住上次成功的路由，下次优先尝试：

```text
请求 1: Provider-A 成功 → sticky = Provider-A
请求 2: 优先尝试 Provider-A → 成功
请求 3: Provider-A 失败 → 清除粘性, 尝试 Provider-B → 成功 → sticky = Provider-B
请求 4: 优先尝试 Provider-B
...
（重启 pi 后仍有效）
```

使用 `/router sticky clear` 重置粘性，从头开始路由。

### 熔断器

```text
失败次数: 0 -> 1 -> 2 -> 3 -> 4 -> 5 (开启)
    ↓
在冷却窗口内阻断请求
    ↓
半开: 允许一次测试请求
    ↓
成功 -> 关闭
失败 -> 再次开启
```

### 上下文迁移

切换模型时：

1. `summary` 模式：对对话进行摘要
2. 如需要，清理不兼容的上下文字段
3. 将适配后的上下文转发给备用模型

## 配置参考

### 主配置文件

```text
~/.pi/agent/pi-router.json
```

### 常见配置

```json
{
  "strategy": "channelFirst",
  "sortBy": "latency",
  "autoSync": true,
  "sticky": true,
  "healthProbe": {
    "enabled": false
  },
  "models": [
    {
      "id": "example-model",
      "channels": ["Provider-A", "Provider-B", "Provider-C"]
    }
  ]
}
```

### 全局选项

```json
{
  "strategy": "channelFirst",
  "auto": true,
  "sortBy": "latency",
  "autoSync": true,
  "sticky": true,
  "request": {
    "timeoutMs": 120000,
    "maxRetries": 0,
    "maxRetryDelayMs": 1000,
    "maxTokens": 32768
  },
  "footer": {
    "rightAlignRoute": true,
    "statusLine": true
  },
  "contextTransfer": "summary",
  "summaryModel": "optional-summary-model",
  "summaryPrompt": "optional custom prompt",
  "summaryMaxTokens": 2000,
  "failover": {
    "cooldownMs": 60000
  },
  "healthProbe": {
    "enabled": true,
    "intervalMs": 600000,
    "timeoutMs": 10000,
    "probeMessage": "ping"
  }
}
```

Footer 默认行为：

- `footer.rightAlignRoute` 默认 `true`：当 router 状态活跃时，pi-router 会替换 pi 的 footer，以便右对齐路由状态
- 将 `footer.rightAlignRoute` 设为 `false` 可保留 pi 内置 footer 布局
- `footer.statusLine` 默认 `true`：禁用替换 footer 时，pi-router 仍会显示简短的内置状态项
- 将 `footer.statusLine` 设为 `false` 可关闭该 fallback 状态项

### 摘要 AI 的默认行为

默认行为：

- 不要求设置 `summaryModel`
- 如果当前上下文能装进目标模型的上下文窗口，pi-router 跳过摘要生成，直接转发完整上下文
- 需要摘要时若未设置 `summaryModel`，pi-router 优先使用目标模型生成摘要
- 如果 AI 摘要生成失败，pi-router 回退到纯文本非 AI 摘要路径
- `summaryMaxTokens` 默认为 `2000`

可选的专用摘要 AI 配置：

```json
{
  "contextTransfer": "summary",
  "summaryModel": "cheap-summary-model",
  "summaryPrompt": "Summarize the conversation for model handoff.",
  "summaryMaxTokens": 2000
}
```

`summaryModel` 支持两种格式：

- `model-id`
- `model-id@provider`

### 单模型选项

```json
{
  "id": "example-model",
  "channels": ["Provider-A", "Provider-B"],
  "sticky": true,
  "sortBy": "latency",
  "contextTransfer": "summary",
  "fallbackModels": [
    {
      "id": "fallback-model",
      "channels": ["Provider-A", "Provider-B"]
    }
  ],
  "failover": {
    "cooldownMs": 30000
  }
}
```

### 手动编辑

可直接编辑 `~/.pi/agent/pi-router.json`。

编辑后：

```text
/reload
```

或重启 pi。

## 性能

pi-router 针对快速启动和最小开销进行了优化。

### 启动优化

- 智能文件哈希缓存
- 延迟加载 `models.json`
- 延迟启动健康探测
- 减少重复文件 I/O

### 典型提升

| 场景 | 优化前 | 优化后 | 提升 |
|------|--------|--------|------|
| 热缓存 | ~50-80ms | ~5-15ms | ~80% |
| 冷缓存 | ~50-80ms | ~30-50ms | ~40% |
| autoSync 禁用 | ~30-50ms | ~5-10ms | ~80% |
| healthProbe 禁用 | ~40-60ms | ~5-15ms | ~75% |

详见 [PERFORMANCE_OPTIMIZATION.md](PERFORMANCE_OPTIMIZATION.md)。

## 卸载

```bash
# npm 安装
pi remove npm:pi-router

# git 安装
pi remove git:github.com/jiangjilin/pi-router

# 本地安装
pi remove /path/to/pi-router
```

配置文件不会自动删除。

```bash
rm -f ~/.pi/agent/pi-router.json ~/.pi/agent/pi-router.README.md
```

## 架构

详见 [ARCHITECTURE.md](./ARCHITECTURE.md)。

## 延伸阅读

- [INSTALL.md](./INSTALL.md)
- [TESTING.md](./TESTING.md)
- [ARCHITECTURE.md](./ARCHITECTURE.md)
- [CHANGELOG.md](./CHANGELOG.md)

## 许可

MIT

## 致谢

基于 [pi coding agent](https://github.com/pi-agi/pi-coding-agent) 扩展 API 构建。
