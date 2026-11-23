---
description: "YXSpec 流程的远程编译验证：声明一台构建服务器，然后针对上传的项目树副本运行一个具名配方，读回退出码、日志与树摘要。"
kind: "package-reference"
---

# @deepseek-ai/dsh-yxspec-remote

[English](README.md) | 中文

## 概述

用 `dsh-yxspec-remote` 让"编译通过"成为转录记录无法伪造的事实：声明一台构建服务器，针对上传的项目树副本运行它的一个具名配方，读回退出码、日志，以及产生这一切的项目树 SHA-256。凡流程要求后续阶段开始前必须有一次绿色远程编译的部署，都应挂载它。源码从不落在服务器上——每次运行把本地树打包、流式送入按项目划分的暂存目录、在那里编译后返回。配方是声明出来的而非现场书写的，因此模型选的是配方 id，而每次运行都作为持久证据被记录。

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

先声明一次服务器，然后在流程走到各个验证点时运行它的配方。

### 何时选用

当编译需要一台智能体主机之外的机器时选用它——例如从 Windows 访问 Linux 构建农场的 AOSP 或 Yocto 树，或任何开发机无法承载其工具链的编译。本地完成编译的部署不需要它，而[流程面板](../../client/ui-yxspec/README.zh.md)的引导向导仍会渲染"尚未声明服务器"的空状态，因为 [Remote owner](../yxspec-api/README.zh.md) 把这条 seam 视为可选。凭据从不属于配置的一部分：目标是交给主机自身 `~/.ssh/config` 解析的 OpenSSH 目标，因此操作者已有的密钥、agent 与跳板机原样生效。

### 最小配置

```yaml
- name: '@deepseek-ai/dsh-yxspec-remote'
  config:
    pushSource: true
```

| 字段 | 默认值 | 含义 |
|---|---|---|
| `excludes` | `.git`、`node_modules`、`build`、`out`、`dist`、`target`、`.gradle`、`.idea`、`.vscode`、`__pycache__`、`*.pyc` | 推送项目树时应用的打包排除项 |
| `pushSource` | `true` | 运行前是否先上传项目树；`false` 表示针对服务器上已有内容直接运行 |
| `tarExecutable` | 探测得到的平台默认值 | 用于打包的本地 `tar` 绝对路径 |
| `logMaxBytes` | `2097152` | 本次运行返回日志的字节预算 |

生成的[配置目录](../../../docs/config-catalog.zh.md#deepseek-aidsh-yxspec-remote)是全部可接受字段的完整来源。

### 声明一台服务器

一次声明给出目标、基础目录和配方映射；一次探测确认握手成功且基础目录存在。只有映射点名的配方才可能被运行，这正是模型的"选择"而非"书写命令"的由来。该服务还向宿主消费方暴露 `list`、`server`、`forget`、`probe`、`run`、`runsFor` 与 `lastSuccess`，其中 `runsFor` 供后续阶段确认某个配方是否已针对指定项目树完成验证。

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现细节——点击展开</summary>

服务之前有三个面向模型的工具——`remote_server_list`、`remote_server_declare` 与 `remote_build`——它们是智能体通往构建服务器的唯一路径。这是刻意的：一次构建就是一次工具调用，因此会经过[阶段门禁](../yxspec-gate/README.zh.md)所挂接的同一条 `tools` 管线，阶段也就能够要求远程构建为绿后才允许后续阶段开始。服务自身声明 `inject = ['subprocess', 'workspaceRegistry', 'storageDomain', 'tools']`，两张持久表都放在存储域而非项目自己的 JSON 里，因为验证记录不得被它所审计的智能体改写。

在 Windows 上 `ssh.ts` 走了另一条路——dsh 自带的 SSH 运行时拒绝任何非 Linux、非 macOS 客户端——它按步骤调用平台自带的 OpenSSH 客户端，并通过 `ctx.subprocess` 读回退出事实。三个可独立诊断的步骤依次执行：`tar` 打包本地树，一次 `ssh` 把该归档通过管道送入服务端的 `tar -x`，第二次 `ssh` 在解出的树中运行配方。归档以字节流经客户端 stdin 传输而非作为命令行参数，因为树大到超出 `ARG_MAX` 才是常态而非边界情况。

`paths.ts` 由项目 id 与标题推导服务端目录。slug 是这里唯一既要扛住恶意标题、又要扛住第二个项目取同样可读名的字符串，因此其字符类不容纳路径分隔符与 shell 元字符，折叠连续点号则去掉了任何 `..` 成分。`recipe.ts` 是唯一构建远程命令行的位置：`renderRecipe` 替换 `{cwd}`，前置 `set -e` 使写成 `a; b` 的模板在第一步就停下而不是报最后一条命令的状态，并显式 `cd` 使配方不再依赖 ssh 的登录目录。

### 源码映射

| 文件 | 职责 |
|---|---|
| [`src/index.ts`](src/index.ts) | 服务本体、其配置，以及三个面向模型的工具 |
| [`src/spec.ts`](src/spec.ts) | 构建服务器与运行台账的存储域声明 |
| [`src/ssh.ts`](src/ssh.ts) | `tar`/`ssh` 传输及其驱动的子进程能力 |
| [`src/paths.ts`](src/paths.ts) | 单个项目的服务端目录命名 |
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
  "remoteDirectory": "/srv/builds/mcu-tree-01/ws_01",
  "command": "set -e; cd '/srv/builds/mcu-tree-01/ws_01'; ninja -C {cwd}/out",
  "exitCode": 0,
  "log": "…",
  "truncated": false,
  "timedOut": false,
  "durationMs": 40213,
  "treeDigest": "9f2c…",
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

`remote_server_declare` 是写入路径，且刻意收窄：模型提供目标、基础目录与配方映射，从不提供凭据。描述明确说明凭据既不传入也不存储，这是操作者把智能体指向构建主机之前需要信任的边界。其结果是一份确认，列出服务器 id 与实际生效的配方 id。

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
- **Windows 上驱动的是平台客户端而非 dsh 自带运行时** — 传输按步骤调用 OpenSSH 可执行文件并按名称解析，因此自带客户端的部署必须自行固定 `tarExecutable` 与每台服务器的 `sshExecutable`。
- **每次运行都推送整棵树** — 排除项基于扩展名与目录名，因此落在未列出路径下的大体积产物每次都会上传；预同步的树只有关掉 `pushSource` 才能避免，代价是失去树摘要。
- **日志只做尾部截断，不能分页** — 一次运行返回最后 `logMaxBytes` 字节与 `truncated` 标志，除重跑配方外没有取回被丢弃头部的办法。
- **`extraArgs` 是不受沙箱约束的 shell 文本** — 该参数被逐字附加到渲染后的配方上，因此一次性开关同时也是共享构建主机上的一次性命令片段。
- **台账回答的是运行而非正确性** — 一条存储记录证明的是哪棵树被编译、返回了什么退出码；它不验证该配方是否测试了阶段所声称测试的内容。
- **超时只报告，不重试** — `timedOut` 标记命令超过了 `timeoutMs`，任何重试策略由调用方承担。
- **声明按项目隔离** — 服务器以 `${workspaceId}:${serverId}` 为键，因此两个项目共用一台构建主机时会各自声明一次、各自探测。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者的工作上下文——点击展开</summary>

无。

</details>
