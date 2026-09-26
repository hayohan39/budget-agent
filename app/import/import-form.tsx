"use client";

// 업로드 화면. ① 담기 → ② 미리보기 → ③ 체크한 파일만 적용.
//
// 여기에는 보안 판단이 없다 — 인증 · 권한 · 크기 제한 · 모드 확인은 전부
// 서버(app/api/import/route.ts)가 요청마다 다시 한다. 이 파일의 상한 값은
// 사용자가 고르기 전에 미리 알려 주기 위한 것일 뿐, 방어선이 아니다.
//
// ── 서버에 무엇을 남기는가 ─────────────────────────────────────────────────
//
// 아무것도 남기지 않는다. 담은 파일은 적용할 때까지 **이 브라우저 탭의 메모리
// 에만** 있다. 미리보기도 적용도 파일 바이트를 그때그때 다시 보내고, 서버는
// 요청이 끝나면 버린다(서버 쪽 임시 저장소 · 캐시 · 스테이징 테이블이 없다).
// 적용 요청은 미리보기 결과를 싣지 않는다 — 서버가 처음부터 다시 검증한다.
//
// ── 요청 모양 ──────────────────────────────────────────────────────────────
//
// 파일마다 요청 하나. Vercel 요청 본문 상한이 4.5MB 라 4MB 파일 셋을 한 번에
// 실으면 넘을 수 있다. 파일별로 나누면 진행 상태도 파일마다 보여 줄 수 있다.
//
// 서버가 돌려주는 결과에는 거래 내용이 들어 있지 않다. 그래서 이 화면이 보여
// 줄 수 있는 것도 파일명 · 계좌 별명 · 조회기간 · 건수 · 경고뿐이다.
import Link from "next/link";
import { useEffect, useState } from "react";

const FILE_FIELD = "files";
const PASSWORD_FIELD = "password";
const MAX_FILE_COUNT = 3;
/** lib/import/statement.mjs 의 MAX_FILE_BYTES 와 같은 값. 서버가 다시 막는다. */
const MAX_FILE_BYTES = 4 * 1024 * 1024;
/** lib/xlsx/crypto.mjs 의 MAX_PASSWORD_LENGTH 와 같은 값. 서버가 다시 막는다. */
const MAX_PASSWORD_LENGTH = 255;

/**
 * 경고 코드 -> 사람이 읽는 문장. 서버는 코드만 보낸다.
 *
 * 앞 6개는 파싱 단계(lib/import/statement.mjs 의 collectWarnings)에서,
 * 뒤 2개는 분류 단계에서 나온다. 문장에는 거래 내용이 들어가지 않는다 —
 * 서버가 코드만 보내므로 여기서 지어낼 수 있는 것도 일반적인 설명뿐이다.
 */
const WARNING_TEXT: Record<string, string> = {
  truncationSuspected: "표시 상한에 걸려 뒷부분이 잘렸을 수 있습니다",
  timestampTies: "같은 시각에 여러 건이 있습니다",
  orderUnsorted: "행이 시간 순서대로 정렬되어 있지 않습니다",
  balanceMissing: "거래 후 잔액이 비어 있는 행이 있습니다",
  balanceMismatch: "잔액 검산이 맞지 않는 구간이 있습니다",
  jointAccount: "모임통장입니다",
  // 규칙을 읽지 못해 이 파일은 통째로 미분류로 처리된다. 거래는 들어간다.
  classificationSkipped: "분류 규칙을 읽지 못해 미분류로 처리합니다 (거래는 저장됩니다)",
  // 규칙 중 일부가 정규식으로 컴파일되지 않아 그 규칙만 건너뛰었다.
  rulePatternSkipped: "사용할 수 없는 분류 규칙이 있어 그 규칙만 건너뛰었습니다",
  // 비밀번호는 맞았지만 푼 파일의 무결성 서명이 맞지 않는다. 거래는 저장된다.
  decryptIntegrityMismatch:
    "암호를 푼 파일의 무결성 서명이 맞지 않습니다 (거래는 저장됩니다)",
  // 아래 5개는 lib/classify/pattern.mjs 가 규칙을 거부할 때 쓰는 코드다.
  // 지금 업로드 응답은 이것들을 rulePatternSkipped 하나로 묶어 보내지만,
  // 규칙별 사유를 내보내는 화면이 생기면 그대로 이 표를 쓴다.
  patternEmpty: "분류 규칙의 패턴이 비어 있습니다",
  patternTooLong: "분류 규칙의 패턴이 너무 깁니다",
  patternUnboundedQuantifier:
    "분류 규칙의 패턴에 끝이 열린 반복(*, +, {n,})이 있어 쓰지 않았습니다",
  patternRepeatTooLarge: "분류 규칙의 패턴에 반복 횟수가 너무 큰 부분이 있습니다",
  patternInvalid: "분류 규칙의 패턴이 올바른 정규식이 아닙니다",
};

/** 표에 없는 코드도 빈칸 대신 읽을 수 있는 문장으로 내보낸다. */
function warningText(code: string): string {
  const known = WARNING_TEXT[code];
  if (known !== undefined) return known;
  // 서버는 위 코드들만 보낸다. 여기 오는 것은 배포 시점이 어긋난 경우뿐이라
  // 코드를 그대로 덧붙여 둔다(코드는 스키마의 식별자이지 거래 내용이 아니다).
  const label = code.trim().slice(0, 64);
  return label === "" ? "알 수 없는 경고입니다" : `알 수 없는 경고입니다 (${label})`;
}

// ── 타입 ───────────────────────────────────────────────────────────────────

/** 앞 8바이트만 보고 브라우저에서 가른 파일 종류. 서버로는 아무것도 가지 않았다. */
type Sniff = "checking" | "encrypted" | "plain" | "invalid" | "tooLarge";

type Account = { role: string; nickname: string };
type Period = { from: string; to: string };

type PreviewData = {
  account: Account;
  period: Period;
  total: number;
  newCount: number;
  existingCount: number;
  unclassified: number;
  warnings: string[];
};

type ApplyData = {
  account: Account;
  period: Period;
  inserted: number;
  skipped: number;
  unclassified: number;
  warnings: string[];
};

type Failure = { code: string; message: string };

type Step<T> =
  | { status: "idle" }
  | { status: "running" }
  | { status: "ok"; data: T }
  | { status: "error"; failure: Failure };

type Staged = {
  /** 이름 · 크기 · 수정 시각으로 만든 키. 같은 파일을 두 번 담지 않으려는 것이다. */
  key: string;
  file: File;
  sniff: Sniff;
  preview: Step<PreviewData>;
  selected: boolean;
};

type AppliedResult = {
  key: string;
  filename: string;
  outcome: { ok: true; data: ApplyData } | { ok: false; failure: Failure };
};

// ── 도움 함수 ──────────────────────────────────────────────────────────────

function stageKey(file: File): string {
  return `${file.name}\u0000${file.size}\u0000${file.lastModified}`;
}

const OLE2_MAGIC = [0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1];
const ZIP_MAGIC = [0x50, 0x4b, 0x03, 0x04];

function startsWith(bytes: Uint8Array, magic: number[]): boolean {
  if (bytes.length < magic.length) return false;
  return magic.every((value, index) => bytes[index] === value);
}

/**
 * 파일 앞 8바이트만 읽어 종류를 가른다. 브라우저 안에서만 일어난다.
 *
 * 서버의 판정(lib/import/statement.mjs)이 최종이다. 이것은 "암호가 필요한지"
 * 를 미리 보여 주려는 것뿐이다.
 */
async function sniffFile(file: File): Promise<Sniff> {
  if (file.size > MAX_FILE_BYTES) return "tooLarge";
  try {
    const head = new Uint8Array(await file.slice(0, 8).arrayBuffer());
    if (startsWith(head, OLE2_MAGIC)) return "encrypted";
    if (startsWith(head, ZIP_MAGIC)) return "plain";
    return "invalid";
  } catch {
    return "invalid";
  }
}

function sizeLabel(bytes: number): string {
  if (bytes < 1024) return `${bytes}B`;
  if (bytes < 1024 * 1024) return `${Math.ceil(bytes / 1024)}KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)}MB`;
}

/** 조회기간(YYYY-MM-DD ~ YYYY-MM-DD)에 걸친 달 목록. 리포트 링크에 쓴다. */
function monthsOf(period: Period): string[] {
  const from = /^(\d{4})-(\d{2})/.exec(period.from);
  const to = /^(\d{4})-(\d{2})/.exec(period.to);
  if (from === null || to === null) return [];
  let year = Number(from[1]);
  let month = Number(from[2]);
  const endYear = Number(to[1]);
  const endMonth = Number(to[2]);
  const months: string[] = [];
  // 조회기간은 많아야 몇 달이다. 이상한 값이 와도 무한히 돌지 않게 묶는다.
  while ((year < endYear || (year === endYear && month <= endMonth)) && months.length < 12) {
    months.push(`${year}-${String(month).padStart(2, "0")}`);
    month += 1;
    if (month > 12) {
      month = 1;
      year += 1;
    }
  }
  return months;
}

function periodsOverlap(left: Period, right: Period): boolean {
  // YYYY-MM-DD 는 문자열 비교가 곧 날짜 비교다.
  return left.from <= right.to && right.from <= left.to;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object";
}

/**
 * 파일 하나를 서버로 보낸다. 미리보기든 적용이든 보내는 것은 같다 — 파일
 * 바이트와(필요하면) 비밀번호뿐이다. 건수 · 키 같은 것은 보내지 않는다.
 */
async function sendOne(
  mode: "preview" | "apply",
  file: File,
  password: string | null,
): Promise<{ ok: true; body: Record<string, unknown> } | { ok: false; failure: Failure }> {
  const data = new FormData();
  data.append(FILE_FIELD, file);
  if (password !== null && password.length > 0) data.append(PASSWORD_FIELD, password);

  let response: Response;
  try {
    response = await fetch(`/api/import?mode=${mode}`, {
      method: "POST",
      body: data,
      cache: "no-store",
    });
  } catch {
    // 네트워크 오류. 원인 객체는 화면에도 콘솔에도 내보내지 않는다.
    return {
      ok: false,
      failure: { code: "network", message: "서버에 연결하지 못했습니다. 잠시 후 다시 시도해 주세요." },
    };
  }

  const payload: unknown = await response.json().catch(() => null);
  if (!response.ok) {
    const message =
      isRecord(payload) && typeof payload.error === "string"
        ? payload.error
        : "요청을 처리하지 못했습니다.";
    return { ok: false, failure: { code: `http${response.status}`, message } };
  }

  const result = isRecord(payload) && isRecord(payload.result) ? payload.result : null;
  if (result === null) {
    return { ok: false, failure: { code: "badResponse", message: "서버 응답을 읽지 못했습니다." } };
  }
  if (result.ok !== true) {
    return {
      ok: false,
      failure: {
        code: typeof result.error === "string" ? result.error : "unknown",
        message: typeof result.message === "string" ? result.message : "처리하지 못했습니다.",
      },
    };
  }
  return { ok: true, body: result };
}

// ── 화면 조각 ──────────────────────────────────────────────────────────────

const SNIFF_LABEL: Record<Sniff, string> = {
  checking: "확인 중",
  encrypted: "🔒 암호 필요",
  plain: "암호 없음",
  invalid: "형식 오류 (xlsx 가 아님)",
  tooLarge: "형식 오류 (4MB 초과)",
};

function PreviewStatus({ step }: { step: Step<PreviewData> }) {
  switch (step.status) {
    case "idle":
      return <span className="text-zinc-500">대기</span>;
    case "running":
      return <span className="text-zinc-500">확인 중…</span>;
    case "ok":
      return <span className="text-emerald-700 dark:text-emerald-400">성공</span>;
    case "error":
      return (
        <span className="text-red-700 dark:text-red-400">
          오류 · {step.failure.message}
        </span>
      );
  }
}

function Warnings({ codes }: { codes: string[] }) {
  if (codes.length === 0) return null;
  return (
    <ul className="list-inside list-disc text-xs text-amber-700 dark:text-amber-400">
      {codes.map((code) => (
        <li key={code}>{warningText(code)}</li>
      ))}
    </ul>
  );
}

// ── 본체 ───────────────────────────────────────────────────────────────────

export function ImportForm() {
  const [staged, setStaged] = useState<Staged[]>([]);
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState<null | "preview" | "apply">(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [dragging, setDragging] = useState(false);
  const [applied, setApplied] = useState<AppliedResult[] | null>(null);

  // 화면을 떠날 때 비밀번호를 비운다. 상태는 컴포넌트와 함께 사라지지만,
  // 그 전제에 기대지 않고 명시적으로 지워 둔다.
  useEffect(() => {
    return () => setPassword("");
  }, []);

  const needsPassword = staged.some((item) => item.sniff === "encrypted");

  function patch(key: string, change: (item: Staged) => Staged) {
    setStaged((list) => list.map((item) => (item.key === key ? change(item) : item)));
  }

  // ① 담기. 여러 번 골라도 쌓인다(폴더가 달라도 된다). 같은 파일은 한 번만.
  function addFiles(files: FileList | File[] | null) {
    if (files === null || busy !== null) return;
    const incoming = Array.from(files);
    if (incoming.length === 0) return;
    setApplied(null);

    const known = new Set(staged.map((item) => item.key));
    const fresh: Staged[] = [];
    let duplicates = 0;
    let overflow = 0;
    for (const file of incoming) {
      const key = stageKey(file);
      if (known.has(key)) {
        duplicates += 1;
        continue;
      }
      if (staged.length + fresh.length >= MAX_FILE_COUNT) {
        overflow += 1;
        continue;
      }
      known.add(key);
      fresh.push({ key, file, sniff: "checking", preview: { status: "idle" }, selected: false });
    }

    const notes: string[] = [];
    if (overflow > 0) {
      notes.push(`최대 ${MAX_FILE_COUNT}개까지 담을 수 있어 ${overflow}개는 담지 않았습니다.`);
    }
    if (duplicates > 0) notes.push(`이미 담긴 파일 ${duplicates}개는 건너뛰었습니다.`);
    setNotice(notes.length > 0 ? notes.join(" ") : null);

    if (fresh.length === 0) return;
    setStaged((list) => [...list, ...fresh]);
    for (const item of fresh) {
      void sniffFile(item.file).then((sniff) => patch(item.key, (current) => ({ ...current, sniff })));
    }
  }

  function removeFile(key: string) {
    if (busy !== null) return;
    const next = staged.filter((item) => item.key !== key);
    setStaged(next);
    // 암호 걸린 파일이 하나도 남지 않으면 비밀번호도 들고 있을 이유가 없다.
    if (!next.some((item) => item.sniff === "encrypted")) setPassword("");
    setNotice(null);
  }

  function onPasswordChange(value: string) {
    setPassword(value);
    // 비밀번호가 바뀌면 암호 걸린 파일의 이전 미리보기는 더 이상 믿을 수 없다.
    setStaged((list) =>
      list.map((item) =>
        item.sniff === "encrypted" && item.preview.status !== "idle"
          ? { ...item, preview: { status: "idle" }, selected: false }
          : item,
      ),
    );
  }

  const previewTargets = staged.filter(
    (item) =>
      (item.sniff === "encrypted" || item.sniff === "plain") &&
      item.preview.status !== "ok" &&
      item.preview.status !== "running",
  );

  // ② 미리보기. 파일마다 요청 하나. 아직 성공하지 않은 파일만 다시 본다.
  async function runPreview() {
    if (busy !== null || previewTargets.length === 0) return;
    setBusy("preview");
    setNotice(null);
    setApplied(null);
    try {
      for (const item of previewTargets) {
        // 비밀번호 없이 암호 걸린 파일을 보내 봐야 서버가 같은 말을 한다.
        // 파일 바이트를 보내지 않고 여기서 멈춘다.
        if (item.sniff === "encrypted" && password.length === 0) {
          patch(item.key, (current) => ({
            ...current,
            preview: {
              status: "error",
              failure: { code: "encrypted", message: "파일 비밀번호를 입력해 주세요." },
            },
            selected: false,
          }));
          continue;
        }
        patch(item.key, (current) => ({ ...current, preview: { status: "running" }, selected: false }));
        const sent = await sendOne(
          "preview",
          item.file,
          item.sniff === "encrypted" ? password : null,
        );
        if (!sent.ok) {
          patch(item.key, (current) => ({
            ...current,
            preview: { status: "error", failure: sent.failure },
            selected: false,
          }));
          continue;
        }
        const data = sent.body as unknown as PreviewData;
        patch(item.key, (current) => ({
          ...current,
          preview: { status: "ok", data },
          // 새로 들어갈 거래가 있을 때만 기본으로 체크한다.
          selected: data.newCount > 0,
        }));
      }
    } finally {
      setBusy(null);
    }
  }

  const applyTargets = staged.filter((item) => item.selected && item.preview.status === "ok");

  // ③ 적용. 체크한 파일만, 파일마다 요청 하나. 서버는 처음부터 다시 검증한다.
  async function runApply() {
    if (busy !== null || applyTargets.length === 0) return;
    setBusy("apply");
    setNotice(null);
    const results: AppliedResult[] = [];
    try {
      for (const item of applyTargets) {
        const sent = await sendOne(
          "apply",
          item.file,
          item.sniff === "encrypted" ? password : null,
        );
        results.push({
          key: item.key,
          filename: item.file.name,
          outcome: sent.ok
            ? { ok: true, data: sent.body as unknown as ApplyData }
            : { ok: false, failure: sent.failure },
        });
      }
    } finally {
      // 적용이 끝나면 성공 여부와 상관없이 비밀번호를 비운다.
      setPassword("");
      setBusy(null);
    }

    setApplied(results);
    const succeeded = new Set(results.filter((r) => r.outcome.ok).map((r) => r.key));
    if (succeeded.size === results.length) {
      // 전부 성공했으면 담아 둔 파일을 비운다. 브라우저 메모리에서도 놓아준다.
      setStaged([]);
    } else {
      // 성공한 파일만 빼고, 실패한 파일은 다시 확인할 수 있게 남긴다.
      setStaged((list) =>
        list
          .filter((item) => !succeeded.has(item.key))
          .map((item) => ({ ...item, preview: { status: "idle" }, selected: false })),
      );
    }
  }

  // 같은 계좌로 풀린 파일이 둘 이상이면 알려 준다(겹치는 거래는 중복으로 건너뛴다).
  const accountNotes: string[] = [];
  const previewed = staged.flatMap((item) =>
    item.preview.status === "ok" ? [{ item, data: item.preview.data }] : [],
  );
  for (let i = 0; i < previewed.length; i += 1) {
    for (let j = i + 1; j < previewed.length; j += 1) {
      const left = previewed[i];
      const right = previewed[j];
      if (left.data.account.role !== right.data.account.role) continue;
      const overlap = periodsOverlap(left.data.period, right.data.period);
      accountNotes.push(
        `${left.item.file.name} 와 ${right.item.file.name} 가 같은 계좌(${left.data.account.nickname})입니다` +
          (overlap ? " · 조회기간이 겹칩니다. 겹치는 거래는 한 번만 저장됩니다." : "."),
      );
    }
  }

  const locked = busy !== null;

  return (
    <div className="flex flex-col gap-8">
      {/* ① 담기 */}
      <section className="flex flex-col gap-3">
        <h2 className="text-sm font-medium text-zinc-700 dark:text-zinc-300">
          ① 파일 담기 (최대 {MAX_FILE_COUNT}개)
        </h2>
        <div
          onDragOver={(event) => {
            event.preventDefault();
            if (!locked) setDragging(true);
          }}
          onDragLeave={() => setDragging(false)}
          onDrop={(event) => {
            event.preventDefault();
            setDragging(false);
            addFiles(event.dataTransfer.files);
          }}
          className={`flex flex-col items-start gap-2 rounded-md border border-dashed p-4 text-sm ${
            dragging
              ? "border-zinc-900 bg-zinc-50 dark:border-zinc-100 dark:bg-zinc-900"
              : "border-zinc-300 dark:border-zinc-700"
          }`}
        >
          <input
            type="file"
            accept=".xlsx,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
            multiple
            disabled={locked || staged.length >= MAX_FILE_COUNT}
            onChange={(event) => {
              addFiles(event.currentTarget.files);
              // 같은 파일을 지웠다가 다시 고를 수 있도록 선택값을 비운다.
              event.currentTarget.value = "";
            }}
            className="text-sm file:mr-3 file:rounded-md file:border file:border-zinc-300 file:bg-transparent file:px-3 file:py-2 file:text-sm dark:file:border-zinc-700"
          />
          <p className="text-xs text-zinc-500">
            여기로 끌어다 놓아도 됩니다. 여러 번 골라도 쌓입니다 — 폴더가 달라도 됩니다.
            한 파일당 4MB 까지. 담기만 해서는 아무것도 서버로 보내지 않습니다.
          </p>
        </div>

        {notice !== null ? (
          <p role="status" className="text-sm text-amber-700 dark:text-amber-400">
            {notice}
          </p>
        ) : null}

        {staged.length > 0 ? (
          <table className="w-full text-left text-sm">
            <thead className="text-xs text-zinc-500">
              <tr>
                <th className="py-1 pr-2 font-normal">적용</th>
                <th className="py-1 pr-2 font-normal">파일</th>
                <th className="py-1 pr-2 font-normal">암호</th>
                <th className="py-1 pr-2 font-normal">미리보기</th>
                <th className="py-1 font-normal" />
              </tr>
            </thead>
            <tbody>
              {staged.map((item) => {
                const ok = item.preview.status === "ok" ? item.preview.data : null;
                return (
                  <tr key={item.key} className="border-t border-zinc-200 align-top dark:border-zinc-800">
                    <td className="py-2 pr-2">
                      <input
                        type="checkbox"
                        aria-label={`${item.file.name} 적용`}
                        checked={item.selected}
                        disabled={locked || ok === null}
                        onChange={(event) => {
                          const checked = event.currentTarget.checked;
                          patch(item.key, (current) => ({ ...current, selected: checked }));
                        }}
                      />
                    </td>
                    <td className="py-2 pr-2">
                      <p className="break-all">{item.file.name}</p>
                      <p className="text-xs text-zinc-500">{sizeLabel(item.file.size)}</p>
                      {ok !== null ? (
                        <div className="mt-1 flex flex-col gap-1 text-xs text-zinc-700 dark:text-zinc-300">
                          <p>
                            {ok.account.nickname} · {ok.period.from} ~ {ok.period.to} · 전체 {ok.total}건
                          </p>
                          <p>
                            신규 예정 <strong>{ok.newCount}</strong>건 · 이미 있음 {ok.existingCount}건 ·
                            미분류 예상 {ok.unclassified}건
                          </p>
                          <Warnings codes={ok.warnings} />
                        </div>
                      ) : null}
                    </td>
                    <td className="py-2 pr-2 whitespace-nowrap">{SNIFF_LABEL[item.sniff]}</td>
                    <td className="py-2 pr-2">
                      {item.sniff === "invalid" || item.sniff === "tooLarge" ? (
                        <span className="text-zinc-500">보낼 수 없음</span>
                      ) : (
                        <PreviewStatus step={item.preview} />
                      )}
                    </td>
                    <td className="py-2 text-right">
                      <button
                        type="button"
                        onClick={() => removeFile(item.key)}
                        disabled={locked}
                        className="text-xs text-zinc-600 underline underline-offset-4 hover:text-zinc-900 disabled:opacity-50 dark:text-zinc-400"
                      >
                        빼기
                      </button>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        ) : null}

        {needsPassword ? (
          <div className="flex w-full flex-col gap-1">
            <label htmlFor="statement-password" className="text-sm text-zinc-700 dark:text-zinc-300">
              파일 비밀번호
            </label>
            <input
              id="statement-password"
              type="password"
              name={PASSWORD_FIELD}
              // 브라우저 비밀번호 관리자가 저장 · 자동 입력을 제안하도록 둔다.
              // 이 값을 기억해 주는 곳은 브라우저뿐이다 — 서버는 저장하지 않는다.
              autoComplete="current-password"
              maxLength={MAX_PASSWORD_LENGTH}
              value={password}
              onChange={(event) => onPasswordChange(event.currentTarget.value)}
              disabled={locked}
              className="w-full max-w-xs rounded-md border border-zinc-300 bg-transparent px-3 py-2 text-sm dark:border-zinc-700"
            />
            <p className="text-xs text-zinc-500 dark:text-zinc-500">
              암호가 걸린 파일이 있습니다. 세 파일 모두 같은 비밀번호로 풉니다.{" "}
              <strong className="font-medium">비밀번호는 서버에 저장하지 않습니다.</strong>{" "}
              요청마다 한 번 쓰고 바로 버리며, 적용이 끝나면 이 입력칸도 비웁니다.
            </p>
          </div>
        ) : null}
      </section>

      {/* ② 미리보기 */}
      <section className="flex flex-col gap-2">
        <h2 className="text-sm font-medium text-zinc-700 dark:text-zinc-300">② 미리보기</h2>
        <p className="text-xs text-zinc-500">
          파일마다 비밀번호 · 계좌 · 건수를 확인합니다. 이 단계에서는 아무것도 저장하지 않습니다.
          오류가 난 파일은 고친 뒤 다시 누르면 그 파일만 다시 확인합니다.
        </p>
        <div>
          <button
            type="button"
            onClick={() => void runPreview()}
            disabled={locked || previewTargets.length === 0}
            className="rounded-md border border-zinc-300 px-4 py-2 text-sm font-medium hover:bg-zinc-50 disabled:opacity-50 dark:border-zinc-700 dark:hover:bg-zinc-900"
          >
            {busy === "preview" ? "확인 중…" : `미리보기 (${previewTargets.length}개)`}
          </button>
        </div>
        {accountNotes.length > 0 ? (
          <ul role="status" className="list-inside list-disc text-sm text-amber-700 dark:text-amber-400">
            {accountNotes.map((note) => (
              <li key={note}>{note}</li>
            ))}
          </ul>
        ) : null}
      </section>

      {/* ③ 적용 */}
      <section className="flex flex-col gap-2">
        <h2 className="text-sm font-medium text-zinc-700 dark:text-zinc-300">③ 월별 현금흐름에 적용</h2>
        <p className="text-xs text-zinc-500">
          체크한 파일만 저장합니다. 서버가 파일을 처음부터 다시 검사한 뒤 저장하고, 이미 있는
          거래는 중복으로 건너뜁니다.
        </p>
        <div>
          <button
            type="button"
            onClick={() => void runApply()}
            disabled={locked || applyTargets.length === 0}
            className="rounded-md bg-zinc-900 px-4 py-2 text-sm font-medium text-white hover:bg-zinc-700 disabled:opacity-50 dark:bg-zinc-100 dark:text-zinc-900 dark:hover:bg-zinc-300"
          >
            {busy === "apply" ? "적용 중…" : `적용 (${applyTargets.length}개)`}
          </button>
        </div>
      </section>

      {applied !== null ? (
        <section className="flex flex-col gap-3">
          <h2 className="text-sm font-medium text-zinc-700 dark:text-zinc-300">적용 결과</h2>
          <ul className="flex flex-col gap-3">
            {applied.map((result) => (
              <li
                key={result.key}
                className={`rounded-md border p-4 text-sm ${
                  result.outcome.ok
                    ? "border-zinc-300 dark:border-zinc-700"
                    : "border-red-400 bg-red-50 dark:bg-red-950/30"
                }`}
              >
                <p className="font-medium break-all">
                  {result.outcome.ok ? "성공" : "오류"} · {result.filename}
                </p>
                {result.outcome.ok ? (
                  <div className="mt-2 flex flex-col gap-1 text-zinc-700 dark:text-zinc-300">
                    <p>
                      {result.outcome.data.account.nickname} · {result.outcome.data.period.from} ~{" "}
                      {result.outcome.data.period.to}
                    </p>
                    <p>
                      저장 {result.outcome.data.inserted}건 · 중복 {result.outcome.data.skipped}건
                    </p>
                    {result.outcome.data.unclassified > 0 ? (
                      <p className="text-amber-700 dark:text-amber-400">
                        이 파일에 미분류 거래가 {result.outcome.data.unclassified}건 있습니다.{" "}
                        {monthsOf(result.outcome.data.period).map((month) => (
                          <Link
                            key={month}
                            href={`/classify?month=${month}`}
                            className="mr-2 underline underline-offset-4"
                          >
                            {month} 분류 정리
                          </Link>
                        ))}
                      </p>
                    ) : null}
                    <Warnings codes={result.outcome.data.warnings} />
                    <p className="flex flex-wrap gap-3">
                      {monthsOf(result.outcome.data.period).map((month) => (
                        <Link
                          key={month}
                          href={`/report?month=${month}`}
                          className="underline underline-offset-4 hover:text-zinc-900 dark:hover:text-zinc-100"
                        >
                          {month} 리포트 보기
                        </Link>
                      ))}
                    </p>
                  </div>
                ) : (
                  <p className="mt-2 text-red-700 dark:text-red-400">{result.outcome.failure.message}</p>
                )}
              </li>
            ))}
          </ul>
        </section>
      ) : null}
    </div>
  );
}
