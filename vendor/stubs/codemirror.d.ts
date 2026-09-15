/**
 * CodeMirror 的最小桩声明 / Minimal stubs for CodeMirror
 *
 * vendor/obsidian/obsidian.d.ts 第 6-7 行导入了：
 *   @codemirror/state 的 Extension、StateField
 *   @codemirror/view  的 EditorView、ViewPlugin
 * 并在多处使用泛型，例如：
 *   export const editorEditorField: StateField<EditorView>;
 *   export const livePreviewState: ViewPlugin<LivePreviewStateType, undefined>;
 *
 * 本机离线、bun 缓存中无 @codemirror/*，故在此声明刚好够用的形状。
 * 插件自身不使用 CodeMirror，这些类型仅为让 obsidian.d.ts 可解析。
 *
 * This plugin never touches CodeMirror directly; these stubs exist only so the
 * vendored obsidian.d.ts resolves offline.
 */

declare module '@codemirror/state' {
  /** 语法扩展 / An editor extension. */
  export type Extension = unknown;

  /** 编辑器状态字段 / A state field holding a value of type T. */
  export class StateField<T> {
    /** 仅用于携带泛型参数，运行时不存在 / phantom type carrier only. */
    private readonly __type?: T;
  }

  /** 文档文本 / The document text. */
  export class Text {}

  /** 编辑器状态 / The editor state. */
  export class EditorState {}
}

declare module '@codemirror/view' {
  /** 编辑器视图 / The editor view instance. */
  export class EditorView {}

  /** 视图插件 / A view plugin parameterised by its value type and plugin spec. */
  export class ViewPlugin<T, P = undefined> {
    /** 仅用于携带泛型参数，运行时不存在 / phantom type carriers only. */
    private readonly __type?: T;
    private readonly __spec?: P;
  }
}
