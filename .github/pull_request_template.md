## 무엇을

<!-- 이 PR 이 무엇을 하는지 한두 줄. Slack 의 어떤 지시에 대한 것인지도. -->

## 어떻게 확인했나

- [ ] `npm test` 통과
- [ ] `npm run lint` / `npm run typecheck` 통과
- [ ] CI 의 ubuntu / windows 양쪽 초록불
- [ ] (해당되면) 마이그레이션을 로컬 DB 에 `npm run migrate` 로 적용해 검증

## 배포 영향

<!-- 새 환경변수, 마이그레이션, 되돌리기 방법. 없으면 "없음". -->

---

리뷰 후 이 PR 을 **merge** 하면 main 이 프로덕션에 자동 배포됩니다.
수정이 필요하면 merge 대신 `@claude <지시>` 로 코멘트를 남겨주세요.
