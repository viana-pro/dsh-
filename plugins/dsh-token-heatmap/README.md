# dsh-token-heatmap

一个用于 DeepSeek Harness Web 界面的 **Token 用量贡献度热力图**插件，样式类似 GitHub 的 contribution graph。

在 Web GUI 右下角显示一个悬浮按钮（🔥 今日用量），点击展开为一张卡片，以「周 × 7 天」的方格热力图展示最近约一年（371 天）每天的 token 用量；颜色越深表示当天消耗的 token 越多。卡片顶部同时显示今日、近 7 天、总计（输入 + 输出）、缓存读取量与请求数等汇总。

## 形态

- **宿主半**（`lib/index.js`）：聚合每个会话的 `assistant/message`（含 `data.usage`）与 `assistant/attempt` 事件里的 provider 用量，按本地日期归并成「每天」的桶，持久化到 `$DSH_HOME/storages/token-heatmap.json`；并通过 `ctx.connection.fetch.register` 暴露一个鉴权后的 `/api/token-heatmap/data` GET 路由给浏览器。
- **客户端半**（`lib/client.js`）：真正的 UI，注册到布局壳声明的全局槽 `shell.overlay`，用 `fetch` 拉取日用量并渲染热力图。

## 目录结构

```
dsh-token-heatmap/
├── package.json      # dsh.client 声明（inject 渲染器、platform=web）
├── lib/
│   ├── index.js      # 宿主插件（聚合 + 持久化 + /api 路由）
│   └── client.js     # 浏览器 bundle（window.__ModuleLoader__.load）
└── README.md
```

## 安装（手动）

本插件是「出树」插件，需要放到当前 profile 的 `node_modules` 并在 patch 中插入一行。

1. 把整个 `dsh-token-heatmap` 目录复制到 profile 的 node_modules：

   ```
   <DSH_HOME>\profiles\<profile>\node_modules\dsh-token-heatmap\
   ```

   桌面 profile 默认是 `C:\Users\<你>\.dsh\profiles\desktop\`。

2. 在该 profile 的 `cordis.patch.yml` 的 `insert` 列表里追加一行：

   ```yaml
   - insert:
       - id: pomodoro
         name: 'dsh-pomodoro'
       - id: token-heatmap
         name: 'dsh-token-heatmap'
   ```

3. 重启 Desktop 应用（或等待 HMR 重载），刷新 Web 页面，右下角即可看到 🔥 按钮。

> 提示：本包宿主半只 import Node 内置模块（`node:fs`/`node:path`/`node:os`），不 import
> 任何 DSH 内部包，因此可以像 `dsh-pomodoro` 一样安全地手动落盘，无需触发 pnpm 对内部私有包的解析。

## 数据说明

- 每条「每天」记录聚合了当天所有会话、所有请求的 provider 上报用量：
  `inputTokens` / `outputTokens` / `cacheReadTokens` / `cacheWriteTokens` / `reasoningTokens` 与请求次数。
- 热力图颜色深浅按「输入 + 输出」token 数相对当日窗口最大值的比例分 5 档（GitHub 亮色绿）。
- 数据在内存中实时累加，并每 30 秒（及卸载时）落盘一次；重启后从 JSON 恢复。

## 已知限制

- 只统计 provider 实际回传 `usage` 的请求；少数未回传 usage 的调用不进入热力图。
- 历史数据从本插件安装后才开始累计（已持久化的历史会话在插件加载时会回放一次）。
