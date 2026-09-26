-- add-item-and-category-source
-- 이 파일은 하나의 트랜잭션으로 실행됩니다.
-- 적용된 뒤에는 수정하지 마세요. 새 마이그레이션을 추가하세요.

-- 월별 현금흐름표에 **항목** 줄(저축 → ISA · IRP …)을 세우고, 사람이 고른 분류가
-- 규칙에 덮이지 않게 **분류 출처**를 남긴다. 컬럼 세 개를 더할 뿐이다.
--
-- ── 컬럼마다 왜 필요한가 (CLAUDE.md: "새 컬럼에 저장하는 데이터가 정말 필요한가") ──
--
-- transactions.item
--   사람이 /classify 에서 고른 항목 이름. 비어 있으면(NULL) 화면이 적요에서 다시
--   계산한다(카드대금이면 카드사, 그 밖에는 정규화한 적요 그대로 —
--   lib/classify/item.mjs). 즉 **사람이 직접 고른 경우에만** 값이 생긴다.
--   값은 이미 `description` 에 저장된 적요이거나 사용자가 붙인 짧은 이름이라
--   새로운 종류의 개인정보를 들이지 않는다.
--
-- transactions.category_source
--   이 행의 category 가 어디서 왔는가: 'rule' | 'map' | 'manual'.
--   "이번만" 고른 값(manual)을 나중의 매핑 · 규칙 실행이 덮지 않게 하는 유일한
--   근거이고, 매핑을 지웠을 때 그 매핑이 채운 행(map)만 골라 되돌리는 근거다.
--   NULL 은 이 컬럼이 생기기 전에 저장된 행이며 코드에서 'rule' 로 취급한다.
--   **데이터를 채우는 UPDATE 는 여기 두지 않는다**(운영 DB 에 적용되는 파일이다).
--
-- merchant_map.item
--   "앞으로도" 고른 항목 이름. 다음 업로드에서 같은 적요가 들어오면 분류와 함께
--   이 항목이 붙는다. NULL 이면 위와 같이 적요에서 계산한다.
--
-- ── 잠금 ──────────────────────────────────────────────────────────────────
--
-- DEFAULT 없는 NULL 컬럼 추가는 테이블을 다시 쓰지 않는 메타데이터 변경이다.
-- CHECK 는 기존 행을 한 번 훑지만 새 컬럼이라 전부 NULL 이고, 개인 가계부라
-- 행 수가 수천 건 수준이다. 그래도 다른 쿼리 뒤에서 ACCESS EXCLUSIVE 잠금을
-- 기다리며 뒤따르는 요청을 줄줄이 막지 않도록 잠금 대기 시간을 짧게 묶는다.
-- 못 잡으면 이 파일이 실패하고 배포가 멈춘다(그대로 재시도하면 된다).
--
-- 인덱스는 만들지 않는다. 같은 적요로 행을 찾는 쓰기는 사람이 버튼을 누를 때만
-- 일어나고 테이블이 작다. 필요해지면 CONCURRENTLY 로 별도 파일에서 만든다.
SET LOCAL lock_timeout = '5s';

ALTER TABLE transactions
  ADD COLUMN item TEXT NULL
    CONSTRAINT transactions_item_valid
    CHECK (item IS NULL OR (btrim(item) <> '' AND char_length(item) <= 40)),
  ADD COLUMN category_source TEXT NULL
    CONSTRAINT transactions_category_source_valid
    CHECK (category_source IS NULL OR category_source IN ('rule', 'map', 'manual'));

ALTER TABLE merchant_map
  ADD COLUMN item TEXT NULL
    CONSTRAINT merchant_map_item_valid
    CHECK (item IS NULL OR (btrim(item) <> '' AND char_length(item) <= 40));

COMMENT ON COLUMN transactions.item IS '사람이 고른 항목 이름. NULL 이면 적요(카드대금은 카드사)에서 계산한다.';
COMMENT ON COLUMN transactions.category_source IS '분류 출처: rule | map | manual. NULL 은 rule 로 본다. manual 은 매핑·규칙이 덮지 않는다.';
COMMENT ON COLUMN merchant_map.item IS '앞으로 이 적요에 붙일 항목 이름. NULL 이면 적요에서 계산한다.';
