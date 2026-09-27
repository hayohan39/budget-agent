"use client";

// /classify 의 입력 조각. 서버로 보내는 것은 달 · 계좌 역할(main · fixed ·
// emergency) · 묶음 키(정규화한 적요) · 방향 · 분류 · 항목 · 범위뿐이다. 행 id · 건수 · 금액은 보내지 않는다 — 서버가 그 달의
// 행을 직접 다시 읽어 묶음을 찾는다(lib/classify/manual.mjs). 방향도 서버가 저장된
// 금액에서 다시 계산해 맞춰 본다.
//
// console 호출이 이 파일에 없다. 실패하면 서버가 준 고정 문장만 보여 준다.
import { useRouter } from "next/navigation";
import { useEffect, useId, useState, type FormEvent } from "react";

import { compileWildcard, parseWildcardPattern, suggestPattern, wildcardMatches } from "@/lib/classify/wildcard.mjs";

import { accountLabel, type GroupAccount } from "./account-label";

/** 묶음의 방향. 매핑에는 방향 구분 전의 `any` 가 더 있다. */
export type Direction = "in" | "out";
export type MappingDirection = Direction | "any";

export type ClassifyGroup = {
  account: GroupAccount | null;
  key: string;
  direction: Direction;
  count: number;
  total: number;
  unclassified: number;
  transferIn: number;
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

export type Mapping = {
  key: string;
  direction: MappingDirection;
  category: string;
  item: string | null;
  updatedAt: string;
};

const FLOW = new Intl.NumberFormat("ko-KR", { signDisplay: "exceptZero" });
const INPUT =
  "rounded-md border border-zinc-300 bg-transparent px-2 py-1 text-sm dark:border-zinc-700";
const BUTTON =
  "rounded-md border border-zinc-300 px-3 py-1 text-sm hover:bg-zinc-100 disabled:opacity-50 dark:border-zinc-700 dark:hover:bg-zinc-900";

/** lib/classify/direction.mjs 의 DIRECTION_LABELS 와 같은 이름. */
const DIRECTION_TEXT: Record<string, string> = {
  in: "입금",
  out: "출금",
  any: "방향 무관",
};

const DIRECTION_BADGE: Record<string, string> = {
  in: "bg-emerald-50 text-emerald-800 dark:bg-emerald-950/40 dark:text-emerald-300",
  out: "bg-rose-50 text-rose-800 dark:bg-rose-950/40 dark:text-rose-300",
  any: "bg-zinc-100 text-zinc-700 dark:bg-zinc-800 dark:text-zinc-300",
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
      <p role="status" className="text-xs text-emerald-700 dark:text-emerald-400">
        {status.text}
      </p>
    );
  }
  if (status.kind === "error") {
    return (
      <p role="alert" className="text-xs text-red-600">
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
  main: "border-zinc-300 text-zinc-700 dark:border-zinc-600 dark:text-zinc-300",
  fixed: "border-amber-400 bg-amber-50 text-amber-900 dark:border-amber-700 dark:bg-amber-950/40 dark:text-amber-200",
  emergency: "border-rose-400 bg-rose-50 text-rose-900 dark:border-rose-700 dark:bg-rose-950/40 dark:text-rose-200",
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
 * 한 묶음의 입력. 분류는 드롭다운 하나로만 고른다(예전 ‘기타’ 는 ‘변동비’ 로 합쳤다).
 */
export function GroupForm({
  month,
  group,
  categories,
}: {
  month: string;
  group: ClassifyGroup;
  categories: string[];
}) {
  const router = useRouter();
  const [category, setCategory] = useState(
    !group.mixed && group.category !== null && categories.includes(group.category) ? group.category : "",
  );
  const [item, setItem] = useState(!group.mixedItem && group.item !== null ? group.item : group.key);
  const [scope, setScope] = useState<"once" | "always">("once");
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
    try {
      const { ok, data } = await post("/api/classify", {
        scope,
        month,
        account: group.account?.role,
        key: group.key,
        direction: group.direction,
        category: chosen,
        item,
        // '이번만'에서는 뜻이 없다(JSON.stringify 가 undefined 키를 뺀다).
        // 패턴은 '앞으로도' 에서만 보낸다. 서버가 같은 규칙으로 다시 검사하고, 지금 고른
        // 적요와 맞는지도 서버가 확인한다.
        pattern: scope === "always" && usePattern ? pattern : undefined,
      });
      if (!ok) {
        setStatus({ kind: "error", text: failureText(data) });
        return;
      }
      setStatus({
        kind: "done",
        text: `${String(data.updated ?? 0)}건에 적용했습니다${data.mapped === true ? " · 매핑 저장" : ""}.`,
      });
      router.refresh();
    } catch {
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

  return (
    <form
      onSubmit={submit}
      data-testid="classify-group"
      className="flex flex-col gap-2 rounded-md border border-zinc-300 p-3 text-sm dark:border-zinc-700"
    >
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <p className="font-medium break-all">
          <AccountBadge account={group.account} />
          <DirectionBadge direction={group.direction} />
          {group.key}
        </p>
        <p className="tabular-nums text-zinc-600 dark:text-zinc-400">
          {group.count}건 · {FLOW.format(group.total)}원
        </p>
      </div>
      <p className="text-xs text-zinc-500">
        현재: {current} · 항목: {group.mixedItem ? "혼합" : (group.item ?? "—")}
        {group.unclassified > 0 && group.unclassified < group.count
          ? ` · 미분류 ${group.unclassified}건`
          : ""}
        {group.manual > 0 ? ` · ‘이번만’으로 고른 거래 ${group.manual}건` : ""}
      </p>
      {group.transferIn > 0 ? (
        <p className="text-xs text-sky-700 dark:text-sky-400">
          이 중 {group.transferIn}건은 메인 계좌에서 옮겨 온 돈(내 계좌 간 이체)으로 확인됐습니다.
          분류하지 않아도 현금흐름표의 ‘{accountLabel(group.account)}’ 입금으로 들어가므로 미분류로
          세지 않습니다.
        </p>
      ) : null}
      {group.transfer > 0 ? (
        <p className="text-xs text-amber-700 dark:text-amber-400">
          내 계좌 간 이동으로 표시된 거래가 {group.transfer}건 있습니다. 이 거래들은 분류와
          무관하게 현금흐름표의 ‘계좌간이동’ 줄에 들어갑니다.
        </p>
      ) : null}
      <div className="flex flex-wrap items-center gap-2">
        <label htmlFor={`category-${uid}`} className="text-xs text-zinc-600 dark:text-zinc-400">
          분류
        </label>
        <CategorySelect id={`category-${uid}`} value={category} onChange={setCategory} categories={categories} />
        <label htmlFor={`item-${uid}`} className="text-xs text-zinc-600 dark:text-zinc-400">
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
            이번만
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
        {scope === "always" ? (
          <label className="flex items-center gap-1 text-xs text-zinc-600 dark:text-zinc-400">
            <input type="checkbox" checked={usePattern} onChange={(event) => setUsePattern(event.target.checked)} />
            달마다 바뀌는 부분이 있어요 — 패턴으로 저장
          </label>
        ) : null}
        <button type="submit" className={BUTTON} disabled={status.kind === "busy"}>
          {status.kind === "busy" ? "저장 중…" : "적용"}
        </button>
      </div>
      {scope === "always" && usePattern ? (
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
  const other: Direction = direction === "out" ? "in" : "out";

  return (
    <div className="flex flex-col gap-1 rounded-md bg-zinc-50 p-2 text-xs dark:bg-zinc-900" data-testid="pattern-editor">
      <div className="flex flex-wrap items-center gap-2">
        <label htmlFor={id} className="text-zinc-600 dark:text-zinc-400">
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
      <p className="text-zinc-500">
        <code>#</code> 는 숫자 한 자리, <code>*</code> 는 아무 글자 여러 개(없어도 됨)입니다. 나머지는 글자 그대로
        비교하고, 적요 전체와 맞아야 합니다. 예: 흥국01184 · 흥국02184 → <code>흥국##184</code>
      </p>
      {localError !== null ? (
        <p role="alert" className="text-red-600">
          {localError}
        </p>
      ) : current === null ? (
        <p className="text-zinc-500">맞는 거래를 세는 중…</p>
      ) : current.failed || current.data === null ? (
        <p className="text-zinc-500">미리보기를 불러오지 못했습니다. 저장은 할 수 있습니다.</p>
      ) : (
        <div data-testid="pattern-preview" className="text-zinc-600 dark:text-zinc-400">
          <p>
            이미 올린 거래 중 이 패턴에 맞는 <strong>{DIRECTION_TEXT[direction]}</strong>{" "}
            {current.data[direction].count}건(서로 다른 적요 {current.data[direction].distinct}개)
            {current.data[direction].manual > 0
              ? ` — 그중 ‘이번만’으로 고른 ${current.data[direction].manual}건은 바꾸지 않습니다`
              : ""}
            {current.data[direction].samples.length > 0 ? ` · 예: ${current.data[direction].samples.join(", ")}` : ""}
          </p>
          {current.data[other].count > 0 ? (
            <p className="text-zinc-500">
              같은 패턴의 {DIRECTION_TEXT[other]} {current.data[other].count}건은 이 저장과 무관합니다(패턴은 이
              묶음의 방향에만 걸립니다).
            </p>
          ) : null}
        </div>
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
      className="flex flex-col gap-2 rounded-md border border-zinc-300 p-3 text-sm dark:border-zinc-700"
    >
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <p className="font-medium break-all">
          <DirectionBadge direction={saved.direction} />
          <code>{saved.pattern}</code>
        </p>
        <p className="text-xs text-zinc-500">
          {saved.category} · {saved.item ?? "(적요 그대로)"} · {saved.updatedAt.slice(0, 10)}
        </p>
      </div>
      {editing ? (
        <form onSubmit={save} className="flex flex-wrap items-center gap-2">
          <label htmlFor={`pat-category-${uid}`} className="text-xs text-zinc-600 dark:text-zinc-400">
            분류
          </label>
          <CategorySelect id={`pat-category-${uid}`} value={category} onChange={setCategory} categories={categories} />
          <label htmlFor={`pat-item-${uid}`} className="text-xs text-zinc-600 dark:text-zinc-400">
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
      className="flex flex-col gap-2 rounded-md border border-zinc-300 p-3 text-sm dark:border-zinc-700"
    >
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <p className="font-medium break-all">
          <DirectionBadge direction={mapping.direction} />
          {mapping.key}
        </p>
        <p className="text-xs text-zinc-500">
          {mapping.category} · {mapping.item ?? "(적요 그대로)"} · {updated}
        </p>
      </div>
      {editing ? (
        <form onSubmit={save} className="flex flex-wrap items-center gap-2">
          <label htmlFor={`map-category-${uid}`} className="text-xs text-zinc-600 dark:text-zinc-400">
            분류
          </label>
          <CategorySelect
            id={`map-category-${uid}`}
            value={category}
            onChange={setCategory}
            categories={categories}
          />
          <label htmlFor={`map-item-${uid}`} className="text-xs text-zinc-600 dark:text-zinc-400">
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
