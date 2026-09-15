/**
 * bun:test 的最小桩声明 / Minimal stub for bun:test
 *
 * 本机离线且 bun 缓存中无 @types/bun，故在此声明测试所需的 API 形状，
 * 让 tests/**\/*.spec.ts 能被 tsc 检查。运行时由 bun 自身提供真实实现。
 *
 * Offline machine with no @types/bun in the bun cache, so we declare the shape
 * of the test API we use. At runtime bun supplies the real implementation.
 */

declare module 'bun:test' {
  type TestFn = () => void | Promise<void>;

  interface Matchers {
    toBe(expected: unknown): void;
    toEqual(expected: unknown): void;
    toStrictEqual(expected: unknown): void;
    toBeTruthy(): void;
    toBeFalsy(): void;
    toBeNull(): void;
    toBeUndefined(): void;
    toBeDefined(): void;
    toBeGreaterThan(n: number): void;
    toBeGreaterThanOrEqual(n: number): void;
    toBeLessThan(n: number): void;
    toBeLessThanOrEqual(n: number): void;
    toContain(item: unknown): void;
    toHaveLength(n: number): void;
    toMatch(re: RegExp | string): void;
    toThrow(message?: string | RegExp): void;
    not: Matchers;
  }

  interface DescribeBlock {
    (label: string, fn: () => void): void;
    skip(label: string, fn: TestFn): void;
    only(label: string, fn: () => void): void;
    todo(label: string): void;
  }

  interface ItBlock {
    (label: string, fn: TestFn, timeout?: number): void;
    skip(label: string, fn?: TestFn): void;
    only(label: string, fn: TestFn, timeout?: number): void;
    todo(label: string): void;
  }

  export const describe: DescribeBlock;
  export const it: ItBlock;
  export const test: ItBlock;
  export function expect(actual: unknown): Matchers;
  export function beforeEach(fn: TestFn): void;
  export function afterEach(fn: TestFn): void;
  export function beforeAll(fn: TestFn): void;
  export function afterAll(fn: TestFn): void;
  export function mock<T extends (...args: never[]) => unknown>(fn?: T): T & { mock: { calls: unknown[][] } };
}
