-- create-adjustments
-- 이 파일은 하나의 트랜잭션으로 실행됩니다.
-- 적용된 뒤에는 수정하지 마세요. 새 마이그레이션을 추가하세요.

-- 수동 보정 항목. 실거래로 설명되지 않는 차액을 사람이 사유와 함께 적는다.
--
-- reason 은 NOT NULL 만으로는 빈 문자열('' 또는 공백)을 허용한다. 사유 없는
-- 보정을 막는 것이 이 테이블의 존재 이유이므로 btrim(reason) <> '' CHECK 로
-- 실제로 강제한다.
-- 이자는 보정이 아니다. `거래 유형 = 이자입금` 으로 실거래에 잡힌다.
CREATE TABLE adjustments (
  id         BIGSERIAL PRIMARY KEY,
  year_month CHAR(7) NOT NULL,
  target     TEXT    NOT NULL,
  amount     BIGINT  NOT NULL,
  reason     TEXT    NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT adjustments_year_month_fmt CHECK (year_month ~ '^[0-9]{4}-[0-9]{2}$'),
  CONSTRAINT adjustments_reason_nonempty CHECK (btrim(reason) <> ''),
  CONSTRAINT adjustments_amount_nonzero  CHECK (amount <> 0),
  CONSTRAINT adjustments_target_valid CHECK (target IN ('수입','저축','용돈','주거비','고정비','비상금','변동비'))
);

COMMENT ON COLUMN adjustments.reason IS '필수. 사유 없는 보정은 입력할 수 없다(btrim CHECK).';

CREATE INDEX adjustments_year_month_idx ON adjustments (year_month);
