import { createHmac, timingSafeEqual } from 'node:crypto';

export type InitDataUser = { id: number; first_name?: string; username?: string };

export function verifyInitData(raw: string, token: string, maxAgeSeconds = 3600): InitDataUser {
  if (!raw || raw.length > 8192) throw Error('缺少 Telegram 登录数据');
  const params = new URLSearchParams(raw);
  const hash = params.get('hash');
  const authDate = Number(params.get('auth_date'));
  if (!hash || !/^[a-f0-9]{64}$/i.test(hash) || !Number.isSafeInteger(authDate)) throw Error('登录数据不完整');
  const now = Math.floor(Date.now() / 1000);
  if (authDate > now + 60 || now - authDate > maxAgeSeconds) throw Error('Telegram 登录已过期');
  if (new Set([...params.keys()]).size !== [...params.keys()].length) throw Error('登录数据包含重复字段');
  const entries = [...params.entries()].filter(([k]) => k !== 'hash').sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0);
  const check = entries.map(([k, v]) => `${k}=${v}`).join('\n');
  const secret = createHmac('sha256', 'WebAppData').update(token).digest();
  const expected = createHmac('sha256', secret).update(check).digest();
  if (!timingSafeEqual(expected, Buffer.from(hash, 'hex'))) throw Error('Telegram 登录签名无效');
  const user = JSON.parse(params.get('user') || 'null') as InitDataUser | null;
  if (!user || !Number.isSafeInteger(user.id) || user.id <= 0) throw Error('Telegram 用户无效');
  return { id: user.id };
}
