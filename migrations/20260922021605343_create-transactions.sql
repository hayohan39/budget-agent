-- create-transactions
-- 이 파일은 하나의 트랜잭션으로 실행됩니다.
-- 적용된 뒤에는 수정하지 마세요. 새 마이그레이션을 추가하세요.

-- 토스뱅크 거래내역의 행 하나가 여기 한 행이 된다.
--
-- txn_at: 원본 `거래 일시` 는 `YYYY.MM.DD HH:mm:ss` 로 타임존이 없는 한국 현지
--   시각이다. 저장할 때 +09:00 오프셋을 명시해 TIMESTAMPTZ 로 넣는다. 오프셋을
--   붙이지 않고 UTC 로 해석하면 KST 09:00 이전 거래가 전날(월초라면 전월)로
--   밀려 year_month 와 어긋난다.
-- year_month: KST 기준 날짜에서 파생한다(`txn_at AT TIME ZONE 'Asia/Seoul'`).
--   서버 타임존에 의존하지 않도록 파생값을 따로 저장한다.
-- amount: 단일 부호 컬럼. 출금이 음수, 입금이 양수다.
-- API/파일 원본을 그대로 담는 컬럼은 두지 않는다. 저장하지 않은 데이터는 유출될 수 없다.
CREATE TABLE transactions (
  id            BIGSERIAL PRIMARY KEY,
  account_id    SMALLINT NOT NULL REFERENCES accounts(id),
  txn_at        TIMESTAMPTZ NOT NULL,
  description   TEXT   NOT NULL,   -- 적요
  txn_type      TEXT   NOT NULL,   -- 거래 유형
  institution   TEXT,              -- 거래 기관
  cp_acct_hash  TEXT,
  amount        BIGINT NOT NULL,   -- 부호 포함
  balance       BIGINT,            -- 거래 후 잔액
  memo          TEXT,
  category      TEXT,
  is_transfer   BOOLEAN NOT NULL DEFAULT FALSE,  -- 내 계좌 간 이동 라벨. 집계 제외 플래그가 아니다
  dedupe_key    TEXT   NOT NULL UNIQUE,
  year_month    CHAR(7) NOT NULL,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT transactions_year_month_fmt CHECK (year_month ~ '^[0-9]{4}-[0-9]{2}$')
);

COMMENT ON COLUMN transactions.cp_acct_hash IS '상대방 계좌번호의 salt 해시. 원본 `계좌번호` 컬럼은 평문이므로 원문을 절대 저장하지 않는다.';
COMMENT ON COLUMN transactions.txn_at IS '거래 일시. 원본은 타임존 없는 KST 현지 시각이며 +09:00 오프셋을 명시해 저장한다.';
COMMENT ON COLUMN transactions.year_month IS 'KST 기준 날짜에서 파생한 YYYY-MM. UTC 로 해석하면 월초 거래가 전월로 밀린다.';

CREATE INDEX transactions_year_month_idx   ON transactions (year_month);
CREATE INDEX transactions_account_txn_idx  ON transactions (account_id, txn_at DESC);
-- 미분류 건만 훑는 부분 인덱스. 분류 작업 큐 조회용.
CREATE INDEX transactions_unclassified_idx ON transactions (year_month) WHERE category IS NULL;
