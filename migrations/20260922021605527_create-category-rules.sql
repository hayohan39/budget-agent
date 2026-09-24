-- create-category-rules
-- 이 파일은 하나의 트랜잭션으로 실행됩니다.
-- 적용된 뒤에는 수정하지 마세요. 새 마이그레이션을 추가하세요.

-- 규칙 기반 분류기가 읽는 테이블. LLM 을 쓰지 않는다.
-- 우선순위: merchant_map -> category_rules(priority, id) -> 미분류
CREATE TABLE category_rules (
  id        SERIAL  PRIMARY KEY,
  txn_type  TEXT,              -- NULL 이면 모든 거래 유형에 적용
  pattern   TEXT    NOT NULL,  -- 적요 정규식
  sign      SMALLINT,          -- -1 출금만 / 1 입금만 / NULL 부호 무관
  category  TEXT    NOT NULL,
  priority  INT     NOT NULL DEFAULT 100,  -- 작은 값이 먼저. 구체적인 규칙이 이긴다
  CONSTRAINT category_rules_sign_valid CHECK (sign IS NULL OR sign IN (-1, 1)),
  CONSTRAINT category_rules_pattern_nonempty CHECK (btrim(pattern) <> '')
);

CREATE INDEX category_rules_priority_idx ON category_rules (priority, id);
