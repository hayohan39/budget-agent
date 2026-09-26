// migrations/20260926055220149_merchant-map-direction.sql
//
// 이미 매핑이 저장된 운영 DB 에 적용된다. 그래서 **행이 있는 merchant_map** 에
// 적용해 본다 — 바로 앞 마이그레이션까지만 적용한 스크래치 DB 에 매핑을 넣고,
// 저장소의 러너로 나머지를 적용한다. `TEST_DATABASE_URL` 이 있을 때만 돈다.
import test from 'node:test';
import assert from 'node:assert/strict';

import { runMigrations, withScratchDatabase } from './helpers/scratch-db.mjs';

const MIGRATION = '20260926055220149_merchant-map-direction.sql';

test('방향 마이그레이션: 기존 매핑이 있는 테이블에 깨끗하게 · 멱등으로 적용되고 기존 행은 any 가 된다', async (t) => {
  await withScratchDatabase(
    t,
    'map_direction',
    async (client, url) => {
      // 적용 전: 방향 컬럼이 없고 적요 하나가 기본키다.
      await client.query(
        `INSERT INTO merchant_map (description, category, item) VALUES
           ('김철수', '수입', NULL),
           ('코인적립', '변동비', '코인')`,
      );
      await assert.rejects(() => client.query(`INSERT INTO merchant_map (description, category) VALUES ('김철수', '용돈')`));

      await runMigrations(url);
      // 두 번째 실행은 아무것도 하지 않는다(체크섬이 같다).
      await runMigrations(url);

      const applied = await client.query('SELECT id FROM schema_migrations WHERE id = $1', [MIGRATION]);
      assert.equal(applied.rowCount, 1);

      // 기존 행은 열 기본값으로 any 가 됐다. 다른 값은 그대로다.
      const rows = await client.query(
        'SELECT description, direction, category, item FROM merchant_map ORDER BY description',
      );
      assert.deepEqual(rows.rows, [
        { description: '김철수', direction: 'any', category: '수입', item: null },
        { description: '코인적립', direction: 'any', category: '변동비', item: '코인' },
      ]);

      const column = await client.query(
        `SELECT is_nullable, column_default FROM information_schema.columns
          WHERE table_name = 'merchant_map' AND column_name = 'direction'`,
      );
      assert.equal(column.rows[0].is_nullable, 'NO');
      assert.match(column.rows[0].column_default, /'any'/);

      // 기본키가 (description, direction) 이다.
      const pk = await client.query(
        `SELECT a.attname
           FROM pg_index i
           JOIN pg_attribute a ON a.attrelid = i.indrelid AND a.attnum = ANY(i.indkey)
          WHERE i.indrelid = 'merchant_map'::regclass AND i.indisprimary
          ORDER BY array_position(i.indkey::int2[], a.attnum)`,
      );
      assert.deepEqual(pk.rows.map((row) => row.attname), ['description', 'direction']);

      // 같은 적요에 방향별 매핑이 함께 선다. 같은 (적요, 방향)은 여전히 하나뿐이다.
      await client.query(
        `INSERT INTO merchant_map (description, direction, category) VALUES ('김철수', 'out', '용돈'), ('김철수', 'in', '수입')`,
      );
      await assert.rejects(() =>
        client.query(`INSERT INTO merchant_map (description, direction, category) VALUES ('김철수', 'out', '저축')`),
      );
      await assert.rejects(() =>
        client.query(`INSERT INTO merchant_map (description, direction, category) VALUES ('김철수', 'both', '저축')`),
      );
      await assert.rejects(() =>
        client.query(`INSERT INTO merchant_map (description, direction, category) VALUES ('이영희', NULL, '저축')`),
      );

    },
    { migrationsBefore: MIGRATION },
  );
});
