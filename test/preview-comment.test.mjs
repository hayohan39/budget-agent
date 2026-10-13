// 프리뷰 PR 코멘트(scripts/preview-comment.mjs) 렌더링 테스트. project-bootstrap 템플릿에서 왔다.
import test from 'node:test';
import assert from 'node:assert/strict';
import { kst, MARKER, renderPreview } from '../scripts/preview-comment.mjs';

const now = new Date('2026-10-06T03:06:00Z');
const base = { project: 'my-app', sha: 'abcdef1234', runUrl: 'https://github.com/o/r/actions/runs/1', now };
test("한국 시간으로 표시한다", () => {
  assert.equal(kst(now), "10/6 12:06 KST");
  assert.equal(kst(new Date("2026-12-31T15:30:00Z")), "1/1 00:30 KST");
});

test("배포 중", () => {
  const text = renderPreview({ ...base, pending: true });
  assert.equal(text.startsWith(MARKER), true);
  assert.ok(text.includes("### 🔎 프리뷰 · my-app · `abcdef1`"));
  assert.ok(text.includes("| ⏳ 배포 중 | — | ⏳ 준비 중 | 10/6 12:06 KST |"));
});

test("성공: Preview·Inspect 링크와 마이그레이션 결과", () => {
  const text = renderPreview({
    ...base,
    url: "https://my-app-abc.vercel.app",
    inspect: "https://vercel.com/me/my-app/dpl1",
    branch: "preview/pr-3-abcdef1",
    branchStep: "success",
    migrate: "success",
    deploy: "success",
  });
  assert.ok(text.includes("| ✅ Ready ([Inspect](https://vercel.com/me/my-app/dpl1)) | [Preview](https://my-app-abc.vercel.app) | ✅ 적용 | 10/6 12:06 KST |"));
  assert.ok(text.includes("DB 브랜치 `preview/pr-3-abcdef1`"));
  assert.ok(!text.includes("⚠️"));
});

test("마이그레이션 실패면 배포는 건너뛰고 이유를 적는다", () => {
  const text = renderPreview({ ...base, branchStep: "success", migrate: "failure", deploy: "skipped" });
  assert.ok(text.includes("| ⏭️ 건너뜀 | — | ❌ 실패 |"));
  assert.ok(text.includes("프로덕션 데이터에서 실패"));
});

test("빌드 실패면 Inspect 로 안내한다", () => {
  const text = renderPreview({ ...base, migrate: "success", deploy: "failure", inspect: "https://vercel.com/x" });
  assert.ok(text.includes("❌ Error ([Inspect](https://vercel.com/x))"));
  assert.ok(text.includes("빌드 로그"));
});

test("DB 브랜치를 못 만들었으면 그렇게 적는다", () => {
  assert.ok(renderPreview({ ...base, branchStep: "failure" }).includes("❌ DB 브랜치 생성 실패"));
});
