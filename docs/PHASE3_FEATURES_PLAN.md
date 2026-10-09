# Phase 3–5 实施方案：补齐可用插件 + 四项新需求

## Context

**当前状态（实测）**

| 项 | 事实 |
|---|---|
| 工程目录 | `<repo>`（origin: lmce72/documents-activity-tracker） |
| 已完成 | Phase 0 冻结基线、Phase 1 构建管线、Phase 2 L0 纯核心层（`bun test` 67 pass / 1 skip，`tsc --noEmit` 通过） |
| 未提交 | `src/data/{adapter,ReadTimeStore,snapshot}.ts`、`src/services/TimerStore.ts`（Phase 3 半成品） |
| 缺口 | `src/main.ts` 仍是 Phase 1 骨架（只打一行日志）。**插件当前完全不可用** |
| vault 实况 | `<vault>/.obsidian/plugins/documents-activity-tracker/` 装的是旧单体 `main.js`（md5 `f2037360…`，与 Phase 0 冻结基线逐字节相同），且**处于禁用状态** |
| 真实数据 | `<vault>/Components/History/readTimeHistory.json`，`version: 2`，timeline 138 事件，`records: {}`，自 2026-09-15 冻结后未被写入 |
| 失效路径 | `build.ts` 的部署目标 `<old-vault>/…` **已不存在**，vault 现为 `<vault>` |

四项需求的落点是**继续 TS 重构**（用户已确认），因此在叠加新功能之前必须先补齐
Phase 3/4 缺失的 data / services / UI 三层——否则插件连"能用"都谈不上。

用户对"修复现有 bug"的口径：**先让插件能用，一般使用下不出现数据错乱与交互混乱**。
即：不复刻旧单体的已知崩溃点，并修正会损坏记录的计时/写盘缺陷。

---

## 一、待接续的方法调用链路（旧单体 → 新分层）

旧单体 `main.js`（5232 行）的调用链与迁移去向：

```
ReadTimeTrackerPlugin.onload (4969)
 ├─ loadData → ReadTimeStore (4986)            → src/data/ReadTimeStore.ts（已存在，待接 sql.js）
 ├─ TimerStore (5003)                          → src/services/TimerStore.ts（已存在）
 ├─ TimerService (5004)                        → src/services/TimerService.ts【待建】
 │   ├─ tick() → dispatch TICK                 → src/core/reducer.ts TICK（已存在）
 │   ├─ _onVisibilityChange / blur / focus     → src/services/TimerService.ts【待建，本次改语义】
 │   ├─ switchFile / togglePause / saveSession → 同上
 │   └─ flushPendingWrites → store.append…     → src/data/ReadTimeStore.ts（已存在）
 ├─ HeaderWidget (5016)                        → src/ui/widget/HeaderWidget.ts【待建】
 ├─ registerView / getRightLeaf                → 旧版**完全没有**（grep 计数 0）【本次新增】
 ├─ addCommand ×4 (5054-5094)                  → src/ui/commands.ts【待建】
 ├─ addSettingTab (5099)                       → src/ui/SettingsTab.ts【待建】
 └─ onunload 定义两次（5116 / 5160，后者覆盖前者）→ 修正为单一定义【本次修复】
```

**旧单体实测的崩溃点（移植时必须不复刻）**

| # | 位置 | 现象 |
|---|---|---|
| B1 | `_flushFileSilent` 无条件 push start+save | timeline 出现 18 个重复 `start`，今日时长开局就多算 |
| B2 | 1872 / 1886 | `this._isPaused(filePath) = true` 对函数调用赋值，保存/弃用按钮全废 |
| B3 | `IconizeLoader`（4430 引用，全文件无定义） | `ReadRecordsModal` 打开即 `ReferenceError` |
| B4 | 4365 / 4638 传 `TimerStore` 给只认 `ReadTimeStore` 的 `HeatmapView` | `getTimeRangeEvents` 等 4 处 `TypeError` |
| B5 | `ReadTimeTrackerPlugin` 从未赋值 `this.store` / `this.service` | DataviewJS API + `showFileRecords` 崩溃 |
| B6 | 4907 用 `this.plugin.headerWidget`，字段实为 `this.widget` | 今日总时长下拉框 `TypeError` |
| B7 | `onunload` 重复定义 | `timerService.destroy()` 永不执行，监听器泄漏 |
| B8 | 迁移白名单漏 blur/focus/switch | 真实数据 41 个事件被静默丢弃（新 `migration.ts` 已修） |

---

## 二、四项新需求的架构设计

### 需求 1：脱离窗口继续计时（新记录属性）

**语义**：Obsidian 窗口失焦 / 最小化时**不再停止计时**，该段时间单独归入新属性，
与"窗口内时长"分开统计与展示。

**accounting 模型**（`TimerFileState`）

| 字段 | 含义 | 是否计入阅读 |
|---|---|---|
| `activeSeconds` | 窗口聚焦期间的秒数（原语义不变） | ✅ 主口径 |
| `unfocusedSeconds` | **新增**：窗口失焦/最小化期间秒数 | ✅ 计入总量，但单列 |
| `pausedSeconds` | 用户主动暂停 + idle 的秒数 | ❌ |

- 派生：`readingSeconds = active + unfocused`；`wallClockSeconds = active + unfocused + paused`
- `RecordEntry` / `FileRecord` 新增 `unfocusedReadTime`（累计）与今日口径由 timeline 现算。
- `minReadSeconds` 阈值改用 `readingSeconds`（失焦时间也是阅读时间）。

**关键技术约束（决定实现方式）**

Chromium 对隐藏窗口做定时器节流：隐藏 5 分钟后降为**每分钟最多一次**，
而现有 `TICK_GAP_LIMIT_MS = 5000` 会把间隔 >5s 的 tick 全部丢弃。
若照搬，失焦期间**几乎一秒都记不上**。故：

- 聚焦通道：保持 `+1 秒/tick` 与 5s 间隔守卫（1Hz 可靠，行为与既有测试一致）。
- 失焦通道：新增 `UNFOCUSED_GAP_LIMIT_MS = 90_000`，按**实际间隔**累加
  `round(delta/1000)`。90s 上限高于节流间隔（60s）而远低于休眠跳变，
  因此"节流后的稀疏 tick"能正确累计，而"机器休眠 10 分钟"的单次大跳变被丢弃。

**新增 action**：`SET_WINDOW_FOCUS { focused: boolean }`，切换时先把已流逝时间
按上述规则结算进**离开的那条通道**，再重置 `lastTickTimestamp`，避免边界丢秒。
`TimerState` 新增 `isWindowFocused`。

### 需求 2：手动计时（与文档追踪相互独立）

- 数据模型 `ManualSession { id, startTime, endTime, durationSeconds, note }`，
  `note` 即"计时完成后用户自己填写做了什么"。
- 状态：`idle | running | paused`，动作 `MANUAL_START / MANUAL_PAUSE / MANUAL_RESUME / MANUAL_STOP`。
- 存储**独立表** `manual_sessions`，与文档 `events` 表无外键关联、互不影响。
- 停止时弹出 Modal 让用户填写 note（可留空），确认后落库。
- 与文档计时**同时运行互不干扰**：手动计时不改变 `activeFilePath`，不共享 reducer 状态树。

### 需求 3：两个开关

`PluginSettings` 新增：
- `documentTrackingEnabled: boolean`（默认 `true`）：关闭后不启动文档计时服务、不挂载 widget、隐藏左侧/侧栏的文档分区。
- `manualTimerEnabled: boolean`（默认 `true`）：关闭后隐藏手动计时 UI 与 ribbon 图标。

### 需求 4：改用 SQLite 存储（sql.js / WASM，保移动端）

- 依赖 `sql.js@1.14.2`（WASM，跨端，`isDesktopOnly` 维持 `false`）。
- 选型理由：`node:sqlite` / `better-sqlite3` 为原生模块，会迫使 `isDesktopOnly: true` 而丢掉移动端。
- wasm 加载：随插件分发 `sql-wasm.wasm`，运行时经
  `adapter.readBinary('.obsidian/plugins/documents-activity-tracker/sql-wasm.wasm')`
  读入并以 `initSqlJs({ wasmBinary })` 注入——**不走 fetch**，规避 CSP 与移动端路径差异。
- 库文件：由 `dataFilePath` 换扩展名派生（现为 `Components/History/readTimeHistory.json`
  → `Components/History/readTimeHistory.sqlite`），经 `adapter.writeBinary` 落盘。
- **设置仍留在 `data.json`**（Obsidian 惯例，体积小、`loadData/saveData` 已稳定）；
  SQLite 只承载 `events` / `records` / `manual_sessions` 三张表。
- **不做历史数据迁移**（用户 2026-09-25 明确要求）：库文件不存在时直接新建空库，
  旧 JSON **既不读取也不改写**。新库只记录此后发生的使用。
- schema 版本记在 `meta` 表，`DATA_VERSION` 继续只在迁移路径读写。

### 需求 5：侧栏视图（含 topbar 菜单）

- 旧版**没有任何 ItemView**，`registerView` 计数为 0，全部 UI 都塞在笔记 header 与 Modal 里。
  本次新增 `src/ui/SidebarView.ts`（`ItemView`），注册 `VIEW_TYPE_RTT_SIDEBAR`，
  挂右侧栏（`getRightLeaf(false)`），并用 ribbon 图标与命令打开。
- 侧栏 **topbar 菜单**（`view.addAction`）放两个图标用于切换面板：
  `activity`（文档追踪）/ `timer`（手动计时）。
- 手动计画面板 = 计时控制 + **手动计时 heatmap** + 其下方**记录列表**。
- 文档面板 = 当前会话状态 + 今日统计 + 今日文档列表。
- **样式复用既有 CSS 类**（`.rtt-stats-*` / `.rtt-list*` / `.rtt-heatmap-*` / `.rtt-hot-*`），
  不硬编码新 CSS；若确需新增，单开一个 `styles/95-sidebar.css` 并同步更新
  `build.ts` 的 `CSS_REFERENCE_MD5` 守门值与 `CSS_MODULES` 列表（见下"破坏性评估"）。

---

## 三、实施顺序（分批交付，每批自带测试）

| 批次 | 内容 | 产物 |
|---|---|---|
| **A** | 核心语义：`unfocusedSeconds` / `SET_WINDOW_FOCUS` / 手动计时 state 与 action / 两个开关的 settings 字段 | `core/{constants,types,reducer,selectors,session,timeline}.ts` + 新测试 |
| **B** | 存储层：`adapter` 扩二进制读写 → `data/SqliteStore.ts`（sql.js）+ JSON→SQLite 迁移 + `ReadTimeStore` 改为 SQLite façade | `src/data/*` + 迁移测试 |
| **C** | 服务层：`TimerService`（含失焦双通道）、`ManualTimerService`、`i18n` 补键 | `src/services/*` |
| **D** | UI 层：Widget / RecordsModal / HeatmapView / SettingsTab 移植 + 新增 `SidebarView` | `src/ui/*` |
| **E** | 装配与验证：`main.ts`、`build.ts` 部署路径修正 + wasm 复制、manifest/README、CDP 冒烟 | 可安装产物 |

---

## 四、破坏性评估（CLAUDE.md 要求的三问）

**1. 是否增加了新的类 / 耦合？**

新增 6 个类：`SqliteStore`、`TimerService`、`ManualTimerService`、`SidebarView`、
`ManualSessionModal`、`SettingsTab`。依赖方向严格自上而下
（`ui → services → data → core`），无反向引用；`core` 层继续保持零环境依赖
（无 `window/document/localStorage`），故仍可离线单测。
`SqliteStore` 通过既有 `DataAdapter` 接口取 I/O，不直接持有 `Plugin`，与 `ReadTimeStore` 同构。

**2. 是否破坏原有面向对象设计或 DOM 构建限制？**

不破坏。DOM 一律走 Obsidian 原生 API（`createEl` / `createDiv` / `createSpan` / `setIcon`），
不使用 `innerHTML`；旧单体的 widget 用全局 `createDiv` 构造、未走 `MarkdownRenderChild`，
移植时**改为** `ItemView` / `MarkdownRenderChild` 承载以纳入 Obsidian 生命周期。

**3. 是否破坏既有数据？**

不破坏。迁移为**追加式**：JSON 原文件保留不动，SQLite 新建；
`DATA_VERSION` 只在迁移路径写入。回滚窗口（见 `docs/ROLLBACK.md`）保持有效。

**4. 一个必须同步修改的守门值（否则构建必失败）**

`build.ts` 的 `CSS_REFERENCE_MD5 = 'd15dfb090e8fb907527dba913edf353c'` 是"样式逐字节未变"的
硬断言。**只要新增侧栏样式，此断言必然失败**——这是设计如此。
处理方式：把新样式放进**新增**的 `styles/95-sidebar.css`（不触碰既有 13 个模块），
并在 `CSS_MODULES` 末尾追加、同时把守门值更新为"原 13 个模块拼接"的 md5，
使守门语义变为"既有 13 模块未被改动"。此为**唯一需要用户批准的样式改动**。

---

## 五、验证计划

**离线（每批次）**
```
bun run typecheck     # tsc --noEmit
bun test              # 现有 67 pass 必须保持；新增用例覆盖失焦通道/手动计时/迁移
```

**构建**
```
bun build.ts          # 断言 main.js 落盘 + CSS 守门通过
```

**运行期（CDP，见 CLAUDE.md 同名章节；插件需重新启用）**
1. 启用插件 → 无 `ReferenceError` / `TypeError`（对照 B1–B7 逐条核）
2. 打开文档计时 10s → 切标签 → `blur` 事件记录且**秒数继续增长**（写入 `unfocusedSeconds`）
3. 最小化窗口 90s → 恢复 → 失焦时长 ≈90s 且 `activeSeconds` 未包含它
4. 手动计时：开始 → 停止 → 弹窗填写 → 侧栏 heatmap 与列表出现该条记录
5. 两个开关：分别关闭后对应 UI 消失、服务不再注册，重载后保持
6. SQLite：`Components/History/readTimeHistory.sqlite` 生成；用 sql.js 读回核对
   事件数 = 138 + 新增；原 JSON 未被修改（md5 不变）
7. 移动端布局：不使用 `emulate` 伪造视口（CLAUDE.md 红线），侧栏样式按既有断点核对

**数据安全**：改动前对 `readTimeHistory.json` 与部署中的 `main.js` 各留一份备份，
记录 md5 于 `docs/ROLLBACK.md`。
