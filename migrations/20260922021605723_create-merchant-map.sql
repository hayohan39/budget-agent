-- create-merchant-map
-- 이 파일은 하나의 트랜잭션으로 실행됩니다.
-- 적용된 뒤에는 수정하지 마세요. 새 마이그레이션을 추가하세요.

-- 사람이 미분류 건을 한 번 고치면 여기에 남아 다음 달부터 자동 분류된다.
-- 적요(가맹점/상대방 라벨)가 키다. NOT NULL 만으로는 빈 문자열이 통과하므로
-- btrim CHECK 로 빈 키/빈 분류를 막는다.
CREATE TABLE merchant_map (
  description TEXT PRIMARY KEY,
  category    TEXT NOT NULL,
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT merchant_map_description_nonempty CHECK (btrim(description) <> ''),
  CONSTRAINT merchant_map_category_nonempty    CHECK (btrim(category) <> '')
);
