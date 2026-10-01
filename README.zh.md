# dsh-sidebrowser

[English](README.md) | 中文

给 DeepSeek Harness（dsh）Web GUI 右侧栏加一个**可控的真实浏览器**：在对话旁边打开 DeepSeek 网页版、Bing、百度/有道翻译或任意网址，让你正在看的页面**成为模型能读、也能操作的那个页面**；并且在对话里选中一个词或一句话时，选区旁边会浮出一个小框，提供「AI 解释」「翻译」和「复制」。

> TODO: screenshot

---

## 为什么需要它

先说最关键的技术事实，因为它决定了这个插件的形态：

**DeepSeek 网页版、Bing、Google 都不允许被跨域 `<iframe>` 嵌入。** 它们返回 `X-Frame-Options`，或者在 CSP 里声明 `frame-ancestors`，任何 `<iframe>` 只会得到一片空白或「拒绝连接」。也就是说，「在 GUI 里内嵌一个网页版 DeepSeek」这条路在浏览器安全模型下是不存在的，不是某家厂商的开关问题。

所以这个插件**不在 GUI 里内嵌 webview**。它做的是：

- Host 进程在你自己的机器上**启动一个真实的 Chrome 窗口**，用 `--remote-debugging-port` 打开 CDP（Chrome DevTools Protocol）端口并驱动它；
- 右侧栏那个 tab 因此是一个**遥控面板**：Chrome 窗口的实时截图、地址栏、后退/前进/刷新、标签页条、以及一个「页面文本」视图；
- 你真正交互的地方，是**桌面上弹出的那个 Chrome 窗口**。

由此产生几条必须说清楚的性质：

- **窗口是可见的。** 它就开在你桌面上，不是一个隐形的后台浏览器，也不是一个需要另外安装的应用——你机器上需要已经装着 Chrome 或 Edge。
- **按需启动。** 只有你第一次使用（打开标签页、调用工具、访问路由）时才会拉起浏览器；装载插件本身不会每次启动 Host 都弹窗。
- **独立 profile 目录。** 插件给这个 Chrome 一个专用的 `--user-data-dir`，所以你在那个窗口里**手动登录一次 DeepSeek**，登录态就会一直保留下来。这个登录流程正是整个功能的地基。
- **这就是模型能读到 DeepSeek 网页的原因。** 模型需要页面文本，而跨域 frame 永远给不了它；一个 Host 端驱动真实 Chrome 的窗口可以。

### 与内置 browser 标签页的区别

| | 内置 `@deepseek-ai/dsh-client-ui-sidebar-browser` | 本插件 `dsh-sidebrowser` |
| --- | --- | --- |
| tab kind | `browser` | `sidebrowser-cdp` |
| 渲染方式 | 应用内 **iframe**（Web）/ Electron `<webview>`（Desktop） | 主机上一个**真实 Chrome 窗口**，通过 CDP 驱动，右侧栏显示其实时画面 |
| 能否加载 DeepSeek / Bing / Google | **不能**——这些站点拒绝被跨域 frame 嵌套 | **能**——它根本不走 frame |
| 模型能否读取并操作页面 | 不能 | 能：`browser_read` / `browser_act` / … |
| 选中文本 AI 解释 / 翻译 | 无 | 有 |

两者**共存**：它们是不同 kind、不同实现 id 的两个 tab 类型，谁也不覆盖谁，可以同时开着。内置那个的文档也直说了这一条——如果你的站点拒绝 iframe 嵌入，或者你需要本包不提供的浏览器能力，就该用明确的外部浏览器操作。

如果你只是需要普通的网页浏览，内置那个 tab 可能已经够用；本插件针对的是「让模型读、并且操作我正在看的这个页面」这个需求。

---

## 功能

1. **右侧栏浏览器。** 在对话旁边开一个 tab（tab 类型 `sidebrowser-cdp`），打开 DeepSeek 网页版、Bing、百度翻译、有道翻译或任意 http(s) 网址。面板提供：实时画面、地址栏（可输入网址或直接搜）、后退 / 前进 / 刷新、标签页条（新建 / 关闭 / 切换）、快捷入口按钮，以及一个「页面文本」视图。tab 的标题会跟着主机窗口当前页面的标题走。
2. **Agent 工具。** 会话里的模型拿到 5 个 `browser_*` 工具，可以读页面、点击、输入、按键、滚动、导航、管理标签页、截图。工具和侧边栏**共用同一个 driver**：你手动开的页面，模型读的就是那一个；模型开的页面，也会出现在你的侧边栏里。可以用设置里的 `agentTools` 单独关掉这层能力而保留侧边栏。
3. **选中文本小工具。** 在对话里选中任何词或一句话，旁边会出现一个小框：**AI 解释**（走 DeepSeek 网页版，不消耗 API 额度，用的是你网页版的对话历史）、**翻译**（默认走有道 / Bing / 百度翻译站，翻译站失败时自动回退到 DeepSeek 网页版）、**复制**。可以用设置里的 `selectionPopup` 关掉。

---

## 安装

### 用 bundle add 安装（推荐）

```bash
dsh plugin --profile <profile> add link:<path-to-this-repo>
```

- `<profile>` 是你的 dsh profile 名，通常是 `desktop` 或 `web`；
- 仓库发布到 GitHub 之后，也可以直接用 git URL 安装：`dsh plugin --profile desktop add git+https://github.com/<owner>/dsh-sidebrowser.git`。

**装完必须重启 DSH。** Host 半边（Chrome driver、控制路由、`browser_*` 工具）跑在 Host 进程里，插件进入 profile 的 `node_modules` 后需要重启 Host 才会被认领；只刷新 Web GUI 页面是不够的。

### 手动安装（等价做法，开发者实际使用的流程）

1. **先构建**：`pnpm install && pnpm build`，产物是 `lib/index.js`（Host 半边，ESM）和 `lib/client.js`（客户端半边，被 Web GUI 的模块加载器包装过的 CJS）；
2. 把**构建后的整个包目录**复制到 profile 的 `node_modules/@dsh-external/dsh-client-ui-sidebrowser/`：

   ```
   ~/.dsh/profiles/<profile>/node_modules/@dsh-external/dsh-client-ui-sidebrowser/
   ```

   注意是带 `@dsh-external/` 这个作用域目录的完整包（要有 `package.json`、`lib/`、`cordis.patch.yml`、`icon.svg`），不是仓库根目录；
3. **确认 `ws` 能被解析。** Host 半边唯一的运行时依赖就是 `ws`。多数 profile 本身就带着它；本仓库的 `node_modules` 里有也可。若解析不到，在该包目录下补一个 `node_modules/ws`，或把它装进 profile。
4. 在 profile 的 bundle patch 里加上 `cordis.patch.yml` 那一行：

```yaml
- insert:
    - id: ui-sidebrowser
      name: '@dsh-external/dsh-client-ui-sidebrowser'
```

5. **重启 DSH。这一步是必须的。** Chrome driver、控制路由和 `browser_*` 工具都跑在 **Host 进程**里——把包复制进 `node_modules` 并不会让正在运行的 Host 认领新插件。只刷新 Web GUI 页面是不够的。

这正是本仓库 `cordis.patch.yml` 的内容。插件是「双面」的：node 侧（exports `.`）在 Host 进程里跑浏览器 driver、控制路由和 `browser_*` 工具；`package.json` 里的 `dsh.client` 声明让客户端侧（exports `./client`）在 Web GUI 里加载，贡献右侧栏 tab 和选区小框。

### 依赖

- 运行时依赖只有 `ws` 一个（CDP 的 WebSocket 客户端）。不需要 Puppeteer / Playwright。
- 本机需要已安装 Chrome 或 Chromium；找不到时也可用 Edge 兜底，也可以在设置里填自定义可执行文件路径。
  - `C:\Program Files\Google\Chrome\Application\chrome.exe`
  - `C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe`
  - macOS: `/Applications/Google Chrome.app/Contents/MacOS/Google Chrome`

---

## 使用

### 打开侧边浏览器

在右侧栏的引导页里点 **侧边浏览器**，或在已打开的格子里用它。首次使用时 Host 会启动 Chrome 窗口。

**第一次请在那个 Chrome 窗口里手动登录 DeepSeek。** 之后 profile 目录会记住登录态，通常不需要再登。

面板上的地址栏接受完整 URL，也接受快捷名：`deepseek`、`bing`、`baidu`、`youdao`、`google`、`googleTranslate`。

### Agent 工具

工具默认注册到会话的工具注册表里（如果当前部署提供了该注册表；没有的话侧边栏照常工作，只是少了面向模型的那部分）。

| 工具 | 作用 | 主要参数 |
| --- | --- | --- |
| `browser_open` | 新标签页打开一个 URL，返回 tabId / title / url。永远开新标签页，不会把你当前的页面顶掉。 | `url`（完整 http(s) URL 或快捷名） |
| `browser_read` | 读当前页面的**渲染文本**（`document.body.innerText`）+ 标题 + URL。可选返回标题 / 链接 / 表单字段清单，好让模型用真实 selector 而不是猜。 | `tabId`、`maxChars`（默认 8000，上限 200000）、`includeInventory` |
| `browser_act` | 执行一个动作并返回确认与当前 URL / 标题。动作：`navigate` / `click` / `type` / `key` / `scroll` / `back` / `forward` / `reload`。 | `action`、`url`、`selector`、`text`、`key`、`x`、`y`、`deltaY`、`tabId` |
| `browser_tabs` | 列出、新建、关闭、切换标签页。 | `action`（`list` 默认 / `open` / `close` / `select`）、`url`、`tabId` |
| `browser_screenshot` | 把当前页面截图成 Host 上的 PNG 文件并返回**文件路径**（不是把 base64 塞进 transcript）。 | `tabId`、`fullPage`、`scale`（0.2–1，默认 0.5） |

几个刻意的设计选择：

- **没有 raw `eval` 工具，也没有接受任意 JavaScript 的路由。** 唯一的求值端点是 `POST /api/sidebrowser/eval-safe`，它只接受 `{operation}` 为 `click` / `type` / `key` / `scroll` / `read` 五个具名操作之一；每个操作都映射到一个 driver 方法，而那个方法的页面函数是**插件自己写死的字面量**，调用方传进来的值一律经 `Runtime.evaluate` 的 `args` 以序列化方式送入，永远不会被拼接成代码。在用户已登录的浏览器里执行任意 JS，等于把页面内容变成注入向量——这条线插件不越。
- **拒绝是返回值，不是异常。** 「这个页面需要登录」这类域内拒绝以 `ok:false` 的结构化结果返回，模型应该据此告诉用户，而不是当作内部故障去重试。常用 code：`no-browser`、`bad-url`、`selector-not-found`、`tab-not-found`、`no-tab`。
- **只允许 http/https。** `file:`、`javascript:` 等 scheme 一律拒绝。
- **截图返回路径而非图片数据。** 一张 base64 PNG 是几 MB，放进会话记录会污染之后每一次上下文窗口；写到临时文件并返回路径，模型要用时自己去读。

### 选中文本小工具

在对话里选中文字，旁边的小框提供：

- **AI 解释** —— 通过 DeepSeek 网页版提问（不是 API）。插件会确认主机浏览器已连接、切到 `chat.deepseek.com`、等页面挂载后逐个尝试候选输入框选择器把提问打进去、回车提交，然后轮询页面文本直到回答停止增长，再把最后一条回答切出来。一个词和一段话会用不同的提问方式；选区被包在 `<selection>` 里，避免选中的文字本身被当成指令。
- **翻译** —— 默认用翻译站（有道 / Bing / 百度），目标语言和引擎在设置里选。翻译站拿不到可读结果时自动回退到「用 DeepSeek 网页版翻译」。
- **复制**。

小框是防御式的：主机浏览器没连上、未登录、找不到输入框、90 秒内没等到回答、Host 路由失败，都会显示一句用户能照做的提示，而不是一个空白的答案框。**「没读到」永远不会被当成「这就是模型的回答」展示出来**——这两者的区别很重要：前者是用户去修登录，后者是 misinformation。

---

## 配置

设置卡片绑的是**本插件自己在 profile 里的那一行**（entry id `ui-sidebrowser`，回退到 `sidebrowser` 命名空间），并通过 dsh 的配置表单写入——**不是**存在浏览器 localStorage 里的。这样设置跟着 profile 走，换机器也在；同一个值（目标语言、翻译引擎）也就能同时被 DeepSeek 网页版桥接和翻译站路径读到。

卡片是「暂存—保存」式的：你输入的内容先留在草稿里，点「保存」才作为一次带版本校验的原子写入提交。输入过程中不会逐字落盘。

Host 侧的 `Config`（`src/index.ts` 里的 schema）是这些字段的唯一事实来源：

| 字段 | 类型 | 默认值 | 说明 |
| --- | --- | --- | --- |
| `enabled` | boolean | `true` | 总开关。关掉后路由和工具都不再挂载。 |
| `executablePath` | string | `''` | 自定义浏览器可执行文件路径。留空则依次探测标准 Chrome / Chromium / Edge 位置。 |
| `port` | number | `0` | 固定 CDP 调试端口。`0` 表示由系统分配一个空闲端口（默认，避免和第二个 dsh profile 或已有的调试浏览器冲突）。 |
| `userDataDir` | string | `''` | Chrome profile 目录。留空则用临时目录下按用户命名的稳定路径。 |
| `headless` | boolean | `false` | 是否无窗口启动。默认关闭——你要在这个窗口里登录 DeepSeek。 |
| `captureIntervalMs` | number | `1000` | 抓帧间隔（**毫秒**），范围 250–10000。 |
| `captureScale` | number | `0.5` | 截图缩放系数，范围 0.2–1。 |
| `selectionPopup` | boolean | `true` | 是否显示选中文本小工具。真的生效：关掉后选区旁不再浮出小框。 |
| `agentTools` | boolean | `true` | 是否注册 `browser_*` 工具。真的生效：关掉后模型拿不到浏览器能力，但侧边栏照常可用——这正是「要浏览器但不要模型控制权」的场景。 |
| `defaultUrl` | string | `https://chat.deepseek.com/` | 新标签页默认打开的地址，必须是 http(s)。 |
| `shortcuts` | string | `''` | 快捷入口网址，每行一条 `名称 网址`。 |
| `targetLanguage` | string | `zh-Hans` | 翻译目标语言，BCP 47 标签。 |
| `translationEngine` | string | `youdao` | 翻译引擎：`youdao` / `bing` / `baidu`。 |

**抓帧间隔的单位陷阱**：Host 存的是**毫秒**（`captureIntervalMs`），设置卡片里显示和编辑的是**秒**。卡片在自己的两个边界上换算，外部代码不用知道这件事——但你如果直接编辑 `settings.yaml`，写的是毫秒。

**改动生效方式**：所有字段都是 volatile 的，改完就地提交，不会重挂插件、不会杀掉你正在用的 Chrome 窗口。但 `executablePath`、`port`、`userDataDir`、`headless` 这四个影响启动的参数是在 driver 构造时读取的，要让它们生效需要**重启 DSH**——这是刻意的，在活着的 Chrome 底下换配置会把你那个窗口变成孤儿。

### Host 控制路由

插件在 `/api/sidebrowser` 前缀下注册路由，供客户端同源调用。每一个都要通过信任围栏：**必须是回环 socket**、**回环 Host 头**、**Origin 相等或 `sec-fetch-site` 非 cross-site**，并且至少带一个浏览器来源标记（`sec-fetch-site: same-origin`、一个 `Origin`，或 Host 的浏览器认证 cookie），裸 `curl` 会被 403。

| 方法 | 路径 | 作用 |
| --- | --- | --- |
| GET | `/state` | 当前浏览器快照（attached / loading / title / url / 当前 tab）+ 可用快捷名 |
| POST | `/navigate` `/back` `/forward` `/reload` | 导航与历史 |
| GET | `/tabs`；POST `/tabs/open` `/tabs/close` `/tabs/select` | 标签页 |
| POST | `/screenshot` | 单次截图（`fullPage`、`scale`） |
| GET | `/frame` | 变更检测后的实时帧：页面没变就只回元数据、不带 payload |
| POST | `/text` | 页面文本，可选 `includeInventory` |
| POST | `/click` `/type` `/key` `/scroll` | 输入操作 |
| POST | `/eval-safe` | 一小组具名操作（click / type / key / scroll / read），**不是**任意求值 |

---

## 隐私与安全

请认真读这一节。这个插件的能力很强，相应的责任也在你。

**它能做什么**

- **读取页面上的一切。** `browser_read` 返回当前页面的渲染文本。你让它打开什么，它就能读到什么——包括你登录后的私人页面。
- **在你的页面上点击和输入。** `browser_act` 可以点按钮、往输入框里打字、按回车提交表单。这意味着它能代表你做出任何网页上的动作。
- **在真实窗口里操作。** 它驱动的是你桌面上可见的那个 Chrome 窗口，你全程都能看到它在做什么。

**它不会做什么**

- **不发往任何第三方服务。** 除了你主动打开的那些网站本身，没有任何数据被发送出去。唯一的运行时依赖是 `ws`，用来连你自己机器上的 Chrome 调试端口。
- **不执行任意脚本。** 没有 `eval` 工具，也没有接受任意 JavaScript 的路由。唯一的求值端点是 `/eval-safe`，它只接受五个具名操作（`click` / `type` / `key` / `scroll` / `read`）之一；每个都映射到 driver 的一个方法，而那个方法的页面函数是插件写死的字面量，调用方的值通过 `Runtime.evaluate` 的 `args` 以序列化方式传入，永远不会被拼进代码里。
- **不碰你的日常浏览器。** 它用的是一个独立的 Chrome profile 目录，不会读你平时的浏览记录、Cookie 或已登录的其它站点。

**你需要知道的边界**

- **登录态是持久的。** 专用 profile 目录里的 DeepSeek 登录会一直保留，直到你删掉那个目录。目录默认在临时目录下（`<tmp>/dsh-sidebrowser-<用户名>`），也可以用 `userDataDir` 指到你自己的位置。想彻底清除登录态，删掉那个目录即可。
- **插件卸载时会关掉它启动的 Chrome。** 这是有意为之：留一个开着调试端口的浏览器在后台不是好结果。
- **控制路由只能本机调用。** 回环 socket + Host/Origin 校验 + 浏览器标记这三道检查一起挡住远程和跨站访问。但这仍然是一个「能操作已登录浏览器」的端点，请不要把它暴露到局域网或公网。
- **截图是明文的。** 侧边栏里的实时画面就是你桌面上那个窗口在显示的一切；如果那个页面上有敏感信息，截图里就有。

**建议**

- 不要用它在打开着敏感数据的页面上跑 agent，除非你确认过那个模型会做什么。
- 想分层收紧权限时：`agentTools: false` 保留侧边栏但不给模型浏览器能力；`selectionPopup: false` 关掉选区小框；`enabled: false` 整个关掉。彻底移除则用 `dsh plugin --profile <profile> remove` 卸载插件。
- 定期检查你的 DeepSeek 网页版对话历史——「AI 解释」走的是真实对话，会留下记录。

---

## 开发

```bash
pnpm install
pnpm build       # tsdown：Host 侧输出 ESM，客户端侧输出被 loader 包起来的 CJS
pnpm typecheck   # tsc --noEmit
pnpm test        # vitest run
```

### 目录结构

```
src/
  index.ts                  Host 装载入口：配置 schema、单例守卫、effect 生命周期
  browser/
    cdp-client.ts           最小 CDP WebSocket 客户端（只依赖 ws）
    driver.ts               有状态控制器：启动 Chrome、持有 tab、把意图翻译成 CDP 调用
    screenshot-stream.ts    定时抓帧 + 变更检测 + 单帧保留
  host/
    routes.ts               /api/sidebrowser 控制路由与信任围栏
    agent-tools.ts          5 个 browser_* 工具
  client/
    index.ts                客户端插件入口（无 JSX，转发 surfaces 的导出）
    surfaces.tsx            所有注册：tab 类型、正文、标题、菜单项、页脚行、设置卡片、选区小框宿主
    panel.tsx               侧边栏面板（地址栏、导航、实时画面、标签页条、文本视图）
    panel/
      use-live-frame.ts     实时帧轮询：只在变化时重绘，隐藏时不轮询
      use-browser-state.ts  面板的浏览器状态订阅
    selection.ts            选区识别（词 / 句）与位置计算
    selection-host.tsx      跨整个文档的选区监听
    selection-popup.tsx     小框本体
    settings-card.tsx       设置卡片（绑定 config form，草稿—保存）
    shortcuts.ts            快捷入口网址的解析与校验
    api.ts                  类型化的路由客户端，永不抛未处理异常
    deepseek-web.ts         通过 DeepSeek 网页版提问 / 翻译（防御式抽取）
    locales.ts              中英双语文案
tests/                      vitest：driver、截图流、选区判定、配置默认值
```

架构上有三条边界值得记住：**Host 半边拥有 Chrome 进程，客户端半边只是它的一层同源异步视图**；**插件按需启动浏览器**——第一次用到才拉起；以及**两侧注册的是两个不同的 tab kind**（`browser` 与 `sidebrowser-cdp`），所以不会互相覆盖。

---

## 致谢

感谢 DeepSeek Harness 提供这套插件 API（尤其是右侧栏的两阶段 tab 注册机制）和文档化的 bundle 安装方式。本插件只是它公开接口上的一个实现。

---

## 许可

[MIT](LICENSE)