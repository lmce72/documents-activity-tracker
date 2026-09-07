/**
 * Documents Activity Tracker 插件修复验证脚本
 * 在 Obsidian 开发者控制台中运行此脚本
 * Run this script in Obsidian Developer Console (Ctrl+Shift+I)
 */

(async function verifyPluginFixes() {
    console.log('='.repeat(60));
    console.log('📋 Documents Activity Tracker 修复验证');
    console.log('='.repeat(60));
    console.log('');

    // 1. 检查插件加载
    console.log('✅ 测试 1: 检查插件加载状态');
    const plugin = app.plugins.plugins['documents-activity-tracker'];

    if (!plugin) {
        console.error('❌ 插件未找到！');
        return;
    }

    console.log('  ✓ 插件已加载');
    console.log('  ✓ 版本:', plugin.manifest.version);
    console.log('  ✓ 已启用:', app.plugins.enabledPlugins.has('documents-activity-tracker'));
    console.log('  ✓ Engine 实例:', !!plugin.engine);
    console.log('');

    // 2. 验证关键函数是否有 try-catch
    console.log('✅ 测试 2: 验证 try-catch 保护');
    const checks = [
        { name: 'saveSettings', obj: plugin, func: 'saveSettings' },
        { name: 'saveTimeline', obj: plugin.engine.store, func: 'saveTimeline' },
        { name: 'onunload', obj: plugin, func: 'onunload' }
    ];

    for (const check of checks) {
        const funcStr = check.obj[check.func].toString();
        const hasTryCatch = funcStr.includes('try {') && funcStr.includes('catch');
        const hasErrorLog = funcStr.includes('console.error');

        console.log(`  ${check.name}:`);
        console.log(`    - try-catch: ${hasTryCatch ? '✓' : '✗'}`);
        console.log(`    - 错误日志: ${hasErrorLog ? '✓' : '✗'}`);
    }
    console.log('');

    // 3. 测试异步函数执行
    console.log('✅ 测试 3: 测试异步函数执行');

    try {
        await plugin.saveSettings();
        console.log('  ✓ saveSettings() 执行成功');
    } catch (e) {
        console.log('  ✗ saveSettings() 失败:', e.message);
    }

    try {
        await plugin.engine.store.saveTimeline(plugin.engine.timeline || []);
        console.log('  ✓ saveTimeline() 执行成功');
    } catch (e) {
        console.log('  ✗ saveTimeline() 失败:', e.message);
    }
    console.log('');

    // 4. 检查当前状态
    console.log('✅ 测试 4: 插件运行状态');
    console.log('  当前文件:', plugin.engine.currentFile || '无');
    console.log('  当前状态:', plugin.engine.currentState || '无');
    console.log('  是否暂停:', plugin.engine.isPaused);
    console.log('  会话时长:', plugin.engine.sessionSeconds, '秒');
    console.log('  窗口焦点:', plugin.engine.isWindowFocused);
    console.log('  计时器运行:', !!plugin.engine.tickTimer);
    console.log('');

    // 5. 检查设置
    console.log('✅ 测试 5: 插件设置');
    console.log('  自动启动模式:', plugin.settings.autoStartMode);
    console.log('  空闲超时启用:', plugin.settings.idleTimeoutEnabled);
    console.log('  空闲超时:', plugin.settings.idleTimeout, '秒');
    console.log('  最小记录时长:', plugin.settings.minReadSeconds, '秒');
    console.log('  追踪模式:', plugin.settings.trackingMode || 'focus');
    console.log('');

    // 6. 测试错误捕获
    console.log('✅ 测试 6: 错误捕获机制');
    const originalError = console.error;
    const errors = [];

    console.error = function(...args) {
        if (args[0] && typeof args[0] === 'string' && args[0].includes('ReadTimeTracker')) {
            errors.push(args.join(' '));
        }
        originalError.apply(console, args);
    };

    // 触发一些事件
    plugin.engine.onUserActivity();

    setTimeout(() => {
        console.error = originalError;
        if (errors.length === 0) {
            console.log('  ✓ 无未捕获错误');
        } else {
            console.log('  ⚠️  捕获到错误:');
            errors.forEach(err => console.log('    -', err));
        }

        console.log('');
        console.log('='.repeat(60));
        console.log('🎉 验证完成！');
        console.log('='.repeat(60));
    }, 2000);

})();
