/**
 * 测试环境的运行时声明 / Runtime declarations for the test environment
 *
 * 测试直接在 bun 下运行，用到 node:fs / node:path / process / import.meta.dir。
 * 本机离线且 bun 缓存中没有 @types/node 与 @types/bun，因此这里声明刚好够用的形状
 * —— 与 vendor/stubs 下对 moment / codemirror 的处理方式一致。
 *
 * Tests run directly under bun and use node:fs / node:path / process / import.meta.dir.
 * This machine is offline with no @types/node or @types/bun in the bun cache, so the
 * shapes actually used are declared here, mirroring the approach in vendor/stubs.
 *
 * 这些声明只对 tsconfig 的 include 生效（tests/**\/*.ts 覆盖 .d.ts），
 * 不会进入插件产物。
 * Scoped to the tsconfig include list and never part of the plugin bundle.
 */

declare module 'node:fs' {
  export function readFileSync(path: string, encoding: 'utf8'): string;
  export function readFileSync(path: string): Uint8Array;
  export function existsSync(path: string): boolean;
  export function writeFileSync(path: string, data: string): void;
  export function mkdirSync(path: string, options?: { recursive?: boolean }): void;
}

declare module 'node:path' {
  export function join(...parts: string[]): string;
  export function resolve(...parts: string[]): string;
  export function dirname(p: string): string;
  export function basename(p: string, ext?: string): string;
}

declare module 'node:crypto' {
  export function createHash(algorithm: string): {
    update(data: string | Uint8Array): { digest(encoding: 'hex'): string };
    digest(encoding: 'hex'): string;
  };
}

declare const process: {
  env: Record<string, string | undefined>;
  argv: string[];
  exit(code?: number): void;
};

interface ImportMeta {
  /** bun 提供的当前模块目录绝对路径 / absolute directory of the current module */
  readonly dir: string;
  readonly path: string;
}
