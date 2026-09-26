# 배포 설정 가이드

Google OAuth 와 Vercel 환경변수를 손으로 세팅하는 절차. 이 문서의 변수 이름과
동작은 전부 이 저장소의 코드에서 확인한 것이고, 근거 파일·줄 번호를 같이 적어
두었다. 이름이 하나라도 틀리면 로그인은 **아무 에러 메시지 없이** 실패한다.

> **이 문서에 실제 값은 넣지 않는다.** 클라이언트 시크릿 · 연결 문자열 · 계좌번호 ·
> 이메일 주소는 자리표시자로만 적는다.
>
> **클라이언트 시크릿을 Claude 와의 대화창에 붙여 넣지 않는다.** 값이 필요한 쪽은
> Google Cloud 콘솔과 Vercel 대시보드뿐이고, 둘 다 사람이 직접 붙여 넣는 자리다.
> 실수로 어딘가에 붙였다면 지우는 것으로 끝내지 말고 **Google Cloud 에서 해당
> 클라이언트 시크릿을 폐기하고 새로 발급**한다(CLAUDE.md 보안 규칙).

프로덕션 주소: `https://budget-agent-eight.vercel.app`

---

## 1. Google Cloud — OAuth 클라이언트 만들기

### 1-1. 프로젝트 생성

Google Cloud 콘솔에서 새 프로젝트를 하나 만든다. 이름은 아무거나 좋다.

### 1-2. API 는 **아무것도 켜지 않는다**

이 앱이 Google 에 요청하는 스코프는 `openid email profile` 셋뿐이다
(`auth.ts:23`). 신원 확인용 기본 스코프라서 Gmail API · Drive API 같은 것을
따로 사용 설정할 필요가 없다. "API 및 서비스 > 사용 설정"에서 무언가를 켜야
하나 고민할 필요 없이 넘어간다.

거래내역은 웹앱에 xlsx 파일을 직접 올려서 받는다. Gmail 읽기 권한은 이 앱의
설계상 필요하지 않다(`auth.ts:11-14`).

### 1-3. OAuth 동의 화면

- **User Type: External**
- 앱 이름: 아무거나 (예: `가계부`)
- 사용자 지원 이메일 / 개발자 연락처 이메일: 본인 이메일
- **스코프는 추가하지 않는다.** 동의 화면의 "범위 추가 또는 삭제"에서 아무것도
  고르지 않는다. `openid email profile` 은 기본 제공 스코프라 여기에 등록하지
  않아도 동작하고, 여기에 뭔가 추가하면 코드가 요청하지도 않는 권한을 화면에
  띄우게 된다.
- **테스트 사용자**에 본인 Google 계정을 추가한다.

### 1-4. 게시 상태는 **Testing** 으로 둔다

"앱 게시(Publish app)" 버튼을 누르지 않는다. Testing 상태에서는 **테스트
사용자 목록에 있는 계정만** 로그인 화면을 통과할 수 있다. 즉 이 목록이
`ALLOWED_EMAILS` 와 별개로 작동하는 **두 번째 화이트리스트**다. 본인 혼자
쓰는 앱이므로 심사를 받을 이유가 없고, 열어 두면 방어선 하나가 줄어든다.

Testing 상태의 Google 쪽 토큰 만료 제약은 이 앱과 무관하다 — 애초에 refresh
token 을 받지 않는다(`auth.ts:16-22`). 로그인 세션은 이 앱이 직접 발급하는
JWT 쿠키이고(`auth.ts:50`), Google 쪽 토큰 수명과 별개로 유지된다.

### 1-5. OAuth 클라이언트 ID 만들기

"사용자 인증 정보 > 사용자 인증 정보 만들기 > OAuth 클라이언트 ID":

- 애플리케이션 유형: **웹 애플리케이션**
- **승인된 리디렉션 URI**:

  ```
  https://budget-agent-eight.vercel.app/api/auth/callback/google
  ```

  이 경로는 추측이 아니다. Auth.js v5 의 `basePath` 가 `/api/auth` 로 정해져
  있고(`node_modules/next-auth/lib/env.js:36`), 그 아래 `callback/<provider id>`
  가 붙는다. provider id 는 `google` 이다(`auth.ts:44`).
  **오타·끝 슬래시·`http://` 는 전부 불일치로 취급된다.**

- 승인된 JavaScript 원본은 넣지 않아도 된다(이 앱은 브라우저에서 직접 Google
  토큰 엔드포인트를 부르지 않는다).

만들고 나면 **클라이언트 ID** 와 **클라이언트 시크릿**이 나온다. 이 두 값은
Vercel 환경변수 칸에 직접 붙여 넣는다. 다른 어디에도 적지 않는다.

---

## 2. `AUTH_SECRET` 만들기

세션 JWT 를 서명·암호화하는 키다. 로컬에 도구를 깔지 않고 만드는 방법:

- **Google Cloud Shell** (콘솔 우상단 터미널 아이콘) 에서:

  ```bash
  openssl rand -base64 32
  ```

  출력된 한 줄이 값이다. 복사한 뒤 Cloud Shell 기록은 닫아 버린다.

- 또는 **비밀번호 관리자**의 랜덤 문자열 생성기로 32바이트(base64 기준 44자)
  이상을 만들어도 된다. 사람이 지어낸 문자열은 쓰지 않는다.

> 나중에 이 값을 바꾸면 **이미 발급된 세션 쿠키가 전부 무효**가 된다. 앱이
> 로그아웃된 것처럼 보이고 다시 로그인해야 한다. 그뿐이고 데이터는 영향받지
> 않는다.

---

## 3. Vercel 환경변수

Vercel 대시보드 > 프로젝트 > Settings > Environment Variables 에서 넣는다.
Production 환경에 넣으면 된다(Preview 도 쓸 생각이면 같이 체크).

### 3-1. 필수 — 이게 없으면 앱이 동작하지 않는다

| 이름 | 용도 | 근거 |
| --- | --- | --- |
| `AUTH_GOOGLE_ID` | Google OAuth 클라이언트 ID | `auth.ts:45` |
| `AUTH_GOOGLE_SECRET` | Google OAuth 클라이언트 시크릿 | `auth.ts:46` |
| `AUTH_SECRET` | 세션 JWT 서명·암호화 키 (2장에서 만든 값) | `node_modules/next-auth/lib/env.js:22` |
| `ALLOWED_EMAILS` | 로그인을 허용할 이메일 목록 | `auth.ts:26` |
| `DATABASE_URL` | Neon Postgres 연결 문자열 | `lib/db/client.mjs:25` |

이름을 반드시 그대로 쓴다. `GOOGLE_CLIENT_ID` 처럼 흔한 다른 이름은 코드가
읽지 않는다 — 앱은 "클라이언트 ID 가 없다"는 말 대신 그냥 로그인에 실패한다.

- `AUTH_SECRET` 대신 `NEXTAUTH_SECRET` 이라는 이름을 써도 읽는다. 둘 다 있으면
  `AUTH_SECRET` 이 이긴다(`node_modules/next-auth/lib/env.js:22`). 새로 넣는
  거라면 `AUTH_SECRET` 하나만 쓴다.
- `DATABASE_URL` 은 **웹앱 런타임에서 실제로 읽는다.** `/import` 의 저장 경로
  (`app/api/import/route.ts:19` → `withClient`)와 `/report` 의 조회 경로
  (`app/report/page.tsx:23`)가 둘 다 `lib/db/client.mjs` 를 거친다. 스크립트
  전용 변수가 아니다. 없으면 로그인은 되지만 업로드와 리포트가 실패한다.

### 3-2. `ALLOWED_EMAILS` 형식 — 여기서 제일 많이 틀린다

```
ALLOWED_EMAILS=first@example.com,second@example.com
```

코드가 하는 일은 이게 전부다(`auth.ts:25-30`):

- **구분자는 쉼표(`,`) 하나뿐이다.** 공백·줄바꿈·세미콜론은 구분자가 아니다.
  `a@x.com b@y.com` 처럼 띄어쓰기로 나누면 **한 덩어리로 취급되어 아무도
  로그인하지 못한다.**
- **각 항목의 앞뒤 공백은 잘라 낸다**(`auth.ts:28` 의 `.trim()`). 그래서
  `a@x.com, b@y.com` 처럼 쉼표 뒤에 공백을 넣어도 된다. 다만 주소 **안쪽**의
  공백은 잘리지 않는다.
- **대소문자는 구분하지 않는다.** 목록도 로그인한 이메일도 둘 다 소문자로
  바꿔 비교한다(`auth.ts:28`, `auth.ts:39`).
- 빈 항목은 버린다(`auth.ts:29`). 끝에 쉼표가 하나 더 붙어도 문제없다.
- **비어 있거나 아예 설정하지 않으면 아무도 로그인할 수 없다**(fail closed).
  `process.env.ALLOWED_EMAILS ?? ""` 가 빈 배열이 되고(`auth.ts:26`),
  `allowedEmails().includes(...)` 가 언제나 `false` 가 된다(`auth.ts:39`).
  "설정을 깜빡하면 다 열린다"의 반대다 — 깜빡하면 다 닫힌다.

또 하나: **Google 이 `email_verified: true` 를 주지 않으면 화이트리스트에
있어도 거부된다**(`auth.ts:58`). 일반적인 Google 계정은 문제없다.

화이트리스트는 로그인할 때 한 번만 보는 게 아니라 요청마다 다시 본다
(`app/api/import/route.ts:86`, `app/report/page.tsx:94`). 목록에서 이메일을
빼면 그 계정의 살아 있는 세션도 그 시점부터 막힌다.

### 3-3. 선택 — 보통은 넣지 않아도 된다

| 이름 | 넣으면 생기는 일 |
| --- | --- |
| `AUTH_URL` / `NEXTAUTH_URL` | 요청 헤더 대신 이 URL 을 앱의 주소로 못 박는다(`node_modules/next-auth/lib/env.js:6,23`). Vercel 에서는 넣지 않아도 `x-forwarded-host` 헤더로 주소를 잡는다(`node_modules/@auth/core/lib/utils/env.js:80-86`). 넣으면 프로덕션 도메인으로 고정되므로 프리뷰 배포에서 로그인이 어긋날 수 있다. |
| `AUTH_TRUST_HOST` | 프록시가 보낸 호스트 헤더를 믿을지 여부. Vercel 배포에는 `VERCEL=1` 이 자동으로 들어가고 그것만으로 이미 켜진다(`node_modules/@auth/core/lib/utils/env.js:40-44`). 그래서 평소에는 필요 없다. |

**요약: Vercel 이라면 `AUTH_URL` · `NEXTAUTH_URL` · `AUTH_TRUST_HOST` 셋 다 넣지
않는 것이 기본값이고, 그래도 동작한다.**

다만 한 가지 조건이 있다. 위의 자동 판정은 Vercel 이 주입하는 시스템 환경변수
`VERCEL` 에 기대고 있다. Vercel 프로젝트 설정에서 "Automatically expose System
Environment Variables" 를 **꺼 두면** 그 변수가 사라질 수 있고, 그때는
`AUTH_TRUST_HOST=true` 를 직접 넣어야 한다. (이 토글의 정확한 동작은 Vercel
쪽 설정이라 저장소 코드로는 확인할 수 없었다. 기본값은 켜져 있다.)

### 3-4. 런타임 변수가 **아닌** 것들 — 헷갈리지 말 것

| 이름 | 어디서 쓰나 |
| --- | --- |
| `ACCOUNT_LAST4_MAIN` / `_FIXED` / `_EMERGENCY` | 계좌 등록 스크립트 전용(`scripts/seed-accounts.mjs:149`). 웹앱은 읽지 않는다. |
| `TEST_DATABASE_URL` | 로컬 테스트 전용. 로컬 호스트가 아니면 테스트가 거부한다(`test/db-transactions.test.mjs:236`). |
| `USE_NEON` / `USE_VERCEL` | GitHub **리포지토리 variable**. 워크플로가 DB·배포 단계를 돌릴지 판단하는 데만 쓴다(`.github/workflows/deploy.yml:29`). **런타임 DB 접근을 막는 플래그가 아니다** — 웹앱 코드 어디에도 `USE_NEON` 은 없다. |

### 3-5. Vercel 환경변수 ≠ GitHub 시크릿

**두 곳은 완전히 별개다.** 같은 이름이라도 서로 복사되지 않는다.

- **Vercel 환경변수**: 배포된 앱이 실행 중에 읽는 값. 위 3-1 표가 여기 들어간다.
- **GitHub 시크릿**: 워크플로가 쓰는 값. `deploy.yml` 은 마이그레이션 실행에
  `DATABASE_URL` 을(`.github/workflows/deploy.yml:38`), Vercel CLI 인증에
  `VERCEL_TOKEN` · `VERCEL_ORG_ID` · `VERCEL_PROJECT_ID` 를
  쓴다(`.github/workflows/deploy.yml:89-91`).

`DATABASE_URL` 은 **양쪽 모두에** 필요하다. 앱이 읽어야 하고(Vercel), 배포 때
마이그레이션도 돌려야 한다(GitHub). 한쪽만 넣고 다른 쪽을 빠뜨리는 게 흔한
실수다.

### 3-6. 환경변수를 바꾸면 **다시 배포해야 한다**

값을 저장하는 것만으로는 이미 돌고 있는 배포에 반영되지 않는다. 배포
파이프라인이 빌드 직전에 Vercel 의 프로덕션 환경변수를 끌어와서 빌드하기
때문이다(`.github/workflows/deploy.yml` 의 `vercel pull --environment=production`
→ `vercel build --prod`).

반영하려면 둘 중 하나:

- GitHub Actions 에서 `Deploy` 워크플로를 수동 실행한다
  (`workflow_dispatch` 가 열려 있다, `.github/workflows/deploy.yml:13`), 또는
- Vercel 대시보드의 Deployments 에서 최신 배포를 **Redeploy** 한다.

---

## 4. 확인과 문제 해결

### 4-1. 순서대로 확인

1. `https://budget-agent-eight.vercel.app` 를 연다.
   → 로그인 안 된 상태면 `/signin` 으로 넘어가야 한다(`middleware.ts:14-19`).
2. "Google 로 로그인" 을 누른다. → Google 동의 화면이 뜬다.
3. 돌아오면 홈에 본인 이메일이 보인다(`app/page.tsx:13`).
4. `/import` 가 열리고 업로드 폼이 보인다.
5. `/report` 가 열린다. 거래가 아직 없으면 "아직 저장된 거래가 없습니다" 가
   정상이다(`app/report/page.tsx:153-157`).

### 4-2. 이럴 때는 이걸 의심한다

| 증상 | 원인 | 조치 |
| --- | --- | --- |
| Google 화면에서 `redirect_uri_mismatch` | 리디렉션 URI 가 한 글자라도 다르다 | 1-5 의 URI 를 그대로 복사해 넣는다. 끝 슬래시·`http`·`www` 확인. |
| Google 이 "액세스 차단됨 / 앱이 확인되지 않음" 으로 막는다 | 그 계정이 **테스트 사용자**로 등록되지 않았다 | 동의 화면의 테스트 사용자 목록에 추가(1-3). |
| 로그인 후 `/signin` 으로 돌아오고 "이 계정으로는 로그인할 수 없습니다" | `ALLOWED_EMAILS` 에 그 주소가 없거나, 형식이 틀렸거나, 구글 계정의 이메일이 미인증이다 | 3-2 를 다시 본다. 특히 구분자가 쉼표인지. 화면은 이 셋을 구분해 주지 않는다(`auth.ts:57-60`) — 일부러 그렇게 둔 것이다. |
| 로그인 후 `/signin` 으로 돌아오고 "서버 설정 문제입니다. 계정 잘못이 아닙니다" | 계정이 아니라 **서버 설정**이 문제다. `AUTH_GOOGLE_ID` / `AUTH_GOOGLE_SECRET` / `AUTH_SECRET` 중 하나가 없거나 틀렸다 | 2장·3-1 의 값을 다시 넣고 재배포(3-6). 화면은 어느 값이 어떻게 틀렸는지 말하지 않는다 — 그 내용은 서버 로그에만 남긴다. |
| 로그인 후 `/signin` 으로 돌아오고 "로그인하지 못했습니다. 잠시 후 다시 시도해 주세요" | 위 둘로 분류되지 않는 오류(취소·일시적 실패 등) | 다시 시도한다. 반복되면 Vercel 런타임 로그에서 Auth.js 오류 코드를 본다. |
| 환경변수를 넣었는데 아무 변화가 없다 | 저장만 하고 재배포하지 않았다 | 3-6. |
| 로그인은 되는데 `/import` 가 "데이터베이스에 연결하지 못했습니다"(503) | `DATABASE_URL` 이 없거나 틀렸다 | Vercel 쪽 `DATABASE_URL` 확인 후 재배포. 앱은 원인을 더 말해 주지 않는다(`app/api/import/route.ts:150-152`) — 에러 객체에 호스트·사용자명이 섞여 나오기 때문이다. |
| `/report` 가 "데이터를 불러오지 못했습니다" | 위와 같은 원인이거나 마이그레이션 미적용 | 같은 확인. 마이그레이션은 `deploy.yml` 이 merge 시 돌린다. |
| `UntrustedHost` 류 에러 | 호스트 신뢰 판정이 꺼졌다 | `AUTH_TRUST_HOST=true` 를 넣고 재배포(3-3). |
| 갑자기 전부 로그아웃됐다 | `AUTH_SECRET` 을 바꿨다 | 정상이다. 다시 로그인하면 된다(2장). |

문제를 좁히려고 **거래 내역·이메일·토큰·연결 문자열을 로그나 대화창에 꺼내지
않는다.** 이 앱은 그런 값을 일부러 출력하지 않도록 만들어져 있다(CLAUDE.md).

---

## 5. 매달 쓰는 법

1. 토스뱅크 앱에서 **계좌 3개(메인 · 고정비 · 비상금)의 거래내역 엑셀(.xlsx)**
   을 그 달 범위로 내려받는다.
2. `https://budget-agent-eight.vercel.app/import` 에서 세 파일을 올린다.
   - 한 번에 **3개까지**, **파일당 4MB 까지**.
   - 파일에 **암호가 걸려 있으면** 폼의 "파일 비밀번호" 칸에 입력한다. 세 파일
     모두 같은 비밀번호로 푼다. **이 값은 서버에 저장하지 않는다** — 환경변수도
     DB 도 아니고, 그 요청 안에서 한 번 쓰고 버린다. 기억해 주는 곳은 브라우저의
     비밀번호 관리자뿐이다(입력칸이 `type="password"` 라 저장을 제안한다).
   - 비밀번호가 틀리면 "파일 비밀번호가 맞지 않습니다" 가 뜬다. 파일 내용에
     대해서는 아무것도 알려 주지 않는다.
   - 결과에는 파일명 · 계좌 별명 · 조회기간 · 저장 건수 · 경고만 나온다.
     거래 내용은 화면에도 응답에도 나오지 않는다
     (`app/api/import/route.ts:11-12`).
   - **같은 달을 다시 올려도 안전하다.** 거래마다 `dedupe_key` 가 UNIQUE 이고
     `ON CONFLICT (dedupe_key) DO NOTHING` 으로 넣기 때문에, 이미 있는 건은
     `skipped` 로 잡히고 중복 저장되지 않는다
     (`lib/db/transactions.mjs:66`). 기간이 겹치게 내려받아도 된다.
3. `/report` 에서 달을 고른다.
   - 미분류가 있으면 표 아래 **‘미분류 정리하기’** 링크(또는 업로드 결과의
     ‘분류 정리’ 링크)로 `/classify` 에 간다. 같은 적요끼리 묶여 나오고, 묶음마다
     분류 · 항목 이름을 고른 뒤 **이번만**(이 달 이 묶음만) 또는 **앞으로도**(매핑으로
     저장 — 다른 달과 앞으로 올릴 거래에도 적용)를 누른다. 저장된 매핑은 같은 화면
     아래에서 고치거나 지울 수 있다.
   - 이 화면과 현금흐름표의 항목 줄에는 **적요가 보인다**(사용자가 요청한 변경,
     PLAN.md "적요 표시 원칙 변경"). 로그인 + `ALLOWED_EMAILS` 뒤에서만 보이고,
     로그 · 에러 메시지에는 나오지 않는다.
4. **표보다 먼저 검산 배너를 본다.** 이게 이 화면에서 제일 중요한 신호다.

   | 배너 | 뜻 | 할 일 |
   | --- | --- | --- |
   | 초록 "검산 통과" | 거래 금액의 합 = 메인 계좌 잔액 변화 | 그대로 읽으면 된다. |
   | 노랑 "검산하지 않았습니다" | 검산에 필요한 값이 없다(메인 계좌 미등록, 그 달 거래 없음, 경계 행의 거래 후 잔액이 빔) | 사유 문장을 보고 판단. 값을 추정해서 채우지 않는 것이 의도된 동작이다(`lib/report/verify.mjs:19-21`). |
   | 빨강 "검산 불일치" | 두 값이 어긋났다 | **보정으로 덮지 않는다.** 거래가 빠졌거나 파싱이 어긋났다는 신호다. 보통은 그 달 파일을 다시 내려받아(기간을 넉넉히) 다시 올리면 맞는다. |

   두 값은 서로 다른 컬럼(거래 금액 / 거래 후 잔액)에서 나오기 때문에 대조가
   의미를 갖는다(`lib/report/verify.mjs:1-8`).

5. 업로드 결과에 경고가 있으면 같이 본다. 특히 "표시 상한에 걸려 뒷부분이
   잘렸을 수 있습니다" 는 파일을 더 좁은 기간으로 나눠 다시 받으라는 뜻이다
   (`app/import/import-form.tsx` 의 경고 문장 표).
