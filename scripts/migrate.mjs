// 최소한의 Postgres 마이그레이션 러너.
//
//   node scripts/migrate.mjs            적용되지 않은 마이그레이션을 실행
//   node scripts/migrate.mjs status     대기 중인 것만 보여주고 아무것도 실행하지 않음
//   node scripts/migrate.mjs new <이름>  타임스탬프가 붙은 빈 .sql 파일 생성
//
// migrations/*.sql 을 파일명 순서대로 적용하고, 적용 내역을 schema_migrations 에
// 기록한다. 각 마이그레이션은 하나의 트랜잭션으로 실행되므로 중간에 실패하면
// 그 파일의 변경은 전부 되돌아간다.
import { readdir, readFile, writeFile, mkdir } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';
import process from 'node:process';

const MIGRATIONS_DIR = path.join(process.cwd(), 'migrations');
// 같은 순간에 두 배포가 겹쳐도 한 쪽만 적용하도록 잡는 자문 잠금 키.
const LOCK_KEY = 8_927_413_550_117n;

const sha256 = (text) => createHash('sha256').update(text).digest('hex').slice(0, 16);

async function listMigrations() {
  let entries;
  try {
    entries = await readdir(MIGRATIONS_DIR);
  } catch (error) {
    if (error.code === 'ENOENT') return [];
    throw error;
  }
  return entries.filter((name) => name.endsWith('.sql')).sort();
}

async function createMigration(name) {
  if (!name) throw new Error('이름이 필요합니다: node scripts/migrate.mjs new <이름>');
  const slug = name.trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
  if (!slug) throw new Error(`이름에 쓸 수 있는 문자가 없습니다: "${name}"`);

  // 파일명 순서가 곧 적용 순서다. 초 단위로만 찍으면 같은 초에 만든 두 파일이
  // 같은 접두사를 받아 이름순으로 밀리면서 생성 순서와 다르게 적용된다.
  // 밀리초까지 쓰고, 그래도 겹치면 기존 최대값 다음으로 밀어 단조 증가를 보장한다.
  let stamp = new Date().toISOString().replace(/[-:T.Z]/g, '').slice(0, 17);
  const existing = await listMigrations();
  const highest = existing.map((name) => name.split('_')[0]).sort().at(-1);
  if (highest && highest >= stamp) {
    stamp = (BigInt(highest) + 1n).toString();
  }

  const file = path.join(MIGRATIONS_DIR, `${stamp}_${slug}.sql`);
  await mkdir(MIGRATIONS_DIR, { recursive: true });
  await writeFile(
    file,
    `-- ${slug}\n-- 이 파일은 하나의 트랜잭션으로 실행됩니다.\n-- 적용된 뒤에는 수정하지 마세요. 새 마이그레이션을 추가하세요.\n\n`,
  );
  console.log(`생성됨: ${path.relative(process.cwd(), file)}`);
}

async function connect() {
  // pg 는 여기서만 필요하다. 최상위에서 import 하면 DB 가 필요 없는
  // `migrate.mjs new` 조차 의존성 없이는 못 돌아간다.
  const { default: pg } = await import('pg');
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) {
    throw new Error('DATABASE_URL 이 설정되지 않았습니다.');
  }
  const client = new pg.Client({ connectionString });
  await client.connect();
  return client;
}

async function run({ dryRun }) {
  const files = await listMigrations();
  if (files.length === 0) {
    console.log('마이그레이션 파일이 없습니다.');
    return;
  }

  const client = await connect();
  try {
    await client.query(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        id         text PRIMARY KEY,
        checksum   text NOT NULL,
        applied_at timestamptz NOT NULL DEFAULT now()
      )
    `);
    await client.query('SELECT pg_advisory_lock($1)', [LOCK_KEY.toString()]);

    const { rows } = await client.query('SELECT id, checksum FROM schema_migrations');
    const applied = new Map(rows.map((row) => [row.id, row.checksum]));

    const pending = [];
    for (const file of files) {
      const sql = await readFile(path.join(MIGRATIONS_DIR, file), 'utf8');
      const checksum = sha256(sql);
      const previous = applied.get(file);

      if (previous === undefined) {
        pending.push({ file, sql, checksum });
      } else if (previous !== checksum) {
        // 이미 적용된 파일이 바뀌었다. 조용히 넘어가면 환경마다 스키마가 갈라진다.
        throw new Error(
          `이미 적용된 마이그레이션이 수정되었습니다: ${file}\n` +
            '되돌리거나, 변경 사항을 새 마이그레이션으로 추가하세요.',
        );
      }
    }

    if (pending.length === 0) {
      console.log(`최신 상태입니다 (적용됨 ${applied.size}개).`);
      return;
    }

    console.log(`대기 중 ${pending.length}개:`);
    for (const { file } of pending) console.log(`  - ${file}`);
    if (dryRun) return;

    for (const { file, sql, checksum } of pending) {
      process.stdout.write(`적용 중 ${file} ... `);
      try {
        await client.query('BEGIN');
        await client.query(sql);
        await client.query(
          'INSERT INTO schema_migrations (id, checksum) VALUES ($1, $2)',
          [file, checksum],
        );
        await client.query('COMMIT');
        console.log('완료');
      } catch (error) {
        await client.query('ROLLBACK');
        throw new Error(`${file} 실패 — 이 파일의 변경은 되돌려졌습니다.\n${error.message}`);
      }
    }
    console.log(`${pending.length}개 적용 완료.`);
  } finally {
    try {
      await client.query('SELECT pg_advisory_unlock($1)', [LOCK_KEY.toString()]);
    } catch {
      // 연결이 이미 끊긴 경우. 잠금은 세션 종료와 함께 풀린다.
    }
    await client.end();
  }
}

const [command, ...rest] = process.argv.slice(2);
try {
  if (command === 'new') await createMigration(rest.join(' '));
  else if (command === 'status') await run({ dryRun: true });
  else if (!command) await run({ dryRun: false });
  else throw new Error(`알 수 없는 명령: ${command}`);
} catch (error) {
  console.error(`\n${error.message}`);
  process.exitCode = 1;
}
