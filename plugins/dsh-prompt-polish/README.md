# dsh-prompt-polish

在 DeepSeek Harness Web 输入框的工具行里加一个「一键优化指令」按钮：点一下，当前草稿会被改写成更清晰、更可执行的指令，然后写回输入框。

按钮位置是布局壳声明的紧凑控件槽 `conversation.input.right`（发送键左侧、模型选择器之前），外观沿用宿主工具行控件：28×28 圆形按钮、`--dsw-alias-*` 主题 token，因此亮色/暗色主题都跟随宿主。

## 形态

- **宿主半**（`lib/index.js`）：注册一条鉴权后的 `POST /api/prompt-polish/optimize` 路由，取到草稿后通过 `ctx.llm.stream` 调用当前 profile 的默认模型（`ctx.agentDefaultModel.currentSelection()`），只回传模型输出的指令正文。
- **客户端半**（`lib/client.js`）：真正的按钮。用插槽标准 prop `useInput` 读草稿与 `draftRev`，用 `inputActions.setDraft()` 写回；扩展点、文案与主题都走宿主已有能力。

## 行为

- 草稿为空、或输入框处于提交中/裁决中（`phase` 为 `adjudicating`/`submitting`/`inert`）时按钮禁用。
- 点击后按钮变为旋转指示，并显示「优化中…」。
- 回复到达时校验点击那一刻的 `draftRev`：期间用户改过草稿就不覆盖，改为提示「草稿已改动，未替换」。
- 失败时按钮旁显示错误文本，并在浏览器控制台输出 `[prompt-polish] …`。
- 优化提示词（system）要求：只输出改写后的指令、保持原语言、不得新增原文没有的需求，并把目标/交付物/范围写明确。

## 配置（可选）

`cordis.patch.yml` 里该插件的 `config` 支持：

| 键 | 默认值 | 说明 |
|---|---|---|
| `provider` / `model` | 默认模型 | 成对覆盖所用模型；不填则用 profile 默认模型 |
| `instruction` | 无 | 追加到内置 system 提示词后的部署级补充要求 |
| `maxInputChars` | 8000 | 允许优化的草稿长度上限 |
| `maxOutputTokens` | 2048 | 模型输出上限 |
| `timeoutMs` | 90000 | 单次调用超时 |

```yaml
- id: prompt-polish
  name: 'dsh-prompt-polish'
  config:
    timeoutMs: 60000
```

## 安装

用 `plugin_manager` 的 `install_bundle`，目标指向本包目录。变更对该 profile 的所有会话生效；客户端 bundle 若未热加载，刷新页面即可。
