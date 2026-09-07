# 数据对接修复总结

## 修复时间
2026-09-05（第二阶段）

## 问题根源
重构后的全局时间轴数据结构与旧代码存在大量不兼容：
- 旧代码使用 `_currentSession` 和 `_currentFilePath`
- 新代码使用 `timeline`、`currentFile` 和 `currentState`
- 核心计时逻辑（tick）无法运行

---

## 已修复的方法

### 1. tick() - 计时器核心逻辑 ✅
**位置**: 行 1250-1305

**修改内容**:
- 将 `_currentFilePath` 替换为 `currentFile`
- 将 `_currentSession` 替换为 `currentState`
- 使用 `_calculateFileTodayStats()` 从全局时间轴计算今日时长
- 从时间轴查找会话开始时间（最后一个 `start` 事件）

**关键变更**:
```javascript
// 旧代码
if (!this._currentFilePath) return;
if (!shouldCount || !this._currentSession) return;
const todaySeconds = /* 从 readTimeLine 遍历计算 */;
const sessionStartTime = Object.keys(this._currentSession).sort()[0];

// 新代码
if (!this.currentFile) return;
if (!shouldCount || !this.currentState) return;
const stats = this._calculateFileTodayStats(this.currentFile);
const todaySeconds = stats.activeTime + this._activeSecondsCache;
const fileEvents = this.timeline.filter(e => e.file === this.currentFile && e.type === 'start');
const sessionStartTime = fileEvents[fileEvents.length - 1]?.time;
```

---

### 2. _getTodaySessionCount() - 今日轮数计算 ✅
**位置**: 行 1384-1408

**修改内容**:
- 从全局时间轴统计 `save` 事件数量
- 检查 `currentFile` 和 `currentState` 而非 `_currentSession`

**关键变更**:
```javascript
// 旧代码
for (const session of record.readTimeLine) {
    if (timestamps[0].startsWith(today)) todaySessionCount++;
}
if (this._currentSession && this._currentFilePath === filePath) {
    todaySessionCount++;
}

// 新代码
const saveEvents = this.timeline.filter(e =>
    e.file === filePath && e.type === 'save' && e.time.startsWith(todayPrefix)
);
sessionCount = saveEvents.length;
if (this.currentFile === filePath && this.currentState !== 'saved') {
    sessionCount++;
}
```

---

### 3. getAllTodaySeconds() - 全库今日总时长 ✅
**位置**: 行 1449-1502

**修改内容**:
- 完全重写，从全局时间轴遍历今日所有事件
- 累加所有文件的 `tracking` 状态时长
- 处理 `switch` 事件（from/to 文件）

**关键逻辑**:
```javascript
for (let i = 0; i < this.timeline.length - 1; i++) {
    const curr = this.timeline[i];
    if (!curr.time.startsWith(todayPrefix)) continue;
    
    const next = this.timeline[i + 1];
    const duration = (new Date(next.time) - new Date(curr.time)) / 1000;
    
    // 只累加 tracking 状态
    if (targetFile && targetState === "tracking") {
        fileStats.set(targetFile, fileStats.get(targetFile) + duration);
    }
}
```

---

### 4. _bindToFile() - 会话恢复逻辑 ✅
**位置**: 行 1050-1068

**修改内容**:
- 检查全局时间轴的最后一个事件
- 如果最后事件未保存，则恢复会话
- 使用 `_calculateFileTodayStats()` 计算已累计时长

**关键变更**:
```javascript
// 旧代码
const record = this.store.getRecord(filePath);
if (record && record.currentSession) {
    this._currentSession = record.currentSession;
    this._currentFilePath = filePath;
    this._activeSecondsCache = calculateSessionDuration(record.currentSession);
}

// 新代码
const lastEvent = this.timeline[this.timeline.length - 1];
const hasUnfinishedSession = lastEvent?.file === filePath && lastEvent?.state !== 'saved';
if (hasUnfinishedSession) {
    this.currentFile = filePath;
    this.currentState = lastEvent.state;
    const stats = this._calculateFileTodayStats(filePath);
    this._activeSecondsCache = stats.activeTime;
}
```

---

### 5. discardCurrentSession() - 弃用会话 ✅
**位置**: 行 1840-1927

**修改内容**:
- 添加 `discard` 事件到时间轴
- 清空 `currentFile` 和 `currentState`
- 使用 `_calculateFileTodayStats()` 计算今日时长

**关键变更**:
```javascript
// 旧代码
this._currentSession = null;
this._currentFilePath = null;
const record = this.store.getRecord(filePath);
record.currentSession = null;

// 新代码
this.timeline.push({
    time: nowFullStr(),
    type: "discard",
    file: filePath
});
this.currentFile = null;
this.currentState = null;
```

---

## 辅助方法（已在第一阶段添加）

### _calculateFileTodayStats()
**位置**: 行 1399-1433

**功能**: 从全局时间轴计算指定文件今日的统计数据

**返回值**: `{ activeTime, pauseTime, inactiveTime }`

---

## 仍需修复的项（未完成）

### 高优先级

1. **_flushFileSilent() - 静默刷盘逻辑**
   - **位置**: 行 1678-1789
   - **问题**: 仍在使用对象格式写入 `readTimeLine[sessionKey] = sessionDetail`
   - **修复**: 应该追加事件到全局时间轴，而非写入对象

2. **_checkCrossDay() - 跨日检测**
   - **位置**: 行 2006-2094
   - **问题**: 依赖旧的会话对象
   - **修复**: 使用全局时间轴判断跨日，添加 `save` 事件

3. **_recoverUnfinishedSessions() - 启动恢复**
   - **位置**: 行 1961-2004
   - **问题**: 从 store 恢复 `currentSession` 对象
   - **修复**: 检查时间轴最后事件是否为 `saved`

### 中优先级

4. **Widget 中的 readTimeLine 遍历**
   - **位置**: 行 2338, 2786, 3111, 5129
   - **问题**: 使用 `Object.entries(record.readTimeLine)` 遍历对象
   - **修复**: 改为从全局时间轴派生数据或使用 `store.calculateFileStats()`

5. **会话详情面板 (_showSessionDetail)**
   - **位置**: 行 3371+
   - **问题**: 遍历 `readTimeLine` 数组（旧格式为对象）
   - **修复**: 从全局时间轴获取文件事件并渲染

6. **_closePreviousSession() - 旧会话闭合**
   - **位置**: 行 1618-1670
   - **问题**: 操作 `readTimeLine` 对象格式
   - **修复**: 可能已废弃，检查是否仍需要

### 低优先级

7. **旧 flushCurrent 残留代码**
   - **位置**: 行 2052-2082（如果存在）
   - **问题**: 重复的废弃实现
   - **修复**: 删除

---

## 测试验证清单

### 基本功能
- [x] 语法检查通过
- [ ] 启动 Obsidian 插件无报错
- [ ] 打开文档，计时器开始运行
- [ ] 顶栏组件显示计时
- [ ] 切换标签页，记录 switch 事件
- [ ] 暂停/继续按钮工作
- [ ] 保存会话成功
- [ ] 弃用会话成功

### 数据验证
- [ ] 检查 data.json 是否包含 `timeline` 数组
- [ ] 检查 `timeline` 中的事件格式正确
- [ ] 今日轮数显示正确
- [ ] 全库今日总时长显示正确
- [ ] 热力图详情面板显示正确

---

## 修复策略建议

1. **优先修复 _flushFileSilent** - 这会导致数据无法正确保存
2. **然后修复跨日检测和恢复逻辑** - 确保多日使用不会出问题
3. **最后修复 UI 组件** - 统计面板和详情面板

---

## 关键文件

- `main.js` - 主逻辑文件（5200+ 行）
- `data.json` - 数据文件（全局时间轴）
- `IMPLEMENTATION_SUMMARY.md` - 第一阶段实施总结
- `REFACTOR_PLAN.md` - 重构计划

---

## 下一步行动

1. 启动 Obsidian 测试基本功能
2. 根据控制台错误修复剩余问题
3. 验证数据持久化正确性
4. 完善 UI 组件数据显示
