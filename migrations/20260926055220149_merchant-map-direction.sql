-- merchant-map-direction
-- 이 파일은 하나의 트랜잭션으로 실행됩니다.
-- 적용된 뒤에는 수정하지 마세요. 새 마이그레이션을 추가하세요.

-- 매핑(merchant_map)을 **입금 · 출금으로 나눈다.** 같은 적요라도 들어온 돈과
-- 나간 돈은 용도가 달라서(예: 같은 사람에게 받은 돈 · 보낸 돈), 적요 하나에
-- 분류 하나를 거는 지금의 키로는 한쪽을 고르면 다른 쪽이 따라 바뀐다.
--
-- ── 컬럼이 왜 필요한가 (CLAUDE.md: "새 컬럼에 저장하는 데이터가 정말 필요한가") ──
--
-- merchant_map.direction
--   'in' | 'out' | 'any'. 이 매핑이 어느 방향의 거래에 걸리는가. 금액 · 날짜 ·
--   계좌를 담지 않는다 — 방향 하나뿐이다. 새로운 종류의 개인정보를 들이지 않는다.
--   'any' 는 이 파일 이전에 저장된 매핑의 뜻(양쪽 방향)을 그대로 보존하는 값이다.
--   /classify 는 앞으로 늘 'in' 또는 'out' 으로만 저장한다(lib/classify/direction.mjs).
--
-- ── 기존 행 ────────────────────────────────────────────────────────────────
--
-- 기존 행은 **열 기본값으로** 'any' 가 된다. 데이터를 채우는 UPDATE 는 두지
-- 않는다(운영 DB 에 적용되는 파일이다). 상수 기본값을 가진 NOT NULL 열 추가는
-- Postgres 11+ 에서 테이블을 다시 쓰지 않는 메타데이터 변경이다.
--
-- ── 기본키 교체 ────────────────────────────────────────────────────────────
--
-- 기본키를 (description) 에서 (description, direction) 으로 바꾼다. 기존 키는
-- description 하나로 이미 유일했고 모든 행의 direction 이 같은 'any' 이므로
-- (description, direction) 도 반드시 유일하다 — 행이 있는 테이블에서도 새
-- 기본키 생성이 중복으로 실패할 수 없다. 두 열 모두 NOT NULL 이다.
-- merchant_map 을 참조하는 외래키는 없다(migrations/ 에 REFERENCES merchant_map 이
-- 없다). 제약 이름은 CREATE TABLE 의 인라인 PRIMARY KEY 가 붙인 기본 이름이다.
--
-- ── 잠금 ──────────────────────────────────────────────────────────────────
--
-- 기본키를 다시 세우는 동안 ACCESS EXCLUSIVE 잠금으로 유일 인덱스를 새로 만든다.
-- 사람이 /classify 에서 고른 매핑 수십~수백 행이라 순간이다. 그래도 다른 쿼리
-- 뒤에서 잠금을 기다리며 뒤따르는 요청을 줄줄이 막지 않도록 대기 시간을 짧게
-- 묶는다. 못 잡으면 이 파일이 실패하고(트랜잭션 전체가 되돌아간다) 배포가
-- 멈춘다 — 그대로 재시도하면 된다. 테이블이 작아 CONCURRENTLY 로 나눌 이유가 없다.
SET LOCAL lock_timeout = '5s';

ALTER TABLE merchant_map
  ADD COLUMN direction TEXT NOT NULL DEFAULT 'any'
    CONSTRAINT merchant_map_direction_valid
    CHECK (direction IN ('in', 'out', 'any'));

ALTER TABLE merchant_map DROP CONSTRAINT merchant_map_pkey;

ALTER TABLE merchant_map
  ADD CONSTRAINT merchant_map_pkey PRIMARY KEY (description, direction);

COMMENT ON COLUMN merchant_map.direction IS '이 매핑이 걸리는 거래 방향: in(입금) | out(출금) | any(방향 구분 전의 매핑, 양쪽). 방향이 맞는 매핑이 any 보다 먼저다.';
