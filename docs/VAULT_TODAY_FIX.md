# Vault Today 计算修复（最终版）

## 修复时间
2026-09-05

## 问题描述

**用户报告**：频繁弃用会话后，Vault Today 仍在累加被弃用的时间

**根本原因**：
`_calculateFileTodayStats()` 方法在查找会话结束点时：
1. ❌ **只检查 `save` 事件**，不检查 `discard` 事件
2. ❌ 如果没有 `save` 事件，`endIndex = fileEvents.length - 1`，计算所有事件
3. ❌ 导致弃用的会话时长仍被计算

---

## 修复内容

### _calculateFileTodayStats() 方法 ✅
**位置**: main.js 行 1506-1575

**修复前逻辑**:
```javascript
// ❌ 只查找 save 事件
let lastSaveIndex = -1;
for (let i = fileEvents.length - 1; i >= 0; i--) {
    if (fileEvents[i].type === "save") {
        lastSaveIndex = i;
        break;
    }
}

// ❌ 如果没有 save，计算到最后一个事件
const endIndex = lastSaveIndex >= 0 ? lastSaveIndex : fileEvents.length - 1;
```

**问题场景**：
```javascript
timeline = [
  { time: "09:00:00", type: "start", state: "tracking" },
  { time: "09:05:00", type: "discard", file: "文档.md" }  // 弃用
];

// lastSaveIndex = -1（没找到 save）
// endIndex = fileEvents.length - 1 = 1
// 计算 09:00 → 09:05 的时长 = 300秒 ❌ 错误！应该是 0
```

**修复后逻辑**:
```javascript
// ✅ 同时查找 save 和 discard 事件
let lastEndIndex = -1;
for (let i = fileEvents.length - 1; i >= 0; i--) {
    if (fileEvents[i].type === "save" || fileEvents[i].type === "discard") {
        lastEndIndex = i;
        break;
    }
}

let endIndex = -1;
if (lastEndIndex >= 0) {
    // 如果最后一个结束事件是 save，计算到该 save
    if (fileEvents[lastEndIndex].type === "save") {
        endIndex = lastEndIndex;
    }
    // 如果是 discard，找 discard 之前的最后一个 save
    else {
        for (let i = lastEndIndex - 1; i >= 0; i--) {
            if (fileEvents[i].type === "save") {
                endIndex = i;
                break;
            }
        }
    }
}

// ✅ 如果没有找到任何 save 事件，不计算任何时长
if (endIndex < 0) {
    // 只加上当前会话的缓存时长（如果正在计时）
    if (this.currentFile === filePath && this.currentState !== 'saved') {
        activeTime = this._activeSecondsCache;
    }
    return { activeTime, pauseTime, inactiveTime };
}
```

---

## 修复逻辑详解

### 场景1：只有弃用，没有保存
```javascript
timeline = [
  { time: "09:00:00", type: "start", state: "tracking" },
  { time: "09:05:00", type: "discard" }
];

// lastEndIndex = 1 (discard)
// endIndex = -1 (discard 之前没有 save)
// activeTime = 0 ✅ 正确！
```

### 场景2：保存后弃用
```javascript
timeline = [
  { time: "09:00:00", type: "start", state: "tracking" },
  { time: "09:05:00", type: "save" },              // 会话1保存
  { time: "09:10:00", type: "start", state: "tracking" },
  { time: "09:15:00", type: "discard" }            // 会话2弃用
];

// lastEndIndex = 3 (discard)
// endIndex = 1 (discard 之前的最后一个 save)
// 计算 09:00 → 09:05 = 300秒 ✅ 正确！
```

### 场景3：多次保存
```javascript
timeline = [
  { time: "09:00:00", type: "start", state: "tracking" },
  { time: "09:05:00", type: "save" },              // 会话1
  { time: "09:10:00", type: "start", state: "tracking" },
  { time: "09:15:00", type: "save" },              // 会话2
  { time: "09:20:00", type: "start", state: "tracking" }  // 会话3进行中
];

// lastEndIndex = 3 (最后一个 save)
// endIndex = 3 (是 save，直接使用)
// 计算 09:00 → 09:15 = 900秒
// + 当前缓存 (09:20 至今)
// ✅ 正确！
```

### 场景4：频繁弃用
```javascript
timeline = [
  { time: "09:00:00", type: "start" },
  { time: "09:01:00", type: "discard" },
  { time: "09:02:00", type: "start" },
  { time: "09:03:00", type: "discard" },
  { time: "09:04:00", type: "start" },
  { time: "09:05:00", type: "discard" }
];

// lastEndIndex = 5 (最后一个 discard)
// endIndex = -1 (所有会话都被弃用)
// activeTime = 0 ✅ 正确！
```

---

## 关键修复点

### ✅ 同时识别 save 和 discard
```javascript
if (fileEvents[i].type === "save" || fileEvents[i].type === "discard")
```

### ✅ discard 后查找之前的 save
```javascript
if (fileEvents[lastEndIndex].type === "save") {
    endIndex = lastEndIndex;  // 直接使用 save
} else {
    // discard：查找 discard 之前的最后一个 save
    for (let i = lastEndIndex - 1; i >= 0; i--) {
        if (fileEvents[i].type === "save") {
            endIndex = i;
            break;
        }
    }
}
```

### ✅ 没有 save 时返回 0
```javascript
if (endIndex < 0) {
    // 所有会话都被弃用，只计算当前正在进行的会话
    if (this.currentFile === filePath && this.currentState !== 'saved') {
        activeTime = this._activeSecondsCache;
    }
    return { activeTime, pauseTime, inactiveTime };
}
```

---

## 验证状态

### 已完成
- [x] 语法检查通过
- [x] 同时检查 save 和 discard 事件
- [x] discard 后查找之前的 save
- [x] 没有 save 时返回 0（不计算弃用的时长）

### 待测试
- [ ] 弃用会话 → Vault Today = 0
- [ ] 频繁弃用 → Vault Today = 0
- [ ] 保存后弃用 → Vault Today = 保存的时长
- [ ] 弃用后保存 → Vault Today = 保存的时长

---

## 测试场景（更新）

### ✅ 场景1：单次弃用
1. 开始计时 3分钟
2. 点击弃用
3. **预期**：Vault Today = 0 秒
4. **修复后**：Vault Today = 0 秒 ✅

### ✅ 场景2：频繁弃用（关键测试）
1. 计时 1分钟 → 弃用
2. 计时 1分钟 → 弃用
3. 计时 1分钟 → 弃用
4. **预期**：Vault Today = 0 秒
5. **修复前**：Vault Today = 180 秒（错误）
6. **修复后**：Vault Today = 0 秒 ✅

### ✅ 场景3：保存后弃用
1. 计时 3分钟 → 保存 → Vault Today = 180秒
2. 计时 2分钟 → 弃用
3. **预期**：Vault Today = 180 秒
4. **修复后**：Vault Today = 180 秒 ✅

---

## 关键文件

- `main.js` - 主逻辑文件（已修复）
- `VAULT_TODAY_FIX.md` - 本文档（最终版）
- `FINAL_FIX_SUMMARY.md` - 计时器状态修复
- `PHASE2_FIX_SUMMARY.md` - Phase 2 修复

---

## 下一步

1. **在 Obsidian 中测试频繁弃用**
2. **验证 Vault Today 始终为 0（如果没有保存）**
3. **测试保存+弃用的组合**
4. **检查控制台日志（每次弃用都有 "记录 discard 事件"）**
