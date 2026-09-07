# 全局时间轴重构 Phase 2 - 高优先级遗留方法修复

## Context

**重构背景**：
全局时间轴数据结构重构的主体工作（Phase 1）已完成：
- ✅ ReadTimeEngine 核心属性（timeline, currentFile, currentState）
- ✅ 事件处理方法（窗口焦点、标签切换、暂停/继续、保存会话）
- ✅ ReadTimeStore 查询方法（getTimeline, getFileEvents, calculateFileStats）
- ✅ HeatmapView 详情面板渲染
- ✅ 计时器核心逻辑（tick, _getTodaySessionCount, getAllTodaySeconds）
- ✅ 会话恢复（_bindToFile）和丢弃（discardCurrentSession）

**当前问题**：
根据 `DATA_MIGRATION_FIX.md`，仍有**3个高优先级方法**使用旧的对象格式操作数据，导致：
1. **数据无法正确保存** - _flushFileSilent 仍在写入对象格式
2. **跨日逻辑失效** - _checkCrossDay 依赖旧的会话对象
3. **启动恢复异常** - _recoverUnfinishedSessions 从废弃的 store.currentSession 读取

**本次任务**：
修复这3个方法，确保它们使用全局时间轴数据结构。

---

## 待修复的3个方法分析

### 1. _flushFileSilent() - 静默刷盘逻辑 ⚠️ 最高优先级
**位置**: main.js 行 1696-1797

**当前问题**:
```javascript
// 行1724: 仍在使用对象格式
const readTimeLine = { ...(existing.readTimeLine || {}) };

// 行1778: 写入对象键值对
readTimeLine[sessionKey] = sessionDetail;
```

**数据流影响**:
- 被标签切换、关闭等场景调用
- 负责将内存中的计时数据持久化到磁盘
- 旧架构：写入对象格式到 readTimeLine
- 新架构应该：添加 save 事件到全局时间轴

**用户需求**:
- ✅ 必须保留自动保存功能（标签关闭时）
- ✅ 重写为使用时间轴数据结构

---

### 2. _checkCrossDay() - 跨日检测 ⚠️ 高优先级
**位置**: main.js 行 2055-2094

**当前问题**:
```javascript
// 行2056: 依赖旧的 _currentSession 对象
if (!this._currentSession || !this._currentFilePath) return;

// 行2060: 遍历对象键
const sessionTimestamps = Object.keys(this._currentSession).sort();

// 行2065: 写入对象
this._currentSession[nowTimestamp] = "saved";
```

**触发时机**:
- 计时器 tick 时每分钟检查一次
- 检测会话开始日期是否与当前日期不同

**修复策略**:
使用新架构的 `currentFile` 和 `timeline`：
1. 检查 `timeline` 中最后一个 `start` 事件的日期
2. 如果跨日，添加 `save` 事件闭合旧会话
3. 如果正在 tracking，添加新的 `start` 事件

---

### 3. _recoverUnfinishedSessions() - 启动恢复 ⚠️ 高优先级
**位置**: main.js 行 2017-2050

**当前问题**:
```javascript
// 行2022: 遍历旧的 store.records
for (const [filePath, record] of Object.entries(records)) {
    if (record.currentSession && Object.keys(record.currentSession).length > 0) {
        // 行2027: 操作对象
        record.currentSession[lastTimestamp] = "saved";
        // 行2033: 写入数组
        record.readTimeLine.push(record.currentSession);
    }
}
```

**触发时机**:
- Obsidian 启动时调用
- 恢复上次未正常保存的会话

**修复策略**:
1. 检查全局时间轴的最后一个事件
2. 如果 `state !== 'saved'`，说明有未完成会话
3. 添加 `save` 事件闭合它
4. 清空 `currentFile` 和 `currentState`

---

## 关键文件修改清单

| 文件 | 方法名 | 修改类型 | 行号范围 |
|------|--------|---------|---------|
| `main.js` | `_flushFileSilent` | 重写为时间轴同步 | 1696-1797 |
| `main.js` | `_checkCrossDay` | 重写为时间轴检查 | 2055-2094 |
| `main.js` | `_recoverUnfinishedSessions` | 重写为时间轴恢复 | 2017-2050 |

---

## Phase 1 已完成的验证

Phase 1 重构已完成以下验证：
1. ✅ 语法检查通过
2. ✅ 核心数据结构（timeline, currentFile, currentState）已就位
3. ✅ 主要事件处理方法（窗口焦点、标签切换、暂停/继续、保存会话）已重构
4. ✅ 计时器核心逻辑修复完成

---

## Phase 2 验证计划

本次修复完成后需要验证：

---

## 实施方案

### 方法1: _flushFileSilent() 修复 ✅ 用户已确认：重写为时间轴同步

**用户需求明确**:
- 标签关闭时**必须保留自动保存** - 用户不会专门切换回标签页去手动保存
- 不能移除自动保存机制，只能重写实现方式

**调用点位置**（共5处）:
1. 行846: `_checkOpenLeaves()` - 标签关闭时刷盘 ✅ 保留
2. 行871: `_checkOpenLeaves()` - 孤立文件刷盘 ✅ 保留
3. 行1162: `_onActiveLeafChange()` - 同叶子切换刷盘 ✅ 保留
4. 行1347: `flushCurrent()` 内部（注释提及）
5. 行1826: `flushAll()` - 批量刷盘 ✅ 保留

**重写策略**:
```javascript
async _flushFileSilent(filePath, sessionKey) {
    // 1. 检查该文件是否有未保存的计时数据
    const record = this.readingMap.get(filePath);
    if (!record || record.seconds <= 0) return;
    
    // 2. 检查最小阈值
    const minSec = Math.max(0, parseInt(this.settings.minReadSeconds) || 0);
    if (minSec > 0 && record.seconds < minSec) {
        console.log(`[ReadTimeTracker] 未达标丢弃: ${filePath} (${record.seconds}s < ${minSec}s)`);
        record.seconds = 0;
        return;
    }
    
    // 3. 如果该文件正在计时，添加 save 事件
    if (this.currentFile === filePath) {
        this.timeline.push({
            time: nowFullStr(),
            type: "save",
            file: filePath,
            state: "saved"
        });
        
        await this.store.saveTimeline(this.timeline);
        
        // 清空状态
        this.currentFile = null;
        this.currentState = null;
        this._activeSecondsCache = 0;
    }
    
    // 4. 清零内存计数
    record.seconds = 0;
    
    console.log(`[ReadTimeTracker] 💾 静默刷盘完成: ${filePath}`);
}
```

**关键变更**:
- ✅ 保留方法名和所有调用点
- ✅ 移除对象格式写入（100+行代码）
- ✅ 改为添加 `save` 事件到 timeline
- ✅ 保留最小阈值检查逻辑
- ✅ 仍清零 `readingMap` 的秒数计数器

---

### 方法2: _checkCrossDay() 修复

**修复逻辑**:
```javascript
_checkCrossDay() {
    // 1. 检查是否有当前文件在计时
    if (!this.currentFile || !this.currentState) return;
    
    // 2. 从时间轴找最后一个 start 事件
    const startEvents = this.timeline.filter(e => 
        e.file === this.currentFile && e.type === 'start'
    );
    if (startEvents.length === 0) return;
    
    const lastStart = startEvents[startEvents.length - 1];
    const sessionStartDate = lastStart.time.split(' ')[0];
    const today = todayStr();
    
    // 3. 如果跨日，闭合旧会话
    if (sessionStartDate !== today) {
        const nowTimestamp = nowFullStr();
        
        // 添加 save 事件结束旧会话
        this.timeline.push({
            time: nowTimestamp,
            type: "save",
            file: this.currentFile,
            state: "saved"
        });
        
        await this.store.saveTimeline(this.timeline);
        
        new Notice("新的一天开始了，已将会话切换至新的一天");
        
        // 4. 如果正在计时，开启新会话
        if (!this.isPaused) {
            this.timeline.push({
                time: nowFullStr(),
                type: "start",
                file: this.currentFile,
                state: "tracking"
            });
            this._activeSecondsCache = 0;
            this._lastTickTime = Date.now();
        } else {
            this.currentFile = null;
            this.currentState = null;
        }
        
        await this.store.saveTimeline(this.timeline);
    }
}
```

**关键变更**:
- 用 `currentFile`/`currentState` 替代 `_currentFilePath`/`_currentSession`
- 从 `timeline` 查找会话开始时间，而非遍历对象键
- 添加 `save` 和 `start` 事件，而非操作对象

---

### 方法3: _recoverUnfinishedSessions() 修复

**修复逻辑**:
```javascript
async _recoverUnfinishedSessions() {
    // 1. 检查全局时间轴最后一个事件
    if (this.timeline.length === 0) return;
    
    const lastEvent = this.timeline[this.timeline.length - 1];
    
    // 2. 如果最后事件不是 saved 或 discard，说明有未完成会话
    if (lastEvent.state !== 'saved' && lastEvent.type !== 'discard') {
        const filePath = lastEvent.file || lastEvent.to;
        
        // 添加 save 事件闭合未完成会话
        this.timeline.push({
            time: nowFullStr(),
            type: "save",
            file: filePath,
            state: "saved"
        });
        
        this._allowWrite = true;
        try {
            await this.store.saveTimeline(this.timeline);
            console.log(`[ReadTimeTracker] 已恢复未完成会话: ${filePath}`);
        } finally {
            this._allowWrite = false;
        }
    }
    
    // 3. 清空当前会话状态
    this.currentFile = null;
    this.currentState = null;
}
```

**关键变更**:
- 不再遍历 `store.records`
- 直接检查 `timeline` 最后一个事件的 `state`
- 添加 `save` 事件闭合，而非操作对象

---

## 调用点检查清单

修复前已确认这些方法的所有调用点：

### _flushFileSilent 调用点（共5处）
- [x] 行846: `_checkOpenLeaves()` - 标签关闭时刷盘
- [x] 行871: `_checkOpenLeaves()` - 孤立文件刷盘
- [x] 行1162: `_onActiveLeafChange()` - 同叶子切换刷盘
- [x] 行1347: `flushCurrent()` 内部（注释提及，非调用）
- [x] 行1826: `flushAll()` - 批量刷盘

### _checkCrossDay 调用点
- [x] `tick()` - 每分钟检查一次

### _recoverUnfinishedSessions 调用点
- [x] `onload()` - 插件启动时

---

## Phase 2 验证计划

### 基础功能验证
1. [ ] 语法检查通过
2. [ ] 启动 Obsidian 插件无报错
3. [ ] 恢复逻辑正常（检查控制台日志）

### 跨日验证
1. [ ] 修改系统时间到 23:59
2. [ ] 打开文档开始计时
3. [ ] 等待跨过 00:00
4. [ ] 验证自动保存旧会话
5. [ ] 验证开启新会话

### 数据持久化验证
1. [ ] 打开文档计时
2. [ ] 切换标签
3. [ ] 检查 `data.json` 中 timeline 数组
4. [ ] 验证 `save` 事件正确记录

### 错误处理验证
1. [ ] 模拟崩溃（强制关闭 Obsidian）
2. [ ] 重新启动
3. [ ] 验证未完成会话被正确恢复

---

## 风险评估

### 中风险
1. **_flushFileSilent 逻辑变更** - 从对象写入改为事件追加，可能影响数据完整性
   - 缓解：保留最小阈值检查，添加详细日志
2. **跨日逻辑测试困难** - 需要修改系统时间或等待真实跨日
   - 缓解：代码审查确保逻辑正确，添加日志便于排查

### 低风险
3. **恢复逻辑简单** - 只检查最后一个事件的 state
   - 缓解：添加详细日志输出

---

## 设计审查

### 不破坏原有设计的原则
1. ✅ **不改变事件类型定义** - 仍使用 start/switch/pause/resume/blur/focus/save/discard
2. ✅ **不修改 timeline 结构** - 仍使用 `{time, type, file, state, ...}` 格式
3. ✅ **不影响已完成的方法** - tick(), flushCurrent(), togglePause() 等保持不变
4. ✅ **保留方法签名** - _flushFileSilent(filePath, sessionKey) 参数不变
5. ✅ **保持 OOP 设计** - 方法仍为 ReadTimeEngine 的成员方法
6. ✅ **保留自动保存** - 标签关闭/切换时仍自动保存
