-- create-tax-tracker
-- 이 파일은 하나의 트랜잭션으로 실행됩니다.
-- 적용된 뒤에는 수정하지 마세요. 새 마이그레이션을 추가하세요.

--
-- 연말정산 공제 트래커(/tax, docs/year-end-tax.md T2)의 사용자 입력 두 가지.
--
-- ── 왜 필요한가 (CLAUDE.md: "새 컬럼에 저장하는 데이터가 정말 필요한가") ──
--
-- tax_year_settings
--   귀속연도마다 한 행. 사용자가 화면에서 직접 입력한 값만 둔다.
--     annual_salary         연봉(총급여 추정, 원). 공제율 · 자격 구간을 가른다(연금계좌 5,500만,
--                           월세 5,500만 · 8,000만, 청약 7,000만, 카드 문턱 25%).
--     marginal_rate         사용자가 고른 한계세율(%). 엔진은 추정하지 않는다(사용자 결정 2026-11).
--     homeless_householder  무주택 세대주인가. 청약 · 전세대출 · 월세 자격.
--     mortgage_tier         주택담보대출 이자 공제 한도 구간(lib/tax/rules 의 키), 해당 없으면 'none'.
--   NULL 은 "아직 입력 안 함" 이다. 화면은 그 칸을 확인 필요로 보여 준다.
--   새로운 종류의 민감정보는 연봉 하나다. 부양가족 · 세액 · 주민번호는 받지 않는다.
--   연봉은 로그 · 에러 메시지 · API 응답 본문에 싣지 않는다(lib/tax/http.mjs).
--
-- tax_item_tags
--   가계부의 (분류, 항목) 묶음 → 공제 항목. merchant_map 처럼 한 번 고르면 계속 적용된다.
--   'none' 은 "공제 항목이 아니다" 를 기억해서 같은 후보를 다시 묻지 않으려는 값이다.
--   **금액은 저장하지 않는다.** 금액은 요청마다 transactions 에서 다시 합친다(lib/tax/store.mjs).
--   item 은 화면의 항목 이름(lib/classify/item.mjs resolveItem) — 이미 화면에 보이는 값이다.
--   귀속연도와 무관하다(IRP 는 해마다 IRP 다).
--
-- 거래 테이블은 건드리지 않는다. 데이터를 채우는 문장도 없다(운영 DB 에 적용되는 파일이다).

CREATE TABLE tax_year_settings (
  tax_year             SMALLINT    PRIMARY KEY,
  annual_salary        BIGINT      NULL,
  marginal_rate        SMALLINT    NULL,
  homeless_householder BOOLEAN     NULL,
  mortgage_tier        TEXT        NULL,
  updated_at           TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT tax_year_settings_year_range CHECK (tax_year BETWEEN 2020 AND 2100),
  CONSTRAINT tax_year_settings_salary_range
    CHECK (annual_salary IS NULL OR annual_salary BETWEEN 0 AND 10000000000),
  CONSTRAINT tax_year_settings_marginal_rate_valid
    CHECK (marginal_rate IS NULL OR marginal_rate IN (6, 15, 24, 35, 38, 40, 42, 45)),
  CONSTRAINT tax_year_settings_mortgage_tier_valid
    CHECK (mortgage_tier IS NULL OR mortgage_tier IN ('20m', '18m', '8m', '6m', 'none'))
);

COMMENT ON TABLE tax_year_settings IS '공제 트래커의 귀속연도별 사용자 입력. NULL 은 미입력.';
COMMENT ON COLUMN tax_year_settings.annual_salary IS '연봉(총급여 추정, 원). 로그 · 응답 본문에 싣지 않는다.';
COMMENT ON COLUMN tax_year_settings.marginal_rate IS '사용자가 고른 한계세율(%). 추정하지 않는다.';

CREATE TABLE tax_item_tags (
  category   TEXT        NOT NULL,
  item       TEXT        NOT NULL,
  deduction  TEXT        NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (category, item),
  CONSTRAINT tax_item_tags_category_nonempty CHECK (btrim(category) <> ''),
  CONSTRAINT tax_item_tags_item_valid CHECK (btrim(item) <> '' AND char_length(item) <= 200),
  CONSTRAINT tax_item_tags_deduction_valid CHECK (deduction IN (
    'pension_savings', 'irp', 'housing_subscription', 'lease_loan', 'mortgage_interest', 'rent',
    'insurance', 'donation_general', 'donation_political', 'donation_hometown', 'none'
  ))
);

COMMENT ON TABLE tax_item_tags IS '가계부 (분류, 항목) → 공제 항목. none 은 공제 아님. 금액은 저장하지 않는다.';
