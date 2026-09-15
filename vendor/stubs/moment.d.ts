/**
 * moment 的最小桩声明 / Minimal stub declaration for moment
 *
 * vendor/obsidian/obsidian.d.ts 第 8 行有 `import * as Moment from 'moment'`，
 * 第 4561 行有 `export const moment: typeof Moment;`。
 * 本机离线、无 moment 包，故在此提供刚好覆盖该用法的类型。
 *
 * obsidian.d.ts imports moment (line 8) and re-exports `typeof Moment` (line 4561).
 * This machine is offline with no moment package, so we declare just enough types.
 */

declare module 'moment' {
  interface Moment {
    format(fmt?: string): string;
    isValid(): boolean;
    toDate(): Date;
    valueOf(): number;
    clone(): Moment;
    locale(): string;
    locale(locale: string): string;
  }

  interface MomentStatic {
    (input?: unknown, format?: string): Moment;
    locale(): string;
    locale(locale: string): string;
    unix(timestamp: number): Moment;
    isValid(value: unknown): boolean;
  }

  const moment: MomentStatic;
  export default moment;
}
