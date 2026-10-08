/**
 * 可注入时钟。引擎内一切时间戳都走 `now()`；默认 `Date.now`。
 * 测试/回放可用 `setClock(fn)` 固定时间，从而获得完全确定的结果。
 */
let clock: () => number = () => Date.now();

export function now(): number {
  return clock();
}

export function setClock(fn: () => number): void {
  clock = fn;
}

export function resetClock(): void {
  clock = () => Date.now();
}
