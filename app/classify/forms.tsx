"use client";

// /classify 의 입력 조각. 서버로 보내는 것은 달 · 계좌 역할(main · fixed ·
// emergency) · 묶음 키(정규화한 적요) · 방향 · 분류 · 항목 · 범위뿐이다. 행 id · 건수 · 금액은 보내지 않는다 — 서버가 그 달의
// 행을 직접 다시 읽어 묶음을 찾는다(lib/classify/manual.mjs). 방향도 서버가 저장된
// 금액에서 다시 계산해 맞춰 본다.
//
// console 호출이 이 파일에 없다. 실패하면 서버가 준 고정 문장만 보여 준다.
import { useRouter } from "next/navigation";
import { useEffect, useId, useState, useTransition, type FormEvent } from "react";

import { compileWildcard, parseWildcardPattern, suggestPattern, wildcardMatches } from "@/lib/classify/wildcard.mjs";

import { accountLabel, type GroupAccount } from "./account-label";

/** 묶음의 방향. 매핑에는 방향 구분 전의 `any` 가 더 있다. */
export type Direction = "in" | "out";
export type MappingDirection = Direction | "any";

export type ClassifyGroup = {
  account: GroupAccount | null;
  key: string;
  /** 묶음의 메모(정규화). 메모 없는 묶음은 null. */
  memo: string | null;
  direction: Direction;
  count: number;
  total: number;
  unclassified: number;
  transferIn: number;
  vault: number;
  transfer: number;
  manual: number;
  mixed: boolean;
  category: string | null;
  item: string | null;
  mixedItem: boolean;
  source: string | null;
};

export type SavedPattern = {
  pattern: string;
  direction: MappingDirection;
  category: string;
  item: string | null;
  updatedAt: string;
};

export type MemoMapping = {
  memo: string;
  direction: Direction;
  category: string;
  item: string | null;
  updatedAt: string;
};

export type Mapping = {
  key: string;
  direction: MappingDirection;
  category: string;
  item: string | null;
  updatedAt: string;
};

const FLOW = new Intl.NumberFormat("ko-KR", { signDisplay: "exceptZero" });

/** 항목 이름 상한(lib/classify/item.mjs 의 ITEM_MAX_LENGTH). 넘는 메모는 항목 기본값으로 쓰지 않는다. */
const ITEM_LIMIT = 40;

/** 전체 기간 보기에서 묶음이 속한 달. */
function MonthBadge({ month }: { month: string }) {
  return (
    <span
      data-testid="group-month"
      className="mr-2 inline-block rounded border border-line-strong bg-subtle px-1.5 py-0.5 align-middle text-xs font-medium text-fg tabular-nums"
    >
      {month}
    </span>
  );
}

/** 묶음 이름 아래의 메모 — 작은 회색 글씨(report 의 항목 줄과 같은 모양). */
function GroupMemo({ memo }: { memo: string | null }) {
  if (memo === null) return null;
  return (
    <span data-testid="group-memo" className="block text-xs font-normal text-faint">
      메모: {memo}
    </span>
  );
}
const INPUT =
  "h-8 rounded-md border border-control bg-canvas px-2 text-[13px]";
const BUTTON =
  "h-8 rounded-md border border-line-strong bg-canvas px-3 text-[13px] font-medium hover:bg-hover disabled:cursor-not-allowed disabled:opacity-50";

/** lib/classify/direction.mjs 의 DIRECTION_LABELS 와 같은 이름. */
const DIRECTION_TEXT: Record<string, string> = {
  in: "입금",
  out: "출금",
  any: "방향 무관",
};

const DIRECTION_BADGE: Record<string, string> = {
  in: "border border-ok-line bg-ok-bg text-ok",
  out: "border border-line-strong bg-subtle text-neg",
  any: "border border-line bg-subtle text-soft",
};

function DirectionBadge({ direction }: { direction: string }) {
  return (
    <span
      data-testid="direction"
      className={`mr-2 inline-block rounded px-1.5 py-0.5 align-middle text-xs font-normal ${DIRECTION_BADGE[direction] ?? DIRECTION_BADGE.any}`}
    >
      {DIRECTION_TEXT[direction] ?? DIRECTION_TEXT.any}
    </span>
  );
}

const SOURCE_TEXT: Record<string, string> = {
  rule: "규칙",
  map: "매핑",
  manual: "이번만",
};

type Status = { kind: "idle" } | { kind: "busy" } | { kind: "done"; text: string } | { kind: "error"; text: string };

async function post(url: string, body: unknown): Promise<{ ok: boolean; data: Record<string, unknown> }> {
  const response = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
    cache: "no-store",
  });
  let data: Record<string, unknown> = {};
  try {
    data = (await response.json()) as Record<string, unknown>;
  } catch {
    data = {};
  }
  return { ok: response.ok && data.ok === true, data };
}

function failureText(data: Record<string, unknown>): string {
  return typeof data.message === "string" ? data.message : "저장하지 못했습니다.";
}

function StatusLine({ status }: { status: Status }) {
  if (status.kind === "done") {
    return (
      <p role="status" className="text-xs text-ok">
        {status.text}
      </p>
    );
  }
  if (status.kind === "error") {
    return (
      <p role="alert" className="text-xs text-danger">
        {status.text}
      </p>
    );
  }
  return null;
}

function CategorySelect({
  id,
  value,
  onChange,
  categories,
}: {
  id: string;
  value: string;
  onChange: (value: string) => void;
  categories: string[];
}) {
  return (
    <select id={id} value={value} onChange={(event) => onChange(event.target.value)} className={INPUT} required>
      <option value="" disabled>
        분류 선택
      </option>
      {categories.map((category) => (
        <option key={category} value={category}>
          {category}
        </option>
      ))}
    </select>
  );
}

const ACCOUNT_BADGE: Record<string, string> = {
  main: "border-line-strong text-soft",
  fixed: "border-warn-line bg-warn-bg text-warn",
  emergency: "border-danger-line bg-danger-bg text-danger",
};

function AccountBadge({ account }: { account: GroupAccount | null }) {
  return (
    <span
      data-testid="account"
      className={`mr-2 inline-block rounded border px-1.5 py-0.5 align-middle text-xs font-normal ${ACCOUNT_BADGE[account?.role ?? ""] ?? ACCOUNT_BADGE.main}`}
    >
      {accountLabel(account)}
    </span>
  );
}

/**
 * 묶음 머리의 짧은 상태 꼬리표(2026-09: 묶음 아래 설명 문단을 걷어 내고 둔다).
 * `hint` 는 마우스를 올리면 보이고(title) 화면 읽기 프로그램에는 괄호 안 글로 읽힌다.
 */
function GroupHint({ text, hint, tone = "accent" }: { text: string; hint: string; tone?: "accent" | "warn" }) {
  return (
    <span
      title={hint}
      data-testid="group-hint"
      className={`rounded border px-1 tabular-nums ${
        tone === "warn" ? "border-warn-line bg-warn-bg text-warn" : "border-line bg-accent-bg text-accent-text"
      }`}
    >
      {text}
      <span className="sr-only"> ({hint})</span>
    </span>
  );
}

/**
 * 한 묶음의 입력. 분류는 드롭다운 하나로만 고른다(예전 ‘기타’ 는 ‘변동비’ 로 합쳤다).
 *
 * ── 빠르게 보이기(2026-09) ──
 *
 * 예전에는 POST 가 끝날 때까지 기다린 뒤 `router.refresh()` 가 끝날 때까지 화면이
 * 그대로였다. 이제:
 *   - `hideOnApply`(= ‘미분류만’ 보기)이면 적용을 누르는 즉시 이 묶음을 목록에서
 *     접는다(낙관적 제거). 분류를 고른 묶음은 어차피 미분류 목록에서 빠진다.
 *   - 서버가 거절하거나 연결이 끊기면 접은 것을 되돌리고 서버가 준 문장을 보여 준다.
 *     분류가 맞는지는 늘 서버가 정한다(lib/classify/manual.mjs 가 다시 검사한다) —
 *     여기서 접는 것은 화면의 예상일 뿐이다.
 *   - 성공하면 목록 새로 고침을 `startTransition` 안에서 한다. 새로 고치는 동안에도
 *     다른 묶음을 계속 고를 수 있다.
 */
export function GroupForm({
  month,
  group,
  categories,
  hideOnApply = false,
  showMonth = false,
}: {
  month: string;
  group: ClassifyGroup;
  categories: string[];
  hideOnApply?: boolean;
  /** 전체 기간 보기: 묶음이 속한 달을 이름 앞에 붙인다(이번만이 그 달에만 적용된다). */
  showMonth?: boolean;
}) {
  const router = useRouter();
  const [, startTransition] = useTransition();
  // 낙관적으로 접었는가. 실패하면 false 로 되돌린다.
  const [collapsed, setCollapsed] = useState(false);
  const [category, setCategory] = useState(
    !group.mixed && group.category !== null && categories.includes(group.category) ? group.category : "",
  );
  // 항목 기본값: 사람이 이미 정한 항목 -> (메모가 있으면) 메모 -> 적요. 메모가 항목 이름인
  // 경우가 많다(예: 적요는 보낸 사람 이름, 메모는 `길동 IRP`).
  const memoAsItem = group.memo !== null && [...group.memo].length <= ITEM_LIMIT ? group.memo : null;
  const [item, setItem] = useState(
    !group.mixedItem && group.item !== null && group.item !== group.key ? group.item : (memoAsItem ?? group.key),
  );
  const [scope, setScope] = useState<"once" | "always">("once");
  // ‘앞으로도’ 의 기준. 메모가 있는 묶음에서만 메모를 고를 수 있다.
  const [basis, setBasis] = useState<"description" | "memo">("description");
  const byMemo = scope === "always" && basis === "memo" && group.memo !== null;
  // 적요 패턴으로 저장(앞으로도에서만). 입력칸은 적요에서 만든 제안으로 미리 채운다.
  const [usePattern, setUsePattern] = useState(false);
  const [pattern, setPattern] = useState(() => suggestPattern(group.key));
  const [status, setStatus] = useState<Status>({ kind: "idle" });

  // id 에 적요를 넣지 않는다(DOM id 에 한글·공백이 섞이면 label 연결이 깨진다).
  const uid = useId();

  async function send() {
    const chosen = category;
    if (chosen === "") {
      setStatus({ kind: "error", text: "분류를 골라 주세요." });
      return;
    }
    setStatus({ kind: "busy" });
    if (hideOnApply) setCollapsed(true);
    try {
      const { ok, data } = await post("/api/classify", {
        scope,
        month,
        account: group.account?.role,
        key: group.key,
        memo: group.memo,
        basis: byMemo ? "memo" : undefined,
        direction: group.direction,
        category: chosen,
        item,
        // '이번만'에서는 뜻이 없다(JSON.stringify 가 undefined 키를 뺀다).
        // 패턴은 '앞으로도' 에서만 보낸다. 서버가 같은 규칙으로 다시 검사하고, 지금 고른
        // 적요와 맞는지도 서버가 확인한다.
        pattern: scope === "always" && usePattern && !byMemo ? pattern : undefined,
      });
      if (!ok) {
        setCollapsed(false);
        setStatus({ kind: "error", text: failureText(data) });
        return;
      }
      setStatus({
        kind: "done",
        text: `${String(data.updated ?? 0)}건에 적용했습니다${data.mapped === true ? " · 매핑 저장" : ""}.`,
      });
      startTransition(() => router.refresh());
    } catch {
      setCollapsed(false);
      setStatus({ kind: "error", text: "서버에 연결하지 못했습니다." });
    }
  }

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    void send();
  }

  const current = group.mixed
    ? "혼합"
    : group.category === null
      ? "미분류"
      : `${group.category}${group.source !== null ? ` (${SOURCE_TEXT[group.source] ?? group.source})` : ""}`;

  if (collapsed) {
    // 낙관적으로 접은 자리. 새로 고침이 끝나면 서버 목록에서 이 묶음이 빠져 사라진다.
    return (
      <div
        data-testid="classify-group-applied"
        className="flex flex-wrap items-baseline justify-between gap-2 rounded-lg border border-dashed border-line-strong px-3 py-2 text-xs text-muted"
      >
        <span className="break-all">
          {showMonth ? <MonthBadge month={month} /> : null}
          <AccountBadge account={group.account} />
          <DirectionBadge direction={group.direction} />
          {group.key}
          <GroupMemo memo={group.memo} />
        </span>
        <span role="status">
          {status.kind === "done" ? `✓ ${status.text}` : `‘${category}’ 적용 중…`}
        </span>
      </div>
    );
  }

  return (
    <form
      onSubmit={submit}
      data-testid="classify-group"
      className="flex flex-col gap-2 rounded-lg border border-line bg-canvas p-3 text-[13px]"
    >
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <p className="font-medium break-all">
          {showMonth ? <MonthBadge month={month} /> : null}
          <AccountBadge account={group.account} />
          <DirectionBadge direction={group.direction} />
          {group.key}
          <GroupMemo memo={group.memo} />
        </p>
        <p className="tabular-nums text-muted">
          {group.count}건 · {FLOW.format(group.total)}원
        </p>
      </div>
      <p className="flex flex-wrap items-center gap-1.5 text-xs text-muted" data-testid="group-meta">
        <span
          data-testid="group-current"
          className={`rounded border px-1 ${
            group.category === null && !group.mixed
              ? "border-warn-line bg-warn-bg text-warn"
              : "border-line bg-subtle text-soft"
          }`}
        >
          {current}
        </span>
        {/* 미분류 묶음의 항목은 적요 그대로라 같은 글자를 두 번 쓰지 않는다. */}
        {group.mixedItem || (group.item !== null && group.item !== group.key) ? (
          <span>항목 {group.mixedItem ? "혼합" : group.item}</span>
        ) : null}
        {group.unclassified > 0 && group.unclassified < group.count ? (
          <span className="tabular-nums">미분류 {group.unclassified}건</span>
        ) : null}
        {group.manual > 0 ? <span className="tabular-nums">이번만 {group.manual}건</span> : null}
        {group.transferIn > 0 ? (
          <GroupHint text={`이체 입금 ${group.transferIn}`} hint="메인에서 옮겨 온 돈 · 미분류 아님" />
        ) : null}
        {group.vault > 0 ? (
          <GroupHint
            text={`${group.direction === "out" ? "금고저축" : "금고 인출"} ${group.vault}`}
            hint={group.direction === "out" ? "계좌 → 금고 · 미분류 아님" : "금고 → 계좌 · 미분류 아님"}
          />
        ) : null}
        {group.transfer > 0 ? (
          <GroupHint text={`계좌간 이동 ${group.transfer}`} hint="분류와 무관하게 계좌간이동으로 집계" tone="warn" />
        ) : null}
      </p>
      <div className="flex flex-wrap items-center gap-2">
        <label htmlFor={`category-${uid}`} className="text-xs text-muted">
          분류
        </label>
        <CategorySelect id={`category-${uid}`} value={category} onChange={setCategory} categories={categories} />
        <label htmlFor={`item-${uid}`} className="text-xs text-muted">
          항목
        </label>
        <input
          id={`item-${uid}`}
          type="text"
          value={item}
          onChange={(event) => setItem(event.target.value)}
          className={`${INPUT} min-w-0 flex-1`}
          autoComplete="off"
        />
      </div>
      <div className="flex flex-wrap items-center gap-4">
        <fieldset className="flex items-center gap-3">
          <legend className="sr-only">적용 범위</legend>
          <label className="flex items-center gap-1">
            <input
              type="radio"
              name={`scope-${uid}`}
              value="once"
              checked={scope === "once"}
              onChange={() => setScope("once")}
            />
            {showMonth ? `이번만(${month})` : "이번만"}
          </label>
          <label className="flex items-center gap-1">
            <input
              type="radio"
              name={`scope-${uid}`}
              value="always"
              checked={scope === "always"}
              onChange={() => setScope("always")}
            />
            앞으로도
          </label>
        </fieldset>
        {scope === "always" && group.memo !== null ? (
          <fieldset className="flex items-center gap-3 text-xs text-muted" data-testid="basis">
            <legend className="sr-only">앞으로도 기준</legend>
            <label className="flex items-center gap-1">
              <input
                type="radio"
                name={`basis-${uid}`}
                value="description"
                checked={basis === "description"}
                onChange={() => setBasis("description")}
              />
              적요 기준
            </label>
            <label className="flex items-center gap-1">
              <input
                type="radio"
                name={`basis-${uid}`}
                value="memo"
                checked={basis === "memo"}
                onChange={() => setBasis("memo")}
              />
              이 메모 기준
            </label>
          </fieldset>
        ) : null}
        {scope === "always" && !byMemo ? (
          <label className="flex items-center gap-1 text-xs text-muted">
            <input type="checkbox" checked={usePattern} onChange={(event) => setUsePattern(event.target.checked)} />
            패턴으로 저장
          </label>
        ) : null}
        <button type="submit" className={BUTTON} disabled={status.kind === "busy"}>
          {status.kind === "busy" ? "저장 중…" : "적용"}
        </button>
      </div>
      {scope === "always" && usePattern && !byMemo ? (
        <PatternEditor
          id={`pattern-${uid}`}
          value={pattern}
          onChange={setPattern}
          groupKey={group.key}
          direction={group.direction}
        />
      ) : null}
      <StatusLine status={status} />
    </form>
  );
}

/** lib/classify/wildcard.mjs 의 거부 코드 -> 화면 문장(서버의 CLASSIFY_ERROR_MESSAGES 와 같은 뜻). */
const PATTERN_ERROR_TEXT: Record<string, string> = {
  patternNotString: "패턴 형식이 올바르지 않습니다.",
  patternControlChars: "패턴에 쓸 수 없는 문자가 들어 있습니다.",
  patternEmpty: "패턴을 입력해 주세요.",
  patternTooLong: "패턴은 64자까지 쓸 수 있습니다.",
  patternTooManyWildcards: "* 는 4개, # 는 16개까지 쓸 수 있습니다.",
  patternNoWildcard: "바뀌는 자리를 # (숫자 한 자리) 나 * (아무 글자) 로 바꿔 주세요.",
  patternTooFewLiterals: "# · * 가 아닌 글자가 2개 이상 있어야 합니다.",
};

type Preview = {
  in: { count: number; manual: number; distinct: number; samples: string[] };
  out: { count: number; manual: number; distinct: number; samples: string[] };
};

/**
 * 패턴 입력 + 미리보기. 입력이 멈추면(0.35초) 서버에 이미 저장된 거래 중 몇 건에
 * 맞는지 묻는다(방향별 건수와 자주 나온 적요 몇 개). 검사는 서버가 다시 한다.
 */
function PatternEditor({
  id,
  value,
  onChange,
  groupKey,
  direction,
}: {
  id: string;
  value: string;
  onChange: (value: string) => void;
  groupKey: string;
  direction: Direction;
}) {
  const parsed = parseWildcardPattern(value);
  const localError = !parsed.ok
    ? (PATTERN_ERROR_TEXT[parsed.code] ?? "패턴 형식이 올바르지 않습니다.")
    : !wildcardMatches(compileWildcard(parsed.pattern), groupKey)
      ? "이 패턴이 지금 고른 적요와 맞지 않습니다."
      : null;
  const [preview, setPreview] = useState<{ pattern: string; data: Preview | null; failed: boolean } | null>(null);

  // 검사를 통과한 패턴만 서버에 묻는다(통과하지 못하면 null).
  const wanted = localError === null && parsed.ok ? parsed.pattern : null;

  useEffect(() => {
    if (wanted === null) return;
    const controller = new AbortController();
    const timer = setTimeout(async () => {
      try {
        const response = await fetch("/api/classify/patterns/preview", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ pattern: wanted, key: groupKey }),
          cache: "no-store",
          signal: controller.signal,
        });
        const data = (await response.json()) as Record<string, unknown>;
        if (!response.ok || data.ok !== true) setPreview({ pattern: wanted, data: null, failed: true });
        else setPreview({ pattern: wanted, data: data as unknown as Preview, failed: false });
      } catch {
        if (!controller.signal.aborted) setPreview({ pattern: wanted, data: null, failed: true });
      }
    }, 350);
    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, [wanted, groupKey]);

  const current = preview !== null && wanted !== null && preview.pattern === wanted ? preview : null;

  return (
    <div className="flex flex-col gap-1 rounded-md border border-line bg-subtle p-2 text-xs" data-testid="pattern-editor">
      <div className="flex flex-wrap items-center gap-2">
        <label htmlFor={id} className="text-muted">
          패턴
        </label>
        <input
          id={id}
          type="text"
          value={value}
          onChange={(event) => onChange(event.target.value)}
          className={`${INPUT} min-w-0 flex-1 font-mono`}
          autoComplete="off"
          spellCheck={false}
        />
      </div>
      <p className="flex flex-wrap gap-3 text-muted" data-testid="pattern-legend">
        <span>
          <kbd className="rounded border border-line-strong bg-canvas px-1 font-mono text-fg">#</kbd> 숫자 1자리
        </span>
        <span>
          <kbd className="rounded border border-line-strong bg-canvas px-1 font-mono text-fg">*</kbd> 아무 글자
        </span>
      </p>
      {localError !== null ? (
        <p role="alert" className="text-danger">
          {localError}
        </p>
      ) : current === null ? (
        <p className="text-muted">세는 중…</p>
      ) : current.failed || current.data === null ? (
        <p className="text-muted">미리보기 실패 · 저장은 가능</p>
      ) : (
        <p data-testid="pattern-preview" className="flex flex-wrap items-center gap-x-2 gap-y-1 text-muted">
          <span className="font-medium text-fg tabular-nums">
            {DIRECTION_TEXT[direction]} {current.data[direction].count}건 일치
          </span>
          <span className="tabular-nums">적요 {current.data[direction].distinct}종</span>
          {current.data[direction].manual > 0 ? (
            <span className="tabular-nums" title="이번만으로 고른 거래는 바꾸지 않음">
              이번만 {current.data[direction].manual}건 제외
            </span>
          ) : null}
          {current.data[direction].samples.map((sample) => (
            <span key={sample} className="rounded border border-line bg-canvas px-1 break-all">
              {sample}
            </span>
          ))}
        </p>
      )}
    </div>
  );
}

export function PatternRow({ saved, categories }: { saved: SavedPattern; categories: string[] }) {
  const router = useRouter();
  const [editing, setEditing] = useState(false);
  const [category, setCategory] = useState(categories.includes(saved.category) ? saved.category : "");
  const [item, setItem] = useState(saved.item ?? "");
  const [status, setStatus] = useState<Status>({ kind: "idle" });
  const uid = useId();

  async function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (category === "") {
      setStatus({ kind: "error", text: "분류를 골라 주세요." });
      return;
    }
    setStatus({ kind: "busy" });
    try {
      const { ok, data } = await post("/api/classify/patterns", {
        action: "update",
        pattern: saved.pattern,
        direction: saved.direction,
        category,
        item: item === "" ? null : item,
      });
      if (!ok) {
        setStatus({ kind: "error", text: failureText(data) });
        return;
      }
      setStatus({ kind: "done", text: `저장했습니다 · ${String(data.updated ?? 0)}건에 반영.` });
      setEditing(false);
      router.refresh();
    } catch {
      setStatus({ kind: "error", text: "서버에 연결하지 못했습니다." });
    }
  }

  async function remove() {
    if (!window.confirm("이 패턴을 지울까요? 이 패턴으로 분류된 거래가 다시 분류됩니다(‘이번만’으로 고른 거래는 그대로).")) {
      return;
    }
    setStatus({ kind: "busy" });
    try {
      const { ok, data } = await post("/api/classify/patterns", {
        action: "delete",
        pattern: saved.pattern,
        direction: saved.direction,
      });
      if (!ok) {
        setStatus({ kind: "error", text: failureText(data) });
        return;
      }
      setStatus({
        kind: "done",
        text: `지웠습니다 · 다시 분류 ${String(data.reclassified ?? 0)}건, 미분류 ${String(data.unclassified ?? 0)}건.`,
      });
      router.refresh();
    } catch {
      setStatus({ kind: "error", text: "서버에 연결하지 못했습니다." });
    }
  }

  return (
    <div
      data-testid="pattern-row"
      className="flex flex-col gap-2 rounded-lg border border-line bg-canvas p-3 text-[13px]"
    >
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <p className="font-medium break-all">
          <DirectionBadge direction={saved.direction} />
          <code>{saved.pattern}</code>
        </p>
        <p className="text-xs text-muted">
          {saved.category} · {saved.item ?? "(적요 그대로)"} · {saved.updatedAt.slice(0, 10)}
        </p>
      </div>
      {editing ? (
        <form onSubmit={save} className="flex flex-wrap items-center gap-2">
          <label htmlFor={`pat-category-${uid}`} className="text-xs text-muted">
            분류
          </label>
          <CategorySelect id={`pat-category-${uid}`} value={category} onChange={setCategory} categories={categories} />
          <label htmlFor={`pat-item-${uid}`} className="text-xs text-muted">
            항목
          </label>
          <input
            id={`pat-item-${uid}`}
            type="text"
            value={item}
            placeholder="비우면 적요 그대로"
            onChange={(event) => setItem(event.target.value)}
            className={`${INPUT} min-w-0 flex-1`}
            autoComplete="off"
          />
          <button type="submit" className={BUTTON} disabled={status.kind === "busy"}>
            저장
          </button>
          <button type="button" className={BUTTON} onClick={() => setEditing(false)}>
            취소
          </button>
        </form>
      ) : (
        <div className="flex gap-2">
          <button type="button" className={BUTTON} onClick={() => setEditing(true)}>
            수정
          </button>
          <button type="button" className={BUTTON} onClick={remove} disabled={status.kind === "busy"}>
            삭제
          </button>
        </div>
      )}
      <StatusLine status={status} />
    </div>
  );
}

export function MappingRow({ mapping, categories }: { mapping: Mapping; categories: string[] }) {
  const router = useRouter();
  const [editing, setEditing] = useState(false);
  const [category, setCategory] = useState(categories.includes(mapping.category) ? mapping.category : "");
  const [item, setItem] = useState(mapping.item ?? mapping.key);
  const [status, setStatus] = useState<Status>({ kind: "idle" });
  const uid = useId();

  async function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (category === "") {
      setStatus({ kind: "error", text: "분류를 골라 주세요." });
      return;
    }
    setStatus({ kind: "busy" });
    try {
      const { ok, data } = await post("/api/classify/mappings", {
        action: "update",
        key: mapping.key,
        direction: mapping.direction,
        category,
        item,
      });
      if (!ok) {
        setStatus({ kind: "error", text: failureText(data) });
        return;
      }
      setStatus({ kind: "done", text: `저장했습니다 · ${String(data.updated ?? 0)}건에 반영.` });
      setEditing(false);
      router.refresh();
    } catch {
      setStatus({ kind: "error", text: "서버에 연결하지 못했습니다." });
    }
  }

  async function remove() {
    const scopeText =
      mapping.direction === "any"
        ? "입금 · 출금 중 따로 저장한 매핑이 없는 쪽"
        : `${DIRECTION_TEXT[mapping.direction]} 거래`;
    if (
      !window.confirm(
        `이 매핑(${DIRECTION_TEXT[mapping.direction] ?? ""})을 지울까요? ${scopeText}만 다시 분류됩니다.`,
      )
    ) {
      return;
    }
    setStatus({ kind: "busy" });
    try {
      const { ok, data } = await post("/api/classify/mappings", {
        action: "delete",
        key: mapping.key,
        direction: mapping.direction,
      });
      if (!ok) {
        setStatus({ kind: "error", text: failureText(data) });
        return;
      }
      setStatus({
        kind: "done",
        // 방향 매핑을 지우면 같은 적요의 방향 무관 매핑으로 돌아갈 수도 있어 '규칙으로' 라고 하지 않는다.
        text: `지웠습니다 · 다시 분류 ${String(data.reclassified ?? 0)}건, 미분류 ${String(data.unclassified ?? 0)}건.`,
      });
      router.refresh();
    } catch {
      setStatus({ kind: "error", text: "서버에 연결하지 못했습니다." });
    }
  }

  const updated = mapping.updatedAt.slice(0, 10);

  return (
    <div
      data-testid="mapping-row"
      className="flex flex-col gap-2 rounded-lg border border-line bg-canvas p-3 text-[13px]"
    >
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <p className="font-medium break-all">
          <DirectionBadge direction={mapping.direction} />
          {mapping.key}
        </p>
        <p className="text-xs text-muted">
          {mapping.category} · {mapping.item ?? "(적요 그대로)"} · {updated}
        </p>
      </div>
      {editing ? (
        <form onSubmit={save} className="flex flex-wrap items-center gap-2">
          <label htmlFor={`map-category-${uid}`} className="text-xs text-muted">
            분류
          </label>
          <CategorySelect
            id={`map-category-${uid}`}
            value={category}
            onChange={setCategory}
            categories={categories}
          />
          <label htmlFor={`map-item-${uid}`} className="text-xs text-muted">
            항목
          </label>
          <input
            id={`map-item-${uid}`}
            type="text"
            value={item}
            onChange={(event) => setItem(event.target.value)}
            className={`${INPUT} min-w-0 flex-1`}
            autoComplete="off"
          />
          <button type="submit" className={BUTTON} disabled={status.kind === "busy"}>
            저장
          </button>
          <button type="button" className={BUTTON} onClick={() => setEditing(false)}>
            취소
          </button>
        </form>
      ) : (
        <div className="flex gap-2">
          <button type="button" className={BUTTON} onClick={() => setEditing(true)}>
            수정
          </button>
          <button type="button" className={BUTTON} onClick={remove} disabled={status.kind === "busy"}>
            삭제
          </button>
        </div>
      )}
      <StatusLine status={status} />
    </div>
  );
}

/** 메모 기준 매핑 한 줄 — 수정 · 삭제. 서버는 `/api/classify/mappings` 에 `basis: "memo"` 로 받는다. */
export function MemoMappingRow({ mapping, categories }: { mapping: MemoMapping; categories: string[] }) {
  const router = useRouter();
  const [editing, setEditing] = useState(false);
  const [category, setCategory] = useState(categories.includes(mapping.category) ? mapping.category : "");
  const [item, setItem] = useState(mapping.item ?? "");
  const [status, setStatus] = useState<Status>({ kind: "idle" });
  const uid = useId();

  async function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (category === "") {
      setStatus({ kind: "error", text: "분류를 골라 주세요." });
      return;
    }
    setStatus({ kind: "busy" });
    try {
      const { ok, data } = await post("/api/classify/mappings", {
        basis: "memo",
        action: "update",
        memo: mapping.memo,
        direction: mapping.direction,
        category,
        item: item === "" ? null : item,
      });
      if (!ok) {
        setStatus({ kind: "error", text: failureText(data) });
        return;
      }
      setStatus({ kind: "done", text: `저장했습니다 · ${String(data.updated ?? 0)}건에 반영.` });
      setEditing(false);
      router.refresh();
    } catch {
      setStatus({ kind: "error", text: "서버에 연결하지 못했습니다." });
    }
  }

  async function remove() {
    if (!window.confirm("이 메모 매핑을 지울까요? 이 매핑으로 분류된 거래가 다시 분류됩니다(‘이번만’으로 고른 거래는 그대로).")) {
      return;
    }
    setStatus({ kind: "busy" });
    try {
      const { ok, data } = await post("/api/classify/mappings", {
        basis: "memo",
        action: "delete",
        memo: mapping.memo,
        direction: mapping.direction,
      });
      if (!ok) {
        setStatus({ kind: "error", text: failureText(data) });
        return;
      }
      setStatus({
        kind: "done",
        text: `지웠습니다 · 다시 분류 ${String(data.reclassified ?? 0)}건, 미분류 ${String(data.unclassified ?? 0)}건.`,
      });
      router.refresh();
    } catch {
      setStatus({ kind: "error", text: "서버에 연결하지 못했습니다." });
    }
  }

  return (
    <div
      data-testid="memo-mapping-row"
      className="flex flex-col gap-2 rounded-lg border border-line bg-canvas p-3 text-[13px]"
    >
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <p className="font-medium break-all">
          <DirectionBadge direction={mapping.direction} />
          <span className="text-xs font-normal text-muted">메모</span> {mapping.memo}
        </p>
        <p className="text-xs text-muted">
          {mapping.category} · {mapping.item ?? "(적요 그대로)"} · {mapping.updatedAt.slice(0, 10)}
        </p>
      </div>
      {editing ? (
        <form onSubmit={save} className="flex flex-wrap items-center gap-2">
          <label htmlFor={`memo-category-${uid}`} className="text-xs text-muted">
            분류
          </label>
          <CategorySelect id={`memo-category-${uid}`} value={category} onChange={setCategory} categories={categories} />
          <label htmlFor={`memo-item-${uid}`} className="text-xs text-muted">
            항목
          </label>
          <input
            id={`memo-item-${uid}`}
            type="text"
            value={item}
            placeholder="비우면 적요 그대로"
            onChange={(event) => setItem(event.target.value)}
            className={`${INPUT} min-w-0 flex-1`}
            autoComplete="off"
          />
          <button type="submit" className={BUTTON} disabled={status.kind === "busy"}>
            저장
          </button>
          <button type="button" className={BUTTON} onClick={() => setEditing(false)}>
            취소
          </button>
        </form>
      ) : (
        <div className="flex gap-2">
          <button type="button" className={BUTTON} onClick={() => setEditing(true)}>
            수정
          </button>
          <button type="button" className={BUTTON} onClick={remove} disabled={status.kind === "busy"}>
            삭제
          </button>
        </div>
      )}
      <StatusLine status={status} />
    </div>
  );
}

/**
 * ‘미분류 다시 분류’ 버튼. 저장된 미분류 거래만 지금의 분류기(메모 매핑 · 적요 매핑 · 패턴 ·
 * 적요와 메모를 함께 보는 규칙)로 다시 본다. 이미 분류된 거래는 건드리지 않는다.
 */
export function ReclassifyButton() {
  const router = useRouter();
  const [status, setStatus] = useState<Status>({ kind: "idle" });

  async function run() {
    setStatus({ kind: "busy" });
    try {
      const { ok, data } = await post("/api/classify/reclassify", {});
      if (!ok) {
        setStatus({ kind: "error", text: failureText(data) });
        return;
      }
      setStatus({
        kind: "done",
        text: `미분류 ${String(data.scanned ?? 0)}건 중 ${String(data.classified ?? 0)}건을 분류했습니다.`,
      });
      router.refresh();
    } catch {
      setStatus({ kind: "error", text: "서버에 연결하지 못했습니다." });
    }
  }

  return (
    <div className="flex flex-wrap items-center gap-2" data-testid="reclassify">
      <button type="button" className={BUTTON} onClick={run} disabled={status.kind === "busy"}>
        {status.kind === "busy" ? "분류하는 중…" : "미분류 다시 분류(메모 포함)"}
      </button>
      <StatusLine status={status} />
    </div>
  );
}
