# dsh-session-cost

在 DeepSeek Harness Web GUI 的**下端信息栏**里，显示**当前任务花了多少钱**的插件。

下端信息栏就是输入框卡片底部那一行统计胶囊（内置的 `stats`：`N 轮 · xx tok/s` 与 `总量 · 缓存命中率`）。
本插件在同一行末尾追加一个估算金额胶囊：

```
3 轮 · 42.1 tok/s    12.3k tokens · 87%     ¥ 0.4213
```

鼠标悬停在金额上会给出明细（模型、当前计费时段、输入/输出各档 token 数与单价）。

这是一个**标准的 DSH 插件包**：`package.json` 里同时声明了 `dsh.bundle`（宿主配置层，安装即自动插入插件行）
与 `dsh.client`（浏览器插件产物），因此其他用户可以直接用 DSH 的插件管理路径安装，不需要手工改 profile 配置。

---

## 安装

### 0. 前提

- DeepSeek Harness（桌面版 / Web / CLI profile 均可），版本 `>= 0.1.5-rc.1`
- 命令行安装需要 `pnpm`（`dsh plugin` 会把它转发给 pnpm）

### 1. 桌面版（Electron）

桌面 profile 由 Electron 应用独占，命令行不接管。请在 GUI 里安装：

**设置 → 插件 → 安装**，填入下列任意一种安装源。

### 2. Web / CLI profile（命令安装）

```bash
# 从 npm 安装（发布后）
dsh plugin --profile web add dsh-session-cost

# 从本地 .tgz 安装（本仓库 dist/ 下的发行产物）
dsh plugin --profile web add ./dsh-session-cost-0.1.0.tgz

# 从本地目录安装（开发时）
dsh plugin --profile web add ./dsh-session-cost

# 从 Git 仓库安装
dsh plugin --profile web add github:<you>/dsh-session-cost
```

安装完成后：

- `dsh plugin` 会自动把 `dsh-session-cost` 追加进该 profile `package.json` 的 `dsh.profile.bundles`；
- 启动/热加载时，DSH 应用本包自带的 `cordis.patch.yml`，把插件行插进宿主组合；
- 浏览器端由包内的 `dsh.client` 声明被发现，无需任何额外配置。

**重启应用（或刷新 Web 页面）**后，输入框下方的统计行末尾就会出现 `¥` 胶囊。

### 3. 卸载

```bash
dsh plugin --profile web remove dsh-session-cost
```

bundle 会被自动移出 `dsh.profile.bundles`；桌面版在「设置 → 插件」里关闭/卸载即可。

> **不要**同时使用「手动拷贝到 profile 的 node_modules + 手改 profile 的 cordis.patch.yml」这种老方式，
> 否则同一个插件会被插入两次。若你之前是手动装的，请先删掉 profile `cordis.patch.yml` 里那两行
> （`- id: session-cost` / `name: 'dsh-session-cost'`）和 `node_modules/dsh-session-cost` 目录，再按上面的方式安装。

---

## 它怎么工作

- **宿主半**（`lib/index.js`）：空实现。它存在只是为了让插件出现在 profile 的 Loader 树里；
  真正让插件行进入组合的是本包自带的 `cordis.patch.yml`（`dsh.bundle.patch`）。
- **客户端半**（`lib/client.js`）：浏览器 bundle，注册进 `conversation.composer.dock`（会话作用域槽位），
  读取该会话的两个**整日志投影**：
  - `tokenUsage` —— 提供商上报的 token 分桶（未命中输入 / 缓存读 / 缓存写 / 输出），覆盖整个会话日志；
  - `modelSelection` —— 会话最近使用的 route（provider + model）。

  两个投影都由宿主对全部持久事件计算，因此统计的是「整个任务」，而不是当前窗口里加载出来的那几轮；
  token 一边消耗，金额一边刷新。

- **显示位置**：插件把自己「传送」（React portal）进内置的统计行 `[data-composer-stats]`，因此金额与内置胶囊
  **同一行**、自动共享居中布局与间距，而不是另起一行。会话尚无 token 用量、内置统计行还不存在时，
  金额会退化成自己独立的一行居中显示；定位是从本插件自己的锚点向上找最近的、只包含一个统计行的祖先容器，
  所以主会话与右侧栏会话各自只显示自己会话的金额。

---

## 计价方式

金额是**估算值**，取自 DeepSeek 官方价目表（单位：元 / 百万 tokens）：

| 模型 | 缓存命中输入（空闲 / 高峰） | 缓存未命中输入（空闲 / 高峰） | 输出（空闲 / 高峰） |
| --- | --- | --- | --- |
| `deepseek-flash`（V4.1-Flash） | 0.02 / 0.04 | 1 / 2 | 4 / 8 |
| `deepseek-v4-pro`（V4-Pro） | 0.15 / 0.30 | 4.5 / 9 | 13.5 / 27 |

- 空闲时段单价是高峰时段的一半；高峰时段为北京时间（UTC+8）周一至周五 09:00–12:00 与 14:00–18:00，
  其余时间（含周末）为空闲时段。胶囊按**当前时刻**所处时段取价。
- `cacheWriteTokens` 并入「未命中输入」档（DeepSeek 未单独公布缓存写入价）。
- 推理（reasoning）token 已包含在输出的 `outputTokens` 内，不重复计费。
- 旧模型名 `deepseek-v4-flash`、`deepseek-v4-flash-vision-exp` 归一到 Flash 价目；带日期后缀的 id
  （如 `deepseek-v4-pro-0813`）按前缀匹配到对应价目。
- 表中没有的模型（例如第三方 provider 的模型）不显示金额胶囊。

调价或换模型时，只改 `lib/client.js` 顶部的 `PRICES` / `ALIASES` 两个常量即可，无需重新构建。

---

## 打包与发布（给作者）

```bash
# 语法自检
node --check lib/index.js && node --check lib/client.js

# 打包（产物在 dist/ 或当前目录，文件名 dsh-session-cost-<version>.tgz）
npm pack

# 发布到 npm
npm publish --access public
```

- 包名必须与 `cordis.patch.yml` 里插入的 `name` 一致。如果你以 scope 发布
  （如 `@you/dsh-session-cost`），请把该文件的 `name` 一起改掉，否则 Loader 解析不到插件。
- `files` 字段已限定发布内容为 `lib/`、`cordis.patch.yml`、`icon.svg` 与 `locale/*.json`
  （npm 另会自动带上 `package.json` / `README.md` / `LICENSE`）。
- `icon` + `locale/en.json` + `locale/zh.json` 是给 DSH 的**插件列表显示元数据**：
  宿主读取 `<包名>/package.json` 的 `icon`（相对路径的 SVG/PNG/JPEG/WebP，≤256 KiB，须留在包目录内）
  以及 `<包名>/locale/<语言>.json` 里的 `{ "meta": { "title", "description" } }`，
  因此这些子路径必须在 `exports` 里可解析（本包已声明）。
- 改完 `lib/client.js` 后，运行中的 DSH 会通过 client-HMR 的 bundle 轮询（默认 500ms）自动热替换该插件，
  无需重启（新增插件行本身仍需重启或刷新页面）。

### 目录结构

```
dsh-session-cost/
├── package.json        # dsh.bundle（宿主层）+ dsh.client（浏览器产物）+ icon 声明
├── cordis.patch.yml    # bundle 补丁：安装即把插件行插入宿主组合
├── icon.svg            # 插件列表图标（¥）
├── locale/
│   ├── en.json         # 插件列表标题/描述（英文）
│   └── zh.json         # 插件列表标题/描述（中文）
├── lib/
│   ├── index.js        # 宿主半（空实现）
│   └── client.js       # 浏览器 bundle（window.__ModuleLoader__.load）
├── LICENSE             # MIT
└── README.md
```

---

## 已知限制

- 金额按「当前时段单价 × 整会话 token 总量」估算：若一次任务跨过高峰/空闲分界，或中途切换过模型，
  结果与账单可能有偏差（最多相差一倍）。
- 只统计提供商实际回传 `usage` 的请求。
- 统计范围是**当前会话**（主会话与子代理会话各自独立）；不汇总同一天或全部会话。
- 宿主半不做任何事，因此该插件只影响浏览器 UI，不影响模型输入（不占用 KV cache）。

---

## English quick install

```bash
# Desktop (Electron): Settings → Plugins → Install, then paste one of these sources.
dsh plugin --profile web add dsh-session-cost          # from npm
dsh plugin --profile web add ./dsh-session-cost-0.1.0.tgz  # from a local tarball
dsh plugin --profile web add github:<you>/dsh-session-cost # from git
```

Installing appends `dsh-session-cost` to the profile's `dsh.profile.bundles`; DSH then applies the bundle's
own `cordis.patch.yml` and loads the browser half declared by `dsh.client`. Restart the app (or reload the
web page) and the composer info bar gains a `¥` pill showing the estimated cost of the current task
(DeepSeek's published price list, CNY per million tokens; peak/off-peak windows in Beijing time).
