-- create-tax-pattern-tags-and-manual-entries
-- 이 파일은 하나의 트랜잭션으로 실행됩니다.
-- 적용된 뒤에는 수정하지 마세요. 새 마이그레이션을 추가하세요.

--
-- 공제 트래커(/tax)에 두 가지를 더한다(사용자 요청 2026-11).
--
-- ── tax_pattern_tags ───────────────────────────────────────────────────────
--
-- "가계부 작성시 패턴화되어 묶인 항목도 연말정산 정리시 동일한 기준으로 분류되었으면 함."
--
-- 가계부의 적요 · 메모 패턴(description_patterns · memo_patterns, 예: `길동 IRP ##회`)은 항목 이름 없이
-- 저장할 수 있다. 그러면 거래마다 적요가 달라(01회 · 02회 …) 트래커의 (분류, 항목) 연결(tax_item_tags)은
-- 달마다 새 묶음을 다시 연결해야 한다. 그래서 **패턴 자체**를 공제 항목에 연결한다.
-- 키는 가계부 패턴과 같은 (기준, 방향, 패턴) 이고, 매칭도 같은 함수(lib/classify/wildcard.mjs)를 쓴다.
-- 가계부 패턴을 지워도 이 연결은 저장된 패턴 문자열로 계속 맞춘다(화면에서 해제할 수 있다).
-- 'none' 은 "후보에서 제외" — 이 패턴에 맞는 거래를 후보 목록에 다시 올리지 않는다.
-- 금액은 저장하지 않는다. 패턴 문자열은 가계부 패턴과 같은 종류의 값이다(로그 · 응답 본문에 싣지 않는다).
--
-- ── tax_manual_entries ─────────────────────────────────────────────────────
--
-- "가계부에는 안 잡히지만 별도로 연금저축 들고 있는 게 있음."
--
-- 가계부 계좌 밖에서 내는 공제 대상 금액을 사람이 직접 적는다. 귀속연도 · 공제 항목 · 짧은 이름 ·
-- 올해 누계 금액뿐이다(계좌번호 · 기관 원문 · 건별 내역은 받지 않는다). 이름은 사용자가 붙이는
-- 짧은 별칭(40자)이다. 로그 · 에러 메시지 · API 응답 본문에 싣지 않는다(lib/tax/http.mjs).
--
-- 거래 테이블은 건드리지 않는다. 데이터를 채우는 문장도 없다.

CREATE TABLE tax_pattern_tags (
  basis      TEXT        NOT NULL,
  direction  TEXT        NOT NULL,
  pattern    TEXT        NOT NULL,
  deduction  TEXT        NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (basis, direction, pattern),
  CONSTRAINT tax_pattern_tags_basis_valid CHECK (basis IN ('description', 'memo')),
  CONSTRAINT tax_pattern_tags_direction_valid CHECK (direction IN ('in', 'out', 'any')),
  -- description_patterns.pattern 과 같은 상한(64자).
  CONSTRAINT tax_pattern_tags_pattern_valid CHECK (btrim(pattern) <> '' AND char_length(pattern) <= 64),
  CONSTRAINT tax_pattern_tags_deduction_valid CHECK (deduction IN (
    'pension_savings', 'irp', 'housing_subscription', 'lease_loan', 'mortgage_interest', 'rent',
    'insurance', 'donation_general', 'donation_political', 'donation_hometown', 'none'
  ))
);

COMMENT ON TABLE tax_pattern_tags IS '가계부 패턴(기준 · 방향 · 패턴) → 공제 항목. none 은 후보에서 제외. 금액은 저장하지 않는다.';

CREATE TABLE tax_manual_entries (
  id         BIGSERIAL   PRIMARY KEY,
  tax_year   SMALLINT    NOT NULL,
  deduction  TEXT        NOT NULL,
  label      TEXT        NOT NULL,
  amount     BIGINT      NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT tax_manual_entries_year_range CHECK (tax_year BETWEEN 2020 AND 2100),
  CONSTRAINT tax_manual_entries_deduction_valid CHECK (deduction IN (
    'pension_savings', 'irp', 'housing_subscription', 'lease_loan', 'mortgage_interest', 'rent',
    'insurance', 'donation_general', 'donation_political', 'donation_hometown'
  )),
  CONSTRAINT tax_manual_entries_label_valid CHECK (btrim(label) <> '' AND char_length(label) <= 40),
  CONSTRAINT tax_manual_entries_amount_range CHECK (amount BETWEEN 0 AND 100000000000)
);

COMMENT ON TABLE tax_manual_entries IS
  '가계부 밖 공제 대상 금액(사용자 직접 입력, 올해 누계). 로그 · 응답 본문에 싣지 않는다.';

CREATE INDEX tax_manual_entries_year_idx ON tax_manual_entries (tax_year);
