# DSH 插件制作规范（第三方插件作者版）

> 本文所有结论都来自**本机真实安装的 DSH 0.2.0-rc.2**，不是凭记忆。每条都标注了证据路径。
> 与本文冲突的说法，以本文为准。

## 0. 证据来源与取证方法

| 来源 | 路径 | 说明 |
|---|---|---|
| Host 官方插件开发技能 | `app.asar` → `dsh/node_modules/@deepseek-ai/dsh-agent-preset/skills/cordis-plugin-development/{SKILL.md,references/*.md,templates/*}` | 官方一手规范 |
| 组合（Loader YAML 方言）参考 | 同上 `skills/cordis-composition-reference/{SKILL.md,references/packages.md}` | patch 方言 + 可安装包清单 |
| profile 装载器实现 | `app.asar` → `dsh/node_modules/@deepseek-ai/dsh-app-boot/lib/index.js`（`//#region lib/types/profile.js`） | 官方对 profile 组合顺序的权威描述 |
| Loader 实现源码 | `app.asar` → `dsh/node_modules/@deepseek-ai/cordis-plugin-loader/src/config/{entry,group,tree}.ts` | 行去重、volatile 判定 |
| 客户端模块系统 | `app.asar` → `dsh/node_modules/@deepseek-ai/dsh-client-modules/README.md` | `/plugins/*` 服务与惰性 CJS 模型 |
| 包清单类型 | `app.asar` → `dsh/node_modules/@deepseek-ai/dsh-package-manifest/README.md` | `package.json` 字段的规范定义 |
| CLI 实现 | `app.asar` → `dsh/node_modules/@deepseek-ai/dsh/lib/{bin.js,plugin-*.js}` | `dsh plugin` 到底做了什么 |
| 官方类型（本仓库已装） | `node_modules/@deepseek-ai/{dsh-tools,dsh-client-ui-slots,dsh-client-ui-sidebar-right,dsh-client-ui-sidebar-browser,schemastery,cordis}/lib/types/**` | 精确接口签名 |
| 真实第三方插件 | `E:\agent project\dsh-comfyui-image`（完整读）、`~/.dsh/profiles/desktop/node_modules/{dsh-cost-meter,dshmarket}`、`~/.dsh/plugin-sources/dsh-plugin-manager` | 最佳实践样例 |

**取证脚本**（本仓库 `.probe-spec/`，可重跑）：

```bash
node .probe-spec/asar-read.mjs "<app.asar>" "<正则>"                     # 列出条目
node .probe-spec/asar-read.mjs "<app.asar>" ".*" --dump "<条目>" "<输出>"  # 导出条目
node .probe-spec/asar-grep.mjs  "<app.asar>" "<路径正则>" "<内容正则>"     # 全库内容检索
```

`app.asar` = `C:\Users\18002\AppData\Local\Programs\DeepSeek Harness\resources\app.asar`
（121 MB，头部 16 字节后是 JSON header，条目按 offset 拼接——不需要装 `asar` 包。）

---

## 1. 包布局契约（package.json）

一个第三方 DSH 插件 = **一个 npm 包**，由若干字段声明它既是 Host 插件又是 Web 客户端插件。

### 1.1 最小可用的双面包

```json
{
  "name": "@dsh-external/dsh-client-ui-sidebrowser",
  "version": "0.1.0",
  "type": "module",
  "icon": "icon.svg",
  "main": "lib/index.js",
  "exports": {
    ".": "./lib/index.js",
    "./client": "./lib/client.js",
    "./package.json": "./package.json",
    "./locale/*.json": "./locale/*.json"
  },
  "engines": { "dsh": ">=0.2.0-rc.1" },
  "dsh": {
    "bundle": { "patch": "./cordis.patch.yml" },
    "client": {
      "platform": "web",
      "immediately": true,
      "inject": ["@deepseek-ai/dsh-client-ui-sidebar-right"]
    }
  }
}
```

> 官方模板：`skills/cordis-plugin-development/templates/decoration/package.json`（本仓库已导出到 `.probe-spec/templates/decoration-package.json`）。

### 1.2 字段逐条说明

| 字段 | 谁读 | 作用 | 省略会怎样 |
|---|---|---|---|
| `name` | 全部 | **浏览器模块 id 就是它**（不是 cordis 行 id）。bundle 列表里写的也是它 | 无法被 profile 激活 |
| `version` | 全部 | 必需；`dsh plugin allow-version` 的豁免键是 `name@version` | 报 manifest 错 |
| `type: "module"` | Node | Host 半边必须是 ESM | CJS 无法被 `import()` |
| `main` | cordis | 行 `name` 指向包时，cordis 从这里取 Host 半边 | Host 半边不被加载 |
| `exports["."]` | cordis | 同上，显式形式 | 同上 |
| `exports["./client"]` | client-modules | **浏览器半边入口**。缺它则该包没有客户端面 | 客户端面完全不存在（不报错，只是不加载） |
| `exports["./package.json"]` | app-boot / 工具 | 官方要求"the package to export `./package.json`" | 版本解析失败 |
| `exports["./locale/*.json"]` | 客户端 locale | 见 §5.4 | 自定义词典不可达 |
| `engines.dsh`（**顶层**） | 声明性 | SemVer 范围，**与 `engines.node` / `engines.npm` 平级** | 不声明兼容版本（**当前不强制执行**，见下） |
| `dsh.manifestVersion` | 声明性 | 清单格式标识，当前值 `1` | 不声明格式版本 |
| `dsh.bundle.patch` | **app-boot（强制）** | 插件行插入文件路径，相对包根；可以是**有序数组** | **插件不会被任何 profile 激活** |
| `dsh.client.platform: "web"` | client-modules | 声明这是一个 Web 客户端插件 | 不生成 `/plugins/*` bundle |
| `dsh.client.immediately` | client-modules | 是否不等懒加载立即注册工厂 | 行为差异，非致命 |
| `dsh.client.inject[]` | client-modules | **只决定激活顺序**，不是运行时 import | 顺序错乱（服务未就绪） |
| `dsh.client.external[]` | client-modules | 精确列出非基线模块请求（见 §5.5） | 组合阶段直接拒绝 |
| `icon`（顶层字符串） | Plugin Manager | 相对清单目录的图标路径；svg/png/jpeg/webp，≤256 KiB。绝对路径/URL/越界/符号链接被拒 | 用面板默认图 |
| `meta.title` / `meta.description` | Plugin Manager | 未激活也能读到的展示名（不写则回落到 `name` / `description`） | — |
| `locale/en.json` | Plugin Manager | 本地化展示文本（`zh.json` 等同字段） | — |
| `files[]` | npm | 见 §7 | — |
| `peerDependencies["@deepseek-ai/dsh"]` 或 `["@deepseek-ai/dsh-*"]` | **app-boot（强制）** | 见下 | — |
| `dsh.compatibility.dsh` | 无人读 | 社区/市场元数据惯例（`dsh-cost-meter` 用） | 无影响 |

### 1.3 两个必须知道的版本字段（不同位置、不同效力）

**顶层 `engines.dsh`（声明性，不强制）**

证据：`dsh-package-manifest/README.md`
> | `engines.dsh` | Author-declared compatible DSH versions as a SemVer range… This field sits beside `engines.node` and `engines.npm`; an engines object may omit `dsh`. |

并且同文 "Known Limitations"：
> Current installers and loaders do not enforce `dsh.manifestVersion` or `engines.dsh`; declaring a range does not reject incompatible hosts or validate SemVer syntax.

**`peerDependencies`（真正会被 Host 检查）**

证据：`dsh-app-boot/lib/index.js` → `//#region lib/types/plugin-compatibility.js`
> Check every `@deepseek-ai/dsh` or `@deepseek-ai/dsh-*` peer against the runtime.

不兼容时 Host **拒绝装载**，除非显式豁免：

```bash
dsh plugin --profile <p> allow-version <pkg>@<version> --dsh-version <exact> --accept-risk
dsh plugin --profile <p> revoke-version <pkg>@<version> --dsh-version <exact>
dsh plugin --profile <p> version-exemptions
```

本机运行时版本 = `0.2.0-rc.2`（`dsh-app-boot/package.json`、`dsh-desktop-host/package.json`）。
只检查名字匹配 `@deepseek-ai/dsh` 或 `@deepseek-ai/dsh-*` 的 peer；`react` 之类被忽略。

> ⚠️ 这解释了真实插件为什么写这么宽的范围：
> `dsh-cost-meter` 写 `"@deepseek-ai/dsh-home-paths": "^0.1.0-rc.6 || … || >=0.2.0-rc.1 <0.3.0-0"`。

---

## 2. 双面模型（Dual-face）

一个包同时产出 Node 插件和浏览器插件，两半互不引用对方的运行时代码。

### 2.1 两个 id，别搞混

| id | 由谁定义 | 出现在哪 | 用途 |
|---|---|---|---|
| **npm 包名**（`@dsh-external/dsh-client-ui-sidebrowser`） | `package.json#name` | `/plugins/<包名>/client.js`、浏览器 `window.__ModuleLoader__.load({ id })`、`dsh.client.external` | **客户端模块 id** |
| **Loader 行 id**（`ui-sidebrowser`） | `cordis.patch.yml` 里的 `- id:` | profile 配置、Settings 插件清单、patch 覆盖目标、Host 侧配置寻址 | **插件行 id** |

两者可以不同（本仓库就是），**但必须各自唯一**。

### 2.2 客户端 bundle 怎么被服务

证据：`dsh-client-modules/README.md`

- Host 扫描"已启用的 Loader 行"，把每个 `dsh.client` 声明变成一个可加载的浏览器 bundle；
- 可用 Web 载体在 `/plugins` 下服务它，shell 载体通过 `fetchBundle()` 派发同一批响应；
- 组合行注入 `<head>`：`window.__ModuleLoader__` 队列门面 → advisory preload → 阻塞解析的 bootstrap 组合脚本 → `window.__DSH_BOOT__` 引导图。

单资源 URL 形态：`/plugins/<包名>/client.js?rev=<rev>`
批量组合形态：`/plugins/??<包名1>,<包名2>&rev=<rev>`（每段在超过 3 KiB 前切分）
代码分块：`/plugins/<包名>/client.<name>.js?rev=<rev>`

> `rev` 来自条目的 `mtimeMs` / `ctimeMs` / size，**不是内容哈希**。

### 2.3 惰性 CJS 模型（最容易踩坑的一条）

证据：`dsh-client-modules/README.md` §Lazy-CJS model

> Executing a plugin bundle only registers its factory; every module-body side effect (**CSS injection included**) lives in the factory closure and runs at materialization (`factory(require)` → exports, memoized in `loadCache`).

官方模板的客户端产物长这样（`.probe-spec/templates/decoration-client.js`）：

```js
window.__ModuleLoader__.load({
  id: '@local/my-decoration',              // ← 必须是包名
  factory(require) {
    const React = require('react');        // ← 从平台模块表取，不打包
    const h = React.createElement;
    function Decoration() { /* ... */ }
    return {
      inject: ['slots'],
      apply(ctx) {
        ctx.slots.inject('conversation.composer.dock', () => ctx.slots.register({
          name: 'conversation.composer.dock', id: 'my-decoration', order: 5,
        }, Decoration));
      },
    };
  },
});
```

推论：
- **工厂函数体里不能有副作用**，否则"加载"和"启用"就分不开了。
- 样式注入、CSS import 会被打包进工厂闭包，**materialize 时才执行**，所以"组件卸载"要靠 effect 的 disposer 收回样式，而不是靠"页面刷新"。
- `require` 循环会抛错（factory 形式的 CJS 交付不了部分导出）。

---

## 3. 安装与注册

### 3.1 Host 到底怎么解析（官方原话）

证据：`dsh-app-boot/lib/index.js` → `//#region lib/types/profile.js`
> A profile is a directory under `$DSH_HOME/profiles/<name>` holding a `package.json` (out-of-tree plugin dependencies plus the profile manifest `dsh.profile` with its ordered `bundles` list) and a `cordis.patch.yml` (the user's own patch layer, applied after every bundle layer). Bundles are npm packages whose manifest declares `"dsh": { "bundle": { "patch": "./cordis.patch.yml" } }` (one file, or an ordered list of files); **the tree is composed by applying each bundle's patch lists in `dsh.profile.bundles` order over an empty entry list, then the profile's own patches, then any launcher layers** (`--patch` files and flag-derived patches).

组合顺序（三层，从低到高）：

```
空列表
  → 每个 bundle 的 dsh.bundle.patch（按 dsh.profile.bundles 顺序）
  → profile 自己的 cordis.patch.yml（$DSH_HOME/profiles/<name>/cordis.patch.yml）
  → 启动器层（--patch 文件、标志派生 patch）
  → $DSH_HOME/cordis.patch.yml（全局用户层，见 §3.4）
```

解析路径（等价实现佐证）：`~/.dsh/plugin-sources/dsh-plugin-manager/lib/index.js:60-81`
```js
const bundles = profile?.dsh?.profile?.bundles ?? [];
for (const bundle of bundles) {
  const dir   = join(PROFILE_DIR, "node_modules", bundle);
  const pkg   = JSON.parse(readFileSync(join(dir, "package.json"), "utf8"));
  const rel   = pkg?.dsh?.bundle?.patch;          // ← 必须是字符串
  extractInsertIds(readFileSync(join(dir, rel), "utf8"), ids);
}
```

### 3.2 因此，安装一个第三方插件需要 **三件事**

1. **pnpm 依赖**：`$DSH_HOME/profiles/<name>/package.json` 的 `dependencies` 里加一条
   （`"dsh-sidebrowser": "link:E:/agent project/dsh-sidebrowser"` 或 `"git+https://…"`）。
   这一步产生 `node_modules` 里的实体（junction / 软链 / 拷贝）。
2. **bundle 列表**：同一份 `package.json` 的 `dsh.profile.bundles` 数组里加**包名**。
   这一步让 Host 把这个包当作 bundle 层参与组合。
3. **插件行**：由插件**自带的** `cordis.patch.yml` 经 `dsh.bundle.patch` 提供，
   **不需要手工往 `~/.dsh/cordis.patch.yml` 里再写一遍**。

真实样例（`~/.dsh/profiles/desktop/package.json`）：

```json
{
  "name": "dsh-profile-desktop",
  "private": true,
  "dependencies": {
    "dsh-comfyui-image": "link:E:/agent project/dsh-comfyui-image",
    "dsh-cost-meter": "git+https://github.com/Han-1413141/dsh-cost-meter.git"
  },
  "dsh": {
    "profile": {
      "bundles": [
        "@deepseek-ai/dsh-base",
        "@deepseek-ai/dsh-web-app",
        "dsh-cost-meter",
        "dsh-comfyui-image"
      ]
    }
  }
}
```

插件自带的 `cordis.patch.yml`（`dsh-comfyui-image` 与 `dshmarket` 完全同形）：

```yaml
- insert:
    - id: comfyui-image          # Loader 行 id，全局唯一
      name: 'dsh-comfyui-image'  # npm 包名
```

### 3.3 CLI 等价写法

实测（本机真实输出）：

```
$ "...\resources\runtime\cli\bin\dsh.cmd" --help
Usage: dsh [--profile] <name> [options] [app-args...]
       dsh plugin --profile <name> <pnpm-args...>
…
  -V, --version                  output the version number
  --profile <name>               the profile under $DSH_HOME/profiles to boot
  --from-default-profile <name>  initialize a new custom profile from a shipped profile template
  --patch <path>                 extra patch-list overlay applied after the profile layer (repeatable)
  --dump-config                  print the composed profile tree and exit
  --dump-config-schema           print JSON Schema for profile entries and patches without mounting
  --dump-default-config          print the profile tree without its user layer or --patch overlays and exit
Examples:
  dsh plugin --profile tui add <package>    install a plugin into the tui profile
```

```
$ dsh.cmd plugin --help
error: required option '--profile <name>' not specified     (exit 1)

$ dsh.cmd plugin --profile desktop --help
Version 11.7.0
Usage: pnpm [command] [flags] …                              ← 纯 pnpm 帮助
```

**`dsh plugin` 做什么、不做什么**（证据：`dsh/lib/bin.js` 与 `dsh/lib/plugin-*.js`）：

> `dsh <name>` abbreviates `dsh --profile <name>`; **`plugin` manages a profile's plugin dependencies by forwarding to pnpm**.

`runPlugin()` 把参数原样交给 `runProfilePnpm` / `runPluginCommand`（即 pnpm），只有三个 DSH 自有子命令被截走：
`allow-version` / `revoke-version` / `version-exemptions`。

| 命令 | 效果 |
|---|---|
| `dsh plugin --profile <p> add link:<path>` | ✅ 写 `dependencies`（pnpm 语义，键取被链接包的包名），执行 pnpm install |
| `dsh plugin --profile <p> add git+https://…` | ✅ 同上；**git 包会跑 `prepare`，被 pnpm 拦下**，需把 pnpm 打印的 key 加进 `<profile>/pnpm-workspace.yaml` 的 `allowBuilds` 后重跑 |
| `dsh plugin --profile <p> remove <pkg>` | ✅ 移除依赖 |
| —— | ❌ **不写 `dsh.profile.bundles`** |
| —— | ❌ **不写 `cordis.patch.yml`** |
| `dsh plugin --profile <p> allow-version <pkg>@<v> --dsh-version <exact> --accept-risk` | ✅ 版本兼容豁免 |

> `desktop` profile 由 Electron 应用独占，CLI 会拒绝 `--dump-config`：
> `error: profile "desktop" is managed exclusively by the Electron application`。

**所以 `dsh plugin … add` 之后必须手动把包名加进 `dsh.profile.bundles`。**

### 3.4 `cordis.patch.yml` 方言

证据：`cordis-composition-reference/SKILL.md` + `cordis-plugin-loader/src/config/*.ts`

顶层是 **YAML 数组**，每个元素是一个 patch：

| 形态 | 语义 |
|---|---|
| `- insert: [rows…]` | 追加行。若某行 `id` 命中一个已存在的 `group: true` 行，则插入该组的 `config` 列表内部 |
| `- id: <id>`（无 `insert`） | 覆盖已存在的同 id 行。**`config` 整体替换，绝不深合并**——必须重写该行需要的每个字段。给一个真值 `name` 是在**断言**插件名，不是改名 |
| 无 `insert` 且无非空 `id`，或目标行不存在 | 警告并跳过 |
| `!!js <表达式>` | Loader 表达式（**是 `!!js`，不是 `!js`**）。`config` 内求值在该插件的 injections 激活之后、针对它的 `ctx` |

行字段（`EntryOptions`，`cordis-plugin-loader/src/config/entry.ts:10-23`）：

```ts
interface EntryOptions {
  id: string          // 容器内稳定 id
  name: string        // 插件包 specifier
  config?: any        // 传给插件的配置
  group?: boolean     // 嵌套组
  disabled?: boolean  // 布尔、null 或 !!js 表达式
  inject?: Inject     // 依赖的服务 / intercept 配置
}
```
（组合参考另提到 `intercept` 与 `isolate`，供 preset 使用。）

### 3.5 重复 `id` 会怎样 —— 直接回答 Lead 的问题

**不会创建重复行。** 插件表是一棵**按 `id` 索引**的树。

证据：`cordis-plugin-loader/src/config/group.ts:20-29`
```ts
async create(options: Omit<EntryOptions, 'id'>) {
  const id = this.tree.ensureId(options)                     // 给了 id 就原样用
  const entry = this.tree.store[id] ??= new Entry(this.ctx.loader)   // ← 复用同一 Entry
  entry.parent = this
  await entry.update(options, true, true)                    // create:true → 整体替换 options
  return entry.id
}
```
证据：`group.ts:48-65`
```ts
const newMap = Object.fromEntries(config.map(o => [o.id ?? Symbol('anonymous'), o]))
```
同一 id 在一个数组里被 `Object.fromEntries` 折叠为**最后一个**。

结论：

| 场景 | 结果 |
|---|---|
| 手写 insert，**id 与 bundle 自带的相同**（`ui-sidebrowser`） | **折叠为一行，后写的 options 生效**。不重复、也不冲突（`name` 一样 → 无实际差异），但**纯属多余** |
| 手写 insert，**id 不同**（如 `sidebrowser`） | **真的会产生第二个 Entry**，同一个包被装载两次：两份 Host 工具、两个客户端工厂、两个 Chrome driver。这才是按旧指引操作的真实风险 |
| 手写 insert 到 `~/.dsh/cordis.patch.yml` | 该层对**所有 profile** 生效（不只是你装插件的那一个），而且这段文件由 `dsh-plugin-manager` 托管重写（`MANAGED_START/END` 标记） |

`~/.dsh/cordis.patch.yml` 现状（本机）：
```yaml
- id: ui-skin-maid-atelier
  disabled: true

# --- dsh-plugin-manager managed (auto-generated; do not edit) ---
- id: opencode-delegation
  disabled: true
# --- end dsh-plugin-manager managed ---
```
—— 里面**只有被禁用的行**，没有任何第三方插件的 insert。这与 §3.1 的结论一致：`dsh-comfyui-image`、`dsh-cost-meter` 等已激活插件的 insert **全部来自 bundle 自身**，从未被手工写进来。

### 3.6 什么时候必须重启 Host

证据：`skills/cordis-plugin-development/references/host-plugin.md`
> Installing a new bundle can activate through HMR; **replacing an installed package requires restart to load a fresh JavaScript module generation**. Do not infer updated browser code from an unchanged slot id.

- 改 `cordis.patch.yml` 的**配置**（同一行的 config）→ 热生效，甚至不需要重启（见 §4.3 volatile）。
- **换掉已安装的包代码**（重新 build、重装）→ **必须重启 Host**，Node 模块不会热替换。
- 刷新浏览器页面 ≠ 生效。

---

## 4. Host 插件编写

### 4.1 两种导出形态（不要混用）

证据：`references/host-plugin.md`
> `index.js` exports one of these forms; do not mix them:
> - `export function apply(ctx, config) {}` with optional `export const inject = ['tools']` and `export const Config`.
> - A service class as the default export.

```js
// lib/index.js
export const name = 'comfyui-image'          // 可选，诊断用
export const inject = ['tools', 'skills']    // 可选；缺失服务时插件不激活而不是抛错

export function apply(ctx, config) {
  const disposers = []
  // …注册资源…
  ctx.on?.('dispose', () => { for (const d of disposers.splice(0)) d() })
  return () => { for (const d of disposers.splice(0)) d() }   // 返回清理函数
}
```

纯装饰型（客户端负责渲染）时 Host 半边可以只有一行（官方模板 `templates/decoration/index.js`）：
```js
/** Host half of the decoration bundle; the Client module owns the rendering. */
export function apply() {}
```

### 4.2 `inject` 与优雅降级

证据：`references/practices.md`
> Put optional services in `inject` or `ctx.inject([...], ...)` so the plugin **stays inactive in profiles without them instead of throwing**.

`dsh-comfyui-image`（实测源码 `lib/index.js:300-311`）用的是更保守的运行时判空：

```js
export function apply(ctx) {
  const disposers = [];
  if (ctx.tools !== undefined) disposers.push(ctx.tools.register(generateTool()))
  if (ctx.skills !== undefined) disposers.push(ctx.skills.register(loadSkill()))
  ctx.on?.('dispose', () => { for (const d of disposers.splice(0)) d(); stopAll() })
  return () => { for (const d of disposers.splice(0)) d(); stopAll() }
}
```

`ctx.inject(['workspaces'], (scope) => {...})` 的嵌套写法见官方 `@deepseek-ai/dsh-client-ui-sidebar-browser/lib/client.js:1632`。

### 4.3 `Config`（schemastery）与 `Volatile`

```js
import { Schema } from '@deepseek-ai/schemastery'

export const Config = Schema.object({
  enabled: Schema.boolean().default(true),
  port:    Schema.number().default(0),
  // 运行期读取、不该重启插件的字段加 .volatile()
  captureIntervalMs: Schema.number().default(1000).volatile(),
}).description('...')
```

**Volatile 为什么重要** —— 证据：`cordis-plugin-loader/src/config/entry.ts:139-195`

```ts
const changes = Object.keys({ ...this.options, ...legacy })
  .filter(key => !deepEqual(this.options[key], legacy[key], key === 'config'))
// Only an active fiber in an unchanged context takes volatile-only config changes without a remount.
const volatileOnly = changes.length === 1 && changes[0] === 'config'
  && this.fiber.state === FiberState.ACTIVE && Object.getPrototypeOf(this.ctx) === this.parent.ctx
  && equalExceptVolatile(legacy.config, this.options.config, this.fiber.runtime?.Config)
if (volatileOnly) this.fiber._config = this.options.config
const pending = volatileOnly && this._commitVolatile() ? [] : changes
if (!pending.length && !force) return
this.context.emit('loader/partial-dispose', this, legacy, true)   // ← 走到这里就是重挂
this._patchContext(pending)
```

即：**只有 volatile 字段变化时，配置就地提交（`_commitVolatile()` 通过 `loader/volatile-update` 事件通知），fiber 不被 dispose；任何普通字段变化都会 `loader/partial-dispose` → 重挂插件。**
对持有外部资源的插件（本仓库持有 Chrome 进程），重挂就意味着进程被孤立 —— 所以这类字段必须 `.volatile()`。

schemastery 侧证据（`node_modules/@deepseek-ai/schemastery/lib/types/index.d.ts`）：
`volatile?: boolean` meta、`Schema.prototype.volatile()`、`type SchemaMode = 'plain' | 'defined' | 'volatile' | 'volatile-defined'`，
`Volatile<T>` 来自 `@deepseek-ai/cosmokit`。
约束：`validateVolatileSchema` —— **volatile 字段要求固定的对象路径，不能嵌套在另一个 volatile 里**。

`Config` 一旦声明，该行的 `config` 在**激活时**会被校验；写 `config` 前应先查该包的 schema（`Config.listConfigs`，过滤 `name` 再查 `entry`），并跟进返回文档里的 `$defs` 引用。

### 4.4 `ctx.effect` 的生命周期

证据：`@deepseek-ai/cordis/lib/fiber.d.ts:145-159`
```ts
effect(execute: () => SyncEffect, label?: string): Disposable<Promise<void>>;
effect(execute: () => Effect, label?: string): AsyncDisposable<Promise<void>>;
```

- `label` 会出现在 fiber 诊断里（官方客户端代码全部带 label：`"ui-sidebar-browser.body"`）。
- `execute` 可以返回清理函数，也可以是 async 清理函数。
- 插件卸载、slot 折叠、profile patch 生效时，拥有该 fiber 的注册**自动被移除**。

证据：`references/practices.md`
> Registrations are effects owned by a context. Plugin unload, agent disposal, slot collapse, and profile patches remove what was registered on the corresponding context. **Choose the owning context.** A registration on another context, such as `agent.ctx`, has two owners: keep its disposer in your plugin's own effect too, so either teardown removes it.

> Register per-agent behavior on `agent.ctx`, obtained in an `agent/created` listener… Wrap it in one `agent.ctx.effect()` **and also keep that disposer**, keyed by agent, in your plugin's own effect; unloading the plugin does not dispose `agent.ctx` registrations by itself.

### 4.5 注册 HTTP 路由

证据：`dsh-client-modules/README.md` 的 Host 半职责 + `@deepseek-ai/dsh-host-webserver`（本仓库已装 types）。

要点：
- 路由注册**跟随注入的 `webServer` 服务生命周期**：服务就绪时注册，服务被替换时先移除再重新注册。
- 没有 Web server 时，模块组合与 `fetchBundle()` 仍可用。
- 路由路径属于 Host 命名空间；本仓库使用 `/api/sidebrowser/*`，需自选前缀避免与其他插件冲突（官方 UI 走 `/plugins/*`）。

> 未在本轮核对 `@deepseek-ai/dsh-host-webserver` 的精确方法签名；实现前请读
> `node_modules/@deepseek-ai/dsh-host-webserver/lib/types/index.d.ts` 确认。

### 4.6 贡献系统提示词

证据：`references/practices.md`
> Add prompt text with `ctx.systemPrompt.section()`. Add per-agent context with `agent.inject()`…
> Do not listen to `system-prompt/assemble` to add or remove tools or text.

`references/user-actions.md` 的"一次操作，两个调用方"原则：
1. 操作实现为 Host 服务方法一次；2. UI 动作通过 Client 可调的 Host 入口调用它；
3. 同一个方法再暴露为 agent tool。**不要在 UI 和 tool 两条路径里各写一份逻辑。**
授予/确认权限的动作（批准工具调用、回答 agent 提问、放宽策略）**只能给用户**，不能做成 tool。

---

## 5. 客户端插件编写

### 5.1 形态

```js
// lib/client.js（构建产物形态）
window.__ModuleLoader__.load({
  id: '@dsh-external/dsh-client-ui-sidebrowser',   // 包名
  factory(require) {
    const React = require('react')
    return {
      inject: ['slots', 'sidebarRightTabs', 'locale'],
      apply(ctx) { /* … */ },
    }
  },
})
```

作者写的是 ESM 源，交给 `tsdown` 编译成上面的惰性 CJS。
证据：`references/ui-plugin.md`
> The browser artifact registers a lazy factory whose id equals the package name. React comes from the browser module table; no duplicate React installation, CDN script, or UMD search is needed. For compiled sources, use the deployment's Client build tooling to emit this format; declare non-baseline runtime imports in `dsh.client.external`.

### 5.2 `ctx.slots.register` 的记录形状

证据：`@deepseek-ai/dsh-client-ui-slots/lib/types/index.d.ts:557-613`

按 slot 的 `kind` 决定用哪组字段：

| slot kind | 必填 | 可选 |
|---|---|---|
| `keyed` | `name`、`key` | `priority`（同 key 遮蔽位，升序，默认 0；同 key 同 priority 抛错） |
| `list` | `name`、`id` | `order`、`label`（`string \| (() => string)`，每次读取重求 → 换语言无需重注册）、`priority` |
| `chain` | `name`、`select` | `priority` |
| `single` | `name` | `priority` |

通用可选字段：`children`（子 slot 声明 = 同时是渲染授权）、`store`、`inject`、`locale`、`registrant`。

注册方式（官方模板）：
```js
ctx.slots.inject('conversation.composer.dock', () => ctx.slots.register({
  name: 'conversation.composer.dock', id: 'my-decoration', order: 5,
}, Decoration))
```
`ctx.slots.inject(ownerKey, factory)` 的回调注册在**所有者声明折叠时自动销毁、返回时自动重装**。

### 5.3 右侧栏 tab：两阶段注册

**阶段一 —— 声明"这个 tab 类型是什么"**：`ctx.sidebarRightTabs.register(definition)`。

证据：`@deepseek-ai/dsh-client-ui-sidebar-right/lib/types/client/tab-registry.d.ts`

```ts
interface SidebarRightTabDefinition {
  readonly id: string                 // 实现身份，全局唯一；惯例用包名
  readonly kind: string               // 类型判别符；openTab 用的名字
  readonly multiple?: boolean         // 同 kind 每次打开是否独立内容；省略 = 每个 pane 一个
  readonly keepMounted?: boolean      // 隐藏后是否保持挂载；默认 false
  readonly patterns?: readonly string[]   // 识别的地址 glob（page 类型不需要）
  readonly priority?: 'extension' | 'builtin' | 'fallback'   // 默认 'extension'
  readonly canOpen?: (address: string) => boolean             // 同步否决
  readonly title: (address: string) => string                // 打开时捕获进布局记录
  readonly guide?: readonly SidebarRightGuideEntry[]          // 引导页入口
}
interface SidebarRightGuideEntry {
  readonly id: string; readonly order: number
  readonly title: () => string
  readonly description?: () => string
  readonly commandId?: ShortcutCommandId
  readonly icon?: ComponentType<IconProps>
}
```

冲突规则：**同一 `kind` 可以同时有一个 `builtin` 和一个 `extension`，`extension` 生效**；
除此之外任何 kind 冲突、以及 `id` 重复，都**抛错**。
`title` / `guide[].title` / `guide[].description` 是 thunk，**每次使用重新读取**，换语言不需要重注册。

**阶段二 —— 用同一个 `id` 作为 key 注册 body 和 title**（两个 seat）：
- `sidebar.right.pane.tab`（body，`keyed`，`scope: 'session'`）
- `sidebar.right.pane.tab.title`（chip 标题，可选；不注册就用 registry 捕获的静态标题）

**官方实作原文**（`@deepseek-ai/dsh-client-ui-sidebar-browser/lib/client.js:1599-1639`）：

```js
ctx.effect(() => ctx.locale.register(namespace, { zh, en }), "ui-sidebar-browser.copy")
ctx.effect(() => ctx.sidebarRightTabs.register({
  ...browserDefinition(t),
  keepMounted: desktop !== void 0,
}), "ui-sidebar-browser.type")

const installFrames = (scope, factory) => {
  scope.effect(() => scope.slots.inject("sidebar.right.pane.tab", () => scope.slots.register({
    name: "sidebar.right.pane.tab",
    key: BROWSER_ID,             // === definition.id
    locale: namespace,
    store,
    inject: (sessionId, actions) => { /* 每 session 一个控制器 */ },
  }, BrowserBody)), "ui-sidebar-browser.body")
}
if (desktop === void 0) installFrames(ctx, () => createIframePage)
else ctx.inject(["workspaces"], (scope) => installFrames(scope, (sessionId) => …))
ctx.effect(() => ctx.slots.inject("sidebar.right.pane.tab.title", () => ctx.slots.register({
  name: "sidebar.right.pane.tab.title", key: BROWSER_ID, store,
}, BrowserTitle)), "ui-sidebar-browser.title")
```

其他 seat（`contract/slots.d.ts`）：
- `rightbar.session` — root 作用域的会话内容
- `sidebar.right.tab.guide`（chain）— 整体替换引导页；全部 decline 时回落到内置
- `sidebar.right.tab.guide.entry`（keyed）— 只贡献一张引导卡
- `sidebar.right.tab.menu.item`（list）— 追加到某个 tab 的操作菜单；**条目必须调用 owner 的 `dismiss()`**

body 运行时从 props / hook 拿到的东西（`SidebarRightTabInfo`）：
`sidebar.{expanded,fullscreen}`、`panel.id`、`tab.{...TabRecord, visible, navigation:{address,params,revision}, signal, actions}`，
其中 `actions` 提供 `bindCommands` / `openResource` / `openTab` / `close`。

页地址格式：`sidebar://<kind>`（`contract/seed.d.ts`），`openTab(kind)` 内部合成，调用方只写 kind。

### 5.4 locale 词典

证据：`references/ui-plugin.md`
> Route visible UI text through the Client locale service.

两条路：
1. **内联词典**（官方 `@deepseek-ai/dsh-client-ui-sidebar-browser` 的做法）
   ```js
   const namespace = 'sidebrowser'
   ctx.effect(() => ctx.locale.register(namespace, { zh, en }), "sidebrowser.copy")
   ctx.slots.register({ name, key, locale: namespace, … }, Body)   // 注册项声明 locale
   // Body 的 props 上就有 t: TranslateNS<'sidebrowser'>
   ```
   注意命名空间需通过 `declare module '@deepseek-ai/dsh-client-ui-slots' { interface LocaleNamespaceMap { … } }`
   声明（`.d.ts`），这样 `LocaleDictOf<N>` 才能在编译期校验键集合。

2. **JSON 文件 + `exports["./locale/*.json"]`**
   仓库里放 `locale/en.json`、`locale/zh.json`，`files` 里带上，通过动态 import 取。
   （本轮**未**在官方包中找到强制使用 JSON 路径的实例，标记为可选。）

### 5.5 模块基线与 `dsh.client.external`

证据：`dsh-client-modules/README.md` §Sharing modules
> The shell seeds a frozen module table (`PLATFORM_MODULES`: React, Cordis, and static UI libraries); every dynamic bundle resolves its externals against exactly that baseline. `dsh.client.external` adds only exact non-baseline requests, each answered by the dynamic package row it names or an exact static-table key. **Type-only imports are erased and create no request.** Composition rejects malformed requests, missing suppliers, self-requests, and synchronous request cycles.

禁止事项（`references/practices.md`）：
> Do not `require('@deepseek-ai/dsh-client-ui-primitives')` or load any other Harness Client package as a module;
> `dsh.client.inject` entries only order activation and stay allowed.
> …a throwing component blanks your slot entry (console: `slot entry crashed in '<slot>'`).

正确做法：把 primitive 的 markup / CSS / 行为**抄进自己的插件**，类名加自己的前缀，
只保留 `--dsw-alias-*` token 引用，并保留用户依赖的行为（Modal 焦点与 Escape、`role="switch"` + `aria-checked`、Tooltip 定位）。

### 5.6 样式

- 主题 token：`--dsw-alias-*`（用 `cordis_inspect_query` 的 `Theme` 列出当前可用集合）。
  **字面颜色只用于插画**。改名只会降级外观，不会炸掉渲染 —— 这是最低风险的匹配方式。
- CSS 由构建器打进 `lib/client.js`，在工厂 materialize 时注入；**卸载靠 effect 的 disposer**，不是靠刷新。
- 组件局部样式可以直接渲染成 React 元素（内联 style / CSS-in-JS 风格的 `<style>` 节点），这样卸载自动带走。
- 不要往 `document.body` 追加第二个应用根，也不要替换 app root。

---

## 6. Agent 工具

### 6.1 `ToolDefinition`

证据：`@deepseek-ai/dsh-tools/lib/types/index.d.ts:105-191`

```ts
interface ToolDefinition extends ToolSchema {   // name / description / parameters
  readonly output: ToolOutputDefinition          // 必填
  execute(args: unknown, exec: ToolRunContext): Promise<unknown>   // 必填
  projectContent?(exec, result): ContentBlock[] | undefined
  finalizeContent?(exec, result): ContentBlock[] | undefined
  timeoutMs?: number
  isConcurrencySafe?(args): boolean
  presentCall?(args): ToolCallView | undefined
  presentResult?(args, result: ToolResult): ToolResultView | undefined
}
interface ToolOutputDefinition {
  readonly schema: JsonSchemaNode
  render(args: unknown, value: JsonValue): ContentBlock[]
  presentationMeta?(args, value): JsonValue
}
```

要点：
- `output.schema` 必须是**合法 JSON Schema**，**注册时即断言** —— 写错会在加载时炸，而不是第一次调用时。
- `parameters` 是**原始 JSON Schema**（不是 DSH DSL）。官方 `defineTool` 能把友好 DSL 编译过去；
  不想依赖 `@deepseek-ai/dsh-tools` 时可以照抄 —— `dsh-comfyui-image/lib/define-tool.js` 就是一份
  零依赖的 `defineTool` 等价实现（`parametersToJsonSchema` + `validateArguments` + `ToolArgsError`）。
  **它的注释说明了为什么这么做**：以目录 junction 安装的插件若 `import` 一个 peer，
  peer 要从 junction 的真实路径解析，而不是从 profile 的 `node_modules` —— 零依赖能在任何暴露
  `ctx.tools` 的 Host 上从裸 git clone 装起来。
- 工具名 `run_code` 被 Host 保留。
- `execute` 必须观察/转发 `exec.signal`；异步工作要等到自己负责的工作静默后再 resolve。
- `timeoutMs` 由 `dsh-tool-call-timeout-policy` 强制，**从不下发给模型**；声明它等于承诺会转发 `exec.signal`。

### 6.2 注册与降级

```js
const dispose = ctx.tools.register(definition)   // 返回 disposer
```
`ctx.tools` 不存在时（profile 未带 `tools`）插件应保持不激活而不是抛错 —— 见 §4.2。

### 6.3 让模型知道工具存在

两种正规途径（`references/practices.md`）：
- `ctx.systemPrompt.section()` —— 追加提示词段落。
- `agent.inject()` —— 每个 agent 的上下文（调用时记为 `agent/inbox/spliced`，进入下一个准入步骤）。

**不要**用 `system-prompt/assemble` 增删工具或文本。

工具可见性策略由强到弱：
`ctx.tools.restrict()`（只能移除）→ `ctx.tools.guard()`（只能否决，同步）→
waterfall 监听器（可重写，依赖注册顺序）→ `system-prompt/assemble`（替换整个组装）。
**能用最弱的就别用最强的。**

### 6.4 实作样例（`dsh-comfyui-image/lib/index.js`）

```js
function generateTool() {
  return defineTool({
    name: 'comfyui_generate',
    description: '…（一整段自然语言描述，两种工作流的取舍在这里讲清楚）',
    parameters: { prompt: { type: 'string', required: true, description: '…' }, … },
    output: { schema: outputSchema, render(_args, value) { return [{ type: 'text', text: … }] } },
    isConcurrencySafe: () => false,
    async execute(args, exec) {
      // …；把 exec?.logger、exec?.signal 传下去
    },
  })
}
```

---

## 7. 构建与打包

### 7.1 构建

- **客户端**：`tsdown`（官方唯一示例），`pnpm run build` 必须先产出 `lib/client.js`。
  证据：`dsh-client-modules/README.md`
  > The host serves built client bundles, so `pnpm run build` must have produced each `lib/client.js` before launch; **a missing bundle fails activation loudly** with one build instruction and a package/path list.
  > A source `import()` split by tsdown compiles to `require.async("./client.<name>.js")`.

  `tsdown` 配置参考本仓库 `tsdown.config.ts`（4880 字节，含 CSS 处理）。
- **Host 半边**：`tsc`/任意打包器产出 ESM `lib/index.js` 即可，无强制工具。
- 官方发布包统一额外产出 `lib/types/**/*.d.ts`（`tsc --emitDeclarationOnly`），本仓库目前**没有**产出 `.d.ts`
  （`files` 只含 `lib/**/*.js` / `.js.map`）—— 对纯 JS 使用无影响，但类型消费者拿不到声明。

### 7.2 `files` 应包含什么

对照真实插件：

| 包 | `files` |
|---|---|
| `@deepseek-ai/dsh-client-ui-sidebar-browser` | `lib/index.js`, `lib/client.js`, `lib/types/**/*.d.ts` |
| `dshmarket` | `locale`, `lib`, `src`, `client`, `UPDATE-API-V1.md`, `cordis.patch.yml`, `LICENSE` |
| `dsh-cost-meter` | `locale`, `lib`, `cordis.patch.yml`, `docs/provider-pricing.json`, `docs/external-usage.md` |
| `dsh-comfyui-image` | `lib`, `skills`, `workflows`, `cordis.patch.yml`, `README.md`, `LICENSE` |

必备清单：
- `lib/`（含 `index.js` 与 `client.js`）
- `cordis.patch.yml`（**缺了插件不会被激活**）
- `icon.svg`
- `locale/`（若用文件词典）
- `package.json` / `README` / `LICENSE`

### 7.3 git URL 安装的一个真实坑

`dsh plugin --profile <p> add git+https://…` 走 pnpm，pnpm 对 git 包会执行 `prepare`，
但被 `allowedDeprecatedVersions`/`allowBuilds` 策略拦住（源码证据 `dsh/lib/plugin-*.js:97` 的错误文案）。
本仓库 `scripts` 里**只有 `prepack`，没有 `prepare`**，
所以 git URL 安装时不会构建出 `lib/` → 客户端激活会响亮失败。
要么加 `prepare`，要么 README 里只推荐 npm 发布包。

---

## 8. 陷阱（Gotchas）

### 8.1 单实例守卫

一个插件持有一个 Chrome / 一个 WebSocket / 一个端口。如果 `apply` 被重新执行
（配置变更导致 fiber 重挂、profile patch 重载、插件重新启用）而旧实例没被收走，就会出现双实例、
端口冲突、僵尸 Chrome。

正确形态：**模块级或 `ctx` 级单例 + 幂等创建 + 幂等销毁**，
并在返回的清理函数与 `ctx.on('dispose')` 里**都**收走（`dsh-comfyui-image` 的注释直说：
> Only stop processes we actually started; a server the user launched stays.）

若字段声明为 `.volatile()`，配置变更不会重挂，这类问题会少很多（见 §4.3）。

### 8.2 卸载清理

- `ctx.effect(() => { …; return cleanup }, "label")` —— label 会出现在诊断里，排障时很有用。
- 所有 `register()` 的返回值都是 disposer，必须收集并调用。
- 客户端的样式、监听器、计时器都在工厂 materialize 后才存在，清理也必须在对应 effect 里。
- 定时器：`references/practices.md` 要求 "Clear the timer in the owning effect"；
  定时器触发工作应调用 `agent.followup()`（能唤醒 agent），`agent.inject()` 不能唤醒。

### 8.3 挂载不得弹窗

- 插件的 `apply` / 工厂函数体**不得有副作用**：不能开窗口、不能起进程、不能发请求。
  惰性 CJS 模型的存在意义就是"加载 ≠ 执行"。
- 官方 sidebar-browser 是 **first-use lazy**：`const desktop = carrier?.protocolVersion === 1 ? carrier.browser : void 0`，
  只在真的要用时才准备渲染后端。本仓库 README 声明的"第一次使用才拉起 Chrome"是对的，符合此原则。
- 只在用户可见的 surface（右侧栏 tab）被打开时做事，不要在 Host 进程启动时就抢端口。

### 8.4 客户端 CSS

- CSS 会被打进 `lib/client.js`，**在工厂 materialize 时注入**（不是加载时）。
- 因此「禁用插件 → 样式是否消失」取决于模块系统是否驱逐样式。证据：
  `dsh-client-modules/README.md` §Live plugin composition
  > disabling it removes the entry and waits for its asynchronous effects before **evicting unused modules and styles**. Re-enabling loads one instance with its styles.
  → 即：**禁用后样式会被驱逐，重新启用会重新注入一份**。所以 CSS 重复注入是幂等的，不需自己去重。
- 保险做法：组件局部样式渲染成 React 元素（`<style>` 或内联 style），卸载时随组件一起消失。
- 不要 import 别的插件的 DOM / 样式表 / 组件源码来"估位置"。

### 8.5 ESM/CJS 互操作与 `ws`

- Host 半边是 **ESM**（`"type": "module"`），`import WebSocket from 'ws'` 走 CJS 默认导出互操作；
  ESM 下取 CJS 的具名导出不可靠，**用 default import**。
- 插件以 `link:` 安装时是 **junction**，`import` 一个 peer 时 Node 会从 **junction 的真实路径**解析，
  而不是从 profile 的 `node_modules` —— 这正是 `dsh-comfyui-image` 选择零运行时依赖并自带
  `define-tool.js` 的原因（`lib/define-tool.js` 注释原文）。
- 纯运行时依赖（`ws`）必须能被解析到：profile 常常已经有 `ws`，但**不能假设**；
  README 里让用户手动补 `node_modules/ws` 是可接受的兜底，正式做法是写进 `dependencies`
  并让 pnpm 安装。

### 8.6 其他

- **不要**用新的 `type` 追加 session 事件：读取方只接受 envelope 带 `ignorable: true` 的未知事件，
  而 live `Session.append()` 设不了这个标记，会导致 Session 无法重开。
  要存自己的数据就用 storage 服务。
- 会话相关状态放 `ctx.sessionProjections` unit，`apply(state, event)` 保持纯函数；
  忽略事件时返回**同一引用**，下游零开销。
- 等持久事件（`turn/end`、`assistant/message`、`tool/result`），实时 token 走 `agent/assistant-stream`。
  **不要轮询 `agent.status`。**
- waterfall 监听器若不拥有该决策，必须 `return next()`；重写 `agent/pre-step` 决策时要展开
  （`{ ...decision, messages }`），否则 `startsRequestSeries` 等字段会丢。

---

## 9. 本仓库（`dsh-sidebrowser`）合规检查

### 9.1 `package.json`

| 项 | 结论 |
|---|---|
| `main` / `exports["."]` → `lib/index.js` | ✅ |
| `exports["./client"]` → `lib/client.js` | ✅ |
| `exports["./package.json"]` | ✅ |
| `icon: "icon.svg"`（顶层） | ✅（`files` 已含） |
| `dsh.bundle.patch` → `./cordis.patch.yml` | ✅ |
| `dsh.client.platform: "web"` | ✅ |
| `dsh.client.inject[]` | ✅ 只列官方包名，语义是排序 |
| `peerDependencies["@deepseek-ai/dsh"] = ">=0.2.0-rc.1"` | ✅ **且这一条真的会被检查**；运行时 `0.2.0-rc.2` 满足 |
| `peerDependencies["react"] = "^18.2.0"` | ⚠️ 名字不匹配检查规则，被忽略；但会让人误以为 React 由包管理器提供。React 必须来自浏览器 `PLATFORM_MODULES` |
| **`engines.dsh`（顶层）** | ✅ 已修正：规范位置是**顶层 `engines.dsh`**（与 `engines.node` 平级）。Host 当前不强制执行此字段 |
| `dsh.manifestVersion` | ⚠️ 未声明（可选） |
| `files[]` 含 `lib/**/*.js.map`、`lib/**/*.css`、`src`、`scripts` | ✅ `lib/**/*.css` 已补（样式随包发布）；`.d.ts` 未产出（可选）；`src`/`scripts` 增大包体，与官方包的 `files` 风格不同（非错误） |
| `scripts.prepare = "tsdown"` | ✅ 已补：git URL 安装会自动构建 `lib/`（§7.3 的坑已封） |

### 9.2 `cordis.patch.yml`

```yaml
- insert:
    - id: ui-sidebrowser
      name: '@dsh-external/dsh-client-ui-sidebrowser'
```
✅ 与 `dsh-comfyui-image` / `dshmarket` 完全同形；`id` 全局唯一，`name` 为包名。
文件头注释已更新为完整安装说明（两处登记 + 不要手写 insert 的警告）。

---

## 10. 现有文档的事实错误清单（✅ 已全部修复）

> **状态**：本清单是审计快照，列出的所有条目已在同一次开发中修复完毕 ——
> E1–E5 重写进 `INSTALL-LOCAL.md`；E7–E10、E12、E13、E18 已改 `README.md` /
> `README.zh.md`；E8 的根因通过给 `package.json` 补 `scripts.prepare` 解决；
> E6、E11 属「表述可接受」，未改。保留原文供后来者核对。

### 10.1 `INSTALL-LOCAL.md`

| # | 位置 | 问题 | 正确说法 |
|---|---|---|---|
| **E1** | L88 | "它会自己写 profile 的 `bundles` 和 `cordis.patch.yml`" —— **事实错误** | `dsh plugin …` 只是把参数转发给 pnpm（`dsh/lib/bin.js` 文档字符串："`plugin` manages a profile's plugin dependencies by forwarding to pnpm"；`runPlugin()` → `runProfilePnpm`/`runPluginCommand`）。**不会**写 `dsh.profile.bundles`，**也不会**写 `cordis.patch.yml` |
| **E2** | L51–66「改动二」 | 要求手工往 `~/.dsh/cordis.patch.yml` 加 `insert` 段 —— **多余**。插件行的正规来源是包内 `cordis.patch.yml` 经 `dsh.bundle.patch` 被读取 | 删除这一节。**同 id 不会造成重复行**（entry tree 按 id 索引，`Object.fromEntries` 折叠，后写覆盖），但**不同 id 会真的装载两遍** —— 这才是风险 |
| **E3** | L6 / L10 | "DSH 加载一个第三方插件需要两处登记，缺一不可"，且把第 2 项写成 `~/.dsh/cordis.patch.yml` | 实际是三件事：① `dependencies` ② `dsh.profile.bundles` ③ bundle 自带的 patch 文件。第 ③ 件**不需要手工维护** |
| **E4** | L88 | `dsh plugin --profile desktop add link:E:/agent\ project/dsh-sidebrowser` | 语法本身对（pnpm 会把空格路径当作一个参数处理，反斜杠转义在 bash 下可用），但**必须紧跟一句**：还要把 `@dsh-external/dsh-client-ui-sidebrowser` 加进 `dsh.profile.bundles` |
| **E5** | L13–14 | "你现有的 `dsh-comfyui-image` 就是这个模式的现成例子" —— 半对 | 它确实是 `link:` + `bundles` 的例子，但**不是** `~/.dsh/cordis.patch.yml` 手写 insert 的例子（那文件里根本没有它的行） |
| **E6** | L93–99 | 内置 browser tab 的对比说明 | 与官方 `@deepseek-ai/dsh-client-ui-sidebar-browser` 的实际形态一致（iframe / Electron webview 两种后端），✅ 无误 |

### 10.2 `README.md`

| # | 位置 | 问题 | 正确说法 |
|---|---|---|---|
| **E7** | L56–65「Install as a bundle (recommended)」 | 把 `dsh plugin --profile <p> add link:<path>` 当作**充分**的安装步骤 | 还要把**包名**加进 `$DSH_HOME/profiles/<p>/package.json` 的 `dsh.profile.bundles`。只做 CLI 这一步的结果是"装上了但永不激活" |
| **E8** | L63 | `dsh plugin --profile desktop add git+https://github.com/<owner>/dsh-sidebrowser.git` | git URL 安装会触发 pnpm 的构建脚本拦截，且本包**没有 `prepare` 脚本**，`lib/` 不会被构建 → 客户端激活响亮失败。应加 `prepare` 或注明需先发布 npm 包 |
| **E9** | L69 / L76 | "producing `lib/index.js` … and `lib/client.js` (the client half, **CommonJS wrapped** for the Web GUI's module loader)" | 准确的说法是**惰性 CJS 工厂**：产物执行时只调用 `window.__ModuleLoader__.load({ id, factory })` 注册工厂，模块体在 materialize 时才跑。直接说 "CommonJS" 会让作者以为可以自己写 `module.exports` |
| **E10** | L78–88「Manual install」第 4 步 | "Add the `cordis.patch.yml` row to the profile's bundle patch" —— 语义含混 | bundle patch 由 `dsh.bundle.patch` 自动读取；手写的正确位置是 **profile 的 `cordis.patch.yml`**（作为配置覆盖层），而不是"bundle patch" |
| **E11** | L112 | "The tools register into the session's tool registry when the deployment provides one" | 表述可以，但**更好的官方做法**是在 `export const inject = ['tools', …]` 里声明，让缺服务的 profile 直接不激活（`references/practices.md`）。当前的运行时判空也可以，但要与 `inject` 一致 |
| **E12** | L143 | "The settings card binds to this plugin's own row in the profile (entry id `ui-sidebrowser`, falling back to the `sidebrowser` namespace) and writes through **dsh's configuration form**" | ⚠️ **未能核实**存在这样一个"配置表单绑定" API。本轮在官方包里找到的是 `dsh-client-ui-settings` / `dsh-client-ui-settings-plugins` / `dsh-host-plugin-inventory`，但没有验证一个第三方插件可以直接绑定到自己的行的通用表单组件。**建议按 §5.2 的 slot 机制实现设置项，或先用 `cordis_inspect_query`（`Slots.listSubTree` + `Service`）确认接口后再写文档** |
| **E13** | L167 | "every field is volatile, so an edit commits in place instead of remounting the plugin" | ✅ 机制正确（`entry.ts:139-195`）。但 "every field" 需要与"四个影响启动的字段要重启"并读——官方语义是 volatile 字段**就地提交**，而启动期读取的字段即便 volatile 也不会被重新读取。建议表述为"就地提交但需重启才生效" |

### 10.3 `README.zh.md`

| # | 位置 | 问题 |
|---|---|---|
| **E14** | L59 | 同 **E7**：`dsh plugin … add` 不是完整安装 |
| **E15** | L63 | 同 **E8**：git URL + 无 `prepare` |
| **E16** | L78 | 同 **E10**："在 profile 的 bundle patch 里加上 `cordis.patch.yml` 那一行" |
| **E17** | L147 / L167 | 与 README.md 对应段落，**E11 / E13** 同样适用 |
| **E18** | L212 | `dsh plugin --profile <profile> remove` —— 语法正确（pnpm `remove`），但**只删依赖，不删 bundles 列表项**，需补一句手动清理 `dsh.profile.bundles` |

### 10.4 原「需要 Lead 确认的两点」——均已解决

1. ~~`~/.dsh/cordis.patch.yml` 是否保留「改动二」？~~ **不保留，已删除。**
   `INSTALL-LOCAL.md` 改为说明 bundle patch 自动生效，并警告不同 id 的手写行
   会导致双份装载。
2. ~~E12（settings 表单绑定）需要实证。~~ **按未验证处理并已改写**：README 现在
   明说 `settings.section` 座位在已发布包中不存在、卡片今天不渲染，配置走
   profile 的 `cordis.patch.yml`。

---

## 11. 一页速查

```
包 = 一个 npm 包，双面
  exports["."]      → Host 半边 (ESM, main)         cordis 行 name 指向它
  exports["./client"]→ 客户端半边 (惰性 CJS)         /plugins/<包名>/client.js
  dsh.bundle.patch  → cordis.patch.yml             → - insert: [{id, name}]
  dsh.client        → {platform:'web', inject[], external[]}
  顶层 engines.dsh  → 声明用（不强制）
  peerDeps @deepseek-ai/dsh* → 强制！不匹配就拒载（可用 allow-version 豁免）

安装 = dependencies  +  dsh.profile.bundles  +  （包自带的 patch，无需手写）
CLI   = dsh plugin --profile <p> add link:<path>     ← 只做 dependencies！
重启 = 换包代码必须重启 Host；改配置不需要（volatile 字段还不重挂）

Host  = export function apply(ctx, config) / export const inject / export const Config
        Schema.object({...}).volatile() → 配置就地提交，不重挂
        ctx.effect(() => {…; return cleanup}, "label")
        ctx.tools.register(ToolDefinition) → disposer
        ctx.systemPrompt.section() / agent.inject() 让模型知道工具

Client= window.__ModuleLoader__.load({ id: 包名, factory(require) { return {inject, apply(ctx)} } })
        ctx.slots.inject(seat, () => ctx.slots.register({name, key|id, order?, locale?, store?, inject?}, C))
        右侧栏两阶段：ctx.sidebarRightTabs.register({id, kind, title, guide?, priority?})
                     + slots.register({name:'sidebar.right.pane.tab', key: 同一个 id}, Body)
                     + slots.register({name:'sidebar.right.pane.tab.title', key: 同一个 id}, Title)
        React 从 PLATFORM_MODULES 来；禁止 require 任何 Harness Client 包
        样式只用 --dsw-alias-* token
```