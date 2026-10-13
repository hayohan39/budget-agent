@AGENTS.md

# budget-agent

개인 가계부 자동화 앱. 은행 거래내역(xlsx)을 업로드해 분류하고 월별 리포트를 본다. 계획은 `PLAN.md`.

개인 프로젝트다. 리포지토리 주인(이하 "사용자")은 Claude 세션에서 개발을 요청하고
진행 상황을 묻고, GitHub 에서 PR 을 리뷰해 merge 한다. 커밋과 PR 은 Claude 가 만든다.
[project-bootstrap](https://github.com/hayohan39/project-bootstrap) 템플릿의 개발 흐름을 따른다.

## 보안 규칙 (최우선)

이 프로젝트는 개인 금융 거래 내역을 다룬다. **기능보다 보안이 우선한다.**
기능과 보안이 충돌하면 언제나 보안을 택한다.

- KFTC OAuth 는 **조회(inquiry) 스코프만** 요청한다. 이체(transfer) 스코프는
  어떤 이유로도 요청하지 않는다.
- **계좌번호 원문(전체 자릿수)은 저장하지 않는다.** 상대방 계좌번호는 읽지도
  저장하지도 않는다(`transactions.cp_acct_hash` 는 영구히 NULL 이다).
  유일한 예외는 내 계좌 **뒤 4자리**(`accounts.last4`)다. 명세서 머리말이 이미
  `****-****-NNNN` 으로 마스킹해 주는 값이라 원문이 아니고, 경우의 수가 1만뿐이라
  해시를 씌워도 즉시 역산된다 — 보호가 아니라 장식이다. 명세서를 등록된 계좌에
  붙이는 유일한 키라서 비교 가능한 평문으로 둔다. 대신 이 4자리도 로그·CI 출력·
  에러 메시지·HTTP 응답·UI 어디에도 내보내지 않는다(코드가 이미 그렇게 되어 있다).
- API 원본 응답을 그대로 보관하는 컬럼을 만들지 않는다. 저장하지 않은 데이터는
  유출될 수 없다.
- 거래 내역·계좌번호·토큰을 **어떤 로그에도 출력하지 않는다.** 디버그 로그 포함.
  에러 객체를 그대로 출력하지 않는다(요청 본문이 섞여 나올 수 있다).
- 비밀값은 커밋하지 않는다. 실수로 커밋했다면 히스토리 정리로 끝내지 말고
  **토큰을 즉시 폐기하고 재발급**한다.
- 실제 거래 데이터(엑셀/CSV)는 커밋하지 않는다. 테스트 fixture 는 개인정보를
  제거한 샘플만 쓴다.
- **거래 내역 원본은 GitHub Actions 를 경유시키지 않는다.** xlsx 원본·파싱 결과·
  거래 행 데이터를 CI 에서 다루거나 CI 로그에 남기지 않는다. 수집·파싱·저장은
  웹앱 런타임에서만 수행한다.
- 스키마 마이그레이션·계좌 등록처럼 **거래 데이터를 다루지 않는 운영 작업**은
  CI 실행을 허용한다. 단 `workflow_dispatch` 전용, `confirm` 입력으로 오실행을
  막고, 시크릿은 필요한 스텝에만 주입하며, 값을 어떤 형태로도 echo 하지 않는다.
- **CI 로그는 영구 저장된다.** GitHub 마스킹은 등록된 시크릿 값의 정확한
  부분문자열만 가린다 — 에러 메시지에 섞여 나온 호스트명·사용자명은 마스킹되지
  않는다. 그래서 에러 객체를 그대로 출력하지 않는 규칙이 CI 에서 특히 중요하다.
- npm 패키지 추가에 보수적으로 접근한다. 추가 시 PR 본문에 이유를 적는다.

### PR 보안 체크리스트

- [ ] 비밀값이 diff 에 포함되지 않았는가
- [ ] 새 로그에 거래 내역·계좌번호·토큰이 찍히지 않는가
- [ ] 새 컬럼에 저장하는 데이터가 정말 필요한가
- [ ] 새 의존성의 추가 이유가 타당한가
- [ ] 이체(transfer) 관련 API 호출 코드가 없는가
- [ ] CI 로그에 거래 데이터나 마스킹되지 않는 식별자가 남지 않는가

## 역할 분담

| 누가 | 무엇을 |
| --- | --- |
| 사용자 | Claude 세션에서 요청 · PR 리뷰 · **merge** (merge 는 항상 사용자가 한다) |
| Claude (세션) | 브랜치 → 구현 → 로컬 검증 → 커밋 → push → **PR 생성** → CI 결과 확인 |
| GitHub Actions | CI(자동) · CI 실패 시 auto-fix · 품질 리뷰 · PR 프리뷰(마이그레이션 검증) · merge 후 마이그레이션+배포 |

## 개발 요청을 받으면

1. **main 에서 새 브랜치**를 딴다: `claude/<짧은-설명>` (세션이 브랜치를 정해 줬으면 그걸 쓴다).
   `git fetch origin main` 후 최신 main 기준으로 시작한다.
2. 요청이 모호하거나 **인프라/비용/외부 서비스가 새로 필요한** 결정이면 구현 전에 먼저
   묻는다(아래 "인프라 결정" 참고). 그 외에는 합리적으로 판단해 진행하고 PR 에 적는다.
3. 구현한다. 한 PR 에 한 목적. 무관한 리팩터링은 하지 않는다.
4. **push 전에 diff 를 스스로 다듬는다**: `.github/review/quality.md` 기준(덧붙임·재사용·단순화·일관성·빈틈)으로
   `git diff origin/main...HEAD` 를 한 번 훑는다. 세션에 `/simplify` 스킬이 있으면 그걸 써도 된다.
   CI 뒤의 품질 리뷰는 안전망이다 — 거기서 지적이 적을수록 좋다.
   위 "PR 보안 체크리스트" 를 확인한다.
   그리고 **반드시** `npm run check` (lint → typecheck → test → build) 를 통과시킨다.
   DB 를 건드렸으면 로컬 Postgres 에 `npm run migrate` 도 돌려 본다(아래 참고).
5. 커밋 메시지는 Conventional Commits, 제목은 한국어 가능: `feat: 할 일 목록 추가`.
6. push 후 **PR 을 만든다**. 본문은 `.github/pull_request_template.md` 형식으로 파일에 쓰고:
   `node scripts/gh.mjs pr-create --title "feat: ..." --body-file /tmp/pr.md`
   "무엇을 / 어떻게 확인했나 / 배포 영향" 을 비우지 않는다. 사용자는 휴대폰으로 PR 을
   볼 수 있다 — 무엇이 바뀌는지 첫 줄에서 알 수 있게 쓴다.
7. PR 을 연 뒤 `node scripts/gh.mjs pr-watch` 로 CI 를 기다리고 결과(체크, 프리뷰 링크)를
   사용자에게 한두 줄로 알린다. 실패하면 auto-fix 가 붙지만, 세션이 살아 있으면 직접 고쳐서
   push 하는 편이 빠르다.
8. **merge 하지 않는다.** 사용자가 요청해도 "PR 에서 merge 버튼을 눌러 주세요" 라고 안내한다.
   (merge 가 곧 프로덕션 배포이므로 사람이 누르는 것이 이 프로세스의 게이트다.)

PR 이 이미 열려 있는 브랜치에서 추가 요청을 받으면 같은 브랜치에 커밋을 더한다.
그 전에 `git pull origin <브랜치>` — CI 가 `[claude-refine]`·`[claude-autofix]` 커밋을 더했을 수 있다.
품질 리뷰 코멘트(🧹)의 **제안**을 사용자가 반영해 달라고 하면 같은 브랜치에서 고친다.

> **GitHub CLI 주의**: 클라우드 세션의 GitHub 프록시는 GraphQL 을 막는다. `gh pr create`,
> `gh pr list/checks/view`, `gh workflow run` 은 403 이 난다. `scripts/gh.mjs`(REST)나
> `gh api repos/{owner}/{repo}/...`, `gh run list/view` 를 쓴다. 세션이 PR 생성 버튼/도구를
> 따로 제공하면 그걸 써도 된다. `gh` 가 없으면 세션 시작 훅이 설치를 시도한다.

## 개발 상황을 물으면

`project-status` 스킬을 따른다. 요약: 열린 PR 과 각 CI/프리뷰 상태, 최근 merge 와
배포 결과, `docs/decisions.md` 의 미결 항목을 짧게 정리하고 다음에 할 일을 제안한다.

## 파이프라인 (건드리기 전에 이해할 것)

```
PR 생성/push ─► ci.yml
                 ├ test     lint · typecheck · test · 빈 Postgres 에 마이그레이션 · build
                 ├ preview  Neon 브랜치(프로덕션 복제)에 마이그레이션 → Vercel 프리뷰 → PR 코멘트
                 ├ refine   위가 통과하면 Claude 품질 리뷰 → 작은 정리는 [claude-refine] 커밋, 큰 것은 제안 (push 당 1회)
                 └ autofix  위가 실패하면 Claude 가 고쳐서 [claude-autofix] 커밋 (PR 당 최대 3회)
             ─► claude-review.yml   PR 을 열거나 push 할 때마다 자동 리뷰 코멘트
PR 코멘트 @claude ─► claude-mention.yml  지시대로 수정 (리포 주인의 코멘트만)
merge ─► deploy.yml  프로덕션 마이그레이션 → Vercel 프로덕션 배포 → /api/health 확인 → PR 코멘트
PR 닫힘 ─► preview-cleanup.yml  Neon 프리뷰 브랜치 삭제
수동     ─► migrate.yml (confirm=migrate) · seed-accounts.yml (confirm=seed)
```

- **프리뷰에서는 로그인이 안 된다.** Google OAuth 가 매번 바뀌는 프리뷰 주소를 허용하지 않고,
  인증 환경변수도 Production 에만 있다. 프리뷰의 목적은 **프로덕션 복제 DB 에서 마이그레이션이
  깨지지 않는지**와 배포 빌드 확인이다. 화면 확인은 로컬(`npm run dev`)에서 한다.
- 프리뷰 DB 는 실제 거래 데이터의 복제본이다. CI 는 그 위에서 마이그레이션 SQL 만 실행하고
  (위 보안 규칙의 "거래 데이터를 다루지 않는 운영 작업"), 러너는 오류의 `message` 만 출력한다.
  마이그레이션에 거래 행을 출력하는 문장(`RAISE NOTICE` 로 값 찍기 등)을 넣지 않는다.
- 워크플로를 고칠 때는 그 이유를 PR 에 적는다. 시크릿 값을 로그에 찍지 않는다.
- `vercel.json` 과 Vercel Git 연동: Vercel 프로젝트는 Git 에 연결하지 않는다.
  배포는 deploy.yml 만 한다(마이그레이션 → 배포 순서를 보장하기 위해).

## 스택

- Next.js (App Router, `app/`) + TypeScript. **AGENTS.md 경고대로** 이 Next.js 버전은
  학습 데이터와 다를 수 있다. 새 API 를 쓰기 전에 `node_modules/next/dist/docs/` 를 확인한다.
- 인증: Auth.js v5(next-auth) + Google, `ALLOWED_EMAILS` 화이트리스트(`auth.ts`, `middleware.ts`).
  로그인 없이 열린 경로는 `middleware.ts` matcher 예외뿐이다(`/api/health` 포함 — `test/middleware-matcher.test.mjs`).
- DB: Neon Postgres. 드라이버는 `pg`, 연결은 `lib/db/client.mjs`(`withClient` / `withTransaction`).
  ORM 은 없다.
- 테스트: `node --test` (`test/**/*.test.mjs`). 라우트 본체는 `lib/` 의 `.mjs` 로 빼서 여기서 테스트한다.
  스타일은 Tailwind.
- Node 24 (`.nvmrc`).

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
- 로컬 개발은 `DATABASE_URL` 을 `.env` 에 두고 쓴다(운영 Neon 이 아닌 값). `.env` 는 커밋하지 않는다.
- main 에 merge 되면 `deploy.yml` 이 마이그레이션을 먼저 적용하고 그 다음 배포한다.
  마이그레이션이 실패하면 배포는 실행되지 않는다.
- 프로덕션에 실제 거래 데이터가 있다고 가정한다. NOT NULL 컬럼 추가는 DEFAULT 와 함께,
  컬럼/테이블 삭제는 PR 본문 "배포 영향" 에 명시한다. preview job 이 프로덕션 복제본에서
  먼저 돌려 보므로 여기서 실패하면 merge 전에 드러난다.
- SQL 은 항상 파라미터 바인딩(`$1`). 문자열로 조합하지 않는다.
- 로컬 검증: 세션에 Postgres 가 있으면 시작 훅이 `TEST_DATABASE_URL` 을 설정한다.
  `DATABASE_URL=$TEST_DATABASE_URL npm run migrate` 로 적용해 볼 수 있다.
  `npm test` 도 이 값이 있으면 DB 테스트를 함께 돌린다(CI 도 Postgres 로 돌린다).

## 환경변수와 비밀값

- 비밀값을 커밋하지 않는다. `.env*` 는 gitignore 되어 있고 Claude 는 읽지 않는다.
- 새 환경변수가 필요하면: 코드에서 없을 때 명확한 에러를 내고, PR 본문 "배포 영향" 에
  이름·용도·어디서 발급받는지 적는다. 값 설정은 사용자가 한다(Vercel 대시보드 또는
  `vercel env add`). Claude 가 대신 설정할 수단이 있어도 먼저 묻는다.
- 이미 있는 것: 이름과 용도는 `.env.example` 에 있다. 운영 쪽 설정 절차는 `docs/SETUP.md`.

## 인프라 결정

Vercel(배포)·Neon(DB)·Google 로그인은 고정이다. 그 밖의 것(파일 저장소, 크론, 이메일, 외부 API,
결제, 캐시 등)이 필요해 보이면:

1. 구현 전에 선택지 2~3개를 **비용(무료 한도)·설정 난이도·락인** 기준으로 짧게 비교해 제안하고
   사용자의 결정을 받는다. Vercel 마켓플레이스/내장 기능(Cron, Blob 등)을 먼저 검토한다.
2. 결정되면 `docs/decisions.md` 에 한 항목으로 기록한다(날짜, 결정, 이유, 대안).
3. 필요한 계정 가입/키 발급처럼 사용자만 할 수 있는 일은 체크리스트로 알려 준다.

## 코드 규칙

- 경로는 `path.join`, 임시 디렉터리는 `os.tmpdir()`. npm scripts 에 POSIX 전용 문법 금지.
- 테스트를 지우거나 skip 해서 통과시키지 않는다. `eslint-disable` / `@ts-ignore` 로 덮지 않는다.
- 사용자에게 보이는 문구는 한국어가 기본.
- 새 페이지·API 는 middleware 의 로그인 관문 뒤에 둔다. matcher 예외를 늘려야 하면 먼저 묻는다.

## 크로스 플랫폼 규칙 (필수)

이 코드는 로컬(Windows)과 CI(Linux) 양쪽에서 돌아야 한다. CI 는 ubuntu 만 돈다(비공개 리포에서
Windows 러너는 사용 시간이 2배로 계산된다) — Windows 에서만 깨지는 것은 아래 규칙으로 미리 막는다.

- 경로는 항상 `path.join()` / `path.resolve()`. 문자열에 `/` 나 `\` 를 직접 넣지 않는다.
- 파일 URL 이 필요하면 `pathToFileURL()`. Windows 에서 `file://C:\...` 는 깨진다.
- npm scripts 에 POSIX 전용 문법을 쓰지 않는다.
  - ❌ `rm -rf dist`, `cp -r`, `FOO=bar node x.js`, `$(...)`, 단일 `'` 인용
  - ✅ Node 스크립트(`node scripts/clean.mjs`), `cross-env`, `rimraf`
- 줄바꿈은 저장소 안에서 LF 로 통일한다(`.gitattributes` 가 강제). 셸 스크립트에
  CRLF 가 섞이면 Linux 에서 `bad interpreter` 로 죽는다.
- 파일명 대소문자에 의존하지 않는다. Windows/macOS 는 구분하지 않지만 Linux 는 구분한다.
  `import './Foo'` 와 `import './foo'` 를 섞어 쓰면 Linux(CI)에서만 깨진다.
- 임시 디렉터리는 `os.tmpdir()`. `/tmp` 를 하드코딩하지 않는다.
- 스냅샷/문자열 비교에서 개행을 비교할 때 `\r\n` 을 정규화한다.
- 프로세스 실행은 `spawn(cmd, args)` 형태로. `shell: true` + 문자열 조합은 인용 규칙이
  플랫폼마다 달라 깨진다. 굳이 필요하면 Windows 에서만 `shell: true` 를 켠다.

## 명령

```bash
npm ci                  # 설치
npm run dev             # 로컬 개발
npm run check           # lint + typecheck + test + build (push 전 필수)
npm run migrate:new -- <이름>
npm run migrate         # DATABASE_URL 대상
npm run migrate:status
node scripts/gh.mjs pr-list      # 열린 PR + CI 상태 (pr-create / pr-status / pr-watch / deploys)
```
