-- create-description-patterns
-- 이 파일은 하나의 트랜잭션으로 실행됩니다.
-- 적용된 뒤에는 수정하지 마세요. 새 마이그레이션을 추가하세요.

--
-- 사람이 /classify 에서 직접 입력한 **적요 패턴** → (분류, 항목).
--
-- 사용자 요청(2026-09): "매번 패턴이 달라질수 있는게 나올수있기 때문에 저장 시
-- 사용자가 직접 패턴을 입력할 수 있게 하는 게 좋을 것 같아."
-- (예: 흥국01184 · 흥국02184 · 흥국03184 → 흥국##184)
--
-- 패턴은 **정규식이 아니다.** `#` = 숫자 한 자리, `*` = 아무 글자 여러 개(없어도
-- 됨), 나머지는 글자 그대로다. 정규식으로 컴파일하지 않고 lib/classify/wildcard.mjs
-- 의 유계 매처로만 비교한다(ReDoS 없음). 길이 · 와일드카드 수 · 글자 수 검사는
-- 코드가 하고, 여기 CHECK 는 마지막 방어선이다(길이 · 빈 값).
--
-- 분류기 순서(lib/classify/engine.mjs): merchant_map 정확한 키 → 월 토큰을 지운 키
-- → **이 테이블** → category_rules → 미분류.
--
-- 적요 원문을 따로 저장하지 않는다. 저장하는 것은 사람이 입력한 패턴 문자열뿐이다.
-- item 제약은 merchant_map.item 과 같다.
CREATE TABLE description_patterns (
  id          SERIAL PRIMARY KEY,
  pattern     TEXT        NOT NULL
    CONSTRAINT description_patterns_pattern_valid
    CHECK (btrim(pattern) <> '' AND char_length(pattern) <= 64),
  direction   TEXT        NOT NULL
    CONSTRAINT description_patterns_direction_valid
    CHECK (direction IN ('in', 'out', 'any')),
  category    TEXT        NOT NULL,
  item        TEXT        NULL
    CONSTRAINT description_patterns_item_valid
    CHECK (item IS NULL OR (btrim(item) <> '' AND char_length(item) <= 40)),
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT description_patterns_pattern_direction_key UNIQUE (pattern, direction)
);

COMMENT ON TABLE description_patterns IS '사람이 입력한 적요 패턴(# = 숫자 한 자리, * = 아무 글자). 정규식이 아니다.';
COMMENT ON COLUMN description_patterns.direction IS 'in | out | any. 방향이 맞는 패턴이 any 보다 먼저다.';
