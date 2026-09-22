// 계좌 인자 해석(환경변수 / CLI) 테스트.
//
// 여기 쓰는 숫자는 전부 가짜다. 실제 계좌 뒤 4자리는 어떤 파일에도 적지 않는다.
import test from 'node:test';
import assert from 'node:assert/strict';

import { parseArgs, parseEnv, resolveAccounts } from '../scripts/seed-accounts.mjs';

// 가짜 값. 역할별로 서로 다르게 둔다(겹치면 해석 자체가 거부된다).
const MAIN = '1111';
const FIXED = '2222';
const EMERGENCY = '3333';
const OTHER = '4444';

// "그 환경변수가 아예 없음"을 나타내는 표식. undefined 를 쓰면 기본값이 대신
// 들어가 버려서 테스트가 조용히 통과한다.
const ABSENT = Symbol('absent');

function overrides(given) {
  return { main: MAIN, fixed: FIXED, emergency: EMERGENCY, ...given };
}

function env(given = {}) {
  const { main, fixed, emergency } = overrides(given);
  const value = {};
  if (main !== ABSENT) value.ACCOUNT_LAST4_MAIN = main;
  if (fixed !== ABSENT) value.ACCOUNT_LAST4_FIXED = fixed;
  if (emergency !== ABSENT) value.ACCOUNT_LAST4_EMERGENCY = emergency;
  return value;
}

function argv(given = {}) {
  const { main, fixed, emergency } = overrides(given);
  return [`main=${main}`, `fixed=${fixed}`, `emergency=${emergency}`];
}

// 역할 -> last4 로 눌러서 비교한다. 경로마다 순서가 다를 수 있어 순서는 보지 않는다.
function byRole(accounts) {
  return Object.fromEntries(accounts.map(({ role, last4 }) => [role, last4]));
}

// ── 환경변수 경로 ──────────────────────────────────────────────────────────

test('환경변수 세 개가 모두 유효하면 역할 세 개로 해석된다', () => {
  const accounts = parseEnv(env());

  assert.equal(accounts.length, 3);
  assert.deepEqual(byRole(accounts), { main: MAIN, fixed: FIXED, emergency: EMERGENCY });
  // 닉네임까지 역할에 맞게 붙는다.
  assert.deepEqual(
    Object.fromEntries(accounts.map(({ role, nickname }) => [role, nickname])),
    { main: '메인', fixed: '고정비', emergency: '비상금' },
  );
});

test('환경변수 값의 앞뒤 공백·개행은 다듬어서 받아들인다', () => {
  // GitHub 시크릿 UI 에 붙여넣으면 개행이 딸려 들어오는 일이 흔하다.
  const accounts = parseEnv(
    env({ main: `${MAIN}\n`, fixed: `  ${FIXED}  `, emergency: `\t${EMERGENCY}\r\n` }),
  );

  assert.deepEqual(byRole(accounts), { main: MAIN, fixed: FIXED, emergency: EMERGENCY });
});

test('환경변수가 하나라도 없거나 비었거나 공백뿐이면 null 을 돌려준다', () => {
  // 다듬고 나서 빈 값은 "없는 값"과 똑같이 취급한다 — 검증 실패가 아니라 폴백이다.
  const holes = [ABSENT, '', '   ', '\n', '\r\n', '\t'];

  for (const hole of holes) {
    const label = typeof hole === 'symbol' ? '없음' : JSON.stringify(hole);
    assert.equal(parseEnv(env({ main: hole })), null, `main=${label}`);
    assert.equal(parseEnv(env({ fixed: hole })), null, `fixed=${label}`);
    assert.equal(parseEnv(env({ emergency: hole })), null, `emergency=${label}`);
  }

  // 환경변수가 아예 하나도 없을 때도 마찬가지다.
  assert.equal(parseEnv({}), null);
});

// ── CLI 인자 경로 ──────────────────────────────────────────────────────────

test('CLI 인자 세 개가 모두 유효하면 역할 세 개로 해석된다', () => {
  const accounts = parseArgs(['main=1111', 'fixed=2222', 'emergency=3333']);

  assert.equal(accounts.length, 3);
  assert.deepEqual(byRole(accounts), { main: '1111', fixed: '2222', emergency: '3333' });
});

test('CLI 인자의 역할이 이상하면 거부한다', () => {
  // 알 수 없는 역할.
  assert.throws(
    () => parseArgs(['savings=1111', 'fixed=2222', 'emergency=3333']),
    /알 수 없는 역할/,
  );
  // 역할 중복.
  assert.throws(() => parseArgs(['main=1111', 'main=2222', 'emergency=3333']), /중복/);
  // 역할 누락.
  assert.throws(() => parseArgs(['main=1111', 'fixed=2222']), /역할이 빠졌습니다/);
  // 인자가 아예 없을 때도 누락으로 걸린다.
  assert.throws(() => parseArgs([]), /역할이 빠졌습니다/);
});

test('CLI 인자는 다듬지 않는다 — 환경변수 경로만 trim 한다', () => {
  // npm run 의 인자는 붙여넣기 사고가 아니라 사람이 친 것이므로 그대로 검증한다.
  assert.throws(() => parseArgs(argv({ main: `${MAIN} ` })), /4자리 숫자가 아닙니다/);
});

// ── 우선순위 ───────────────────────────────────────────────────────────────

test('환경변수 세 개가 다 있으면 argv 는 파싱조차 하지 않는다', () => {
  // argv 를 건드렸다면 형식 오류로 던졌을 값을 일부러 넣는다.
  const accounts = resolveAccounts(env(), ['이건-형식이-틀린-인자']);

  assert.deepEqual(byRole(accounts), { main: MAIN, fixed: FIXED, emergency: EMERGENCY });
});

test('환경변수가 불완전하면 argv 로 폴백한다', () => {
  const accounts = resolveAccounts(env({ emergency: ABSENT }), argv({ main: OTHER }));

  assert.deepEqual(byRole(accounts), { main: OTHER, fixed: FIXED, emergency: EMERGENCY });
});

// ── 검증은 두 경로에 똑같이 적용된다 ────────────────────────────────────────

test('4자리 숫자가 아니면 두 경로 모두 거부한다', () => {
  const invalid = ['12345', '123', '12a4', 'abcd', '11 11', '-111', '１１１１'];

  for (const value of invalid) {
    const label = JSON.stringify(value);
    assert.throws(() => parseEnv(env({ main: value })), /4자리 숫자가 아닙니다/, `env ${label}`);
    assert.throws(() => parseArgs(argv({ main: value })), /4자리 숫자가 아닙니다/, `argv ${label}`);
  }
});

test('두 역할의 뒤 4자리가 같으면 두 경로 모두 거부한다', () => {
  assert.throws(() => parseEnv(env({ fixed: MAIN })), /서로 달라야 합니다/);
  assert.throws(() => parseArgs(argv({ fixed: MAIN })), /서로 달라야 합니다/);
  // 셋이 전부 같을 때도 마찬가지다.
  assert.throws(() => parseEnv(env({ fixed: MAIN, emergency: MAIN })), /서로 달라야 합니다/);
});

// ── 보안 성질: 오류 메시지에 값이 새지 않는다 ───────────────────────────────

test('오류 메시지에 값이 포함되지 않는다', () => {
  // 이 프로젝트에서 계좌 뒤 4자리는 로그에 남으면 안 되는 값이다. 검증에 걸린
  // 값을 에러 메시지에 되비추면 그 메시지가 CI 로그(영구 저장)에 그대로 남는다.
  // 누군가 메시지에 값을 넣기 시작하면 여기서 깨지게 둔다.
  const rejected = [
    '12345', // 너무 길다
    '123', // 너무 짧다
    '12a4', // 숫자가 아니다
    '11\n11', // 가운데 개행 — 다듬어도 남는다
    '1111 2222', // 두 개를 붙여넣었다
    '9'.repeat(200), // 아주 긴 값
  ];

  for (const value of rejected) {
    const label = JSON.stringify(value);

    // 환경변수 경로.
    assert.throws(
      () => parseEnv(env({ main: value })),
      (error) => {
        assert.ok(!error.message.includes(value), `env 오류 메시지에 값이 새어 나왔다: ${label}`);
        return true;
      },
      `env ${label}`,
    );

    // CLI 경로. 개행이 든 값은 `역할=값` 토큰 하나로 표현할 수 없어(형식 검사가
    // 먼저 걸린다) 환경변수 경로에서만 확인한다.
    if (!value.includes('\n')) {
      assert.throws(
        () => parseArgs(argv({ main: value })),
        (error) => {
          assert.ok(
            !error.message.includes(value),
            `argv 오류 메시지에 값이 새어 나왔다: ${label}`,
          );
          return true;
        },
        `argv ${label}`,
      );
    }
  }
});

test('겹치는 값을 거부할 때도 오류 메시지에 값이 들어가지 않는다', () => {
  for (const parse of [() => parseEnv(env({ fixed: MAIN })), () => parseArgs(argv({ fixed: MAIN }))]) {
    assert.throws(parse, (error) => {
      assert.ok(!error.message.includes(MAIN), `겹침 오류 메시지에 값이 새어 나왔다`);
      return true;
    });
  }
});
