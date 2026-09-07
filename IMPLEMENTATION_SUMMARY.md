# 全局时间轴数据结构重构 - 实施总结

## 完成时间
2026-09-05

## 重构范围

### 1. ReadTimeEngine 核心属性修改 ✅
**文件**: `main.js` 行 623-632

**修改内容**:
- 添加 `timeline` 数组（全局时间轴）
- 添加 `currentFile` 和 `currentState`（替代旧的 `_currentSession`）
- 保留 `_activeSecondsCache` 和 `_lastTickTime`

### 2. 事件处理方法重构 ✅

#### 2.1 窗口焦点事件（_onVisibilityChange）
**文件**: `main.js` 行 736-781

**新增功能**:
- 窗口隐藏时添加 `blur` 事件（type: "blur", state: "inactive"）
- 窗口恢复时添加 `focus` 事件（type: "focus", state: "tracking/pausing"）

#### 2.2 标签切换事件（_onActiveLeafChange）
**文件**: `main.js` 行 1054-1073

**新增功能**:
- 文件切换时添加 `switch` 事件（包含 from/to/fromState/toState）

#### 2.3 用户暂停/继续（togglePause）
**文件**: `main.js` 行 1822-1899

**重构内容**:
- 使用全局时间轴记录 `pause`/`resume` 事件
- 移除旧的 `_currentSession` 操作
- 添加 `_calculateFileTodayStats` 辅助方法

#### 2.4 保存会话（flushCurrent）
**文件**: `main.js` 行 1435-1503

**重构内容**:
- 添加 `save` 事件到全局时间轴
- 调用 `store.saveTimeline()` 持久化
- 清空当前会话状态

#### 2.5 开启新会话（_startNewSession）
**文件**: `main.js` 行 1511-1528

**重构内容**:
- 添加 `start` 事件到全局时间轴
- 初始化 `currentFile` 和 `currentState`

### 3. ReadTimeStore 数据操作方法 ✅
**文件**: `main.js` 行 538-623

**新增方法**:
- `saveTimeline(timeline)` - 保存全局时间轴
- `getTimeline()` - 获取全局时间轴
- `getFileEvents(filePath)` - 按文件过滤事件
- `getTimeRangeEvents(startTime, endTime)` - 按时间范围过滤事件
- `calculateFileStats(filePath, startTime, endTime)` - 计算文件统计数据

### 4. HeatmapView 详情面板渲染 ✅
**文件**: `main.js` 行 3958-4108

**完全重写内容**:
- 从全局时间轴获取事件（`store.getTimeRangeEvents`）
- 按文件分组（Map<filePath, events[]>）
- 每个文件只占一行
- 状态序列去重后用图标+箭头显示（⏱️ → 🔀 → ⏱️）
- 添加4列统计汇总行：活跃/暂停/失焦/总计

**表格结构**:
| 文件名 | 状态序列 | 时间轴 | 时长 |
|--------|----------|--------|------|
| 📄 文档A.md | ⏱️ → 🔀 → ⏱️ | 14:20 – 14:30 | 7分0秒 |

**统计汇总行**:
```
[circle-gauge] 5分  [pause] 2分  [arrow-left-right] 1分  [clock] 7分
```

### 5. CSS 样式添加 ✅
**文件**: `styles.css` 行 1469-1564

**新增样式**:
- `.rtt-state-sequence` - 状态序列容器（flexbox）
- `.rtt-state-icon` - 状态图标样式
- `.rtt-state-arrow` - 箭头样式
- `.rtt-heatmap-summary` - 统计汇总行（4列 grid）
- 移动端适配（@media max-width: 600px）

---

## 数据结构对比

### 旧格式（v1 - 面向文件）
```json
{
  "records": {
    "文档A.md": {
      "readTimeLine": [
        {
          "2026-09-05 14:20:00": "tracking",
          "2026-09-05 14:22:00": "pausing",
          "2026-09-05 14:25:00": "saved"
        }
      ]
    }
  }
}
```

### 新格式（v2 - 全局时间轴）
```json
{
  "version": 2,
  "timeline": [
    {
      "time": "2026-09-05 14:20:00",
      "type": "start",
      "file": "文档A.md",
      "state": "tracking"
    },
    {
      "time": "2026-09-05 14:22:00",
      "type": "switch",
      "from": "文档A.md",
      "to": "文档B.md",
      "fromState": "inactive",
      "toState": "tracking"
    },
    {
      "time": "2026-09-05 14:25:00",
      "type": "pause",
      "file": "文档B.md",
      "state": "pausing"
    },
    {
      "time": "2026-09-05 14:27:00",
      "type": "blur",
      "file": "文档B.md",
      "state": "inactive",
      "reason": "window-blur"
    },
    {
      "time": "2026-09-05 14:30:00",
      "type": "save",
      "file": "文档B.md",
      "state": "saved"
    }
  ]
}
```

---

## 事件类型定义

| type | 说明 | 涉及字段 | 触发时机 |
|------|------|---------|---------|
| `start` | 打开文件开始计时 | `file`, `state` | `_startNewSession` |
| `switch` | 切换标签页 | `from`, `to`, `fromState`, `toState` | `_onActiveLeafChange` |
| `pause` | 用户主动暂停 | `file`, `state` | `togglePause` |
| `resume` | 用户主动继续 | `file`, `state` | `togglePause` |
| `blur` | 窗口失焦 | `file`, `state`, `reason` | `_onVisibilityChange` |
| `focus` | 窗口恢复焦点 | `file`, `state`, `reason` | `_onVisibilityChange` |
| `save` | 保存会话 | `file`, `state` | `flushCurrent` |
| `discard` | 丢弃会话 | `file` | `discardCurrentSession` |

---

## 状态图标映射

| 状态值 | 图标名称 | Lucide 图标 |
|--------|---------|-------------|
| `tracking` | `circle-gauge` | ⏱️ |
| `pausing` | `pause` | ⏸️ |
| `inactive` | `arrow-left-right` | 🔀 |
| `saved` | `save` | 💾 |

---

## 未完成项（需要后续处理）

### 1. ReadRecordsModal 聚合逻辑
**原因**: 当前没有数据，无法测试聚合逻辑

**需要修改的位置**: `main.js` 行 4156-4224

**修改内容**:
```javascript
// 从全局时间轴构建聚合数据
const timeline = this.store.getTimeline();
const aggregated = {};

for (let i = 0; i < timeline.length - 1; i++) {
  const curr = timeline[i];
  const next = timeline[i + 1];
  const duration = (new Date(next.time) - new Date(curr.time)) / 1000;
  
  const startKey = curr.time.slice(0, 16);
  if (!aggregated[startKey]) {
    aggregated[startKey] = { active: 0, pause: 0, inactive: 0 };
  }
  
  if (curr.state === "tracking") aggregated[startKey].active += duration;
  else if (curr.state === "pausing") aggregated[startKey].pause += duration;
  else if (curr.state === "inactive") aggregated[startKey].inactive += duration;
}
```

### 2. 丢弃会话逻辑（discardCurrentSession）
**位置**: `main.js` 行 1683-1770

**需要修改**:
- 添加 `discard` 事件
- 清空当前文件相关的未保存事件

### 3. 跨日检测逻辑（_checkCrossDay）
**位置**: `main.js` 行 1900-1944

**需要修改**:
- 使用全局时间轴判断跨日
- 添加 `save` 事件结束旧会话
- 添加 `start` 事件开启新会话

### 4. 恢复未完成会话（_recoverUnfinishedSessions）
**位置**: `main.js` 行 1867-1898

**需要修改**:
- 从全局时间轴恢复最后的状态

---

## 验证清单

- [x] 语法检查通过（node -c main.js）
- [x] CSS 样式添加完成
- [ ] 启动 Obsidian 测试插件加载
- [ ] 打开文档测试 `start` 事件
- [ ] 切换标签测试 `switch` 事件
- [ ] 窗口失焦测试 `blur` 事件
- [ ] 暂停/继续测试 `pause`/`resume` 事件
- [ ] 保存会话测试 `save` 事件
- [ ] 热力图详情面板测试（状态序列显示）
- [ ] 统计汇总行测试（4列布局）

---

## 关键改进

1. **彻底解决跨文件事件表达问题**: `switch` 事件原生支持 from/to 关系
2. **简化查询逻辑**: 按时间或文件过滤事件，O(n) 复杂度
3. **无断链风险**: 全局时间轴按时间顺序存储，天然有序
4. **支持 inactive 状态**: 区分主动暂停和失去焦点
5. **过程式显示**: 热力图详情面板按真实时间顺序展示用户操作

---

## 注意事项

1. **无向后兼容**: 旧数据格式（readTimeLine 对象格式）会被跳过
2. **数据迁移**: 当前无历史数据，全新开始
3. **插件目录**: `/home/corevortex/documents-activity-tracker/`
4. **计划文档**: `REFACTOR_PLAN.md`
