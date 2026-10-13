// PR 프리뷰 코멘트. Vercel 봇 코멘트처럼 배포 상태·링크·갱신 시각을 한 줄 표로 보여 주고,
// 여기에 프로덕션 복제 DB 의 마이그레이션 결과를 더한다. PR 당 코멘트 하나를 계속 갱신한다.
//
//   node scripts/preview-comment.mjs pending   배포 시작 전 "⏳ 배포 중"
//   node scripts/preview-comment.mjs result    결과
//
// 환경변수(ci.yml 의 preview job 이 넣는다):
//   GITHUB_TOKEN, GITHUB_REPOSITORY, PR, SHA, RUN_URL
//   URL, INSPECT, BRANCH, BRANCH_STEP, MIGRATE, DEPLOY  (각 스텝의 결과: success/failure/skipped/'')
import process from 'node:process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const MARKER = '<!-- preview-comment -->';

/** 2026-10-06T03:06Z → "10/6 12:06 KST" */
export function kst(date) {
  const d = new Date(date.getTime() + 9 * 60 * 60 * 1000);
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getUTCMonth() + 1}/${d.getUTCDate()} ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())} KST`;
}

function deployCell({ pending, deploy, inspect }) {
  const link = inspect ? ` ([Inspect](${inspect}))` : '';
  if (pending) return '⏳ 배포 중';
  if (deploy === 'success') return `✅ Ready${link}`;
  if (deploy === 'failure') return `❌ Error${link}`;
  return '⏭️ 건너뜀';
}

function dbCell({ pending, branchStep, migrate }) {
  if (pending) return '⏳ 준비 중';
  if (branchStep === 'failure') return '❌ DB 브랜치 생성 실패';
  if (migrate === 'success') return '✅ 적용';
  if (migrate === 'failure') return '❌ 실패';
  return '⏭️ 건너뜀';
}

export function renderPreview(input) {
  const { pending = false, project, sha, url, branch, migrate, deploy, runUrl, now = new Date() } = input;
  const lines = [
    MARKER,
    `### 🔎 프리뷰 · ${project} · \`${String(sha ?? '').slice(0, 7)}\``,
    '',
    '| 배포 | 미리보기 | DB 마이그레이션 (프로덕션 복제) | 갱신 |',
    '| --- | --- | --- | --- |',
    `| ${deployCell(input)} | ${url ? `[Preview](${url})` : '—'} | ${dbCell(input)} | ${kst(now)} |`,
    '',
  ];
  if (!pending && migrate === 'failure') {
    lines.push('⚠️ 마이그레이션이 프로덕션 데이터에서 실패했습니다(예: 기존 행이 있는데 DEFAULT 없는 NOT NULL). merge 전에 잡혔습니다 — auto-fix 가 시도합니다.');
    lines.push('');
  } else if (!pending && deploy === 'failure') {
    lines.push('⚠️ 배포가 실패했습니다. Inspect 에서 빌드 로그를 확인하세요 — auto-fix 가 시도합니다.');
    lines.push('');
  }
  const footer = [branch ? `DB 브랜치 \`${branch}\`` : null, runUrl ? `[실행 로그](${runUrl})` : null, 'PR 을 닫으면 DB 브랜치는 자동으로 지워집니다.'];
  lines.push(footer.filter(Boolean).join(' · '));
  return lines.join('\n');
}

async function github(apiPath, { method = 'GET', body } = {}) {
  const res = await fetch(`${process.env.GITHUB_API_URL ?? 'https://api.github.com'}${apiPath}`, {
    method,
    headers: {
      Authorization: `Bearer ${process.env.GITHUB_TOKEN}`,
      Accept: 'application/vnd.github+json',
      ...(body ? { 'Content-Type': 'application/json' } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  if (!res.ok) throw new Error(`GitHub ${method} ${apiPath} → HTTP ${res.status}`);
  return res.json();
}

async function upsert(pr, body) {
  const repo = process.env.GITHUB_REPOSITORY;
  for (let page = 1; page <= 10; page++) {
    const comments = await github(`/repos/${repo}/issues/${pr}/comments?per_page=100&page=${page}`);
    const mine = comments.find((c) => c.user?.login === 'github-actions[bot]' && c.body?.startsWith(MARKER));
    if (mine) return github(`/repos/${repo}/issues/comments/${mine.id}`, { method: 'PATCH', body: { body } });
    if (comments.length < 100) break;
  }
  return github(`/repos/${repo}/issues/${pr}/comments`, { method: 'POST', body: { body } });
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const e = process.env;
  try {
    const body = renderPreview({
      pending: process.argv[2] === 'pending',
      project: e.GITHUB_REPOSITORY?.split('/')[1] ?? '',
      sha: e.SHA,
      url: e.URL,
      inspect: /^https:\/\/vercel\.com\//.test(e.INSPECT ?? '') ? e.INSPECT : '',
      branch: e.BRANCH,
      branchStep: e.BRANCH_STEP,
      migrate: e.MIGRATE,
      deploy: e.DEPLOY,
      runUrl: e.RUN_URL,
    });
    await upsert(e.PR, body);
  } catch (error) {
    // 코멘트 실패가 CI 결과를 바꾸지는 않는다.
    console.log(`::warning::프리뷰 코멘트를 남기지 못했습니다: ${error.message}`);
  }
}
