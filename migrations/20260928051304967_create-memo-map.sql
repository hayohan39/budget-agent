-- create-memo-map
-- 이 파일은 하나의 트랜잭션으로 실행됩니다.
-- 적용된 뒤에는 수정하지 마세요. 새 마이그레이션을 추가하세요.

--
-- 사람이 /classify 에서 **메모 기준으로** 고른 "앞으로도" 매핑: (메모, 방향) → (분류, 항목).
--
-- 사용자 요청(2026-09): "현재 엑셀파일에서 적요 뿐만 아니라 메모도 중요한 정보야 …
-- 7월의 경우 저축에 대한 항목명들이 적요가 아닌 메모로 적혀 있어 … 적요와 메모까지 함께
-- 검토해서 항목을 분류하는 분류기 개선이 필요해."
--
-- ── 왜 새 테이블인가 (CLAUDE.md: "새 컬럼에 저장하는 데이터가 정말 필요한가") ──
--
-- 메모 자체는 이미 transactions.memo 에 저장돼 있다(최초 스키마부터). 여기 새로 저장하는
-- 것은 **사람이 "이 메모면 앞으로도 이 분류"라고 고른 메모 문자열 하나**와 분류 · 항목 ·
-- 방향뿐이다 — merchant_map 이 적요 문자열을 키로 두는 것과 같은 종류 · 같은 양의 값이다.
-- 금액 · 날짜 · 계좌 · 거래 id 는 담지 않는다. 메모는 사용자가 직접 적은 글이라 적요와
-- 똑같이 다룬다: 로그 · CI · 에러 메시지 · API 에러 본문에 싣지 않는다.
--
-- merchant_map 에 `basis` 열을 더해 기본키를 또 바꾸는 대신 테이블을 나눴다. 두 키는
-- 조회 순서가 다르고(lib/classify/engine.mjs), 적요 매핑의 기존 행 · 잠금 · 수정 경로를
-- 전혀 건드리지 않아도 된다.
--
-- 분류기 순서(lib/classify/engine.mjs): **이 테이블(메모)** → merchant_map 정확한 적요 →
-- 월 토큰을 지운 적요 → description_patterns → category_rules(적요 또는 메모) → 미분류.
--
-- 방향은 in · out 만 받는다(화면은 늘 묶음의 방향으로 저장한다 — 방향 구분 전의 'any'
-- 같은 옛 값이 이 테이블에는 없다).
--
-- 메모 길이 상한 256 은 /classify 의 묶음 키 상한(lib/classify/manual.mjs MAX_KEY_LENGTH)과
-- 같다. item 제약은 merchant_map.item 과 같다.
CREATE TABLE memo_map (
  memo        TEXT        NOT NULL
    CONSTRAINT memo_map_memo_valid
    CHECK (btrim(memo) <> '' AND char_length(memo) <= 256),
  direction   TEXT        NOT NULL
    CONSTRAINT memo_map_direction_valid
    CHECK (direction IN ('in', 'out')),
  category    TEXT        NOT NULL
    CONSTRAINT memo_map_category_nonempty
    CHECK (btrim(category) <> ''),
  item        TEXT        NULL
    CONSTRAINT memo_map_item_valid
    CHECK (item IS NULL OR (btrim(item) <> '' AND char_length(item) <= 40)),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT memo_map_pkey PRIMARY KEY (memo, direction)
);

COMMENT ON TABLE memo_map IS '사람이 메모 기준으로 고른 "앞으로도" 매핑. 분류기에서 적요 매핑보다 먼저 걸린다.';
COMMENT ON COLUMN memo_map.memo IS '정규화한 메모(transactions.memo 와 같은 정규화). 사용자가 적은 글이라 로그에 싣지 않는다.';
