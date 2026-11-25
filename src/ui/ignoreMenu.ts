/**
 * 排除菜单 / the exclude menu
 *
 * 侧栏卡片上的排除按钮会打开它：笔记列出自身与各级祖先目录，插件视图只有自身。选中一项即把该
 * 值交给装配层写入忽略列表并丢弃当前轮。
 *
 * 用 Obsidian 原生 `Menu` 而不是自绘弹层：定位翻转、焦点圈定与键盘语义都由宿主提供，移动端也能
 * 得到原生样式。图标按钮本身已有 `aria-label`（见 `SidebarView.iconButton`），菜单项由 `Menu`
 * 暴露为菜单项，不需要我们补 `role`。
 *
 * Opened by a card's exclude button. A note lists itself plus its ancestor folders by level; a
 * plugin view lists only itself. Picking an entry hands the value to the assembly layer, which
 * writes the ignore list and discards the current round.
 */

import { Menu } from 'obsidian';

import { t } from '../core/i18n';
import { ignoreTargetsFor, type IgnoreTarget } from '../core/ignoreTargets';

/** 菜单项文案 / the label for one menu entry. */
function labelFor(target: IgnoreTarget): string {
  switch (target.kind) {
    case 'view':
      return t('ignoreMenuView');
    case 'note':
      return t('ignoreMenuNote');
    case 'folder':
      return t('ignoreMenuFolder')
        .replace('{path}', target.value.replace(/\/+$/, ''))
        .replace('{level}', String(target.level));
  }
}

/** 菜单项图标：目录用「移出目录」、笔记与视图用「隐藏」 / folder-minus for folders, eye-off otherwise. */
function iconFor(target: IgnoreTarget): string {
  return target.kind === 'folder' ? 'folder-minus' : 'eye-off';
}

export interface IgnoreMenuOptions {
  /** 正在计时的目标（笔记路径或 view: 键） / the running target */
  target: string;
  /** 触发按钮的点击事件 / the click that opened the menu */
  event: MouseEvent;
  /** 选中某一粒度 / called with the entry to ignore */
  exclude: (entry: string) => void;
}

/**
 * 打开排除菜单 / open the exclude menu.
 *
 * 鼠标触发用 `showAtMouseEvent`；键盘触发（`detail === 0`，坐标为 0,0）退回按钮矩形，否则菜单会
 * 出现在视口左上角，像是没有打开。
 * Pointer opens at the pointer. A keyboard activation reports `detail === 0` and zero coordinates,
 * so fall back to the button's rectangle — otherwise the menu appears in the viewport's top-left
 * corner and reads as "nothing happened".
 */
export function showIgnoreMenu(options: IgnoreMenuOptions): void {
  const menu = new Menu();
  menu.addItem((item) => item.setTitle(t('ignoreMenuSection')).setIsLabel(true));

  for (const target of ignoreTargetsFor(options.target)) {
    menu.addItem((item) =>
      item
        .setTitle(labelFor(target))
        .setIcon(iconFor(target))
        .onClick(() => options.exclude(target.value)),
    );
  }

  if (options.event.detail > 0) {
    menu.showAtMouseEvent(options.event);
    return;
  }

  const host = options.event.currentTarget;
  const rect = host instanceof HTMLElement ? host.getBoundingClientRect() : null;
  menu.showAtPosition(rect ? { x: rect.left, y: rect.bottom } : { x: 0, y: 0 });
}
