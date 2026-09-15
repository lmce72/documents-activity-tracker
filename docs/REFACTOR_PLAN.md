# 全局时间轴数据结构重构方案

## Context

当前插件使用**面向文件的数据结构**（每个文件存储自己的 `readTimeLine`），无法原生支持**跨文件的过程式事件**（如标签切换、窗口焦点切换）。这导致热力图详情面板无法按照真实的时间顺序展示用户的操作流程。

**用户需求**：
1. 添加 `inactive` 状态（失去焦点/切换标签）
2. 热力图详情表格按**过程式顺序**显示事件（每个文件一行，状态序列用图标展示）
3. 避免复杂的跨文件查询和断链问题
4. 不需要向后兼容，可以完全重构数据结构

**解决方案**：重构为**全局时间轴优先**的数据结构。

---

## 探索结果总结

### 当前数据结构（面向文件）
```javascript
data.json:
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

### 核心问题
1. **跨文件事件无法表达**：14:22切换到文档B时，只能分别记录"A变pausing"和"B开始tracking"，无法表达"切换"关系
2. **热力图渲染复杂**：需要从所有文件聚合数据，按时间排序，推断事件关系
3. **状态去重困难**：同一文件多个连续tracking需要去重，但跨会话边界难以判断

### 关键代码位置
- **ReadTimeEngine**: 行591-1945，管理会话状态
- **ReadTimeStore**: 行443-585，数据持久化
- **事件触发点**：
  - 标签切换：行690-694 (`active-leaf-change`)
  - 窗口焦点：行637-673 (`focus`/`blur`/`visibilitychange`)
  - 用户按钮：行2260-2309 (暂停/保存/丢弃)
- **视图渲染**：
  - HeatmapView: 行3638-4042
  - ReadRecordsModal: 行4080-4650
  - 会话详情: 行3222-3450

---

## 新数据结构设计

### 核心理念
**单一真相来源**：全局时间轴是唯一的数据源，按时间顺序记录所有事件。

### data.json 结构
```javascript
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
      "type": "focus",
      "file": "文档B.md",
      "state": "tracking",
      "reason": "window-focus"
    },
    {
      "time": "2026-09-05 14:35:00",
      "type": "save",
      "file": "文档B.md",
      "state": "saved"
    }
  ]
}
```

### 事件类型定义
| type | 说明 | 涉及字段 |
|------|------|---------|
| `start` | 打开文件开始计时 | `file`, `state` |
| `switch` | 切换标签页 | `from`, `to`, `fromState`, `toState` |
| `pause` | 用户主动暂停 | `file`, `state` |
| `resume` | 用户主动继续 | `file`, `state` |
| `blur` | 窗口失焦 | `file`, `state`, `reason` |
| `focus` | 窗口恢复焦点 | `file`, `state`, `reason` |
| `save` | 保存会话 | `file`, `state` |
| `discard` | 丢弃会话 | `file` |

---

## 实现方案

### 1. 修改 ReadTimeEngine 核心方法

#### 1.1 切换文件（_onActiveLeafChange）
**当前代码**：行1024
```javascript
await this._flushFileSilent(prevState.filePath, prevState.sessionKey);
```

**修改为**：
```javascript
// 添加 switch 事件
this.timeline.push({
  time: nowFullStr(),
  type: "switch",
  from: prevState.filePath,
  to: newFilePath,
  fromState: "inactive",
  toState: "tracking"
});
this.currentFile = newFilePath;
this.currentState = "tracking";
```

#### 1.2 窗口失焦（_onVisibilityChange）
**当前代码**：行655-673（只更新标志位）

**修改为**：
```javascript
if (document.visibilityState === 'hidden') {
  this.isWindowFocused = false;
  if (this.currentFile && this.currentState === "tracking") {
    this.timeline.push({
      time: nowFullStr(),
      type: "blur",
      file: this.currentFile,
      state: "inactive",
      reason: "window-blur"
    });
    this.currentState = "inactive";
  }
}
```

#### 1.3 用户暂停（togglePause）
**当前代码**：行1795-1802
```javascript
this._currentSession[timestamp] = this.isPaused ? "tracking" : "pausing";
```

**修改为**：
```javascript
const newState = this.isPaused ? "tracking" : "pausing";
this.timeline.push({
  time: nowFullStr(),
  type: this.isPaused ? "resume" : "pause",
  file: this.currentFile,
  state: newState
});
this.currentState = newState;
this.isPaused = !this.isPaused;
```

#### 1.4 保存会话（flushCurrent）
**当前代码**：行1377-1410
```javascript
this._currentSession[timestamp] = "saved";
record.readTimeLine.push(this._currentSession);
```

**修改为**：
```javascript
this.timeline.push({
  time: nowFullStr(),
  type: "save",
  file: this.currentFile,
  state: "saved"
});
await this.store.saveTimeline(this.timeline);
this.currentFile = null;
this.currentState = null;
```

### 2. 修改 ReadTimeStore 数据操作

#### 2.1 新增方法
```javascript
// 保存全局时间轴
async saveTimeline(timeline) {
  this._cache.timeline = timeline;
  await this.save();
}

// 获取全局时间轴
getTimeline() {
  return this._cache.timeline || [];
}

// 按文件过滤事件
getFileEvents(filePath) {
  return this.getTimeline().filter(e => 
    e.file === filePath || e.from === filePath || e.to === filePath
  );
}

// 按时间范围过滤事件
getTimeRangeEvents(startTime, endTime) {
  return this.getTimeline().filter(e => 
    e.time >= startTime && e.time <= endTime
  ).sort((a, b) => new Date(a.time) - new Date(b.time));
}

// 计算文件统计数据（从时间轴派生）
calculateFileStats(filePath) {
  const events = this.getFileEvents(filePath);
  let activeTime = 0, pauseTime = 0, inactiveTime = 0;
  
  for (let i = 0; i < events.length - 1; i++) {
    const curr = events[i];
    const next = events[i + 1];
    const duration = (new Date(next.time) - new Date(curr.time)) / 1000;
    
    let state = curr.state;
    if (curr.type === "switch") {
      state = curr.from === filePath ? curr.fromState : curr.toState;
    }
    
    if (state === "tracking") activeTime += duration;
    else if (state === "pausing") pauseTime += duration;
    else if (state === "inactive") inactiveTime += duration;
  }
  
  return { activeTime, pauseTime, inactiveTime };
}
```

### 3. 修改 HeatmapView 渲染逻辑

#### 3.1 详情面板（_showDetail）
**当前代码**：行3904-3976（三层循环，每个时段一行）

**修改为**：
```javascript
_showDetail(seg) {
  // 1. 获取时间段内的所有事件
  const events = this.store.getTimeRangeEvents(seg.startTime, seg.endTime);
  
  // 2. 按文件分组
  const fileGroups = new Map();
  for (const event of events) {
    if (event.type === "switch") {
      if (!fileGroups.has(event.from)) fileGroups.set(event.from, []);
      if (!fileGroups.has(event.to)) fileGroups.set(event.to, []);
      fileGroups.get(event.from).push({ ...event, _state: event.fromState });
      fileGroups.get(event.to).push({ ...event, _state: event.toState });
    } else if (event.file) {
      if (!fileGroups.has(event.file)) fileGroups.set(event.file, []);
      fileGroups.get(event.file).push(event);
    }
  }
  
  // 3. 渲染表格（每个文件一行）
  for (const [filePath, fileEvents] of fileGroups) {
    const row = tbody.createEl('tr');
    
    // 文件名
    row.createEl('td', { text: `📄 ${filePath.split('/').pop()}` });
    
    // 状态序列（去重）
    const stateCell = row.createEl('td', { cls: 'rtt-state-sequence' });
    const uniqueStates = [];
    for (let i = 0; i < fileEvents.length; i++) {
      const state = fileEvents[i]._state || fileEvents[i].state;
      if (i === 0 || state !== uniqueStates[uniqueStates.length - 1]) {
        uniqueStates.push(state);
      }
    }
    
    for (let i = 0; i < uniqueStates.length; i++) {
      const iconSpan = stateCell.createSpan();
      if (uniqueStates[i] === "tracking") setIcon(iconSpan, 'circle-gauge');
      else if (uniqueStates[i] === "pausing") setIcon(iconSpan, 'pause');
      else if (uniqueStates[i] === "inactive") setIcon(iconSpan, 'arrow-left-right');
      
      if (i < uniqueStates.length - 1) {
        stateCell.createSpan({ text: ' → ' });
      }
    }
    
    // 时间轴
    const firstTime = fileEvents[0].time;
    const lastTime = fileEvents[fileEvents.length - 1].time;
    row.createEl('td', { text: `${formatLocalHMS(firstTime)} – ${formatLocalHMS(lastTime)}` });
    
    // 时长（只统计 tracking + pausing）
    const stats = this.store.calculateFileStats(filePath, seg.startTime, seg.endTime);
    const totalTime = stats.activeTime + stats.pauseTime;
    row.createEl('td', { text: formatDurationWithSeconds(totalTime) });
  }
}
```

### 4. 修改聚合逻辑（ReadRecordsModal）

**当前代码**：行4156-4224（遍历所有文件的readTimeLine）

**修改为**：
```javascript
// 从全局时间轴构建聚合数据
const timeline = this.store.getTimeline();
const aggregated = {};  // { 'YYYY-MM-DD HH:mm': {active, pause, inactive} }

for (let i = 0; i < timeline.length - 1; i++) {
  const curr = timeline[i];
  const next = timeline[i + 1];
  const duration = (new Date(next.time) - new Date(curr.time)) / 1000;
  
  const startKey = curr.time.slice(0, 16); // 'YYYY-MM-DD HH:mm'
  if (!aggregated[startKey]) {
    aggregated[startKey] = { active: 0, pause: 0, inactive: 0 };
  }
  
  if (curr.state === "tracking") aggregated[startKey].active += duration;
  else if (curr.state === "pausing") aggregated[startKey].pause += duration;
  else if (curr.state === "inactive") aggregated[startKey].inactive += duration;
}
```

---

## 关键文件修改清单

| 文件 | 修改内容 | 影响范围 |
|------|----------|---------|
| `main.js` | ReadTimeEngine 事件处理方法 | 行690-1770 |
| `main.js` | ReadTimeStore 数据操作方法 | 行443-585 |
| `main.js` | HeatmapView 渲染逻辑 | 行3812-4015 |
| `main.js` | ReadRecordsModal 聚合逻辑 | 行4156-4224 |
| `styles.css` | 状态序列样式 | 新增约30行 |

---

## 验证计划

1. **启动插件**：检查数据加载无报错
2. **打开文档A**：验证 `start` 事件记录
3. **切换到文档B**：验证 `switch` 事件（包含from/to字段）
4. **点击暂停**：验证 `pause` 事件
5. **最小化窗口**：验证 `blur` 事件
6. **恢复窗口**：验证 `focus` 事件
7. **点击保存**：验证 `save` 事件和数据持久化
8. **打开热力图**：点击时间段，检查详情面板表格格式：
   - 每个文件只占一行
   - 状态序列用图标+箭头显示
   - 时长只统计 tracking + pausing
9. **检查控制台**：无异常日志

---

## 注意事项

1. **不读取历史数据**：无向后兼容，旧数据不迁移
2. **仅操作 documents-activity-tracker 目录**：不能读取 Markdown Docs/Components
3. **不读取 Deprecated 目录**
4. **新增 inactive 状态图标**：使用 Lucide `arrow-left-right`
