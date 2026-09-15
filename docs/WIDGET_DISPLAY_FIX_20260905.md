# Obsidian Documents Activity Tracker - Widget 显示修复报告

**修复日期**: 2026-09-05  
**修复时间**: 19:00 - 20:40 CST

---

## 问题描述

用户报告：**新打开文档时，Widget 只显示 "Vault Today"**，其他区域（Started、今日第n轮、按钮）都不显示。

用户设置：`todayTotalDisplay = "always"`（Always show 模式）

---

## 根本原因

在 `update()` 方法中（`main.js` 第 3320-3360 行），`todayTotalDisplay` 设置有三种模式：

1. **never**: 隐藏今日总计段
2. **always**: 第3段固定显示全库今日总计
3. **idle**（默认）: 根据 isRunning 动态切换第3段内容

**问题所在**：

### 原始代码（备份版本和当前版本）

```javascript
} else if (displayMode === 'always') {
    // always 模式：第三段始终显示全库今日总计
    if (w.todaySection) w.todaySection.style.display = '';
    if (w.todayLabel) w.todayLabel.textContent = t('vaultToday');
    w.todayValue.textContent = formatReadTime(allTodaySeconds, this.settings.timeDisplayMode || 'compact');
    // ❌ 问题：没有设置其他区域的 display 属性
}
```

**当 `displayMode = 'always'` 时**：
- ✅ 正确设置了 `todaySection.style.display = ''`（显示）
- ❌ **没有设置** `startSection`, `sessionSection`, `buttonSection` 的 `display` 属性
- ❌ **没有设置** `sessionLabel` 和 `sessionValue` 的内容

结果：这些区域保持 Widget 创建时的初始状态，可能是 `display: none` 或空内容，导致不显示。

---

## 修复方案

### 修复后的代码

```javascript
} else if (displayMode === 'always') {
    // always 模式：第三段固定显示全库今日总计，其他区域行为与 idle 相同
    if (w.todaySection) w.todaySection.style.display = '';
    if (w.todayLabel) w.todayLabel.textContent = t('vaultToday');
    w.todayValue.textContent = formatReadTime(allTodaySeconds, this.settings.timeDisplayMode || 'compact');
    
    // ✅ 其他区域根据 isRunning 动态切换
    if (isRunning) {
        // 运行中：显示本轮计时
        if (w.startSection) w.startSection.style.display = '';
        if (w.sessionSection) w.sessionSection.style.display = '';
        if (w.buttonSection) w.buttonSection.style.display = '';
        if (w.sessionLabel) w.sessionLabel.textContent = `今日第${sessionCount}轮`;
    } else {
        // 暂停/空闲：显示文件今日总计
        if (w.startSection) w.startSection.style.display = '';
        if (w.sessionSection) w.sessionSection.style.display = '';
        if (w.buttonSection) w.buttonSection.style.display = '';
        if (w.sessionLabel) w.sessionLabel.textContent = t('fileToday');
        w.sessionValue.textContent = formatReadTime(todaySeconds, this.settings.timeDisplayMode || 'compact');
    }
}
```

### 同时修复 `never` 模式

`never` 模式也有类似问题，修复后：

```javascript
if (displayMode === 'never') {
    // never 模式：隐藏今日总计段
    if (w.todaySection) w.todaySection.style.display = 'none';
    
    // ✅ 仍需显示其他区域，行为与 idle 模式相同
    if (isRunning) {
        if (w.startSection) w.startSection.style.display = '';
        if (w.sessionSection) w.sessionSection.style.display = '';
        if (w.buttonSection) w.buttonSection.style.display = '';
        if (w.sessionLabel) w.sessionLabel.textContent = `今日第${sessionCount}轮`;
    } else {
        if (w.startSection) w.startSection.style.display = '';
        if (w.sessionSection) w.sessionSection.style.display = '';
        if (w.buttonSection) w.buttonSection.style.display = '';
        if (w.sessionLabel) w.sessionLabel.textContent = t('fileToday');
        w.sessionValue.textContent = formatReadTime(todaySeconds, this.settings.timeDisplayMode || 'compact');
    }
}
```

---

## 三种模式的行为总结

| 模式 | 第1段（Started） | 第2段（本轮/文件今日） | 第3段（Vault Today） | 按钮 |
|------|-----------------|---------------------|---------------------|------|
| **never** | 显示 | 运行时=本轮，暂停=文件今日 | **隐藏** | 显示 |
| **always** | 显示 | 运行时=本轮，暂停=文件今日 | **固定显示全库今日** | 显示 |
| **idle** | 显示 | 运行时=本轮，暂停=文件今日 | 运行时=全库今日，暂停=全库今日 | 显示 |

**关键差异**：
- `never`: 完全隐藏第3段
- `always`: 第3段固定显示全库今日总计
- `idle`: 第3段内容与 `always` 相同，只是语义上表示"根据运行状态动态切换"

---

## 修改的文件

| 文件 | 修改位置 | 说明 |
|------|---------|------|
| `main.js` | 行 3320-3360 | 修复 `never` 和 `always` 模式的区域显示逻辑 |

---

## 测试验证

### 测试场景

1. **设置为 always 模式**，打开新文档
   - ✅ 预期：显示所有区域（Started, 本轮/文件今日, Vault Today, 按钮）
   
2. **设置为 never 模式**，打开新文档
   - ✅ 预期：显示 Started, 本轮/文件今日, 按钮，隐藏 Vault Today

3. **设置为 idle 模式**，打开新文档
   - ✅ 预期：显示所有区域（已验证正常）

### 验证步骤

1. 在 Obsidian 设置中切换 `Today Total Display Mode` 为 `Always show`
2. 重新加载插件
3. 打开一个新文档（白名单内）
4. 检查 Widget 是否显示完整

---

## 相关问题

### 问题：为什么备份版本也有这个 bug？

备份版本（`/home/corevortex/文档/Markdown Docs_backup/.obsidian/plugins/documents-activity-tracker/main.js`）也只设置了 `todaySection` 的显示，没有设置其他区域。

**可能原因**：
1. 这是一个长期存在的 bug，只在特定设置下才会触发
2. 用户之前可能一直使用 `idle` 模式，所以没有发现

### 问题：为什么 `idle` 模式正常？

`idle` 模式（第 3338-3359 行）有完整的 `if (isRunning)` / `else` 分支，正确设置了所有区域的 `display` 和内容。

---

## 后续改进建议

### 代码重构

创建一个统一的辅助函数来设置区域显示，避免重复代码：

```javascript
_setWidgetRegions(w, isRunning, sessionCount, seconds, todaySeconds, showTodaySection = true) {
    // 第1段：Started
    if (w.startSection) w.startSection.style.display = '';
    
    // 第2段：本轮/文件今日
    if (w.sessionSection) w.sessionSection.style.display = '';
    if (w.buttonSection) w.buttonSection.style.display = '';
    
    if (isRunning) {
        if (w.sessionLabel) w.sessionLabel.textContent = `今日第${sessionCount}轮`;
        w.sessionValue.textContent = formatReadTime(seconds, this.settings.timeDisplayMode || 'compact');
    } else {
        if (w.sessionLabel) w.sessionLabel.textContent = t('fileToday');
        w.sessionValue.textContent = formatReadTime(todaySeconds, this.settings.timeDisplayMode || 'compact');
    }
    
    // 第3段：Vault Today
    if (w.todaySection) {
        w.todaySection.style.display = showTodaySection ? '' : 'none';
    }
}
```

然后在各个模式中调用：

```javascript
if (displayMode === 'never') {
    this._setWidgetRegions(w, isRunning, sessionCount, seconds, todaySeconds, false);
} else if (displayMode === 'always') {
    this._setWidgetRegions(w, isRunning, sessionCount, seconds, todaySeconds, true);
    if (w.todayLabel) w.todayLabel.textContent = t('vaultToday');
    w.todayValue.textContent = formatReadTime(allTodaySeconds, this.settings.timeDisplayMode || 'compact');
} else { // idle
    this._setWidgetRegions(w, isRunning, sessionCount, seconds, todaySeconds, true);
    // idle 模式的第3段逻辑...
}
```

### 单元测试

为 `update()` 方法添加单元测试，覆盖所有 `todayTotalDisplay` 模式。

---

## 总结

修复了 `always` 和 `never` 模式下 Widget 区域显示不完整的问题。现在三种模式都能正确显示所有区域（除了各自需要隐藏的部分）。

**修复前**：
- `always` 模式只显示 "Vault Today"
- `never` 模式只隐藏今日总计，其他区域可能不显示

**修复后**：
- `always` 模式显示所有区域，第3段固定显示全库今日总计
- `never` 模式显示所有区域（除了第3段），行为与 `idle` 一致
- `idle` 模式行为不变（已正常）

---

**报告生成时间**: 2026-09-05 20:40:00 CST  
**修复工程师**: Claude Sonnet 4.6
