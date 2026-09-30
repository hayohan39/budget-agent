-- create-memo-patterns
-- 이 파일은 하나의 트랜잭션으로 실행됩니다.
-- 적용된 뒤에는 수정하지 마세요. 새 마이그레이션을 추가하세요.


--
-- 사람이 /classify(또는 /report 의 미분류 섹션)에서 **메모 기준으로** 입력한 패턴 → (분류, 항목).
--
-- 사용자 요청(2026-09): "앞으로도 선택시 메모 기준도 마찬가지로 '패턴으로 저장' 기능 추가해줘."
-- (예: 메모가 `길동 IRP 01회` · `길동 IRP 02회` … → `길동 IRP ##회`)
--
-- 문법 · 검사 · 매처는 description_patterns 와 같다(lib/classify/wildcard.mjs — 정규식이
-- 아니다, ReDoS 없음). 다른 것은 **비교 대상이 적요가 아니라 메모**라는 점뿐이다.
--
-- ── 왜 새 테이블인가 (CLAUDE.md: "새 컬럼에 저장하는 데이터가 정말 필요한가") ──
--
-- 메모 자체는 이미 transactions.memo 에 있다. 새로 저장하는 것은 사람이 입력한 패턴 문자열
-- 하나와 방향 · 분류 · 항목뿐이다 — description_patterns 와 같은 종류 · 같은 양의 값이다.
-- 금액 · 날짜 · 계좌 · 거래 id 는 담지 않는다. 메모 패턴은 사용자가 적은 글에서 온 값이라
-- 메모와 똑같이 다룬다: 로그 · CI · 에러 메시지 · API 에러 본문에 싣지 않는다.
--
-- description_patterns 에 `basis` 열을 더해 유니크 키를 바꾸는 대신 테이블을 나눴다
-- (memo_map 이 merchant_map 과 나뉜 것과 같은 이유). 적요 패턴의 기존 행 · 키 · 쿼리를 전혀
-- 건드리지 않으므로, 메모 패턴이 적요에 걸리거나 적요 패턴의 수정 · 삭제가 메모 패턴을
-- 건드리는 일이 구조적으로 없다.
--
-- 분류기 순서(lib/classify/engine.mjs): memo_map → merchant_map 정확한 적요 → 월 토큰을 지운
-- 적요 → **이 테이블(메모 패턴)** → description_patterns → category_rules → 미분류.
-- 정확한 값이 패턴보다 세고(기준과 무관하게), 같은 단계 안에서는 메모가 적요보다 먼저다
-- (memo_map 이 merchant_map 보다 먼저인 것과 같다).
--
-- 방향은 in · out 만 받는다(화면은 늘 묶음의 방향으로 저장한다 — memo_map 과 같다).
-- 길이 · item 제약은 description_patterns 와 같다.
CREATE TABLE memo_patterns (
  id          SERIAL PRIMARY KEY,
  pattern     TEXT        NOT NULL
    CONSTRAINT memo_patterns_pattern_valid
    CHECK (btrim(pattern) <> '' AND char_length(pattern) <= 64),
  direction   TEXT        NOT NULL
    CONSTRAINT memo_patterns_direction_valid
    CHECK (direction IN ('in', 'out')),
  category    TEXT        NOT NULL
    CONSTRAINT memo_patterns_category_nonempty
    CHECK (btrim(category) <> ''),
  item        TEXT        NULL
    CONSTRAINT memo_patterns_item_valid
    CHECK (item IS NULL OR (btrim(item) <> '' AND char_length(item) <= 40)),
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT memo_patterns_pattern_direction_key UNIQUE (pattern, direction)
);

COMMENT ON TABLE memo_patterns IS '사람이 입력한 메모 패턴(# = 숫자 한 자리, * = 아무 글자). 정규식이 아니다. 적요가 아니라 메모에 건다.';
COMMENT ON COLUMN memo_patterns.pattern IS '사용자가 적은 메모에서 만든 값이라 로그에 싣지 않는다.';
