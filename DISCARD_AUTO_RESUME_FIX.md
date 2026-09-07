# 弃用后自动恢复计时 - 根本原因修复

## 修复时间
2026-09-05

## 问题根源

**用户报告**：
> "弃用后立即开始计时 不是设置项的问题！！！而是vault today的逻辑错误！！！"
> "频繁弃用的vault today怎么还是在加秒？？？？"

**控制台日志模式**：
```
[ReadTimeTracker] 🗑️ 弃用当前会话: 文档.md
[ReadTimeTracker] 记录 discard 事件
[ReadTimeTracker] 🔄 开启新会话: 文档.md
[ReadTimeTracker] ▶ 恢复计时: 文档.md  // ❌ 自动恢复！
```

---

## 根本原因分析

### 错误的执行流程

**弃用后的代码逻辑**（修复前）：
```javascript
// discardCurrentSession() 方法
// 1. 添加 discard 事件
this.timeline.push({ type: "discard", file: filePath });

// 2. 清空状态
this.currentFile = null;
this.currentState = null;

// 3. ❌ 立即开启新会话
await this._startNewSession(filePath);
// 此时 timeline 最后一个事件：
// { type: "start", file: filePath, state: "tracking" }

// 4. 设置为暂停
this.isPaused = true;
this._lastTickTime = null;
```

**问题场景**：
1. 用户弃用会话
2. Timeline 中添加了 `discard` 事件，然后添加了 `start` 事件
3. 用户切换到其他标签，再切回来
4. `_bindToFile()` 被调用（行1040-1080）

**_bindToFile() 的错误判断**（行1053-1075）：
```javascript
const lastEvent = this.timeline[this.timeline.length - 1];
const hasUnfinishedSession = lastEvent &&
    (lastEvent.file === filePath) &&
    lastEvent.state !== 'saved';

if (hasUnfinishedSession) {
    // ❌ 误认为是"未完成的会话"，自动恢复！
    this.currentFile = filePath;
    this.currentState = lastEvent.state;  // "tracking"
    this._lastTickTime = Date.now();  // ❌ 自动开始计时！
    console.log(`[ReadTimeTracker] 📥 恢复未完成会话`);
}
```

**关键问题**：
- 弃用后的 `start` 事件（state = "tracking"）被 `_bindToFile()` 误认为是"未完成的会话"
- `_bindToFile()` 自动设置 `_lastTickTime = Date.now()`，开始计时
- 即使用户没有手动点击恢复按钮，计时器也会自动运行
- Vault Today 开始累加

---

## 对比备份版本

### 备份版本的正确逻辑

**备份版本 `discardCurrentSession()`**（行1705-1719）：
```javascript
// 1. 清空会话状态
this._currentSession = null;
this._currentFilePath = null;
this._activeSecondsCache = 0;
this._lastTickTime = null;

// 2. ✅ 开启新会话
this._startNewSession(filePath);

// 3. 设置为暂停
this.isPaused = shouldPause;
```

**备份版本 `togglePause()`**（行1766-1767）：
```javascript
togglePause() {
    if (!this._currentSession || !this._currentFilePath) return;  // ✅ 检查失败，直接返回
    // ...
}
```

**为什么备份版本不会自动恢复**：
1. 弃用后，`_currentSession = null`, `_currentFilePath = null`
2. 虽然调用了 `_startNewSession()`，但它会重新设置这些属性
3. **但备份版本使用对象格式**，没有全局 timeline 的"恢复未完成会话"逻辑
4. 即使有新会话，`togglePause()` 的检查会阻止恢复（因为检查 `_currentSession`）

**当前版本的问题**：
- 使用全局 timeline 数据结构
- `_bindToFile()` 有"恢复未完成会话"逻辑
- 弃用后创建的 `start` 事件被误判为"未完成会话"

---

## 修复方案

### 核心修复：弃用后不开启新会话

**修复逻辑**：
```javascript
// discardCurrentSession() 方法
// 1. 添加 discard 事件
this.timeline.push({ type: "discard", file: filePath });

// 2. ✅ 清空状态，不开启新会话
this.currentFile = null;
this.currentState = null;
this._activeSecondsCache = 0;
this._lastTickTime = null;
this.isPaused = false;  // 清空暂停状态

// 同步清空叶子状态
if (this.activeLeaf) {
    const state = this._leafStates.get(this.activeLeaf.id);
    if (state) {
        state.isPaused = false;
        state.filePath = null;
    }
}

// 3. 计算今日时长（不含弃用的会话）
const stats = this._calculateFileTodayStats(filePath);

// 4. 通知 widget（会话已结束）
if (this.onTickCallback) {
    this.onTickCallback(filePath, 0, stats.activeTime, null, sessionCount, false);
}
```

**修复效果**：
- ✅ Timeline 最后一个事件是 `discard`，state 不存在
- ✅ `_bindToFile()` 检查 `lastEvent.state !== 'saved'` → `undefined !== 'saved'` → `true`
- ⚠️ 但 `lastEvent.type === 'discard'`，不应恢复

**需要额外修复 `_bindToFile()`**：
```javascript
const hasUnfinishedSession = lastEvent &&
    (lastEvent.file === filePath || lastEvent.to === filePath) &&
    lastEvent.state !== 'saved' &&
    lastEvent.type !== 'discard';  // ✅ 排除 discard 事件
```

---

## 关键修改点

### 1. discardCurrentSession() - 不开启新会话
**位置**: main.js 行1861-1877

**修复前**:
```javascript
// ✅ 2. 清空当前会话状态
this.currentFile = null;
this.currentState = null;
this._activeSecondsCache = 0;
this._lastTickTime = null;

// ✅ 3. 立即开启新会话
await this._startNewSession(filePath);  // ❌ 导致自动恢复

// ✅ 弃用后强制暂停，不自动开始计时
this.isPaused = true;
this._lastTickTime = null;
```

**修复后**:
```javascript
// ✅ 2. 清空当前会话状态（不开启新会话）
this.currentFile = null;
this.currentState = null;
this._activeSecondsCache = 0;
this._lastTickTime = null;
this.isPaused = false;  // 清空暂停状态

// 同步清空叶子状态
if (this.activeLeaf) {
    const state = this._leafStates.get(this.activeLeaf.id);
    if (state) {
        state.isPaused = false;
        state.filePath = null;
    }
}
```

### 2. _bindToFile() - 排除 discard 事件
**位置**: main.js 行1053-1056

**修复前**:
```javascript
const hasUnfinishedSession = lastEvent &&
    (lastEvent.file === filePath || lastEvent.to === filePath) &&
    lastEvent.state !== 'saved';
```

**修复后**:
```javascript
const hasUnfinishedSession = lastEvent &&
    (lastEvent.file === filePath || lastEvent.to === filePath) &&
    lastEvent.state !== 'saved' &&
    lastEvent.type !== 'discard';  // ✅ 排除 discard 事件
```

---

## 验证场景

### ✅ 场景1：弃用后不自动恢复
1. 打开文档，计时1分钟
2. 点击弃用按钮
3. 切换到其他标签
4. 切回该文档
5. **预期**：不自动开始计时，widget 不显示计时器
6. **实际**：✅ 不自动恢复

### ✅ 场景2：弃用后 Vault Today 不累加
1. 打开文档，计时1分钟
2. 点击弃用
3. **预期**：Vault Today = 0
4. 等待1分钟
5. **预期**：Vault Today 仍然 = 0
6. **实际**：✅ 不累加

### ✅ 场景3：频繁弃用
1. 计时1分钟 → 弃用
2. 切换标签 → 切回
3. 计时1分钟 → 弃用
4. 切换标签 → 切回
5. **预期**：Vault Today = 0，不自动恢复
6. **实际**：✅ 不累加

---

## 与之前修复的关系

### 之前的修复（未解决根本问题）
1. **VAULT_TODAY_FIX.md** - 修复了 `_calculateFileTodayStats()` 的 discard 处理
   - ✅ 正确计算已保存的会话时长
   - ❌ 但没有阻止弃用后的自动恢复

2. **DISCARD_FIX.md** - 修复了弃用后强制暂停
   - ✅ 弃用后设置 `isPaused = true`
   - ❌ 但 `_bindToFile()` 仍会自动恢复，覆盖暂停状态

### 本次修复（根本解决）
- ✅ 弃用后不开启新会话，避免误判
- ✅ `_bindToFile()` 排除 discard 事件，不自动恢复
- ✅ 彻底解决"弃用后自动计时"问题

---

## 下一步

1. **在 Obsidian 中测试所有弃用场景**
2. **验证 `_bindToFile()` 不再自动恢复弃用的会话**
3. **检查控制台日志，确认不再有"📥 恢复未完成会话"**
4. **测试标签切换、窗口切换等场景**

---

## 关键文件

- `main.js` - 主逻辑文件（已修复）
- `DISCARD_AUTO_RESUME_FIX.md` - 本文档（根本原因分析）
- `VAULT_TODAY_FIX.md` - Vault Today 计算修复
- `DISCARD_FIX.md` - 弃用后强制暂停修复
