// 미분류 정리 화면 — 적요별로 묶어 분류와 항목을 고른다.
//
// ── 적요가 보인다 ──────────────────────────────────────────────────────────
//
// 이 앱에서 적요(가맹점 · 상대방 · 사용자 라벨)를 화면에 싣는 곳은 여기와
// /report 의 항목 줄뿐이다. 사용자가 "미분류를 스스로 고를 수 있게" 요청했고,
// 무엇인지 보이지 않으면 고를 수 없기 때문이다(PLAN.md "적요 표시 원칙 변경").
// 그래서 이 화면은:
//   - 세션 + 화이트리스트를 **요청마다 다시** 본다(middleware 와 별개로).
//   - 항상 동적으로 렌더한다(`force-dynamic`). 정적으로 구워 두지 않는다.
//     동적 페이지의 응답은 Next 가 `Cache-Control: private, no-cache, no-store`
//     로 내보낸다.
//   - 행 단위가 아니라 **적요별 묶음**만 보여 준다(건수 · 합계). 거래 일시 ·
//     잔액 · 메모 · 계좌번호는 없다.
//   - console 호출이 없다. 에러는 바인딩 없는 `catch {}` 로 받는다.
//   - `month` 는 SQL 에 닿기 전에 `^[0-9]{4}-[0-9]{2}$` 로 거르고, 틀리면 받은
//     값을 되비추지 않는다.
import Link from "next/link";
import { redirect } from "next/navigation";

import { auth, isAllowedEmail } from "@/auth";
import { withClient } from "@/lib/db/client.mjs";
import { isYearMonth, listYearMonths } from "@/lib/report/months.mjs";
import { CLASSIFY_CATEGORIES } from "@/lib/report/monthly.mjs";
import { CLASSIFY_FILTERS, listClassifyGroups, listMappings } from "@/lib/classify/manual.mjs";
import { ITEM_MAX_LENGTH } from "@/lib/classify/item.mjs";

import { GroupForm, MappingRow, type ClassifyGroup, type Mapping } from "./forms";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const PLAIN_LINK =
  "text-sm text-zinc-600 underline underline-offset-4 hover:text-zinc-900 dark:text-zinc-400 dark:hover:text-zinc-100";

function Shell({ children }: { children: React.ReactNode }) {
  return (
    <main className="mx-auto flex w-full max-w-3xl flex-1 flex-col gap-6 p-8">
      <div className="flex items-baseline justify-between">
        <h1 className="text-2xl font-semibold tracking-tight">분류 정리</h1>
        <div className="flex gap-4">
          <Link href="/report" className={PLAIN_LINK}>
            현금흐름표
          </Link>
          <Link href="/" className={PLAIN_LINK}>
            홈
          </Link>
        </div>
      </div>
      {children}
    </main>
  );
}

function Picker({
  months,
  selected,
  filter,
}: {
  months: string[];
  selected: string;
  filter: string;
}) {
  const options = months.includes(selected) ? months : [selected, ...months];
  return (
    <form method="get" action="/classify" className="flex flex-wrap items-center gap-2">
      <label htmlFor="month" className="text-sm text-zinc-600 dark:text-zinc-400">
        조회 월
      </label>
      <select
        id="month"
        name="month"
        defaultValue={selected}
        className="rounded-md border border-zinc-300 bg-transparent px-2 py-1 text-sm dark:border-zinc-700"
      >
        {options.map((month) => (
          <option key={month} value={month}>
            {month}
          </option>
        ))}
      </select>
      <label htmlFor="filter" className="ml-2 text-sm text-zinc-600 dark:text-zinc-400">
        보기
      </label>
      <select
        id="filter"
        name="filter"
        defaultValue={filter}
        className="rounded-md border border-zinc-300 bg-transparent px-2 py-1 text-sm dark:border-zinc-700"
      >
        <option value={CLASSIFY_FILTERS.unclassified}>미분류만</option>
        <option value={CLASSIFY_FILTERS.all}>전체</option>
      </select>
      <button
        type="submit"
        className="rounded-md border border-zinc-300 px-3 py-1 text-sm hover:bg-zinc-100 dark:border-zinc-700 dark:hover:bg-zinc-900"
      >
        보기
      </button>
    </form>
  );
}

function first(value: string | string[] | undefined): string {
  return (Array.isArray(value) ? value[0] : value) ?? "";
}

type Loaded = {
  months: string[];
  month: string | null;
  groups: ClassifyGroup[];
  mappings: Mapping[];
};

export default async function ClassifyPage({ searchParams }: PageProps<"/classify">) {
  const session = await auth();
  if (!session) redirect("/signin?callbackUrl=%2Fclassify");
  if (!isAllowedEmail(session.user?.email)) {
    return (
      <Shell>
        <p role="alert" className="text-sm text-red-600">
          접근 권한이 없습니다.
        </p>
      </Shell>
    );
  }

  const params = await searchParams;
  const requested = first(params.month);
  if (requested !== "" && !isYearMonth(requested)) {
    return (
      <Shell>
        <p role="alert" className="text-sm text-red-600">
          조회할 월의 형식이 올바르지 않습니다. 주소의 <code>month</code> 값은
          <code> YYYY-MM</code> 이어야 합니다.
        </p>
        <Link href="/classify" className={`self-start ${PLAIN_LINK}`}>
          최근 달 보기
        </Link>
      </Shell>
    );
  }
  const filter =
    first(params.filter) === CLASSIFY_FILTERS.all ? CLASSIFY_FILTERS.all : CLASSIFY_FILTERS.unclassified;

  let loaded: Loaded;
  try {
    loaded = await withClient(async (client) => {
      const months = await listYearMonths(client);
      const month = requested === "" ? (months[0] ?? null) : requested;
      const groups = month === null ? [] : await listClassifyGroups(client, month, filter);
      const mappings = await listMappings(client);
      return { months, month, groups, mappings };
    });
  } catch {
    return (
      <Shell>
        <p role="alert" className="text-sm text-red-600">
          데이터를 불러오지 못했습니다. 잠시 후 다시 시도해 주세요.
        </p>
      </Shell>
    );
  }

  const categories = [...CLASSIFY_CATEGORIES];

  return (
    <Shell>
      {loaded.month === null ? (
        <p className="text-sm text-zinc-600 dark:text-zinc-400">
          아직 저장된 거래가 없습니다. 거래내역을 먼저 올려주세요.
        </p>
      ) : (
        <>
          <Picker months={loaded.months} selected={loaded.month} filter={filter} />
          <p className="text-xs text-zinc-500">
            같은 적요끼리 묶어 보여 주고, 같은 적요라도 <strong>입금과 출금은 따로</strong>{" "}
            묶습니다(용도가 다르기 때문입니다). <strong>이번만</strong>은 이 달의 이 묶음에만
            적용하고, 나중에 매핑이나 규칙이 다시 돌아도 바뀌지 않습니다.{" "}
            <strong>앞으로도</strong>는 매핑으로 저장해 다른 달의 같은 적요와 앞으로
            올릴 거래 중 <strong>같은 방향</strong>의 거래에 적용합니다(반대 방향의 거래와
            ‘이번만’으로 고른 다른 달의 거래는 건드리지 않습니다). 항목 이름은 {ITEM_MAX_LENGTH}자까지이며, 비워 두면 적요를 그대로
            씁니다.
          </p>
          {loaded.groups.length === 0 ? (
            <p className="text-sm text-zinc-600 dark:text-zinc-400">
              {filter === CLASSIFY_FILTERS.unclassified
                ? `${loaded.month} 에 미분류 거래가 없습니다.`
                : `${loaded.month} 에 저장된 거래가 없습니다.`}
            </p>
          ) : (
            <ul className="flex flex-col gap-3">
              {loaded.groups.map((group) => (
                <li key={`${group.direction}\u001f${group.key}`}>
                  <GroupForm month={loaded.month as string} group={group} categories={categories} />
                </li>
              ))}
            </ul>
          )}
          <Link href={`/report?month=${loaded.month}`} className={`self-start ${PLAIN_LINK}`}>
            {loaded.month} 현금흐름표 보기
          </Link>
        </>
      )}

      <section className="flex flex-col gap-2">
        <h2 className="text-sm font-medium text-zinc-700 dark:text-zinc-300">저장된 매핑</h2>
        <p className="text-xs text-zinc-500">
          ‘앞으로도’로 저장한 것들입니다. 새로 올리는 거래는 규칙보다 이 매핑을 먼저
          봅니다. 입금 · 출금 매핑이 따로 있고, ‘방향 무관’은 입금 · 출금을 나누기 전에
          저장한 매핑으로 같은 방향의 매핑이 없는 쪽에만 걸립니다. 지우면 이 매핑으로
          분류된 그 방향의 거래가 다시 분류됩니다(방향 무관 매핑이 있으면 그것으로, 없으면
          규칙으로. ‘이번만’으로 고른 거래는 그대로).
        </p>
        {loaded.mappings.length === 0 ? (
          <p className="text-sm text-zinc-600 dark:text-zinc-400">저장된 매핑이 없습니다.</p>
        ) : (
          <ul className="flex flex-col gap-2">
            {loaded.mappings.map((mapping) => (
              <li key={`${mapping.direction}\u001f${mapping.key}`}>
                <MappingRow mapping={mapping} categories={categories} />
              </li>
            ))}
          </ul>
        )}
      </section>
    </Shell>
  );
}
