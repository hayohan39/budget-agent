-- create-voided-pairs
-- 이 파일은 하나의 트랜잭션으로 실행됩니다.
-- 적용된 뒤에는 수정하지 마세요. 새 마이그레이션을 추가하세요.

--
-- 사람이 **무효(상쇄)** 로 표시한 출금 · 입금 한 쌍.
--
-- 사용자 요청(2026-09): "지현 IRP, 선용 IRP 의 경우 출금되었다가 거부되어서 다시 입금되는
-- 경우가 있는데 이때 중복으로 수입에 잡히는 것 같아. 보통은 입출금 항목 모두 독립적으로
-- 동작해야하는게 맞지만 이 경우에는 입출금 무효화 하고 싶어. 예외처리할 수 있는 기능도
-- 추가해줘."
--
-- 무효로 표시한 두 거래는 현금흐름표의 수입 · 지출 · 미분류 · 계좌 블록 · 통계에서 빠지고
-- (lib/report/monthly.mjs), /report 의 '무효 처리' 목록에서 보이며 언제든 해제할 수 있다.
-- 거래 행 자체는 그대로다 — 잔액 검산은 두 거래를 여전히 본다.
--
-- ── 왜 새 테이블인가 (CLAUDE.md: "새 컬럼에 저장하는 데이터가 정말 필요한가") ──
--
-- 저장하는 것은 **거래 id 두 개와 만든 시각**뿐이다. 금액 · 적요 · 날짜 · 계좌는 담지
-- 않는다(이미 transactions 에 있고, 짝을 지을 때 서버가 거기서 다시 읽어 검사한다).
-- transactions 에 열을 더하지 않아 기존 행 · 업로드 · dedupe 경로를 건드리지 않고,
-- 해제는 이 테이블의 행 하나를 지우는 것으로 끝난다.
--
-- ── 제약 ──────────────────────────────────────────────────────────────────
--
-- 한 거래는 많아야 한 쌍에만 든다: 출금 쪽 · 입금 쪽 id 가 각각 UNIQUE 이고, 출금 쪽은
-- 늘 금액 < 0, 입금 쪽은 늘 금액 > 0 인 거래라서(코드가 검사한다) 한 거래가 한 쌍의 출금
-- 쪽이면서 다른 쌍의 입금 쪽일 수 없다. 같은 계좌 · 금액 크기 같음 · 방향 반대는 코드가
-- 행을 잠근 뒤 검사한다(lib/report/voids.mjs). 거래가 지워지면 쌍도 함께 지워진다.
CREATE TABLE voided_pairs (
  id           SERIAL      PRIMARY KEY,
  out_txn_id   BIGINT      NOT NULL REFERENCES transactions(id) ON DELETE CASCADE,
  in_txn_id    BIGINT      NOT NULL REFERENCES transactions(id) ON DELETE CASCADE,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT voided_pairs_out_key UNIQUE (out_txn_id),
  CONSTRAINT voided_pairs_in_key UNIQUE (in_txn_id),
  CONSTRAINT voided_pairs_distinct CHECK (out_txn_id <> in_txn_id)
);

COMMENT ON TABLE voided_pairs IS '사람이 무효(상쇄)로 표시한 출금 · 입금 한 쌍. 현금흐름표 · 통계 · 미분류에서 빠진다. 거래 id 만 담는다.';
