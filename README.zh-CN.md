# pi-router

**Pi 智能路由层 - 多级故障转移与可观测性**

[English](./README.md) | 简体中文

## 特性

- 🔄 **通道故障转移**：同模型不同提供商（lan → n1-claude → run-claude）
- 🎯 **模型降级**：跨模型故障转移，支持上下文迁移（opus → sonnet → gemini）
- 🧠 **智能路由**：基于延迟、成本、能力的通道选择
- 🛡️ **熔断器**：快速失败机制，自动恢复检测
- 📊 **可观测性**：决策日志、延迟追踪、健康监控
- 💾 **粘性模式**：优先使用上次成功的通道，优化缓存命中
- ⏱️ **冷却机制**：故障后防止重试风暴

## 快速开始

### 1. 安装

```bash
npm install pi-router
# 或
yarn add pi-router
```

### 2. 配置

编辑 `~/.pi/agent/pi-router.json`：

```json
{
  "strategy": "channelFirst",
  "auto": true,
  "sticky": true,
  "contextTransfer": "summary",
  "sortBy": "latency",
  "models": [
    {
      "id": "claude-opus-4-8",
      "channels": ["lan", "n1-claude", "run-claude"],
      "fallbackModels": [
        { "id": "claude-sonnet-4-6", "channels": ["lan"] }
      ]
    }
  ]
}
```

### 3. 使用

在 pi 中选择 router 模型：

```
模型：router/claude-opus-4-8
```

Pi-router 会自动：
- 按顺序尝试通道（智能排序）
- 遇到错误自动切换
- 应用熔断器和冷却机制
- 必要时降级到备选模型
- 追踪性能和健康状态

## 命令

```
/router status       # 显示当前配置
/router list         # 列出可用模型
/router explain      # 显示故障、延迟、健康、熔断器状态
/router decisions    # 显示最近的路由决策
/router probes       # 显示后台健康探测结果
/router pricing      # 显示每个通道的定价明细
/router sync         # 检查模型变更
/router sync accept  # 应用检测到的变更
```

## 工作原理

```
用户请求：router/claude-opus-4-8
    ↓
Router 拦截请求
    ↓
尝试通道：lan → n1-claude → run-claude
├─ 检查冷却期
├─ 检查熔断器
├─ 转发到真实提供商
└─ 出错时：记录、尝试下一个
    ↓
所有 L1 失败？尝试 L2 降级
├─ 生成上下文摘要
├─ 清理兼容性问题
└─ 转发到 claude-sonnet-4-6@lan
    ↓
流式返回给用户
├─ 记录首 token 延迟
├─ 更新健康状态
└─ 记录路由决策
```

## 核心概念

### 粘性模式

优先使用上次成功的通道以最大化缓存命中：

```
请求 1：lan（成功）→ sticky = lan
请求 2：优先尝试 lan（缓存命中！）
请求 3：lan 失败 → 尝试 n1-claude → sticky = n1-claude
请求 4：优先尝试 n1-claude（缓存保留）
```

### 熔断器

快速失败机制防止持续请求失败的通道：

```
失败次数：0 → 1 → 2 → 3 → 4 → 5（开启）
    ↓
阻塞请求 2 分钟
    ↓
半开状态：允许 1 次测试请求
    ↓
成功？→ 关闭（重置）
失败？→ 开启（再等 2 分钟）
```

### 上下文迁移

切换模型时（L2 降级）处理不兼容问题：

1. **摘要模式**：AI 生成对话摘要（~500 tokens）
2. **清理**：处理 system message / role 不兼容
3. **转发**：使用修改后的上下文到备选模型

## 可观测性

### /router explain

```
活跃通道：
  claude-opus-4-8 → lan

活跃冷却期：
  claude-opus-4-8@n1-claude：剩余 45s

最近故障：
  claude-opus-4-8@n1-claude（52秒前）：连接超时

通道延迟（最近 10 次平均）：
  claude-opus-4-8@lan：523ms（10 次采样）
  claude-opus-4-8@n1-claude：1247ms（8 次采样）

通道健康：
  claude-opus-4-8@lan：✓ 健康（5秒前检查）
  claude-opus-4-8@n1-claude：✗ 不健康（3 次失败）

熔断器：
  🔴 opus@n1-claude：开启（5 次失败，87秒后重试）
```

### /router decisions

```
最近路由决策（最近 20 条）：

claude-opus-4-8 -> lan (523ms)（12秒前）
  策略：sticky | 首选

claude-opus-4-8 -> run-claude (1847ms)（45秒前）
  策略：sticky | 2 次失败后降级
  尝试过：lan -> n1-claude -> run-claude
```

## 配置参考

### 全局选项

```json
{
  "strategy": "channelFirst",     // 路由策略
  "auto": true,                   // 自动同步 models.json 变更
  "sticky": true,                 // 优先使用上次成功的通道
  "contextTransfer": "summary",   // "none" | "full" | "summary"
  "sortBy": "latency",            // "config" | "latency" | "cost"
  "summaryPrompt": "...",         // 自定义摘要提示词
  "failover": {
    "cooldownMs": 60000           // 冷却时长（默认 60 秒）
  },
  "healthProbe": {
    "enabled": true,              // 启用后台健康探测
    "intervalMs": 300000,         // 探测间隔（默认 5 分钟）
    "timeoutMs": 10000,           // 探测超时（默认 10 秒）
    "probeMessage": "ping"         // 简单测试消息
  }
}
```

### 单模型选项

```json
{
  "id": "claude-opus-4-8",
  "channels": ["lan", "n1-claude", "run-claude"],
  "sticky": true,                 // 覆盖全局 sticky
  "sortBy": "latency",            // 覆盖全局 sortBy
  "contextTransfer": "summary",   // 覆盖全局 contextTransfer
  "fallbackModels": [
    {
      "id": "claude-sonnet-4-6",
      "channels": ["lan", "run-claude"]
    }
  ],
  "failover": {
    "cooldownMs": 30000           // 覆盖全局冷却时长
  }
}
```

## 架构

详见 [ARCHITECTURE.md](./ARCHITECTURE.md)（英文）了解技术设计。

## 开发状态

**v0.3.0-alpha** - 成本优化：
- ✅ 按通道定价与倍率
- ✅ 基于成本的通道排序
- ✅ 免费自建通道检测
- ✅ /router pricing 命令

**v0.2.0-alpha** - 增强功能：
- ✅ 真实 AI 摘要生成
- ✅ 后台健康探测
- ✅ 主动熔断器恢复
- ✅ 增强的可观测性

**v0.1.0-alpha** - 核心功能完成：
- ✅ 通道故障转移
- ✅ 模型降级
- ✅ 熔断器
- ✅ 延迟追踪
- ✅ 健康监控
- ✅ 决策日志
- ✅ 完整命令集

**v0.4.0** - 计划中：
- 单元测试
- 决策分析
- 单元测试

## 安装指南

详见 [INSTALL.md](./INSTALL.md)（英文）。

## 变更日志

详见 [CHANGELOG.md](./CHANGELOG.md)（英文）。

## 许可

MIT License - 详见 [LICENSE](./LICENSE) 文件。

## 致谢

基于 [pi coding agent](https://github.com/pi-agi/pi-coding-agent) 扩展 API 构建。
