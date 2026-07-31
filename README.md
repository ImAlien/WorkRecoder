# 工作记录本 WorkRecoder

一个独立的桌面客户端，用来记录账号密码、文档链接、使用方法等，支持关键词搜索。

- **Electron + Vue 3** 技术栈，独立运行，**无需 Python**
- 数据存本地 JSON 文件（在系统 userData 目录），换电脑用「导出/导入」迁移
- 全部数据只存在你自己电脑上，不联网

## 环境要求

- Node.js（已在本机验证 v26）

## 运行（开发模式）

```bash
npm install       # 首次：安装依赖（会自动下载 Electron 二进制）
npm run dev       # 启动应用窗口
```

启动后会弹出「工作记录本」桌面窗口。

## 功能

采用 **Apple 备忘录风格** 的自由笔记：一条记录 = 标题 + 富文本正文（可插图）+ 标签。

- **笔记编辑器**：大标题 + 正文，支持基础格式：标题(H1/H2)、加粗/斜体/删除线、有序/无序列表、待办清单、代码块
- **插入图片**：工具栏「插图」选择文件，或直接**粘贴截图 / 拖拽图片**进正文（图片以 base64 内嵌，最长边超 1600 会自动等比缩小）
- **标签**：编辑器底部添加标签（输入回车即建），也可点已有标签快速补充；列表页顶部按标签筛选
- **自动保存**：编辑时直接关闭窗口也会先保存当前笔记再退出（未改动或空白新笔记不会留下垃圾记录）
- **搜索**：顶部搜索框实时匹配 标题 / 正文 / 标签
- **列表**：卡片式展示，含标题、正文摘要、标签、含图标记，点击进入编辑
- **导出 / 导入**（顶部按钮，使用系统原生文件对话框）：
  - `导出` → 保存 JSON 备份（含全部笔记与内嵌图片，用于完整还原）
  - `导出CSV` → 保存 CSV（正文转纯文本，带 BOM，Excel 可直接打开）
  - `导入` → 选择之前导出的 JSON，**追加**导入（兼容旧版账号/密码字段，自动并入正文）

## 数据位置与备份

数据文件固定在 `C:\Users\<你>\AppData\Roaming\workrecoder\workrecoder-data.json`。
**开发模式和打包后的 exe 共用这一份数据**（已在主进程锁定目录名），不会因为打包而看不到之前记的内容。

- 备份：用「导出」生成 JSON 文件另存
- 迁移：新电脑上「导入」该 JSON 即可（按 uid 与本机合并，同一条取较新的一份，重复导入不会产生副本；导入前自动备份为 `*.before-import-<时间戳>.json`）
- 数据安全：采用原子写入（临时文件 + 重命名），中途崩溃不会写坏主文件；万一数据文件损坏，会被改名为 `workrecoder-data.json.corrupt-<时间戳>.json` 保留，绝不静默清空

## 同步到私有仓库（换电脑用）

顶部「同步」按钮可把数据推送到一个**私有 git 仓库**，另一台电脑再拉下来，实现两台机器同步。走 **SSH + 系统 git**，复用你现有的 SSH 密钥，应用本身不保存任何令牌。

**前置条件（每台要同步的电脑）**：已安装 `git`，且已配置好能访问该仓库的 SSH 密钥（`ssh -T git@github.com` 能通）。

**使用步骤**：

1. 在 GitHub 新建一个**私有**仓库（例如 `WorkRecoder-data`），可留空。
2. 应用里点「同步」→ 填 SSH 地址 `git@github.com:你的账号/WorkRecoder-data.git`（分支默认 `main`）→「保存设置」。
3. 本机点「⬆ 上传到仓库」；另一台电脑装好 git、配好同一把 SSH key 后，填相同地址点「⬇ 从仓库下载」。

**「同步」= 自动合并**（推荐，日常只用这一个按钮）：拉取远端 → 按记录合并 → 推回。两台机器各自随便改、各自删，都不会互相覆盖丢数据。合并规则：

- 每条记录有一个全局唯一 `uid`（旧数据首次载入自动按内容派生补上，两台机器同一份数据得到相同 uid，不会重复），按 uid 认身份，不受本地整数 id 影响。
- 每条记录还带一个**版本号 `ver`**：本机每次改动都 +1，合并时**版本高者胜**，修改时间仅在版本相同时作次级判定。这样即使两台电脑系统时钟有偏差，也不会用旧改动盖掉新改动。
- **删除也会同步**：删过的记录记在「墓碑」里（同样带版本号），合并时另一台也会删掉；但若另一台在删除之后又编辑过它（版本更高），则按较新的编辑复活。
- 每次合并前本机数据自动备份为 `workrecoder-data.json.before-merge-<时间戳>.json`。

**兜底（弹窗里「高级」，一般用不到）**：整份强制覆盖，不做合并。

- **强制上传 = 本机覆盖云端**；**强制下载 = 云端覆盖本机**（下载前备份为 `*.before-download-<时间戳>.json`）。
- 新电脑第一次拉全量，用「强制下载」最干净（拿到的记录 uid 与源机一致，之后再用「同步」不会重复）。

> ⚠️ 合并主要靠版本号定序，不强依赖系统时钟；仅当同一条记录在两台机器上于「都没同步过对方改动」的情况下被各自改过（真正的并发冲突），才会退化为按较新的一份取胜，另一份改动可能被覆盖——这是无人工合并时的固有取舍。数据以**明文**推送，务必使用**私有**仓库、不要设为公开——git 历史永久，公开即泄露。同步配置存在 `%APPDATA%\workrecoder\workrecoder-sync.json`，不进仓库。

## 打包成免安装 exe

已配置好 `electron-builder`，一条命令生成免安装单文件 exe：

```bash
npm run build:win
```

产物在 `dist/WorkRecoder-1.0.0-portable.exe`（约 65 MB），双击即用、可拷到 U 盘或其他 Windows 电脑运行，不写注册表、不进开始菜单。

### 国内网络必读

打包时 electron-builder 需要下载 Electron 本体和 nsis 工具链，默认走 GitHub 会失败。已在 `.npmrc` 配好 Electron 镜像；工具链镜像通过环境变量指定，`build:win` 前先设好：

```bash
export ELECTRON_MIRROR=https://cdn.npmmirror.com/binaries/electron/
export ELECTRON_BUILDER_BINARIES_MIRROR=https://cdn.npmmirror.com/binaries/electron-builder-binaries/
npm run build:win
```

首次打包会下载约 100+MB（之后有缓存，很快）。若报 `Cannot read properties of undefined (reading 'whenReady')`，同样是 `ELECTRON_RUN_AS_NODE=1` 导致，`unset ELECTRON_RUN_AS_NODE` 即可。

### 图标

图标由 `build/gen-icon.js` 用纯 Node 生成（`build/icon.png` / `build/icon.ico`）。想换图标：改脚本里的颜色/形状后 `npm run icon` 重新生成，再重新打包；或直接把自己的 256×256 `icon.ico` 覆盖到 `build/` 下。

## 项目结构

```
WorkRecoder/
├─ package.json
├─ electron.vite.config.js      构建配置
├─ electron-builder.yml         打包配置（免安装 exe）
├─ .npmrc                       Electron 二进制下载镜像
├─ build/                       打包资源：图标 + 图标生成脚本
├─ src/
│  ├─ main/index.js             主进程：窗口 + JSON 存储 + IPC + 导出导入
│  ├─ preload/index.js          安全桥接，暴露 window.api
│  └─ renderer/                 前端（Vue 3）
│     ├─ index.html
│     └─ src/
│        ├─ main.js
│        ├─ App.vue             笔记列表 + 标签筛选 + 编排
│        ├─ NoteEditor.vue      笔记编辑器（Tiptap：富文本/插图/标签）
│        └─ assets/main.css
└─ README.md
```

## 说明

- 数据为**明文存储**，靠电脑本身的登录保护，请勿放在公用电脑。
- 若在某些环境（如自动化/CI）里 `npm run dev` 报 `Cannot read properties of undefined (reading 'whenReady')`，是因为设置了环境变量 `ELECTRON_RUN_AS_NODE=1`，取消该变量即可（正常桌面终端无此问题）。
