# 결정 기록

이 프로젝트에서 내린 기술·인프라 결정을 남긴다. Claude 와 세션에서 합의한 것도 여기에 적는다.
최신 항목이 위로 온다.

형식:

```
## YYYY-MM-DD 제목
- 결정:
- 이유:
- 검토한 대안:
- 영향: (새 환경변수, 비용, 되돌리는 법)
```

## 미결

- (없음)

---

## 2026-10-13 project-bootstrap 개발 흐름 도입

- 결정: devflow 스캐폴드 → project-bootstrap 템플릿의 CI·배포 흐름으로 맞춘다
  (DB 테스트 포함 CI, Neon 프리뷰 브랜치에서 마이그레이션 검증, 품질 리뷰, 배포 후 헬스체크).
- 이유: 두 리포가 같은 스캐폴드에서 출발했고, 템플릿 쪽에 운영 안전장치가 더 쌓였다.
- 이 프로젝트만의 차이:
  - 프리뷰는 **마이그레이션 검증용**. 로그인이 안 된다(Google OAuth 가 프리뷰 주소를 허용하지 않음).
  - CI 는 ubuntu 만(이전: ubuntu + windows). 비공개 리포에서 Windows 러너는 사용 시간 2배.
    Windows 호환은 CLAUDE.md 의 크로스 플랫폼 규칙으로 지킨다.
  - `/api/health` 를 로그인 예외로 연다. 커밋 7자리와 DB 연결 여부(ok/error)만 돌려준다.
  - `@claude` 는 리포 주인의 코멘트만 처리(이 리포에서 먼저 넣은 제한, 유지).
- 영향: 리포 시크릿 `NEON_API_KEY` 와 `NEON_PROJECT_ID`(변수 또는 시크릿)가 있어야 프리뷰가 돈다(없으면 건너뜀).
  되돌리려면 이 도입 PR 을 revert.

## 2026-09-17 기본 스택

- 결정: Next.js(App Router) + TypeScript, Vercel 배포, Neon Postgres(`pg` + SQL 마이그레이션), Auth.js + Google 로그인
- 이유: devflow 스캐폴드의 고정 스택.
