-- create-tax-card-confirmations
-- 이 파일은 하나의 트랜잭션으로 실행됩니다.
-- 적용된 뒤에는 수정하지 마세요. 새 마이그레이션을 추가하세요.

--
-- 공제 트래커의 카드 사용액 확인값(docs/year-end-tax.md 3장 "보정", T3).
--
-- ── 왜 필요한가 (CLAUDE.md: "새 컬럼에 저장하는 데이터가 정말 필요한가") ──
--
-- 카드 공제는 가계부의 카드대금 결제액으로 **추정**한다(결제월을 한 달 앞당겨 사용월로 보고, 전부
-- 신용카드로 친다 — lib/tax/store.mjs). 이 추정은 결제수단(체크 · 전통시장 · 대중교통)을 모르고
-- 관리비처럼 공제되지 않는 결제가 섞여 있다. 사용자가 홈택스 연말정산 미리보기(11월, 1~9월분)나
-- 카드사 앱에서 확인한 **기준월까지의 결제수단별 누계**를 넣으면 그 달까지는 확인값을 쓰고,
-- 그 뒤 달만 추정한다.
--
--   귀속연도마다 한 행. 다섯 금액은 결제수단별 누계(원)이고 through_month 까지의 합이다.
--   PLAN.md 의 "카드 건별 내역은 저장하지 않는다" 원칙과 맞는다 — 가맹점 · 날짜 · 건별 금액은 없고
--   연간 누계 다섯 개뿐이다. 로그 · 에러 메시지 · API 응답 본문에 싣지 않는다(lib/tax/http.mjs).
--
-- 거래 테이블은 건드리지 않는다. 데이터를 채우는 문장도 없다.

CREATE TABLE tax_card_confirmations (
  tax_year      SMALLINT    PRIMARY KEY,
  through_month CHAR(7)     NOT NULL,
  credit        BIGINT      NOT NULL DEFAULT 0,
  debit         BIGINT      NOT NULL DEFAULT 0,
  culture       BIGINT      NOT NULL DEFAULT 0,
  market        BIGINT      NOT NULL DEFAULT 0,
  transit       BIGINT      NOT NULL DEFAULT 0,
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT tax_card_confirmations_year_range CHECK (tax_year BETWEEN 2020 AND 2100),
  -- 기준월은 그 귀속연도 안의 달이어야 한다.
  CONSTRAINT tax_card_confirmations_month_fmt
    CHECK (through_month ~ '^[0-9]{4}-(0[1-9]|1[0-2])$' AND substr(through_month, 1, 4)::int = tax_year),
  CONSTRAINT tax_card_confirmations_amounts_range CHECK (
    credit  BETWEEN 0 AND 100000000000 AND
    debit   BETWEEN 0 AND 100000000000 AND
    culture BETWEEN 0 AND 100000000000 AND
    market  BETWEEN 0 AND 100000000000 AND
    transit BETWEEN 0 AND 100000000000
  )
);

COMMENT ON TABLE tax_card_confirmations IS
  '공제 트래커 카드 사용액 확인값: 기준월까지 결제수단별 누계. 건별 내역은 없다. 로그 · 응답 본문에 싣지 않는다.';
