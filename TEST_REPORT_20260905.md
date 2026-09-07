# Obsidian Documents Activity Tracker - 测试报告

**测试日期**: 2026-09-05  
**测试时间**: 18:43 - 18:44 CST  
**测试环境**: Obsidian 1.13.7 (Linux)  
**插件版本**: documents-activity-tracker (最新代码)

---

## 执行摘要

本次测试对 Obsidian Documents Activity Tracker 插件进行了全面的功能测试，包括基础计时、白名单/黑名单逻辑、Widget UI、数据持久化等核心功能。

**测试结果**:
- 总测试数: **9**
- 通过: **6** (66.7%)
- 失败: **3** (33.3%)

**问题统计**:
- **CRITICAL**: 2 个
- **HIGH**: 1 个
- **MEDIUM**: 0 个

---

## 🔴 关键问题列表

### 问题 1: 追踪逻辑错误 [CRITICAL]

**描述**: 文件 `PrimeCore.md` 不在白名单中，但引擎正在追踪该文件并计时。

**详细信息**:
- 当前文件: `PrimeCore.md`
- 过滤模式: `whitelist` (白名单模式)
- 白名单规则: 
  ```
  10-Planner/8-日常记录
  10-Planner/70-历史记录
  15-IDEA_DISPERSE_BOX
  20-Inbox储件箱
  22-浏览器收件箱
  23-References-InVault
  29-仓库Vault
  30-笔记
  32-草稿
  40-问题解决方案
  02-Obsidian专辑
  00-精品收藏夹
  CLAUDE.md
  PrimeCore-Features
  36-阅读文学
  ```
- 匹配规则: **无** (空数组)
- 期望行为: 不应追踪
- 实际行为: `engine.currentFile = "PrimeCore.md"`, `engine.currentState = "tracking"`

**影响**:
- 被排除的文件仍然被计时
- 违反用户的白名单配置
- 可能导致错误的统计数据

**根本原因**:
推测是 `_bindToFile()` 或文件切换逻辑未正确调用白名单检查函数 `shouldTrackFile()`。

---

### 问题 2: Widget 完全不存在 [CRITICAL]

**描述**: WidgetManager 中没有任何 Widget，UI 完全无法显示。

**详细信息**:
- `widgetManager._viewWidgets.size`: **0**
- 当前活动视图: 存在 (MarkdownView)
- Widget 对象: **null**

**影响**:
- 用户无法看到任何计时器 UI
- 无法通过 UI 进行暂停/继续/保存/弃用操作
- 插件核心功能完全不可用

**根本原因**:
推测是 WidgetManager 初始化失败，或者 Widget 创建逻辑未被触发。

**建议排查**:
1. 检查 `WidgetManager.onload()` 是否正确执行
2. 检查 `workspace.on('active-leaf-change')` 事件是否正确注册
3. 检查 `_createWidget()` 方法是否有错误

---

### 问题 3: 计时功能异常 [HIGH]

**描述**: 等待 5 秒后，`_activeSecondsCache` 未增加，计时器未工作。

**详细信息**:
- 计时前: `5.785` 秒
- 计时后 (5秒后): `5.785` 秒
- 增量: **0.00** 秒
- 期望增量: **≥4** 秒

**影响**:
- 计时器停止工作
- 无法累积阅读时间
- 统计数据不准确

**可能原因**:
1. `tick()` 方法未被调用 (ticker 未启动)
2. `shouldCount` 条件判断错误 (isPaused、isWindowFocused、idle timeout 等)
3. `_lastTickTime` 为 null (计时器未启动)

**实际状态**:
- `currentState`: `"tracking"`
- `isPaused`: `false`
- `_lastTickTime`: `1788604510681` (有值)

**结论**: 计时器虽然有 `_lastTickTime`，但 `tick()` 方法可能因为某些条件判断失败而未累加时间。

---

## ✅ 通过的测试

1. **插件加载**: 插件成功加载
2. **引擎加载**: ReadTimeEngine 成功初始化
3. **Timeline 初始化**: 全局时间轴已创建 (timeline 字段存在)
4. **获取当前文件**: 成功获取活动文件路径
5. **Timeline 有事件**: 记录了 2 个事件 (1 个 start, 1 个 switch)
6. **Store 存在**: ReadTimeStore 已初始化

---

## Timeline 事件记录

**总事件数**: 2

**事件类型分布**:
- `start`: 1
- `switch`: 1

**最近 5 个事件**:

| # | 类型 | 文件 | 状态 | 时间 |
|---|------|------|------|------|
| 1 | start | 15-IDEA_DISPERSE_BOX/20-Projects/0-260726-从今天开始报组件bug.md | tracking | 2026-09-05 18:35:04 |
| 2 | switch | PrimeCore.md | undefined | 2026-09-05 18:35:04 |

**注意**: 第 2 个事件的 `state` 为 `undefined`，可能是 switch 事件未正确设置状态。

---

## 数据文件分析

**data.json 路径**: `.obsidian/plugins/documents-activity-tracker/data.json`

**发现**:
- 数据格式为**旧格式** (有 records 字段，但 readTimeLine 为空对象 `{}`)
- 缺少 timeline 全局时间轴数据
- 部分文件有今日阅读时间 (如 `PrimeCore.md: 86秒`, `Templetes/日记模板.md: 62秒`)

**结论**: 插件代码已更新为使用 timeline，但数据文件尚未迁移。

---

## 建议修复优先级

### P0 - 立即修复

1. **修复追踪逻辑错误** (问题 1)
   - 在 `_bindToFile()` 和 `_onActiveLeafChange()` 中添加 `shouldTrackFile()` 检查
   - 确保被排除的文件不会被追踪

2. **修复 Widget 不存在** (问题 2)
   - 检查 WidgetManager 初始化流程
   - 确保 Widget 正确创建和注册

### P1 - 高优先级

3. **修复计时功能异常** (问题 3)
   - 排查 `tick()` 方法的 `shouldCount` 条件
   - 验证 `isWindowFocused` 和 idle timeout 逻辑

### P2 - 中优先级

4. **修复 switch 事件状态缺失**
   - 确保所有事件都有正确的 `state` 字段

5. **数据迁移**
   - 实现从旧格式到新格式的自动迁移
   - 或提示用户重新加载插件

---

## 测试方法

本次测试使用 Chrome DevTools Protocol (CDP) 通过 WebSocket 连接到 Obsidian，直接执行 JavaScript 代码进行测试。

**测试脚本**: `/tmp/full_test.js`  
**完整报告**: `/tmp/obsidian_full_test_report.json`

**测试步骤**:
1. 启动 Obsidian 并启用远程调试 (`--remote-debugging-port=9222`)
2. 连接到 Obsidian 主窗口
3. 执行测试脚本，检查插件状态
4. 打开白名单/非白名单文件，验证追踪逻辑
5. 等待计时，验证计时器功能
6. 检查 Timeline 事件记录
7. 生成测试报告

---

## 附录: 白名单配置

**过滤模式**: `whitelist` (白名单模式)

**白名单规则**:
```
10-Planner/8-日常记录
10-Planner/70-历史记录
15-IDEA_DISPERSE_BOX
20-Inbox储件箱
22-浏览器收件箱
23-References-InVault
29-仓库Vault
30-笔记
32-草稿
40-问题解决方案
02-Obsidian专辑
00-精品收藏夹
CLAUDE.md
PrimeCore-Features
36-阅读文学
```

**匹配逻辑**:
- 如果规则不包含 `.` 且不以 `/` 结尾，自动添加 `/` 前缀匹配
- 支持完整路径匹配
- 支持前缀匹配

**示例**:
- `PrimeCore-Features` → 匹配 `PrimeCore-Features/` 下所有文件
- `CLAUDE.md` → 仅匹配 `CLAUDE.md` 文件本身
- `PrimeCore.md` → **不匹配** (不在白名单中)

---

## 结论

插件核心功能存在严重问题：

1. **追踪逻辑完全失效** - 白名单/黑名单不起作用
2. **UI 完全不可用** - Widget 不存在
3. **计时功能异常** - 计时器停止工作

**建议**: 立即修复 P0 问题，否则插件基本不可用。

---

**报告生成时间**: 2026-09-05 18:44:06 CST  
**报告生成工具**: Node.js + Chrome DevTools Protocol
