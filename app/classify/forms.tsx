"use client";

// /classify 의 입력 조각. 서버로 보내는 것은 달 · 묶음 키(정규화한 적요) ·
// 분류 · 항목 · 범위뿐이다. 행 id · 건수 · 금액은 보내지 않는다 — 서버가 그 달의
// 행을 직접 다시 읽어 묶음을 찾는다(lib/classify/manual.mjs).
//
// console 호출이 이 파일에 없다. 실패하면 서버가 준 고정 문장만 보여 준다.
import { useRouter } from "next/navigation";
import { useId, useState, type FormEvent } from "react";

export type ClassifyGroup = {
  key: string;
  count: number;
  total: number;
  unclassified: number;
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
  category: string;
  item: string | null;
  updatedAt: string;
};

const FLOW = new Intl.NumberFormat("ko-KR", { signDisplay: "exceptZero" });
const INPUT =
  "rounded-md border border-zinc-300 bg-transparent px-2 py-1 text-sm dark:border-zinc-700";
const BUTTON =
  "rounded-md border border-zinc-300 px-3 py-1 text-sm hover:bg-zinc-100 disabled:opacity-50 dark:border-zinc-700 dark:hover:bg-zinc-900";

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
  const [status, setStatus] = useState<Status>({ kind: "idle" });

  // id 에 적요를 넣지 않는다(DOM id 에 한글·공백이 섞이면 label 연결이 깨진다).
  const uid = useId();

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (category === "") {
      setStatus({ kind: "error", text: "분류를 골라 주세요." });
      return;
    }
    setStatus({ kind: "busy" });
    try {
      const { ok, data } = await post("/api/classify", { scope, month, key: group.key, category, item });
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
        <p className="font-medium break-all">{group.key}</p>
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
    if (!window.confirm("이 매핑을 지울까요? 이 매핑으로 분류된 거래는 규칙으로 다시 분류됩니다.")) {
      return;
    }
    setStatus({ kind: "busy" });
    try {
      const { ok, data } = await post("/api/classify/mappings", { action: "delete", key: mapping.key });
      if (!ok) {
        setStatus({ kind: "error", text: failureText(data) });
        return;
      }
      setStatus({
        kind: "done",
        text: `지웠습니다 · 규칙으로 ${String(data.reclassified ?? 0)}건, 미분류 ${String(data.unclassified ?? 0)}건.`,
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
        <p className="font-medium break-all">{mapping.key}</p>
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
