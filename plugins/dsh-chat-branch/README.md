# dsh-chat-branch

参照 ChatGPT 的交互给 DeepSeek Harness Web 对话加上**分支**能力：把鼠标移到任意一条消息上，点出现的分支图标，就会以该节点为末尾开启一条新的会话分支（Session fork），并直接在新分支里继续。

宿主自带的「分支」只出现在**轮次页脚**，而且只有在该轮最后一条消息是助手回复时才可用。本插件补上缺口：任何人类消息（提问、插话、唤醒通知）、任何中间助手回复、任何工具调用节点都可以作为分支点。

## 交互形态

- **任意消息角标**：鼠标悬停（或键盘焦点进入）任意消息节点时，该消息右上角出现一个分支图标。点击即以该消息为**包含式前缀末尾**创建分支：宿主拷贝该 seq 之前（含该 seq）的全部事件，新会话自动继承标题并加分支序号，然后当前面板切换到新分支。
  - 提问 / 插话 / 唤醒消息 → 以该消息事件为界；新分支以你的话结尾，可以接着换一种问法。
  - 助手回复 → 以该条 `assistant/message` 事件为界（不是渲染锚点，避免把消息截断在半句）。
  - 工具调用 → 以 `tool/call` 事件为界；宿主会用合成收尾事件把这一轮收干净。
- **轮次页脚补位**：当宿主自己的分支按钮不可用时（该轮最后一条记录不是收尾的助手消息，例如回复之后还有工具调用），页脚动作行里会出现本插件的分支图标，保证每个已完成轮次都有且只有一个可用分支入口。
- 已折叠/未加载的节点没有渲染座位，因此不会出现角标；正在生成中的轮次尚未发布页脚，也没有角标。

## 实现

纯客户端插件（宿主半只占一个 Loader 行，让 `dsh.client` 把浏览器 bundle 接进启动图，没有宿主行为）。两个扩展点全部是宿主已声明的槽位，不替换、不遮盖任何宿主组件：

| 槽位 | 贡献 | 作用 |
|---|---|---|
| `conversation.chat.turnTail` | `chat-branch-nodes` | 每个已完成轮次渲染一次；按 `useChat` 的节点索引找出该轮可分支的节点，一次性扫描本会话滚动容器内的渲染座位（`[data-chat-node-key]`，按 key 集合过滤，不做逐节点选择器查询），再用 `ReactDOM.createPortal` 把悬停分支按钮挂进目标座位，并给该座位补 `position:relative`（卸载或换座位时还原） |
| `conversation.chat.assistant-actions` | `chat-branch-row` | 宿主页脚动作行里的分支图标；只在宿主自己的分支动作不可用时渲染，避免出现两个分支按钮 |

- 分支动作直接调用公开的客户端服务：`ctx.sessions.fork({ sessionId, atSeq, increaseTitle: true })`，随后 `ctx.uiWorkspace.openSession(childId)`——与宿主聊天页脚的分支动作完全一致。
- 「宿主是否已覆盖该节点」用宿主同一条规则判断（`turn-tail.branchUnavailable` 加上「收尾助手消息之后本轮是否还有内容」），因此不会与宿主重复，也不会漏掉宿主拒绝的轮次。
- 扫描按「可分支节点集合的签名」触发：流式输出的每个 chunk 不会重新遍历 DOM，只有新增节点或助手消息定稿（拿到 `finalNode.seq`）时才重扫一次；`MutationObserver` 兜住分页、折叠这类纯 DOM 变化。
- 样式只使用主题 token（`--dsw-alias-*`、`--dsw-radius-sm`、`--dsh-content-font-delta`），亮色/暗色都跟随宿主；按钮几何对齐宿主动作行（28px / 15px 图标）。
- 悬停显示复用宿主自己的模式：`[data-chat-node-key]:hover`、`:focus-within`，触摸设备上常显。
- 文案：中文 / English，命名空间 `chat-branch`。

## 安装

包声明了 `dsh.bundle.patch`，作为普通 profile bundle 安装：

```powershell
dsh plugin --profile desktop add <克隆路径>\plugins\dsh-chat-branch
```

或用 `plugin_manager` 的 `install_bundle` 指向本包目录。装入后该行进入 Loader，浏览器端 bundle 随客户端启动图加载；页面已在打开状态时按客户端 HMR 重新加载该行，否则刷新页面。

## 已知限制

- **只覆盖已完成轮次**：宿主在 `turn/end` 时才发布轮次页脚，正在生成的轮次没有页脚也没有角标。
- **依赖宿主 DOM 契约**：节点角标通过 `[data-chat-node-key]` 座位定位。宿主若改名该属性，角标不再出现（宿主组件不受影响，功能降级而非报错）。
- **同一会话渲染两份时**：座位查找以本插件所在渲染位置向上最近的滚动容器为界，不会把角标挂到另一个面板的同名节点上。
- **分支点语义是宿主 `atSeq` 前缀**：在工具调用处分支会得到一条以该调用结尾、由宿主补收尾事件的分支，适合「回到这个节点换条路走」，不是「重放该工具」。
- **不做分支切换器**：本插件只负责「从任意节点开启新分支」；ChatGPT 那种 `< 2/3 >` 兄弟分支切换仍由侧边栏的会话树承担。
- **不编辑历史消息**：宿主会话日志只追加，插件不改写既有消息，因此没有 ChatGPT 的「编辑后自动成为新分支」，只能「从这条消息开分支」。

## 测试

```powershell
node tools\chat-branch-client.test.mjs
```

测试在 Node 里用桩模块加载器真实执行 `lib/client.js`：校验插件导出、两条槽位注册的槽名/顺序/本地化命名空间、注入后的 `forkAt` 确实以 `{sessionId, atSeq, increaseTitle:true}` 调用 `sessions.fork` 并打开子会话；再用合成 Chat 快照校验纯模型读取——页脚定位、宿主可用性规则的两个条件、各节点类型的分支边界、已覆盖/不可见节点跳过、节点顺序、页脚补位可见性、座位选择（隐藏 / 零尺寸 / 非目标 / 重复 key）与座位比较。

## 验证状态

- 已在运行中的 Web GUI 上验证（通过客户端 Slot 检查器读取实时扩展点）：宿主行 `include:chat-branch` 为 `active`；`chat-branch-nodes`、`chat-branch-row` 两个注册都存活在各自槽位中（没有因渲染异常被摘除）；被查看会话的 3 个提问节点各自挂上了 1 个分支按钮（每个座位恰好 1 个，无重复、无孤儿），目标座位都获得了 `position:relative`。
- 未做端到端点击验证：当前环境无法驱动浏览器点击，因此「点击 → fork → 切换到子会话」没有实机点过。该调用与宿主既有分支按钮调的是同一个公开客户端服务（`ctx.sessions.fork` + `ctx.uiWorkspace.openSession`），入参形状由单元测试断言。
