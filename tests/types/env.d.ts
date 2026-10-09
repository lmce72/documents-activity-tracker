/**
 * Runtime declarations for the test environment
 *
 * Tests run directly under bun and use node:fs / node:path / process / import.meta.dir.
 * This machine is offline with no @types/node or @types/bun in the bun cache, so the
 * shapes actually used are declared here, mirroring the approach in vendor/stubs.
 *
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
  /** absolute directory of the current module */
  readonly dir: string;
  readonly path: string;
}
