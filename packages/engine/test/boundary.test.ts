import test from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const SRC = fileURLToPath(new URL('../src', import.meta.url));

test('引擎边界：只允许 ./ 相对导入 + zod（禁止 TG/DB/网络/传输）', () => {
  const files = readdirSync(SRC).filter(f => f.endsWith('.ts'));
  assert.ok(files.length > 0, 'engine src 不应为空');
  const re = /from\s+['"]([^'"]+)['"]/g;
  for (const f of files) {
    const src = readFileSync(join(SRC, f), 'utf8');
    let m: RegExpExecArray | null;
    while ((m = re.exec(src)) !== null) {
      const spec = m[1];
      const ok = spec.startsWith('./') || spec === 'zod';
      assert.ok(ok, `${f} 非法依赖 '${spec}'（引擎只允许 ./ 相对导入 + zod）`);
    }
  }
});
