import { loadMermaid } from 'obsidian';

/**
 * Pele 的浏览器全局接口 / the browser-global surface of Pele.
 *
 * Obsidian 1.15 replaced Mermaid.js with Pele and exposes it as `window.pele` once `loadMermaid()`
 * resolves. Only the members used here are typed, so a renamed internal field cannot leak into the
 * plugin's types.
 *
 * 1.15 起 Mermaid 由 Pele 绘制；`loadMermaid()` 完成后即可在 `window.pele` 上拿到渲染器。
 * 这里只声明用到的成员，避免把内部实现固化成插件类型。
 */
export interface PeleMounted {
  /** 换一份源码重绘 / redraw with a new source */
  update(text: string, options?: PeleMountOptions): void;
  /** 停止尺寸监听 / stop observing */
  destroy(): void;
}

export interface PeleMountOptions {
  /** 侧栏里不需要缩放控件 / no zoom controls in a narrow sidebar */
  zoom?: boolean | 'auto';
  /** 基础字号（像素）/ base label size in pixels */
  fontSize?: number;
  /** 图形四周留白（像素）/ space around the diagram in pixels */
  padding?: number;
  /** 窄容器是否自动转竖向 / whether a narrow container may switch to a vertical layout */
  autoDirection?: boolean;
  onError?: (error: unknown) => void;
}

interface PeleApi {
  mount(element: HTMLElement, text: string, options?: PeleMountOptions): PeleMounted;
}

let loading: Promise<PeleApi | null> | null = null;

/**
 * 取得 Pele 渲染器 / resolve the Pele renderer.
 *
 * `loadMermaid()` 是 Obsidian 的公开入口：一来自带缓存，二来在 1.15 上正是它把 `window.pele`
 * 装好。失败时返回 null，由调用方决定是否退化为纯文本。
 *
 * `loadMermaid()` is the public entry point: it is cached by Obsidian, and on 1.15 it is what makes
 * `window.pele` available. A failure resolves to null so the caller can fall back to text.
 */
export function loadPele(): Promise<PeleApi | null> {
  if (!loading) {
    loading = loadMermaid()
      .then(() => {
        const pele = (window as unknown as { pele?: PeleApi }).pele;
        return pele && typeof pele.mount === 'function' ? pele : null;
      })
      .catch(() => null);
  }
  return loading;
}
