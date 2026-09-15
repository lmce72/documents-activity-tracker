/**
 * documents-activity-tracker — 插件入口 / Plugin entry point
 *
 * Phase 1 骨架：仅验证构建管线（bun → CJS 单文件产物）与类型接线是否正常。
 * 真正的插件实现将在 Phase 4 从 plugin/ReadTimeTrackerPlugin 接入。
 *
 * Phase 1 skeleton: proves the build pipeline (bun -> single-file CJS) and the
 * offline type wiring. The real implementation lands in Phase 4.
 */

import { Plugin } from 'obsidian';

export default class ReadTimeTrackerPlugin extends Plugin {
  override async onload(): Promise<void> {
    // 骨架阶段仅打印一条日志，不做任何实际工作
    // Skeleton stage: log only, no actual work
    console.log('[RTT] Phase 1 skeleton loaded — build pipeline OK');
  }

  override onunload(): void {
    console.log('[RTT] Phase 1 skeleton unloaded');
  }
}
