# 弃用后立即开始计时 - 修复总结

## 修复时间
2026-09-05

## 问题描述

**用户报告**：
1. ❌ 频繁弃用后，Vault Today 仍在累加
2. ❌ 被排除的文件也在计时

**控制台日志**：
```
[ReadTimeTracker] 🗑️ 弃用当前会话
[ReadTimeTracker] 记录 discard 事件
[ReadTimeTracker] 🔄 开启新会话
[ReadTimeTracker] ▶ 恢复计时  // ❌ 问题：弃用后立即恢复！
```

---

## 问题1：弃用后立即开始计时 ✅ 已修复

### 根本原因
`discardCurrentSession()` 方法在弃用后：
1. 调用 `_startNewSession()` 开启新会话
2. **根据配置决定是否暂停**：如果用户配置为"自动开始"，`shouldPause = false`
3. 设置 `_lastTickTime = Date.now()` → **立即开始计时**
4. 新会话的时间累加到 Vault Today

**修复前代码**（行1870-1878）：
```javascript
// 丢弃后设置为暂停状态
let config = { startOnOpen: false };
if (this.plugin && this.plugin.getAutoStartConfig) {
    config = this.plugin.getAutoStartConfig(this.settings.autoStartMode);
}
const shouldPause = !config.startOnOpen;  // ❌ 根据配置决定
this.isPaused = shouldPause;
this._lastTickTime = shouldPause ? null : Date.now();  // ❌ 可能立即开始
```

**修复后代码**：
```javascript
// ✅ 弃用后强制暂停，不自动开始计时
this.isPaused = true;
this._lastTickTime = null;

// 同步回当前叶子状态
if (this.activeLeaf) {
    const state = this._leafStates.get(this.activeLeaf.id);
    if (state) state.isPaused = true;
}

// ✅ 5. 通知 widget 更新为暂停状态
if (this.onTickCallback) {
    this.onTickCallback(
        filePath,
        0,
        stats.activeTime,
        null,
        this._getTodaySessionCount(filePath),
        false  // ✅ 强制暂停状态
    );
}
```

**关键变更**：
- ✅ 弃用后**强制暂停**，不管用户配置
- ✅ 设置 `isPaused = true` 和 `_lastTickTime = null`
- ✅ 通知 widget 为暂停状态（`false`）
- ✅ 符合备份版本的行为

---

## 问题2：被排除的文件也在计时 ⚠️ 需要诊断

### 现有逻辑检查

**排除检查位置**：`_bindToFile()` 方法，行914-923
```javascript
if (!shouldTrackFile(filePath, this.settings)) {
    this.currentPath = null;
    if (leaf) this._leafStates.delete(leaf.id);
    if (this.onExcludedCallback) this.onExcludedCallback(filePath);
    return;  // ✅ 被排除文件不继续绑定
}
```

**`shouldTrackFile()` 函数**：行333-348
- 支持黑名单和白名单模式
- 支持正则表达式和路径前缀匹配
- 逻辑看起来正确

### 可能的原因

#### 原因A：文件在计时中，然后被添加到排除列表
**场景**：
1. 文件正在计时
2. 用户修改排除规则，将该文件添加到黑名单
3. `_bindToFile()` 不会重新调用
4. 计时器仍在运行

**解决方法**：
- 设置变更时，重新检查当前文件是否应排除
- 如果当前文件被排除，停止计时并清空状态

#### 原因B：Widget 显示排除图标，但计时器仍在后台运行
**场景**：
- Widget 正确显示排除图标
- 但 `ReadTimeEngine` 的状态未清空
- `tick()` 仍在累加秒数

**排查方法**：
1. 检查控制台是否有 `onExcludedCallback` 的日志
2. 检查 `this.currentFile` 是否被清空
3. 检查 `_lastTickTime` 是否被清空

#### 原因C：排除规则配置错误
**场景**：
- 用户以为文件被排除了，但实际规则不匹配
- 例如：规则是 `test/`，但文件是 `Test/file.md`（大小写）

**排查方法**：
1. 在控制台执行 `shouldTrackFile(filePath, settings)` 测试规则
2. 检查排除模式（黑名单/白名单）
3. 检查正则表达式语法

---

## 诊断步骤

### 1. 验证弃用修复
- [ ] 弃用会话后，查看控制台日志
- [ ] 应该看到 "🗑️ 弃用当前会话" 和 "记录 discard 事件"
- [ ] **不应该**看到 "▶ 恢复计时"
- [ ] Widget 应显示暂停图标（▶ 播放按钮）
- [ ] Vault Today 不应增加

### 2. 验证排除文件问题
请提供以下信息：

#### 当前排除规则
- [ ] 黑名单还是白名单模式？
- [ ] 排除规则内容？（例如：`test/, \.draft$`）

#### 被排除文件的路径
- [ ] 完整文件路径？
- [ ] 是否匹配排除规则？

#### 控制台日志
- [ ] 打开该文件时，是否有 `onExcludedCallback` 日志？
- [ ] 是否有 `_bindToFile` 日志？
- [ ] `currentFile` 的值是什么？

#### Widget 状态
- [ ] Widget 是否显示排除图标（⊖）？
- [ ] Widget 是否显示时间？
- [ ] 时间是否在累加？

---

## 验证状态

### 已完成
- [x] 语法检查通过
- [x] 弃用后强制暂停
- [x] 不根据配置自动开始
- [x] 通知 widget 为暂停状态

### 待测试
- [ ] 弃用后不立即开始计时
- [ ] 弃用后 Vault Today 不累加
- [ ] 排除文件问题的具体原因

---

## 关键文件

- `main.js` - 主逻辑文件（已修复弃用逻辑）
- `DISCARD_FIX.md` - 本文档
- `VAULT_TODAY_FIX.md` - Vault Today 计算修复
- `FINAL_FIX_SUMMARY.md` - 计时器状态修复

---

## 下一步

1. **在 Obsidian 中测试弃用功能**
2. **验证弃用后不立即开始计时**
3. **提供排除文件问题的详细信息**
   - 排除规则配置
   - 被排除文件路径
   - 控制台日志
   - Widget 状态

---

## 测试场景

### 场景1：弃用后不计时 ✅
1. 开始计时 1分钟
2. 点击弃用
3. **预期**：
   - Widget 显示暂停图标（▶）
   - 不显示 "▶ 恢复计时" 日志
   - Vault Today = 0
4. 等待 1分钟
5. **预期**：
   - Vault Today 仍然 = 0
   - 时间不累加

### 场景2：频繁弃用
1. 计时 1分钟 → 弃用
2. 计时 1分钟 → 弃用
3. 计时 1分钟 → 弃用
4. **预期**：
   - 每次弃用后都是暂停状态
   - Vault Today = 0
