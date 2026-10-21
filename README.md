# Documents Activity Tracker

一个用于 Obsidian 的文档阅读时间追踪插件，帮助你了解在每个文档上花费的时间；
另附一个与文档追踪**相互独立**的手动计时器。

> **本仓库是重构版（v1.3.1）**：源码已从单体 `main.js` 重构为 `src/` 下的 TypeScript
> 分层模块，存储由 JSON 改为 SQLite（sql.js / WASM）。行为与数据格式的对照说明见
> `docs/`，重构前的基线副本见 `docs/ROLLBACK.md`。

## 功能特性

### 文档追踪
- **实时计时**：按文档自动累计阅读时长，支持多轮会话
- **插件活动**：保存插件视图提供的完整活动标题，RSS 切换文章会记录标题变化；「插件视图计入阅读时长」默认开启，关闭后仍保留记录与热力图。
- **连续热力图**：连续高亮按整段选中，跨文章、文档和小时边界保留活动详情；真实未记录的空档断开，手动计时仍按完整轮次区分。
- **失焦单独记录**：默认暂停阅读计时，失焦时长继续记录并显示在热力图；「失焦时间计入阅读」默认关闭，保留已有设置。
- **分屏阅读**：开始本轮后开启卡片下方的开关，失焦仍计入阅读；结束本轮、切换文档或进入后台后自动关闭。
- **失焦时段归类**：点击卡片负数或记录面板的「处理失焦时段」，将已结束时段计入阅读、计入暂停或保留失焦，允许改回。进行中的失焦或尚未结算的手动暂停需先结束。
- **暂停 / 继续**：按钮或命令手动控制
- **空闲检测**：可配置的空闲超时；失焦期间不做空闲判定（否则该功能 20 秒后即失效）
- **文件过滤**：黑/白名单，支持路径前缀与正则

### 手动计时（独立）
- 秒表式计时：开始 / 暂停 / 继续 / 停止
- 停止时填写「这段时间做了什么」，留空则只存时长
- 与文档追踪互不影响：不绑定文件、不受过滤规则影响、关闭文档追踪后照常可用

### 侧栏
一个正式的侧栏视图（`ItemView`），topbar 两个图标切换面板：
- **文档追踪面板**：本轮 / 脱离窗口 / 今日总计 / 今日轮数，当前文件的操作按钮，今日各文档列表
- **手动计时面板**：计时控制、当日热力图（按小时 × 分钟定位）、当日记录列表

### 两个总开关
设置中可分别关闭「文档追踪」与「手动计时」；关闭文档追踪会同时停止计时并保存当前会话。

## 安装

从仓库根目录复制 `manifest.json`，并从 `dist/` 复制以下三个文件到 `<vault>/.obsidian/plugins/documents-activity-tracker/`：

```
main.js
styles.css
sql-wasm.wasm     ← SQLite 由 sql.js(WASM) 提供，缺这个文件插件会降级为
                     「不落盘」并在界面与通知里明确告知，不会假装已保存
```

然后在 Obsidian 设置中启用插件并重新加载。

## 数据存储

- 记录存于 **SQLite**，路径由设置的「自定义数据文件路径」换扩展名派生
  （如 `Components/History/readTimeHistory.json` → `Components/History/readTimeHistory.sqlite`）。
- **不迁移历史数据**：新库从空开始，只记录从此以后的使用。旧 JSON 数据文件**既不读取
  也不改写**，原样留在磁盘上由用户自行处置。
- 设置本身仍存于插件目录的 `data.json`（Obsidian 惯例）。
- 表：`events`（事件流，唯一真相）、`records`（物化统计）、`manual_sessions`（手动计时）。

## API 兼容性

最低支持 Obsidian 1.7.2。开发依赖固定为官方 `obsidian@1.7.2`，不再内置新版 API 类型声明。`bun run lint:api` 使用官方 `obsidianmd/no-unsupported-api` 规则检查源码；检查与发布构建均包含此步骤。

## 开发

```bash
bun run check          # tsc --noEmit + bun test
bun build.ts           # 开发构建 -> dist/
bun build.ts --prod    # 生产构建
bun build.ts --watch   # 监听 src/ 与 styles/ 增量重建

# 部署目标由调用方给定 —— 仓库里不硬编码本地 vault 路径
RTT_VAULT_PLUGIN_DIR=/path/to/vault/.obsidian/plugins/documents-activity-tracker \
  bun build.ts --deploy
```

### 分层

```
core/      纯逻辑，零环境依赖（无 window/document/localStorage），可离线单测
data/      SQLite 存储与适配器；服务层只依赖 HistoryStore 接口
services/  计时服务（文档 / 手动），不 import obsidian 运行期值
ui/        视图与 Obsidian 事件绑定（唯一在运行期 import obsidian 值的一层）
main.ts    装配，不放业务判断
```

### 样式

`styles/` 下 13 个模块按 `build.ts` 里的顺序逐字节拼接。拼接结果对既有模块有 md5
守门（`CSS_REFERENCE_MD5`），新增样式必须放进 `CSS_MODULES_EXTRA`，不得改动既有模块。

## 许可证

MIT License
