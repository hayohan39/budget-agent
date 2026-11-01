#!/usr/bin/env node
// 바뀐 파일이 문서뿐인지 판정한다. 문서만 바뀐 PR·merge 는 앱 검사·프리뷰·배포를 건너뛰어 Actions 시간을 아낀다.
//
//   node scripts/ci-changes.mjs --base <커밋> [--head HEAD]   → code=true|false
//
// base 를 모르면(첫 push, 강제 push 로 사라진 커밋) 앱 코드가 바뀐 것으로 본다 — 건너뛰지 않는 쪽이 안전하다.
// GitHub Actions 에서는 $GITHUB_OUTPUT 에도 쓴다.
import { execFileSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

// 앱·DB·빌드에 영향이 없는 파일. 세 템플릿(mobile·production·project)이 같은 규칙을 쓴다.
// 문서로 보는 곳만 나열한다: docs/, 루트의 .md, .claude/ 의 .md(세션 지침), .github/ 바로 아래의 .md(PR 템플릿),
// 어디에 있든 README.md, LICENSE. 그 밖의 .md(content/·public/ 처럼 앱이 읽을 수 있는 것)는 코드로 본다.
//   - src/·assets/ 안은 README 라도 번들에 들어갈 수 있어 문서로 보지 않는다.
//   - .github/review/·.github/risk/ 는 리뷰 기준(프롬프트·rubric)이라 파이프라인에 영향이 있다.
const DOCS = [/^docs\//, /^[^/]+\.md$/, /^\.claude\/.*\.md$/, /^\.github\/[^/]+\.md$/, /(^|\/)README\.md$/i, /^LICENSE(\.|$)/];
const NEVER_DOCS = [/^src\//, /^assets\//, /^\.github\/(review|risk)\//];

export const isDocs = (file) => DOCS.some((re) => re.test(file)) && !NEVER_DOCS.some((re) => re.test(file));

/** 바뀐 파일 목록 → 앱 코드가 바뀌었나. 목록이 비었으면(빈 커밋) 문서 변경과 같이 본다. */
export function codeChanged(files) {
  return files.some((f) => !isDocs(f));
}

/** base...head 에서 바뀐 경로. 이름 바꾸기는 옛 경로와 새 경로를 둘 다 낸다(assets/ → docs/ 로 옮긴 파일을 문서로 보지 않게). */
export function changedFiles(base, head = 'HEAD', cwd = process.cwd()) {
  const out = execFileSync('git', ['diff', '--name-only', '--no-renames', `${base}...${head}`], { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
  return out.split('\n').filter(Boolean);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const argv = process.argv.slice(2);
  const arg = (name) => argv[argv.indexOf(`--${name}`) + 1];
  const base = argv.includes('--base') ? arg('base') : '';
  const head = argv.includes('--head') ? arg('head') : 'HEAD';
  let code = true;
  if (base && !/^0+$/.test(base)) {
    try {
      const files = changedFiles(base, head);
      code = codeChanged(files);
      console.log(`바뀐 파일 ${files.length}개 — ${code ? '앱 코드 포함' : '문서만'}`);
    } catch {
      console.log(`base ${base.slice(0, 7)} 를 찾지 못했습니다 — 앱 코드가 바뀐 것으로 봅니다.`);
    }
  }
  console.log(`code=${code}`);
  if (process.env.GITHUB_OUTPUT) writeFileSync(process.env.GITHUB_OUTPUT, `code=${code}\n`, { flag: 'a' });
}
