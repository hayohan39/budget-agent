// CI 의 "문서만 바뀜" 판정(scripts/ci-changes.mjs — 세 템플릿 공통 규칙).
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { changedFiles, codeChanged, isDocs } from '../scripts/ci-changes.mjs';

test('문서만 바뀌면 앱 코드 변경이 아니다', () => {
  assert.equal(codeChanged(['docs/decisions.md', 'README.md', 'CLAUDE.md', '.github/pull_request_template.md']), false);
  assert.equal(codeChanged(['LICENSE']), false);
  assert.equal(codeChanged([]), false);
});

test('코드·설정·워크플로가 하나라도 있으면 앱 코드 변경이다', () => {
  assert.equal(codeChanged(['docs/a.md', 'app/page.tsx']), true);
  assert.equal(codeChanged(['next.config.ts']), true);
  assert.equal(codeChanged(['migrations/20261020000000_x.sql']), true);
  assert.equal(codeChanged(['.github/workflows/ci.yml']), true);
  assert.equal(codeChanged(['vercel.json']), true);
});

test('리뷰 기준(.github/review·risk)의 .md 는 파이프라인에 영향이 있어 문서로 보지 않는다', () => {
  assert.equal(isDocs('.github/review/quality.md'), false);
  assert.equal(isDocs('.github/risk/rubric.md'), false);
  assert.equal(isDocs('.github/pull_request_template.md'), true);
});

test('문서 자리가 아닌 .md(앱이 읽을 수 있는 콘텐츠)는 문서로 보지 않는다', () => {
  assert.equal(isDocs('content/terms.md'), false);
  assert.equal(isDocs('public/notice.md'), false);
  assert.equal(isDocs('.claude/skills/project-status/SKILL.md'), true);
});

test('assets/ 의 파일을 docs/ 로 옮기면 옛 경로도 바뀐 파일로 잡는다', () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'ci-changes-'));
  const git = (...args) => execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', ...args], { cwd: dir, stdio: 'pipe' });
  git('init', '-q');
  mkdirSync(path.join(dir, 'assets'));
  writeFileSync(path.join(dir, 'assets', 'credits.md'), '# credits\n');
  git('add', '-A');
  git('commit', '-qm', 'base');
  const base = String(execFileSync('git', ['rev-parse', 'HEAD'], { cwd: dir })).trim();
  mkdirSync(path.join(dir, 'docs'));
  git('mv', 'assets/credits.md', 'docs/credits.md');
  git('commit', '-qm', 'move');

  const files = changedFiles(base, 'HEAD', dir);
  assert.ok(files.includes('assets/credits.md') && files.includes('docs/credits.md'));
  assert.equal(codeChanged(files), true);
});
