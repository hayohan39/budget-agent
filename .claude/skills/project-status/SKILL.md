---
name: project-status
description: 사용자가 이 프로젝트의 개발 상황·진행 현황·"어디까지 됐어?"·"PR 어떻게 됐어?"·배포 상태를 물을 때 사용한다. 열린 PR, CI/프리뷰, 최근 배포, 미결 결정을 모아 짧게 보고한다.
---

# 개발 현황 보고

사용자는 대개 휴대폰으로 읽는다. **10줄 안팎**으로, 결론부터.

## 1. 모으기

클라우드 세션에서는 GraphQL 이 막혀 `gh pr ...` 이 안 된다. REST 헬퍼를 쓴다:

```bash
git fetch origin main --quiet
node scripts/gh.mjs pr-list          # 열린 PR + 각 PR 의 체크 상태
node scripts/gh.mjs pr-status <번호>  # 체크 상세 + 프리뷰 링크 + Claude 리뷰 판정
node scripts/gh.mjs deploys          # 최근 main 배포 결과
git log origin/main --oneline -10    # 최근 merge
```

그리고 `docs/decisions.md` 에서 "미결" 항목을 확인한다.
gh 자체가 안 되면 git 만으로라도 파악하고 "CI 상태는 확인 못 함" 이라고 적는다.

## 2. 보고 형식

```
**요약** 한 줄 (예: PR 1개 리뷰 대기, 마지막 배포 정상)

**리뷰 대기** — #12 할 일 목록 추가: CI ✅ · 프리뷰 <링크> · 리뷰 "merge 해도 됨"
**진행 중** — #13 …: CI ❌ auto-fix 2/3 시도 중
**최근 배포** — 9/26 #11 로그인 추가 ✅
**결정 필요** — 이메일 발송 서비스 선택 (decisions.md)

**다음 제안** 1~2개
```

- 사용자가 할 일(merge, 결정, 키 발급)은 굵게 표시한다.
- CI 가 auto-fix 한도에 걸렸거나 배포가 실패했으면 맨 위에 올린다.
- 추측하지 않는다. 확인 못 한 항목은 "확인 못 함" 이라고 쓴다.
