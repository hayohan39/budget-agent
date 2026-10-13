#!/usr/bin/env bash
# Claude Code 세션 시작 훅. 클라우드(웹/모바일) 세션에서만 의존성을 설치해 두어
# Claude 가 바로 lint / test / build 를 돌릴 수 있게 한다. 로컬에서는 아무것도 안 한다.
set -euo pipefail
[ "${CLAUDE_CODE_REMOTE:-}" = "true" ] || exit 0
cd "${CLAUDE_PROJECT_DIR:-.}"
# gh 가 없으면 설치를 시도한다(scripts/gh.mjs 가 쓴다). 실패해도 세션은 계속한다.
if ! command -v gh >/dev/null 2>&1 && command -v apt-get >/dev/null 2>&1; then
  (apt-get install -y gh >/dev/null 2>&1 || { apt-get update >/dev/null 2>&1 && apt-get install -y gh >/dev/null 2>&1; }) || true
fi
if [ ! -d node_modules ]; then
  npm ci --no-audit --no-fund >/dev/null 2>&1 || npm install --no-audit --no-fund >/dev/null 2>&1 || true
fi
# 세션에 로컬 Postgres 가 있으면 켜 두고 테스트용 URL 을 알려 준다(없으면 건너뜀).
if command -v pg_ctlcluster >/dev/null 2>&1 && [ -n "${CLAUDE_ENV_FILE:-}" ]; then
  version=$(ls /usr/lib/postgresql 2>/dev/null | sort -n | tail -1)
  [ -n "$version" ] && pg_ctlcluster "$version" main start >/dev/null 2>&1 || true
  if pg_isready -q -h localhost 2>/dev/null; then
    su postgres -c "psql -qc \"alter user postgres password 'postgres'\"" >/dev/null 2>&1 || true
    echo "export TEST_DATABASE_URL=postgres://postgres:postgres@localhost:5432/postgres" >> "$CLAUDE_ENV_FILE"
  fi
fi
exit 0
