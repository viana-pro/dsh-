# dsh-

DeepSeek Harness（DSH）插件集合。每个插件都是独立的 npm 包，声明 `dsh.bundle.patch`，
因此可以作为普通 profile bundle 装进任意 DSH profile，装入后可在 Web 客户端的插件页里启停。

| 插件 | 作用 | 运行面 | 来源 |
|---|---|---|---|
| [`dsh-chat-branch`](plugins/dsh-chat-branch/README.md) | 悬停任意一条消息即可从该节点开启新会话分支，补齐宿主只在轮次页脚提供分支入口的缺口 | 客户端 | 本仓库 |
| [`dsh-prompt-polish`](plugins/dsh-prompt-polish/README.md) | 输入框工具行里的「一键优化指令」按钮：把草稿改写成更清晰、更可执行的指令后写回 | 宿主 + 客户端 | 本仓库 |
| [`dsh-turn-rollback`](plugins/dsh-turn-rollback/README.md) | `/rollback` 命令与 `rollback_turn` 工具：撤销最新一个已完成轮次对该轮所涉文件的改动 | 宿主 | 本仓库 |
| [`dsh-codex-bridge`](plugins/dsh-codex-bridge/README.md) | 移植 OpenAI Codex 的 `apply_patch` 工具语义、失败措辞与配套 prompt section | 宿主 | 本仓库 |
| [`dsh-session-cost`](plugins/dsh-session-cost/README.md) | 在下端信息栏追加一个估算花费胶囊（CNY，DeepSeek 价目） | 客户端 | `rongtopman` 编写（MIT） |
| [`dsh-token-heatmap`](plugins/dsh-token-heatmap/README.md) | 右下角悬浮按钮，展开为 GitHub 贡献图样式的每日 token 用量热力图 | 客户端 | `rongtopman` 编写（MIT） |

每个插件自己的 README 写了完整的交互形态、实现说明、配置项、已知限制与验证状态。

## 目录结构

```
plugins/<name>/     插件包本体：package.json、cordis.patch.yml、lib/ 或 src/、locale/、README.md
tools/              自研插件的测试，被测入口按 ../plugins/<name>/lib 解析
```

`tools/` 里的测试与 `plugins/` 平级，正是为了让它们用相对路径直接加载插件的真实
`lib/` 入口（客户端 bundle 与宿主半都被真实执行，而不是被 mock 掉）。

## 安装

先取到本地工作副本：

```powershell
git clone https://github.com/viana-pro/dsh-.git
```

再把要用的包装进某个 profile（`desktop` 换成你自己的 profile 名）：

```powershell
dsh plugin --profile desktop add <clone>\plugins\dsh-chat-branch
```

也可以直接改 profile 的 `package.json`，用 `link:` 指到工作副本，这样插件行始终加载
你的工作副本，改完代码刷新页面即可生效：

```json
{
  "dependencies": {
    "dsh-chat-branch": "link:<clone>/plugins/dsh-chat-branch"
  },
  "dsh": {
    "profile": {
      "bundles": ["dsh-chat-branch"]
    }
  }
}
```

客户端半在页面已打开时按客户端 HMR 重新加载；没有热加载就刷新页面。宿主半（
`dsh-prompt-polish`、`dsh-turn-rollback`、`dsh-codex-bridge`）在 Loader 组合时装配，
改动 `cordis.patch.yml` 这类 profile 层一般需要重启应用。

## 测试

自研插件的三套测试只依赖 Node，直接在仓库根目录跑：

```powershell
node tools/chat-branch-client.test.mjs
node tools/prompt-polish-host.test.mjs
node tools/turn-rollback-host.test.mjs
```

`dsh-codex-bridge` 的测试需要 DSH 应用里读得到的 `@deepseek-ai/*` 包树，跑法见它自己的
README；`dsh-session-cost` 与 `dsh-token-heatmap` 未随附测试。

## 授权与来源

本仓库以 MIT 授权，见 [LICENSE](LICENSE)。

`plugins/dsh-session-cost` 与 `plugins/dsh-token-heatmap` 由 `rongtopman` 编写，在这里按原样收录
（MIT），各自的 `LICENSE` 文件保留在包内。其余四个插件是本仓库自己的实现。各插件的名称与代码
归属以对应包的 `package.json` 为准。
