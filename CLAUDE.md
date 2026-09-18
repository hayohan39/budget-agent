# budget-agent

## 보안 규칙 (최우선)

이 프로젝트는 개인 금융 거래 내역을 다룬다. **기능보다 보안이 우선한다.**
기능과 보안이 충돌하면 언제나 보안을 택한다.

- KFTC OAuth 는 **조회(inquiry) 스코프만** 요청한다. 이체(transfer) 스코프는
  어떤 이유로도 요청하지 않는다.
- **계좌번호 원문을 저장하지 않는다.** salt 적용 해시만 저장한다.
- API 원본 응답을 그대로 보관하는 컬럼을 만들지 않는다. 저장하지 않은 데이터는
  유출될 수 없다.
- 거래 내역·계좌번호·토큰을 **어떤 로그에도 출력하지 않는다.** 디버그 로그 포함.
  에러 객체를 그대로 출력하지 않는다(요청 본문이 섞여 나올 수 있다).
- 비밀값은 커밋하지 않는다. 실수로 커밋했다면 히스토리 정리로 끝내지 말고
  **토큰을 즉시 폐기하고 재발급**한다.
- 실제 거래 데이터(엑셀/CSV)는 커밋하지 않는다. 테스트 fixture 는 개인정보를
  제거한 샘플만 쓴다.
- 파이프라인은 **로컬 실행이 기본**이다. CI 에 금융 시크릿을 올리지 않는다.
- npm 패키지 추가에 보수적으로 접근한다. 추가 시 PR 본문에 이유를 적는다.

### PR 보안 체크리스트

- [ ] 비밀값이 diff 에 포함되지 않았는가
- [ ] 새 로그에 거래 내역·계좌번호·토큰이 찍히지 않는가
- [ ] 새 컬럼에 저장하는 데이터가 정말 필요한가
- [ ] 새 의존성의 추가 이유가 타당한가
- [ ] 이체(transfer) 관련 API 호출 코드가 없는가

## 이 리포지토리의 개발 흐름

1. Slack 채널에서 개발 지시가 들어온다.
2. Claude 가 브랜치를 파고 구현한 뒤 PR 을 연다.
3. CI(`.github/workflows/ci.yml`)가 ubuntu + windows 양쪽에서 돈다.
4. CI 가 실패하면 `autofix` job 이 자동으로 붙어 고치고 다시 push 한다.
5. 사람이 PR 을 읽고 merge 하거나 코멘트를 남긴다.
   - merge → `deploy.yml` 이 DB 마이그레이션 + Vercel 프로덕션 배포를 한다.
   - `@claude` 코멘트 → `claude-mention.yml` 이 그 지시대로 수행한다.

## 크로스 플랫폼 규칙 (필수)

이 코드는 Windows 와 Linux 양쪽에서 돌아야 하고 CI 도 양쪽에서 돈다.

- 경로는 항상 `path.join()` / `path.resolve()`. 문자열에 `/` 나 `\` 를 직접 넣지 않는다.
- 파일 URL 이 필요하면 `pathToFileURL()`. Windows 에서 `file://C:\...` 는 깨진다.
- npm scripts 에 POSIX 전용 문법을 쓰지 않는다.
  - ❌ `rm -rf dist`, `cp -r`, `FOO=bar node x.js`, `$(...)`, 단일 `'` 인용
  - ✅ Node 스크립트(`node scripts/clean.mjs`), `cross-env`, `rimraf`
- 줄바꿈은 저장소 안에서 LF 로 통일한다(`.gitattributes` 가 강제). 셸 스크립트에
  CRLF 가 섞이면 Linux 에서 `bad interpreter` 로 죽는다.
- 파일명 대소문자에 의존하지 않는다. Windows/macOS 는 구분하지 않지만 Linux 는 구분한다.
  `import './Foo'` 와 `import './foo'` 를 섞어 쓰면 CI 의 ubuntu 레그만 깨진다.
- 임시 디렉터리는 `os.tmpdir()`. `/tmp` 를 하드코딩하지 않는다.
- 스냅샷/문자열 비교에서 개행을 비교할 때 `\r\n` 을 정규화한다.
- 프로세스 실행은 `spawn(cmd, args)` 형태로. `shell: true` + 문자열 조합은 인용 규칙이
  플랫폼마다 달라 깨진다. 굳이 필요하면 Windows 에서만 `shell: true` 를 켠다.

## 명령

```bash
npm ci          # 설치
npm run dev     # 로컬 개발
npm run lint
npm run typecheck
npm test
npm run build
```

CI 는 위 스크립트 중 존재하는 것만 실행한다(`--if-present`).

## PR 규칙

- PR 하나에 하나의 목적. 무관한 리팩터링을 끼워 넣지 않는다.
- 테스트를 지우거나 skip 해서 CI 를 통과시키지 않는다.
- lint/타입 오류를 `eslint-disable` 이나 `@ts-ignore` 로 덮지 않는다.
- 비밀값을 커밋하지 않는다. 새 환경변수가 필요하면 PR 본문에 이름과 용도를 적는다.

## 데이터베이스 (Neon Postgres)

- 스키마 변경은 반드시 `migrations/` 의 SQL 파일로 한다. 콘솔에서 직접 바꾸지 않는다.
- 새 마이그레이션: `npm run migrate:new -- <이름>`
  파일명의 타임스탬프가 곧 적용 순서다. 직접 이름을 짓지 말고 이 명령을 쓴다.
- 적용: `npm run migrate` / 대기 목록만 보기: `npm run migrate:status`
- **이미 적용된 마이그레이션 파일은 절대 수정하지 않는다.** 러너가 체크섬으로
  감지해 실패시킨다. 바꿀 것이 있으면 새 마이그레이션을 추가한다.
- 각 파일은 하나의 트랜잭션으로 실행된다. 트랜잭션 안에서 못 도는 문장
  (`CREATE INDEX CONCURRENTLY` 등)은 별도 파일로 분리하고 그 이유를 주석에 남긴다.
- 롤백 스크립트는 없다. 되돌리려면 되돌리는 마이그레이션을 새로 쓴다.
- 로컬 개발은 `DATABASE_URL` 을 `.env` 에 두고 쓴다. `.env` 는 커밋하지 않는다.
- main 에 merge 되면 `deploy.yml` 이 마이그레이션을 먼저 적용하고 그 다음 배포한다.
  마이그레이션이 실패하면 배포는 실행되지 않는다.
