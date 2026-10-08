import type { UserId } from './model.js';

/**
 * 显示名解析。引擎默认用 `用户 #后4位`；适配器可注入真实名字（Telegram 用 @username / 昵称，
 * Discord 用用户名，网页用登录名）。注入后引擎消息里就是真实名字。
 */
let resolver: ((id: number) => string) | null = null;

export function setNameResolver(fn: ((id: number) => string) | null): void {
  resolver = fn;
}

export function displayName(userId: UserId): string {
  return resolver ? resolver(userId) : `用户 #${String(userId).slice(-4)}`;
}
