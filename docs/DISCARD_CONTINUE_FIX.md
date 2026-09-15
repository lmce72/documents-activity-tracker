# 弃用后无法继续计时 - 修复总结

## 修复时间
2026-09-05

## 问题描述

**用户报告**：
1. ❌ 弃用后点击继续按钮，无法开启新一轮计时
2. ❌ Vault Today 仍在累加（虽然按钮无反应）

**根本原因**：
之前的修复中，弃用后清空了 `currentFile` 和 `currentState`，导致：
1. `togglePause()` 在第一行检查失败 → 直接返回
2. 无法开启新会话

---

## 修复方案

### 核心思路：引入 "discarded" 状态

**弃用后不清空 `currentFile`，而是设置 `currentState = "discarded"`**

这样：
1. ✅ `currentFile` 保留，`togglePause()` 可以继续执行
2. ✅ `currentState = "discarded"` 作为特殊状态，阻止计时
3. ✅ 点击继续时，`togglePause()` 检测到 "discarded" 状态，开启新会话

---

## 关键修改点

### 1. discardCurrentSession() - 设置 discarded 状态

**位置**: main.js 行1862-1873

**修复前**:
```javascript
// ✅ 2. 清空当前会话状态（不开启新会话）
this.currentFile = null;  // ❌ 清空后 togglePause() 无法工作
this.currentState = null;
```

**修复后**:
```javascript
// ✅ 2. 设置为 discarded 状态（保留 currentFile，允许点击继续开启新会话）
this.currentState = "discarded";
// currentFile 保留不变
```

**关键变更**：
- ✅ 保留 `currentFile`
- ✅ 设置 `currentState = "discarded"`（新状态）
- ✅ 清空 `_activeSecondsCache` 和 `_lastTickTime`

---

### 2. togglePause() - 处理 discarded 状态

**位置**: main.js 行1901-1933

**新增逻辑**:
```javascript
togglePause() {
    if (!this.currentFile || !this.currentState) return;

    // ✅ 如果是弃用状态，开启新会话
    if (this.currentState === "discarded") {
        this._startNewSession(this.currentFile);
        this.currentState = "tracking";
        this.isPaused = false;
        this._lastTickTime = Date.now();
        this.lastEventTime = Date.now();
        console.log(`[ReadTimeTracker] ▶ 弃用后开启新会话: ${this.currentFile}`);

        // 通知 widget 更新
        if (this.onTickCallback) {
            // ... 更新 widget 显示
        }
        return;
    }

    // 原有的暂停/恢复逻辑
    // ...
}
```

**关键变更**：
- ✅ 检测 `currentState === "discarded"`
- ✅ 调用 `_startNewSession()` 开启新会话
- ✅ 设置 `currentState = "tracking"`
- ✅ 启动计时器（`_lastTickTime = Date.now()`）
- ✅ 通知 widget 更新

---

### 3. _bindToFile() - 排除 discarded 状态

**位置**: main.js 行1059-1068

**新增检查**:
```javascript
// ✅ 如果当前是 discarded 状态且文件匹配，不自动恢复
if (this.currentState === "discarded" && this.currentFile === filePath) {
    console.log(`[ReadTimeTracker] 弃用状态，不自动恢复: ${filePath}`);
    // 不自动开启新会话，等待用户点击继续按钮
    this._startTicker();  // 启动 ticker 以便 widget 能更新
    return;
}
```

**关键变更**：
- ✅ 检查 `currentState === "discarded"`
- ✅ 不自动开启新会话
- ✅ 等待用户手动点击继续按钮

---

### 4. tick() - 排除 discarded 状态计时

**位置**: main.js 行1280-1286

**修复前**:
```javascript
const shouldCount =
    !this.isPaused &&
    this.activeFilePath === this.currentFile &&
    this.isWindowFocused &&
    (/* idle check */);
```

**修复后**:
```javascript
const shouldCount =
    !this.isPaused &&
    this.currentState !== "discarded" &&  // ✅ 弃用状态不计时
    this.activeFilePath === this.currentFile &&
    this.isWindowFocused &&
    (/* idle check */);
```

**关键变更**：
- ✅ 添加 `currentState !== "discarded"` 检查
- ✅ 确保 discarded 状态下不累加时间

---

## 状态转换流程

### 正常流程
```
开始计时 → tracking
↓
暂停 → pausing
↓
继续 → tracking
↓
保存 → saved
```

### 弃用流程（新）
```
正在计时 → tracking
↓
弃用 → discarded  (保留 currentFile)
↓
点击继续 → tracking (开启新会话)
↓
保存 → saved
```

### 状态对照表

| 状态 | currentFile | currentState | isPaused | _lastTickTime | 行为 |
|------|-------------|--------------|----------|---------------|------|
| 正在计时 | 文件路径 | "tracking" | false | Date.now() | ✅ 累加时间 |
| 暂停中 | 文件路径 | "pausing" | true | null | ❌ 不累加 |
| 弃用后 | 文件路径 | "discarded" | false | null | ❌ 不累加，等待继续 |
| 失焦 | 文件路径 | "inactive" | - | null | ❌ 不累加 |
| 已保存 | 文件路径 | "saved" | - | null | ❌ 不累加 |

---

## 验证场景

### ✅ 场景1：弃用后点击继续
1. 开始计时 3分钟
2. 点击弃用
3. **预期**：
   - Widget 显示播放按钮 ▶
   - Vault Today = 0
   - 不自动计时
4. 点击继续（播放按钮）
5. **预期**：
   - 开启新会话
   - Widget 显示暂停按钮 ⏸
   - Started 显示新的时间
   - 轮次 +1
   - 开始计时

### ✅ 场景2：弃用后切换文件
1. 正在计时文档A
2. 点击弃用
3. 切换到文档B
4. **预期**：
   - 文档B 正常开启新会话
   - 文档A 保持 discarded 状态
5. 切回文档A
6. **预期**：
   - 不自动开启新会话
   - 显示播放按钮 ▶
   - Vault Today = 0

### ✅ 场景3：弃用后不累加时间
1. 正在计时
2. 点击弃用
3. 等待 1分钟（不点击任何按钮）
4. **预期**：
   - Vault Today 不变
   - File Today 不变
   - 不累加时间

---

## 与之前修复的关系

### 之前的修复（导致新问题）
- **DISCARD_AUTO_RESUME_FIX.md** - 弃用后清空 `currentFile`
  - ✅ 解决了自动恢复问题
  - ❌ 但导致无法手动继续

### 本次修复（完整解决）
- ✅ 弃用后保留 `currentFile`，设置 `currentState = "discarded"`
- ✅ 阻止自动恢复（`_bindToFile()` 检查）
- ✅ 允许手动继续（`togglePause()` 处理）
- ✅ 阻止累加时间（`tick()` 检查）

---

## 关键文件

- `main.js` - 主逻辑文件（已修复）
- `DISCARD_CONTINUE_FIX.md` - 本文档
- `DISCARD_AUTO_RESUME_FIX.md` - 自动恢复修复
- `DISCARD_FINAL_FIX.md` - 弃用功能总结

---

## 下一步

1. **在 Obsidian 中测试弃用 + 继续流程**
2. **验证 Vault Today 不累加**
3. **测试切换文件后的行为**
4. **检查控制台日志**：
   - 弃用后应该看到："记录 discard 事件"
   - 点击继续应该看到："▶ 弃用后开启新会话"
   - 不应该看到："📥 恢复未完成会话"
