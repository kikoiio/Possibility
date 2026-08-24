// scripts/publish-personas.ts — 把 personas/*/profile.md 发布到 Worker 的 D1
// 用法：
//   pnpm exec tsx scripts/publish-personas.ts [baseUrl]
// 默认 http://localhost:8787（本地 wrangler dev）；远程则传 worker 域名。
// 需要 .dev.vars 里的 ADMIN_TOKEN。

import { readdirSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

function loadAdminToken(): string {
  const raw = readFileSync('.dev.vars', 'utf8');
  for (const line of raw.split('\n')) {
    const i = line.indexOf('=');
    if (i > 0 && line.slice(0, i).trim() === 'ADMIN_TOKEN') return line.slice(i + 1).trim();
  }
  console.error('✗ .dev.vars 里缺少 ADMIN_TOKEN');
  process.exit(1);
}

const baseUrl = (process.argv[2] ?? 'http://localhost:8787').replace(/\/$/, '');
const token = loadAdminToken();

if (!existsSync('personas')) {
  console.error('✗ 没有 personas/ 目录');
  process.exit(1);
}

const ids = readdirSync('personas', { withFileTypes: true })
  .filter((d) => d.isDirectory())
  .map((d) => d.name);

if (ids.length === 0) {
  console.error('✗ personas/ 下没有人格目录');
  process.exit(1);
}

for (const id of ids) {
  const file = join('personas', id, 'profile.md');
  if (!existsSync(file)) {
    console.warn(`⚠ 跳过 ${id}：没有 profile.md`);
    continue;
  }
  const raw = readFileSync(file, 'utf8');
  const res = await fetch(`${baseUrl}/api/admin/profiles/${id}`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'content-type': 'text/plain; charset=utf-8' },
    body: raw,
  });
  if (res.ok) {
    console.log(`✓ ${id} 发布成功`);
  } else {
    const err = await res.text();
    console.error(`✗ ${id} 发布失败（${res.status}）：${err}`);
    process.exitCode = 1;
  }
}
