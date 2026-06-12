# Pi-Router 术语修正说明

## 错误理解 ❌

之前错误地将 pi-router 描述为**"双层路由"**：
- ❌ L1（通道层）：多通道故障转移
- ❌ L2（模型层）：跨模型降级
- ❌ 暗示两层协同工作

## 正确理解 ✅

Pi-router 是**单策略路由**，有两种可选策略：

### 策略 1：channelFirst（通道优先）

**定义**：同一个模型的多个通道（提供商）之间故障转移

**示例配置**：
```json
{
  "strategy": "channelFirst",
  "models": [{
    "id": "claude-opus-4-8",
    "channels": ["lan", "anthropic", "openrouter"]
  }]
}
```

**工作流程**：
1. 尝试 `claude-opus-4-8@lan`
2. 失败 → 尝试 `claude-opus-4-8@anthropic`
3. 失败 → 尝试 `claude-opus-4-8@openrouter`
4. 全部失败 → 报错（或尝试 fallbackModels）

**特点**：
- ✅ 保持模型一致性
- ✅ 优化成本（可以配置免费通道优先）
- ✅ 提高可用性（多个提供商）

---

### 策略 2：modelFirst（模型优先）

**定义**：不同模型之间按优先级故障转移

**示例配置**：
```json
{
  "strategy": "modelFirst",
  "models": [
    {
      "id": "claude-opus-4-8",
      "channels": ["anthropic"]
    },
    {
      "id": "claude-sonnet-4-6",
      "channels": ["anthropic"]
    },
    {
      "id": "claude-haiku-4-5",
      "channels": ["anthropic"]
    }
  ]
}
```

**工作流程**：
1. 尝试 `claude-opus-4-8@anthropic`
2. 失败 → 尝试 `claude-sonnet-4-6@anthropic`
3. 失败 → 尝试 `claude-haiku-4-5@anthropic`
4. 全部失败 → 报错

**特点**：
- ✅ 按能力降级（opus → sonnet → haiku）
- ✅ 成本优化（失败时用便宜模型）
- ✅ 保持可用性

---

## fallbackModels 配置

`fallbackModels` 是**可选的降级链**，可以和两种策略配合使用：

### 与 channelFirst 配合

```json
{
  "strategy": "channelFirst",
  "models": [{
    "id": "claude-opus-4-8",
    "channels": ["lan", "anthropic"],
    "fallbackModels": [{
      "id": "claude-sonnet-4-6",
      "channels": ["anthropic"]
    }]
  }]
}
```

**工作流程**：
1. 尝试 `claude-opus-4-8@lan`
2. 失败 → 尝试 `claude-opus-4-8@anthropic`
3. **全部通道失败** → 尝试 `fallbackModels`
4. 尝试 `claude-sonnet-4-6@anthropic`

### 与 modelFirst 配合

```json
{
  "strategy": "modelFirst",
  "models": [
    {
      "id": "gpt-4",
      "channels": ["openai"],
      "fallbackModels": [{
        "id": "claude-opus-4-8",
        "channels": ["anthropic"]
      }]
    }
  ]
}
```

**工作流程**：
1. 尝试 `gpt-4@openai`
2. 失败 → 尝试 `fallbackModels`
3. 尝试 `claude-opus-4-8@anthropic`

---

## 关键概念

### 没有"层级"

Pi-router **不是分层架构**：
- ❌ 不是"L1层处理通道，L2层处理模型"
- ✅ 是"选择一种策略，配置可选的降级链"

### 策略是互斥的

用户选择**一种**策略：
- `"strategy": "channelFirst"` - 通道优先
- `"strategy": "modelFirst"` - 模型优先

不是两个策略同时工作，而是二选一。

### fallbackModels 是增强

`fallbackModels` 是**可选的降级机制**：
- 无论选择哪种策略，都可以配置 fallbackModels
- 当主模型（的所有通道）都失败时，尝试降级模型
- 支持上下文迁移（AI 摘要）

---

## 术语对照表

| ❌ 错误术语 | ✅ 正确术语 | 说明 |
|------------|------------|------|
| L1 通道故障转移 | 通道故障转移 | 不要用 L1/L2 |
| L2 模型降级 | 模型降级 | 没有层级概念 |
| 双层路由 | 双策略路由 | 策略不是层 |
| L1 channels | channels | 去掉层级标记 |
| L2 model | fallback model | 更准确的描述 |
| tryL2ModelFallback | tryModelFallback | 函数名修正 |

---

## 实际场景

### 场景 1：成本优化（channelFirst）

**目标**：优先使用免费自建服务，失败时用付费 API

```json
{
  "strategy": "channelFirst",
  "sortBy": "cost",
  "models": [{
    "id": "claude-opus-4-8",
    "channels": ["lan", "anthropic", "openrouter"]
  }]
}
```

**路由顺序**：
1. lan (免费)
2. anthropic (官方价格)
3. openrouter (加价 10%)

### 场景 2：能力降级（modelFirst）

**目标**：优先用最强模型，失败时降级到弱模型

```json
{
  "strategy": "modelFirst",
  "models": [
    {"id": "claude-opus-4-8", "channels": ["anthropic"]},
    {"id": "claude-sonnet-4-6", "channels": ["anthropic"]},
    {"id": "claude-haiku-4-5", "channels": ["anthropic"]}
  ]
}
```

**路由顺序**：
1. opus（最强）
2. sonnet（中等）
3. haiku（最快最便宜）

### 场景 3：混合策略（channelFirst + fallbackModels）

**目标**：通道优先 + 模型降级保底

```json
{
  "strategy": "channelFirst",
  "models": [{
    "id": "claude-opus-4-8",
    "channels": ["lan", "anthropic"],
    "fallbackModels": [{
      "id": "claude-sonnet-4-6",
      "channels": ["anthropic", "openrouter"]
    }]
  }]
}
```

**路由顺序**：
1. claude-opus-4-8@lan
2. claude-opus-4-8@anthropic
3. **（主模型全失败）** → 生成上下文摘要
4. claude-sonnet-4-6@anthropic
5. claude-sonnet-4-6@openrouter

---

## 代码架构

### 核心函数

```typescript
// 路由入口
function routeRequest(
  routerModel: any,
  context: Context,
  options: SimpleStreamOptions | undefined,
  config: RouterConfig,
  modelMap: Map<string, PiModel>,
  _pi: any
): AssistantMessageEventStream

// 通道故障转移
async function tryChannelFailover(
  channels: string[],
  modelId: string,
  context: Context,
  ...
): Promise<AssistantMessageEventStream>

// 模型降级
async function tryModelFallback(  // 之前错误地叫 tryL2ModelFallback
  fallbackModels: FallbackModel[],
  ...
): Promise<AssistantMessageEventStream>
```

### 决策流程

```
用户请求
    ↓
选择策略 (channelFirst 或 modelFirst)
    ↓
根据策略排序通道/模型
    ↓
逐个尝试
    ↓
全部失败？
    ↓
有 fallbackModels？
    ↓ 是
生成上下文摘要（三级 fallback）
    ↓
尝试降级模型
    ↓
成功或最终失败
```

---

## 修正历史

### v0.3.0-alpha.1 (2026-06-12)

**问题**：
- 代码和文档中使用了 L1/L2 术语
- 暗示了"双层架构"概念
- 与实际设计不符

**修正**：
- 移除所有 L1/L2 引用
- 使用 channelFirst/modelFirst 术语
- 强调"双策略"而非"双层"
- 更新所有文档和注释

**影响范围**：
- index.ts (代码和注释)
- ARCHITECTURE.md
- README.md + README.zh-CN.md
- CHANGELOG.md
- DEVELOPMENT_SUMMARY.md
- TESTING.md
- SUMMARY_FALLBACK.md

**总计**：
- 7 个文件
- ~50 处修改
- 术语完全统一

---

## 总结

### 核心设计

Pi-router 提供**两种路由策略**：
1. **channelFirst**: 多通道故障转移（同模型）
2. **modelFirst**: 多模型故障转移（不同模型）

### 增强机制

- **fallbackModels**: 可选的模型降级链
- **上下文迁移**: AI 摘要生成（三级 fallback）
- **熔断器**: 防止频繁重试故障通道
- **健康探测**: 后台检测通道可用性

### 设计原则

- ✅ 单一策略选择（非分层）
- ✅ 可扩展降级机制
- ✅ 灵活配置
- ✅ 完整可观测性

---

**作者**: Jiang Jilin  
**版本**: v0.3.0-alpha.1  
**更新**: 2026-06-12  
**Commit**: 91b6d0a
