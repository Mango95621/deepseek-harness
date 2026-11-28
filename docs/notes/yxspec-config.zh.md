# `yxspec.json` 项目声明

[English](yxspec-config.md) | 中文

运行 [YXSpec 流程](../subsystems/yxspec.zh.md)的项目在其根目录携带一份 `yxspec.json`。该文件回答宿主无法单从目录树回答的两个问题：这个项目到底走不走受控流程，以及它是哪份规格。它同时也是随发行版提供的 `yxspec-*` 技能所读取的配置源。

本页记录该文件是什么、谁在读它，以及其中哪些键是活的。它是对一个已部署项目中观察到的布局的参考；[子系统页](../subsystems/yxspec.zh.md)持有流程自身的契约。

## 文件本身就是开关，不是标志位

存在性即判据。`@deepseek-ai/dsh-yxspec/project` 的 `declaresYxspecProcess()` 解析该文件并报告它是否存在；没有任何布尔配置键表达同一件事。

三个消费方必须对这一答案取得一致，而它们读同一份字节，因此不可能不一致：

- **`@deepseek-ai/dsh-yxspec`** 从该文件播种所上报的规格标识，使阶段模型与标识描述的是同一棵树。
- **`@deepseek-ai/dsh-yxspec-step`** 对项目未声明流程的会话隐藏 `yxspec_status` 与 `yxspec_next`，使无关会话永不背负该 schema。
- **`@deepseek-ai/dsh-yxspec-remote`** 以同样方式隐藏它的三个构建服务器工具。

用文件而非标志位，是因为该文件正是引导向导与各技能实际读取的东西。第二处声明会可能与其所描述的树失去同步。

### 它住在哪里

`resolveProjectConfigPath(root)` 按序查询两个候选并返回第一个存在者：

| 顺序 | 路径 | 状态 |
|---|---|---|
| 1 | `yxspec.json` | 当前——项目根目录，紧邻它所描述的树 |
| 2 | `project/config/yxspec.json` | 旧布局——该文件在迁移前所处的位置 |

两者并存时根文件优先，因此迁移是新增文件而非删除文件。只写过嵌套路径的部署继续可用。

部署配置中显式的 `projectConfigPath` 被逐字沿用：一个指明自身位置的部署，并不是在要求在其下方再搜索回退项。

## 两个消费方分组，一份文件

宿主读取该文件的一小部分，随发行版提供的技能读取其余部分。把两者混为一谈是误读该文件最常见的方式。

| 消费方 | 读取 | 为什么 |
|---|---|---|
| 宿主（TypeScript） | `spec_id`、`project_name`、`customer`、`product_type`、`sqt.paths` | 渲染流程面板；为向导枚举候选规范文档 |
| `yxspec-*` 技能（Python） | `spec_id`、`product_scope`、`init_file_kinds`、`clarify_partitions`、`anchor_template`、…… | 驱动受控流程：产物命名、范围过滤、澄清规则 |

### 宿主读什么

`readProjectIdentity()` 从该文件投影出四个键，落盘为 snake_case、代码中为 camelCase：

| 键 | 类型 | 用途 | 缺失时 |
|---|---|---|---|
| `spec_id` | string | 面板上报的规格标识 | `'unspecified'` |
| `project_name` | string | 项目名称 | `'unspecified'` |
| `customer` | string | 客户名称 | `'unspecified'` |
| `product_type` | string | 产品类型 | `'unspecified'` |

文件缺失或畸形时得到 `undefined` 而非抛错：标识是上报用的元数据，没有它部署也照样依据阶段模型正确门禁。显式的 `Config.identity` 取值优先于文件。

`readDeclaredEntries()` 为向导的规范文档步骤读取 `sqt.paths`。只有形状表明指向位置的字符串值会被读取，且只有带文档扩展名（`.md .txt .json .yaml .yml`）的会成为候选。`repo_root` 在取值为 `'.'` 时跳过——它命名的是检出本身，是其他取值解析所依据的基准而非文档所在之处。紧邻它们的数组与对象被有意排除在外：`prd_globs` 持有的是模式，`trace_bases` 在另一个工具的工作目录内解析，而 `source_app` 命名的是一份本模块未被告知的检出的子目录。

## 键清单

下表覆盖一个已部署项目中观察到的文件：19 个顶层键。同一批键的注解以 `yxspec-template.json` 随实际项目一同发行；实例中有 7 个键不在该模板内。

### 在宿主边界上是活的

| 键 | 消费方 | 备注 |
|---|---|---|
| `schema` | — | 格式标记，`yxspec-config/v1` |
| `spec_id` | 175 个技能脚本 | 产物前缀与追溯 ID 根；该文件中被读取最重的键 |
| `naming_version` | 63 个技能脚本 | 路径命名规范，如 `lowercase-paths/v1` |
| `project_name` | 12 个技能脚本 | 面板也读 |
| `customer` | 12 个技能脚本 | 面板也读 |
| `product_type` | 13 个技能脚本 | 整体选择功能锚点模板；见下文 |
| `sqt.paths` | 宿主 + 74 处引用 | 向导所枚举的路径声明 |

### 全流程配置

| 键 | 消费方 | 备注 |
|---|---|---|
| `product_scope` | 67 个技能脚本 | `product`、`in_scope`、`out_of_scope`、`note`；由 init brief 渲染与 PRD 范围判定消费 |
| `clarify_partitions` | 3 个技能脚本 | `customer_partitions`、`audience_map`、`category_map`、`category_rules`、`blocking_keywords`；缺节时退到包内默认 |
| `init_file_kinds` | 2 个技能脚本 | `native` / `convert` / `attachment` 扩展名；扫描时与自身集合合并而非替换 |
| `anchor_template` | 4 个脚本（迁移工具） | 见下文——其机制并非模板注解所述 |

### 无观察到消费方的键

在所考察的部署中这些键是惰性的：没有脚本读它们，宿主也不读。它们能无错解析，因此留在原位无害——但填了也不会让任何事发生。

| 键 | 模板注解声称 | 实际观察 |
|---|---|---|
| `init_buckets.{max_files,max_kb,partition_depth}` | ACQ.4 分桶尺寸 | 只存在命令行开关（`--max-files`）；无配置读取 |
| `init_concurrency` | ACQ.4 解析并发 | 无配置读取 |
| `workspace_layout.{baseline_root,sw_arch_docs_dir}` | SWE.2 基线位置 | 无配置读取 |
| `node_identity` | — | 仅实例独有的键；本树中无读取方 |
| `residue_tokens` | 迁移携带 | 仅被产品迁移工具读取 |

### `sqt` 段

`sqt` 持有 SQT 阶段的常量：路径声明、ID 模式、维度阈值、关键词表与产物命名。其 `schema` 标记为 `sqt-config/v1`。

在所考察的部署中，该段自身的常量在本树内没有读取方——搜索标记值 `sqt-config/v1` 与判别性取值如 `protocol-source-first` 均无命中。18 个可读路径值中有 6 个也无法在磁盘上解析。把该段当作属于本检出之外某条工具链的配置来对待。

唯一的例外是宿主，它为向导候选遍历 `sqt.paths`；那是本仓库执行的唯一一处 `sqt` 读取。

## `anchor_template`：注解已过期

`anchor_template` 的模板注解描述了一条解析链——`prd.anchor_template` 回退到顶层键，未设置时报 `rc=1 ANCHOR_TEMPLATE_UNSET`——并声称 `product_type` 一律从模板 YAML 读取。两条陈述描述的都是迁移工具，而非流程。

真正起作用的读取在 `yxspec-sys-arch`。**SYS.3 根本不读这个键。** 它用 glob 找文件：

```
--anchor-dir project/config/anchor-templates --anchor-dir project/traceability/mounts/templates
--anchor-prefix ""
```

第一个含有 `*-anchor-template.yaml` 的目录胜出；同一目录内，前缀匹配 `anchor_prefix` 的命中优先于字典序首个。没有任何目录给出命中时，worker 报告锚点模板缺失并阻塞派发。

因此该键的真实效果取决于运行哪条工具链：

| 运行 | 要做什么 |
|---|---|
| 流程（`yxspec-sys-arch`、PRD） | 什么都不用——把 `*-anchor-template.yaml` 放进 `project/config/anchor-templates/`，SYS.3 会发现它 |
| init 预检 | 把该键指向一个存在的文件，如 `project/config/anchor-templates/ivi-function-anchor-template.yaml` |
| 迁移工具 | 必填——省略即得 `rc=1 ANCHOR_TEMPLATE_UNSET` |

取值处理（`resolve_anchor_template()`）：

```
bare filename (no separator)  → join with anchor_template_dir (default project/config/anchor-templates)
relative path                 → resolve against the workspace root
absolute path                 → used as-is
```

`anchor_template_dir` 正是让裸文件名可解析的东西；除此之外它不被使用。

### `product_type` 已迁出

注解称 `product_type` 从锚点模板 YAML 读取、且 `yxspec.json` 不设该键。这一点此后已改变：`config_gen.py` 的派生键表现在为空，并留有注释记录 `product_type` 与 `form_factor` 因属 PRD 专用、而 `yxspec.json` 是全流程声明而被迁出。当前来源是 `config.base.yaml` 加项目覆盖层。

## 验证状态

宿主侧的读取路径——`resolveProjectConfigPath`、标识播种与 `sqt.paths` 遍历——由四个 `yxspec` 包中的 235 个单元测试覆盖，并通过 `pnpm run build:check` 与 `pnpm run typecheck`。上文中关于 Python 侧消费方的论断来自阅读随发行版提供的脚本；它们不被本仓库的测试覆盖，因为本仓库不 vendor 那些脚本。
