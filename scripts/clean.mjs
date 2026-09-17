// rm -rf 대신. Windows/Linux 양쪽에서 동일하게 동작한다.
import { rm } from 'node:fs/promises';
import path from 'node:path';

const targets = process.argv.slice(2);
if (targets.length === 0) {
  console.error('usage: node scripts/clean.mjs <dir...>');
  process.exit(1);
}

for (const target of targets) {
  const abs = path.resolve(process.cwd(), target);
  if (!abs.startsWith(process.cwd())) {
    console.error(`프로젝트 밖 경로는 지우지 않습니다: ${target}`);
    process.exit(1);
  }
  await rm(abs, { recursive: true, force: true });
  console.log(`removed ${target}`);
}
