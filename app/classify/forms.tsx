"use client";

// /classify 의 입력 조각. 서버로 보내는 것은 달 · 계좌 역할(main · fixed ·
// emergency) · 묶음 키(정규화한 적요) · 방향 · 분류 · 항목 · 범위뿐이다. 행 id · 건수 · 금액은 보내지 않는다 — 서버가 그 달의
// 행을 직접 다시 읽어 묶음을 찾는다(lib/classify/manual.mjs). 방향도 서버가 저장된
// 금액에서 다시 계산해 맞춰 본다.
//
// console 호출이 이 파일에 없다. 실패하면 서버가 준 고정 문장만 보여 준다.
import { useRouter } from "next/navigation";
import { useId, useState, useTransition, type FormEvent } from "react";

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
}: {
  month: string;
  group: ClassifyGroup;
  categories: string[];
  hideOnApply?: boolean;
}) {
  const router = useRouter();
  const [, startTransition] = useTransition();
  // 낙관적으로 접었는가. 실패하면 false 로 되돌린다.
  const [collapsed, setCollapsed] = useState(false);
  const [category, setCategory] = useState(
    !group.mixed && group.category !== null && categories.includes(group.category) ? group.category : "",
  );
  const [item, setItem] = useState(!group.mixedItem && group.item !== null ? group.item : group.key);
  const [scope, setScope] = useState<"once" | "always">("once");
  const [stripMonth, setStripMonth] = useState(false);
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
        direction: group.direction,
        category: chosen,
        item,
        // '이번만'에서는 뜻이 없다(JSON.stringify 가 undefined 키를 뺀다).
        stripMonth: scope === "always" ? stripMonth : undefined,
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
        className="flex flex-wrap items-baseline justify-between gap-2 rounded-md border border-dashed border-zinc-300 px-3 py-2 text-xs text-zinc-500 dark:border-zinc-700"
      >
        <span className="break-all">
          <AccountBadge account={group.account} />
          <DirectionBadge direction={group.direction} />
          {group.key}
        </span>
        <span role="status">
          {status.kind === "done" ? `${status.text} 목록에서 뺐습니다.` : `‘${category}’(으)로 적용하는 중…`}
        </span>
      </div>
    );
  }

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
            <input
              type="checkbox"
              checked={stripMonth}
              onChange={(event) => setStripMonth(event.target.checked)}
            />
            월마다 문구가 바뀌는 항목이에요 (예: OO월렌탈) — 앞으로 자동 적용
          </label>
        ) : null}
        <button type="submit" className={BUTTON} disabled={status.kind === "busy"}>
          {status.kind === "busy" ? "저장 중…" : "적용"}
        </button>
      </div>
      <StatusLine status={status} />
    </form>
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
