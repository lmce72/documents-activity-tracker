# 被排除文件仍在计时 - 诊断指南

## 问题症状
被排除的文件仍然显示计时器，Vault Today 在累加。

---

## 诊断步骤

### 1. 检查插件是否加载了最新代码

**打开 Obsidian 开发者控制台**（Ctrl+Shift+I 或 Cmd+Option+I），执行：

```javascript
// 检查插件状态
const plugin = app.plugins.plugins['documents-activity-tracker'];
console.log('插件版本:', plugin);
console.log('Timeline 长度:', plugin.engine?.timeline?.length);
console.log('当前文件:', plugin.engine?.currentFile);
console.log('当前状态:', plugin.engine?.currentState);
```

**预期结果**：
- `Timeline 长度: 0` 或更多（如果为 `undefined`，说明插件未加载最新代码）

**如果 timeline 是 undefined**：
1. 重新加载插件：设置 → 社区插件 → Documents Activity Tracker → 禁用 → 启用
2. 或重启 Obsidian

---

### 2. 检查当前文件是否应被排除

**在控制台执行**：

```javascript
// 获取当前文件路径
const view = app.workspace.getActiveViewOfType(require('obsidian').MarkdownView);
const filePath = view?.file?.path;
console.log('当前文件:', filePath);

// 获取白名单规则
const plugin = app.plugins.plugins['documents-activity-tracker'];
const settings = plugin.settings;
console.log('过滤模式:', settings.filterMode);
console.log('过滤规则:', settings.filterPatterns);

// 测试是否应该追踪
const shouldTrack = (function() {
    const raw = (settings.filterPatterns || settings.excludePatterns || '').trim();
    const mode = settings.filterMode || 'blacklist';
    if (!raw) return mode !== 'whitelist';
    const patterns = raw.split(/[,，\n]/).map(s => s.trim()).filter(s => s.length > 0);
    const matches = (pattern) => {
        try {
            const reMatch = pattern.match(/^\/(.+)\/([gimsuy]*)$/);
            if (reMatch) return new RegExp(reMatch[1], reMatch[2]).test(filePath);
            const prefix = (pattern.indexOf('.') < 0 && !pattern.endsWith('/')) ? pattern + '/' : pattern;
            return filePath.startsWith(prefix) || filePath === pattern;
        } catch (e) { return false; }
    };
    const matched = patterns.some(p => matches(p));
    return mode === 'whitelist' ? matched : !matched;
})();

console.log('是否应追踪:', shouldTrack);
console.log('匹配的规则:', settings.filterPatterns.split('\n').filter(p => {
    const prefix = (p.indexOf('.') < 0 && !p.endsWith('/')) ? p + '/' : p;
    return filePath.startsWith(prefix) || filePath === p;
}));
```

**预期结果**：
- `是否应追踪: false`（如果为 `true`，说明文件匹配了白名单）
- `匹配的规则: []`（空数组表示不匹配任何规则）

---

### 3. 检查 widget 状态

**在控制台执行**：

```javascript
const plugin = app.plugins.plugins['documents-activity-tracker'];
const view = app.workspace.getActiveViewOfType(require('obsidian').MarkdownView);
const widget = plugin.widgetManager._viewWidgets.get(view);

console.log('Widget 状态:', {
    存在: !!widget,
    文件路径: widget?.filePath,
    isExcluded: widget?.isExcluded,
    container存在: !!widget?.container
});
```

**预期结果**：
- `isExcluded: true`（如果为 `false` 或 `undefined`，说明 widget 未标记为排除）

---

### 4. 检查引擎状态

**在控制台执行**：

```javascript
const plugin = app.plugins.plugins['documents-activity-tracker'];
const engine = plugin.engine;

console.log('引擎状态:', {
    currentFile: engine.currentFile,
    currentState: engine.currentState,
    isPaused: engine.isPaused,
    _lastTickTime: engine._lastTickTime,
    _activeSecondsCache: engine._activeSecondsCache,
    readingMap: Array.from(engine.readingMap.entries())
});
```

**预期结果**：
- 被排除的文件：`currentFile: null` 或不是当前文件
- `_lastTickTime: null`（如果有值，说明计时器在运行）

---

## 常见问题

### 问题1：timeline 为空，但插件看起来正常工作

**原因**：data.json 是旧格式，没有 timeline 字段。

**解决方法**：
1. 保存一次会话（点击保存按钮或切换文件）
2. 检查 data.json 是否生成了 timeline 字段
3. 如果没有，重新加载插件

### 问题2：文件应该被排除，但 isExcluded 为 false

**原因**：白名单规则不匹配。

**调试**：
检查文件路径是否包含在白名单中：

```javascript
const filePath = "PrimeCore.md";  // 替换为实际文件路径
const patterns = [
    "10-Planner/8-日常记录",
    "PrimeCore-Features",
    // ... 其他规则
];

patterns.forEach(p => {
    const prefix = (p.indexOf('.') < 0 && !p.endsWith('/')) ? p + '/' : p;
    const matches = filePath.startsWith(prefix) || filePath === p;
    console.log(`${p}: ${matches ? '✅ 匹配' : '❌ 不匹配'}`);
});
```

**常见匹配问题**：
- `PrimeCore.md` 不匹配 `PrimeCore-Features`（前缀不同）
- `Components/test.md` 不匹配 `Component`（少了 s）
- 路径大小写敏感

### 问题3：widget 显示计时器，但引擎 currentFile 为 null

**原因**：widget 显示的是旧数据或缓存数据。

**解决方法**：
1. 切换到其他文件再切回
2. 重新加载插件
3. 检查 `update()` 方法是否有 `isExcluded` 检查

---

## 修复建议

### 如果 timeline 为空
1. 重新加载插件（禁用 → 启用）
2. 打开任意文件，计时1秒，然后保存
3. 检查 data.json 是否生成了 timeline 字段

### 如果白名单规则不匹配
1. 修改白名单规则，添加缺失的路径
2. 或将文件移动到白名单路径下

### 如果 widget 未标记为排除
1. 检查 `onExcludedCallback` 是否正确触发
2. 检查 `widget.markAsExcluded()` 是否被调用
3. 检查控制台是否有错误日志

---

## 下一步

请执行上述诊断步骤，并提供以下信息：

1. **Timeline 长度**：是否为 0 或 undefined？
2. **当前文件路径**：完整路径是什么？
3. **是否应追踪**：true 还是 false？
4. **匹配的规则**：哪些白名单规则匹配了？
5. **Widget isExcluded**：true 还是 false？
6. **引擎 currentFile**：是否为 null？

---

## 关键文件

- `main.js` - 主逻辑文件（最新）
- `data.json` - 数据文件（可能是旧格式）
- `EXCLUDED_FILE_DIAGNOSIS.md` - 本文档
