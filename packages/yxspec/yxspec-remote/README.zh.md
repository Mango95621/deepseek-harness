---
description: "YXSpec 流程的远程编译验证：声明一台构建服务器，然后在该机器已有的检出目录内运行一个具名配方，读回退出码、日志、源码版本与所点名的产物。"
kind: "package-reference"
---

# @deepseek-ai/dsh-yxspec-remote

[English](README.md) | 中文

## 概述

用 `dsh-yxspec-remote` 让"编译通过"成为转录记录无法伪造的事实：声明一台构建服务器，在该机器已有的检出目录内运行它的一个具名配方，读回退出码、日志、源码版本与调用方点名的产物。这里不上传任何东西——车机源码树动辄数百 GB——因此 harness 从不创建、替换或删除它所编译的那棵树。凡要求后续阶段开始前必须有一次绿色远程编译的部署都应挂载它：配方是声明出来的而非现场书写的，模型选的是配方 id，每次运行都作为持久证据被记录。

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

先声明一次服务器——点名构建机上已存在的检出目录——然后在流程走到各个验证点时运行它的配方。

### 何时选用

当编译需要一台智能体主机之外的机器时选用它——例如从 Windows 访问 Linux 构建农场的 AOSP 或 Yocto 树，或任何开发机无法承载其工具链的编译——且那台机器上已经有源码，由团队既有的同步或 CI 保持最新。只存在于开发机上的树不是这条 seam 的场景：每次运行拉取数百 GB 比编译本身更贵。本地完成编译的部署不需要它，而[流程面板](../../client/ui-yxspec/README.zh.md)的引导向导仍会渲染"尚未声明服务器"的空状态，因为 [Remote owner](../yxspec-api/README.zh.md) 把这条 seam 视为可选。凭据从不属于配置的一部分：目标是交给主机自身 `~/.ssh/config` 解析的 OpenSSH 目标，因此操作者已有的密钥、agent 与跳板机原样生效。

### 最小配置

```yaml
- name: '@deepseek-ai/dsh-yxspec-remote'
```

| 字段 | 默认值 | 含义 |
|---|---|---|
| `sshExecutable` | 探测得到的平台默认值 | 所有声明共用的本地 `ssh`（声明自己填了则以声明为准）——部署指向包装客户端的唯一位置 |
| `tarExecutable` | 探测得到的平台默认值 | 用于展开取回产物的本地 `tar` 绝对路径 |
| `logMaxBytes` | `2097152` | 本次运行返回日志的字节预算 |
| `probeTimeoutMs` | `60000` | 单次连接测试的墙钟预算，与声明的每次运行预算相互独立 |
| `fetchMaxBytes` | `536870912` | 单次取回产物的字节上限，在流式传输过程中即生效 |

生成的[配置目录](../../../docs/config-catalog.zh.md#deepseek-aidsh-yxspec-remote)是全部可接受字段的完整来源。

### 声明一台服务器

一次声明给出目标、编译工程目录与配方映射（每条 recipe 可各自给出产物目录）。探测是一次往返：报告平台、工程目录是否存在、产物目录是否已存在；向导的"测试连接"控件调用它，其结果存在声明上，因此之后列表渲染出的那一行描述的是**最近一次尝试**，而不是最近一次成功。

工程目录不存在时，报告会带上真正存在的那个路径：探测同时测试该路径在登录目录下的同名位置，因为按 Windows 共享写法（`\\host\user\projects\x`）填写的声明在机器上并不存在——共享名对应用户家目录——而操作者需要的正是"该填什么"这个答案。若那个位置也没有，缺失信息会带上登录目录，两次拼写不用另开会话就能比对。只有映射点名的配方才可能被运行，这正是模型的"选择"而非"书写命令"的由来。该服务还向宿主消费方暴露 `list`、`server`、`forget`、`probe`、`run`、`runsFor` 与 `lastSuccess`，其中 `runsFor` 供后续阶段确认某个配方是否已针对指定项目树完成验证。

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现细节——点击展开</summary>

服务之前有三个面向模型的工具——`remote_server_list`、`remote_server_declare` 与 `remote_build`——它们是智能体通往构建服务器的唯一路径。这是刻意的：一次构建就是一次工具调用，因此会经过[阶段门禁](../yxspec-gate/README.zh.md)所挂接的同一条 `tools` 管线，阶段也就能够要求远程构建为绿后才允许后续阶段开始。服务自身声明 `inject = ['subprocess', 'storageDomain']`——它不读取任何本地项目，因为它编译的树属于服务器——两张持久表都放在存储域而非项目自己的 JSON 里，因为验证记录不得被它所审计的智能体改写。

声明是"选"出来的而不是"打"出来的：`browse` 列出服务器上某个路径下的目录，向导因此可以先连上、再把看到的东西摆给操作者。它点名的是 destination 而不是声明——操作者在"能命名它的那条声明"存在之前就要选目录——并且每次往返只读一个目录：`cd` 之后的 `pwd`，再加上子目录；会多请求一条以判断是否被上限截断。不写入任何东西，也不读所点目录之外的任何内容。

在 Windows 上 `ssh.ts` 走了另一条路——dsh 自带的 SSH 运行时拒绝任何非 Linux、非 macOS 客户端——它按步骤调用平台自带的 OpenSSH 客户端，并通过 `ctx.subprocess` 读回退出事实。三个可独立诊断的步骤依次执行：一次 `ssh` 在声明要求时读取服务端源码版本，第二次在工程目录内运行配方，第三次把点名的产物以 `tar.gz` 流式取回并在本地展开。字节只有一个方向：产物回来，源码从不出去。

这些目录属于操作者，因此不由任何东西推导：recipe 未给 `outputDirectory` 时，每次运行解析为 `<工程目录>/out`，这样约定日后变动也不会被写进此前每一行记录里。它挂在 recipe 而非服务器上，因为同一棵树的整编与局部编译产物落在不同位置，一台机器一个目录只能描述其中之一。取回时路径相对该产物目录，服务在传输开始前就拒绝绝对路径、`~` 与任何 `..` 成分，因此取回产物不会变成读取该机器任意文件的手段。`recipe.ts` 是唯一构建远程命令行的位置：`renderRecipe` 替换 `{cwd}` 与 `{out}`，前置 `set -e` 使写成 `a; b` 的模板在第一步就停下而不是报最后一条命令的状态，并显式 `cd` 使配方不依赖 ssh 的登录目录——也让工程目录不存在时以点名的路径失败。

### 源码映射

| 文件 | 职责 |
|---|---|
| [`src/index.ts`](src/index.ts) | 服务本体、其配置，以及三个面向模型的工具 |
| [`src/spec.ts`](src/spec.ts) | 构建服务器与运行台账的存储域声明 |
| [`src/ssh.ts`](src/ssh.ts) | `ssh` 传输、版本读取、产物取回及其驱动的子进程能力 |
| [`src/recipe.ts`](src/recipe.ts) | 唯一的命令行渲染器 |
| [`src/types.ts`](src/types.ts) | 已声明服务器、运行请求、运行结果与探测的词汇表 |

</details>

-----

<a id="further-exploration"></a>
## 进一步探索

- [YXSpec 子系统](../../../docs/subsystems/yxspec.zh.md)——`yxspecRemote` 服务与 `yxspec/remote-run` 事件。
- [Remote owner](../yxspec-api/README.zh.md)——把声明投影到浏览器的只读命名空间。
- [阶段门禁](../yxspec-gate/README.zh.md)——构建调用所经过的钩子，也是阶段得以要求绿色运行的原因。
- [存储域](../../storage/storage-domain/README.zh.md)——声明与运行台账所在的持久表。
- [子进程](../../subprocess/subprocess/README.zh.md)——OpenSSH 传输所驱动的 seam。
- [新增包](../../../docs/cookbook/adding-a-package.zh.md)——本包所遵循的 seam/提供方/消费方拓扑。

-----

<a id="model-experience"></a>
## 模型体验

### 构建服务器工具

#### 模型所见

三个已注册工具是唯一的面向模型表面。它们的描述是固定散文，模型在每一次提供它们的机会里都会读到；其结果以共享渲染器输出的规范 JSON 抵达，因此模型对每个工具读到一种稳定形状，而不是手写的句子；构建失败作为数据而非工具错误返回，因为读 `exitCode` 与 `log` 正是运行它的目的。`remote_build` 的结果就是阶段证据所依托的形状。

##### 成功的运行结果

```markdown
{
  "ok": true,
  "workspaceId": "ws_01",
  "serverId": "aosp-builder",
  "recipe": "ninja-full",
  "projectDirectory": "/srv/aosp",
  "outputDirectory": "/srv/aosp-out",
  "command": "set -e; cd '/srv/aosp'; ninja -C /srv/aosp-out",
  "exitCode": 0,
  "log": "…",
  "truncated": false,
  "timedOut": false,
  "durationMs": 40213,
  "revision": "a3f9c1e…",
  "revisionDigest": "7b1d…",
  "logSha256": "41ab…",
  "runId": "run_7"
}
```

#### Token 影响

除已存在于提供集合中的工具描述外无直接 token。每次调用随后返回一份 JSON 文档，其 `log` 受 `logMaxBytes` 限制，并由 `truncated` 报告头部已被丢弃，因此构建的噪声不会无界地撑大结果。

#### KV Cache 影响

仅追加。工具结果是 Session 日志中的普通新增，不会改写可复用前缀，因此此前对话的提供方缓存复用得以保留。本包贡献的任何内容都不改动 system prompt 或工具提供集合本身。

### 已声明服务器的声明工具

#### 模型所见

`remote_server_declare` 是写入路径，且刻意收窄：模型提供目标、编译工程目录与配方映射（每条 recipe 可选带自己的产物目录），从不提供凭据。描述明确说明凭据既不传入也不存储，这是操作者把智能体指向构建主机之前需要信任的边界。其结果是一份确认，列出服务器 id 与实际生效的配方 id。

##### 声明确认

```markdown
{
  "ok": true,
  "workspaceId": "ws_01",
  "serverId": "aosp-builder",
  "recipes": ["ninja-full", "ninja-incremental"]
}
```

#### Token 影响

除已存在于提供集合中的描述外无直接 token。确认是一份很短的 JSON 文档，而畸形的配方列表会让整次声明失败，而不是丢掉某个阶段门禁可能已被要求必须存在的配方。

#### KV Cache 影响

仅追加，与任何其他工具结果相同。声明与其确认都不触及 system prompt，因此不会使任何可复用前缀失效。

## 已知限制与延期工作

<a id="known-limitations-and-deferred-work"></a>

- **只实现了 OpenSSH** — `transport` 被声明为唯一的字面量 `'ssh'`，因此以其他方式访问的构建农场需要新增一种传输，而不是改配置。
- **Windows 上驱动的是平台客户端而非 dsh 自带运行时** — 传输按步骤调用 OpenSSH 可执行文件并按名称解析，因此自带客户端的部署要自行固定 `sshExecutable`（配一次，适用于所有未自填的声明）与 `tarExecutable`。
- **只能密码登录时需要部署自备客户端** — 每次调用都带 `BatchMode=yes`，因此缺密钥会立刻失败而不是卡在交互式提示上；而任何声明都不可能携带凭据：目标是交给宿主自身 `~/.ssh/config` 解析的 OpenSSH 目标。只能密码登录的构建机，做法是把 `sshExecutable` 指向一个在 seam 之外取得密码的包装客户端（`sshpass`、PuTTY 的 `plink -pw`、读取系统钥匙串的脚本）；包装客户端收到与平台客户端相同的 argv。能用密钥时，装公钥是更短的路。
- **树必须已经在机器上** — 声明只是点名一个目录，运行既不创建也不同步它。保持它最新是部署自己的事，过期的树编译出过期的源码；记录下来的源码版本正是让这一点可见的手段。
- **取回清单由调用方给出，而非工具扫描** — 一次运行带回的是调用方点名的路径，这条 seam 自己不列目录，因此发现产物名是配方的责任（或编译日志的责任）。
- **日志只做尾部截断，不能分页** — 一次运行返回最后 `logMaxBytes` 字节与 `truncated` 标志，除重跑配方外没有取回被丢弃头部的办法。
- **`extraArgs` 是不受沙箱约束的 shell 文本** — 该参数被逐字附加到渲染后的配方上，因此一次性开关同时也是共享构建主机上的一次性命令片段。
- **台账回答的是运行而非正确性** — 一条存储记录证明的是在何处执行了哪条命令、读到了哪个源码版本、返回了什么退出码；它不验证该配方是否测试了阶段所声称测试的内容，而且除非声明要求，源码版本是缺省的。
- **超时只报告，不重试** — `timedOut` 标记命令超过了 `timeoutMs`，任何重试策略由调用方承担。
- **声明按项目隔离** — 服务器以 `${workspaceId}:${serverId}` 为键，因此两个项目共用一台构建主机时会各自声明一次、各自探测。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者的工作上下文——点击展开</summary>

无。

</details>
