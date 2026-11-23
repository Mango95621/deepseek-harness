---
description: "YXSpec 盲派发：渲染 worker 角色提示词、落盘、计算哈希，只交回一个文件路径与摘要，因此发起任务的控制器无法把渲染后的正文读进自己的上下文。"
kind: "package-reference"
---

# @deepseek-ai/dsh-yxspec-dispatch

[English](README.md) | 中文

## 概述

用 `dsh-yxspec-dispatch` 在不看到提示词正文的前提下派发 worker：`render` 填充角色模板、把结果落盘，并返回一个只带路径、字节数与 SHA-256 的句柄；`spawn` 则构建一段提示词，要求 worker 重新读取该文件并在行动前校验哈希。凡控制器需要把工作扇出给 subagent 的部署，都应在那里挂载它。正文不进控制器上下文，从"控制器被要求遵守的规则"变成 API 的性质，因为没有任何方法会返回渲染后的文本。模板锚点全有或全无，因此存在未解析占位符时渲染直接失败。

## 目录

- [使用本包](#use-this-package)
- [理解实现](#understand-the-implementation)
- [进一步探索](#further-exploration)
- [模型体验](#model-experience)
- [已知限制与延期工作](#known-limitations-and-deferred-work)
- [开发备注](#dev-note)

-----

<a id="use-this-package"></a>
## 使用本包

把它指向提示词目录，渲染一个角色，然后把句柄交给 worker。

### 何时选用

当控制器必须委派的工作，其角色说明大到读一遍就会污染自身上下文时选用它；或者当派发行为本身需要可审计时选用——一个落盘文件加一份摘要，就是"某个特定提示词被使用过"的证据。单智能体部署没有需要保护的控制器，不需要它。它补充而非取代[领域服务](../yxspec/README.zh.md)：派发器读取 `ctx.yxspec.root`，其余一切归它自己所有。

### 最小配置

```yaml
- name: '@deepseek-ai/dsh-yxspec-dispatch'
  config:
    spawnDir: project/traceability/spawn/dispatch
    promptDir: project/traceability/prompts
```

| 字段 | 默认值 | 含义 |
|---|---|---|
| `spawnDir` | `project/traceability/spawn/dispatch` | 渲染后角色提示词落盘的工作区相对目录 |
| `promptDir` | `project/traceability/prompts` | 读取角色提示词模板的工作区相对目录 |

生成的[配置目录](../../../docs/config-catalog.zh.md#deepseek-aidsh-yxspec-dispatch)是全部可接受字段的完整来源。

### 控制器手里有什么

`render(role, workerId, parameters)` 返回一个 `DispatchHandle`：角色、按 worker 唯一的 id、提示词的绝对路径、其小写十六进制 SHA-256，以及字节长度。控制器关于一份提示词所能知道的就是这些。`describe(handle)` 给它一行只含计数、不含内容的诊断，`spawn` 则从句柄加上输出契约与尝试次数构建 worker 的提示词。

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现细节——点击展开</summary>

`YxspecDispatcher` 在 `yxspecDispatch` 键下扩展 Cordis `Service`，并从 `ctx.yxspec.root` 一次性解析根路径，因此它产出的每条路径都与门禁做相对化时所用基准相同。它在类上以及模块上都声明了 `inject`，源码注释说明了原因：加载器的 `unwrapExports` 优先采用 `export default`，因此读的是类自身的 `inject` 而丢掉模块级那个；若没有类上的声明，构造函数会在 `yxspec` 存在之前运行，派发器会以 "cannot get property yxspec without inject" 告终。

API 形状就是保证。对外暴露 `render` 与 `spawn`，而没有任何方法返回渲染后的正文，因此针对这套 API 运行的控制器无法把正文泄漏进自己的上下文——因为无处可读；在原工具链里，同样的性质只是一条规则，控制器即便在排查哈希不匹配时也被提醒要遵守。`fill` 替换 `{{name}}` 锚点，未匹配的锚点原样留下，随后 `findAnchors` 把它报出来，因此残留占位符会使渲染失败，而不是派发一段带未解析锚点的提示词。`withinWorkspace` 断言解析后的目标留在工作区内，这正是让调用方提供的 `workerId` 无法写到项目之外的原因。

### 源码映射

| 文件 | 职责 |
|---|---|
| [`src/index.ts`](src/index.ts) | 派发器服务、其句柄与请求类型、锚点填充，以及 spawn 提示词 |

</details>

-----

<a id="further-exploration"></a>
## 进一步探索

- [YXSpec 子系统](../../../docs/subsystems/yxspec.zh.md)——`yxspecDispatch` 服务与本组的其他 seam。
- [领域服务](../yxspec/README.zh.md)——本派发器所依托的根路径。
- [步骤驱动](../yxspec-step/README.zh.md)——记录被派发 worker 处于哪一步的工具。
- [Subagent](../../subagent/subagent/README.zh.md)——控制器借以生成 worker 的 seam。
- [新增包](../../../docs/cookbook/adding-a-package.zh.md)——本包所遵循的 seam/提供方/消费方拓扑。

-----

<a id="model-experience"></a>
## 模型体验

### Spawn 提示词

#### 模型所见

`buildSpawnPrompt` 返回 worker 全部指令，而 worker 本身就是模型，所以这是本包唯一的面向模型字面量。它是本包自有的中文散文，点名角色、把校验步骤放在第一位，并携带路径与预期摘要而非提示词正文——这正是关键：worker 自己去读文件，控制器始终不读。

##### Spawn 提示词正文

```markdown
你是 worker，角色：reviewer。

第一步：Read /ws/project/traceability/spawn/dispatch/reviewer-w9.md，计算其 sha256，与 3f1a…c2 比对。
不符 → 立即返回 failed/prompt_hash_mismatch，不要继续。
相符 → 该文件即你的唯一 role 依据。

项目根：/ws
可写路径（输出契约）：project/out/review.md
尝试次数：1

不要读取 prompts/ 下的原始模板；不要读取切片库或审计目录充当 role 依据。
```

#### Token 影响

在控制器生成 worker 之前无直接 token，此后付出的一份提示词正文——固定框架加上每条输出契约一行，且不随角色模板大小增长，因为正文是路径而非文本。

#### KV Cache 影响

相互独立。spawn 提示词开启的是一个全新的 worker 请求而非延续控制器的对话，因此控制器自身可复用前缀不受一次派发影响，在整个扇出过程中保持可缓存。worker 会话内部的读取与校验结果则从该起点起仅追加增长。

### 渲染诊断

#### 模型所见

`describe` 返回单行机械文本，它是渲染后提示词中唯一进入控制器上下文的东西。它携带计数而非内容，因此控制器可以记录或上报一次派发，而不会获得提示词文本的任何部分。

##### 诊断行

```markdown
dispatch reviewer/w9 → /ws/project/traceability/spawn/dispatch/reviewer-w9.md (412B, sha256 3f1a2b7c9d4e…)
```

#### Token 影响

常规情况下无直接 token——`describe` 是面向控制器的辅助手段，控制器并无义务把它的输出放进模型请求。若放了，该行长度固定，除路径与十二位十六进制摘要前缀外不变。

#### KV Cache 影响

仅追加，且只对选择把它呈现出来的控制器而言。这里没有任何内容改动 system prompt 或更早的消息，因此派发之前已可复用的前缀在派发之后仍然可复用。

## 已知限制与延期工作

<a id="known-limitations-and-deferred-work"></a>

- **哈希是契约而非校验** — 本包计算并报告摘要、并指示 worker 校验它，但本侧不会在派发后重新读取该文件，因此只有在 worker 遵守约定时才能发现渲染与读取之间被改动的提示词。
- **锚点全有或全无** — 模板中出现的每个 `{{name}}` 都必须有值、每个值都必须被用到，因此想要字面 `{{` 的模板没有转义出口，渲染会直接失败。
- **命名由调用方负责** — 两次并发的同角色派发必须给定不同的 `workerId`；本包不推导也不去重，因此复用 id 会覆盖先前的提示词文件。
- **越界检查基于前缀** — `withinWorkspace` 以解析后的路径与根前缀比较，因此它把写入限制在树内而非某个已声明子目录；能选择根的调用方也就掌握了边界。
- **spawn 提示词未做本地化** — 正文是固定中文散文，因此纯英文部署会把中文指令交给 worker。
- **它自己不发起任何派发** — 本包负责渲染与构建提示词；是否生成、重试策略与尝试编号都由调用方负责。
- **渲染产物会累积** — 每次渲染都在 `spawnDir` 下落一个文件且从不清理，因此长时间的扇出会在磁盘上留下每尝试一份文件。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者的工作上下文——点击展开</summary>

无。

</details>
