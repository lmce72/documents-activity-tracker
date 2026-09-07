# 📋 Documents Activity Tracker 修复验证指南

## 快速验证（推荐）

### 步骤 1: 打开 Obsidian 开发者工具
1. 启动 Obsidian
2. 按 `Ctrl+Shift+I` (或 `Cmd+Option+I` on Mac)
3. 切换到 Console 标签页

### 步骤 2: 运行验证脚本
将以下代码复制到控制台并按回车：

```javascript
(async function() {
    console.log('='.repeat(60));
    console.log('📋 Documents Activity Tracker 修复验证');
    console.log('='.repeat(60));
    
    const plugin = app.plugins.plugins['documents-activity-tracker'];
    
    if (!plugin) {
        console.error('❌ 插件未找到！');
        return;
    }
    
    // 1. 检查 try-catch
    const checks = {
        saveSettings: plugin.saveSettings.toString().includes('try {'),
        saveTimeline: plugin.engine.store.saveTimeline.toString().includes('try {'),
        onunload: plugin.onunload.toString().includes('try {')
    };
    
    console.log('\n✅ Try-Catch 保护:');
    console.log('  saveSettings:', checks.saveSettings ? '✓' : '✗');
    console.log('  saveTimeline:', checks.saveTimeline ? '✓' : '✗');
    console.log('  onunload:', checks.onunload ? '✓' : '✗');
    
    // 2. 测试执行
    console.log('\n✅ 函数执行测试:');
    try {
        await plugin.saveSettings();
        console.log('  saveSettings(): ✓');
    } catch (e) {
        console.log('  saveSettings(): ✗', e.message);
    }
    
    try {
        await plugin.engine.store.saveTimeline(plugin.engine.timeline || []);
        console.log('  saveTimeline(): ✓');
    } catch (e) {
        console.log('  saveTimeline(): ✗', e.message);
    }
    
    // 3. 当前状态
    console.log('\n✅ 插件状态:');
    console.log('  版本:', plugin.manifest.version);
    console.log('  当前文件:', plugin.engine.currentFile || '无');
    console.log('  计时状态:', plugin.engine.currentState || '无');
    console.log('  会话时长:', plugin.engine.sessionSeconds, '秒');
    
    console.log('\n' + '='.repeat(60));
    console.log('🎉 验证完成！所有测试通过即表示修复成功。');
    console.log('='.repeat(60));
})();
```

### 步骤 3: 检查输出

预期输出应该类似：
```
============================================================
📋 Documents Activity Tracker 修复验证
============================================================

✅ Try-Catch 保护:
  saveSettings: ✓
  saveTimeline: ✓
  onunload: ✓

✅ 函数执行测试:
  saveSettings(): ✓
  saveTimeline(): ✓

✅ 插件状态:
  版本: 1.0.1
  当前文件: PrimeCore.md
  计时状态: tracking
  会话时长: 125 秒

============================================================
🎉 验证完成！所有测试通过即表示修复成功。
============================================================
```

---

## 详细验证（可选）

如果需要更详细的验证，可以运行完整的验证脚本：

```bash
# 在终端中执行
cat /home/corevortex/documents-activity-tracker/verify-fixes.js
```

然后将输出复制到 Obsidian 控制台执行。

---

## 常见问题排查

### Q1: 控制台显示"插件未找到"
**解决方案**:
1. 检查插件是否已启用: 设置 → 第三方插件 → Documents Activity Tracker
2. 重启 Obsidian
3. 检查插件目录: `.obsidian/plugins/documents-activity-tracker/`

### Q2: 函数执行失败
**解决方案**:
1. 查看控制台详细错误信息
2. 检查 `main.js` 文件是否正确同步
3. 尝试重新加载插件: `Ctrl+R` (刷新 Obsidian)

### Q3: Try-Catch 检查显示 ✗
**解决方案**:
1. 确认 `main.js` 已更新到最新版本
2. 检查文件权限: `ls -l .obsidian/plugins/documents-activity-tracker/main.js`
3. 手动重新同步文件

---

## 手动功能测试

完成代码验证后，建议进行以下功能测试：

### 1. 基础计时功能
- [ ] 打开一个 Markdown 文件
- [ ] 观察状态栏是否显示计时器
- [ ] 等待几秒，观察时间是否增加
- [ ] 切换到另一个文件，观察是否保存并重新计时

### 2. 暂停/恢复功能
- [ ] 点击计时器的暂停按钮
- [ ] 观察是否停止计时
- [ ] 点击恢复按钮
- [ ] 观察是否继续计时

### 3. 查看记录
- [ ] 运行命令: "查看阅读记录"
- [ ] 检查是否显示历史记录
- [ ] 查看时长是否正确累加

### 4. 错误恢复
- [ ] 强制刷新 Obsidian (`Ctrl+R`)
- [ ] 观察插件是否正常重新加载
- [ ] 检查控制台是否有错误信息

---

## 性能监控

### 检查内存使用
```javascript
// 在控制台执行
console.log('Memory usage:', performance.memory);
console.log('Timeline length:', app.plugins.plugins['documents-activity-tracker'].engine.timeline.length);
```

### 检查计时器精度
```javascript
// 在控制台执行
const plugin = app.plugins.plugins['documents-activity-tracker'];
console.log('Tick interval:', plugin.engine.tickTimer ? 'Active' : 'Inactive');
console.log('Last tick time:', plugin.engine._lastTickTime);
console.log('Session seconds:', plugin.engine.sessionSeconds);
```

---

## 报告问题

如果验证失败或发现问题，请提供以下信息：

1. **控制台输出**: 完整的验证脚本输出
2. **错误日志**: 任何红色的错误信息
3. **Obsidian 版本**: 帮助 → 关于
4. **插件版本**: 设置 → 第三方插件 → Documents Activity Tracker
5. **操作系统**: Linux/Windows/Mac + 版本号

---

## 下一步

验证成功后，您可以：
- ✅ 正常使用插件
- ✅ 观察是否有错误提示
- ✅ 等待剩余 70% 函数的修复 (预计 v1.0.3)

---

**文档版本**: 1.0  
**最后更新**: 2026-09-07  
**支持**: 通过 GitHub Issues 报告问题
