-- create-accounts
-- 이 파일은 하나의 트랜잭션으로 실행됩니다.
-- 적용된 뒤에는 수정하지 마세요. 새 마이그레이션을 추가하세요.

-- 계좌 3개(메인/고정비/비상금)만 들어간다.
-- 토스뱅크가 계좌번호를 이미 마스킹해서 주므로 뒤 4자리만 저장한다.
-- 전체 계좌번호는 다루지 않으므로 여기에는 해시조차 두지 않는다.
CREATE TABLE accounts (
  id         SMALLSERIAL PRIMARY KEY,
  nickname   TEXT    NOT NULL UNIQUE,  -- '메인' | '고정비' | '비상금'
  role       TEXT    NOT NULL UNIQUE,  -- 역할별로 정확히 하나씩만 존재한다
  last4      CHAR(4) NOT NULL UNIQUE,  -- 계좌 식별 키
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT accounts_role_valid CHECK (role IN ('main','fixed','emergency')),
  CONSTRAINT accounts_last4_digits CHECK (last4 ~ '^[0-9]{4}$')
);

COMMENT ON COLUMN accounts.last4 IS '계좌번호 뒤 4자리. 계좌 식별 키. 전체 계좌번호는 저장하지 않는다.';
