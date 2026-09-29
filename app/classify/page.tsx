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
//   - 행 단위가 아니라 **(계좌, 적요, 메모, 방향)별 묶음**만 보여 준다(건수 · 합계).
//     메모는 사용자가 거래마다 적은 글이라 적요와 똑같이 다룬다(2026-09 사용자 요청으로
//     화면에 보인다). 거래 일시 · 잔액 · 계좌번호는 없다. 계좌는 별칭(메인 · 고정비 ·
//     비상금)으로만 보인다 — 뒤 4자리는 읽지도 않는다.
//   - `month=all`(전체 기간, 기본)은 달별 묶음을 한 화면에 모은 것이다. 묶음은 그 달에
//     속하고 쓰기도 묶음의 달로 보낸다(lib/classify/manual.mjs 의 listAllPeriodGroups).
//   - console 호출이 없다. 에러는 바인딩 없는 `catch {}` 로 받는다.
//   - `month` 는 SQL 에 닿기 전에 `^[0-9]{4}-[0-9]{2}$` 로 거르고, 틀리면 받은
//     값을 되비추지 않는다.
import Form from "next/form";
import Link from "next/link";
import { redirect } from "next/navigation";

import { auth, isAllowedEmail } from "@/auth";
import { withClient } from "@/lib/db/client.mjs";
import { isYearMonth, listYearMonths } from "@/lib/report/months.mjs";
import { CLASSIFY_CATEGORIES } from "@/lib/report/monthly.mjs";
import {
  ALL_MONTHS,
  CLASSIFY_FILTERS,
  MAX_ALL_PERIOD_ROWS,
  classifyMonthHref,
  listAllPeriodGroups,
  listClassifyGroups,
  listMappings,
  listMemoMappings,
  listPatterns,
} from "@/lib/classify/manual.mjs";
import { ITEM_MAX_LENGTH } from "@/lib/classify/item.mjs";

import { accountLabel } from "./account-label";
import {
  GroupForm,
  MappingRow,
  MemoMappingRow,
  PatternRow,
  ReclassifyButton,
  type ClassifyGroup,
  type Mapping,
  type MemoMapping,
  type SavedPattern,
} from "./forms";

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
  const options = months.includes(selected) || selected === ALL_MONTHS ? months : [selected, ...months];
  return (
    <Form action="/classify" className="flex flex-wrap items-center gap-2">
      <label htmlFor="month" className="text-sm text-zinc-600 dark:text-zinc-400">
        조회 월
      </label>
      <select
        id="month"
        name="month"
        defaultValue={selected}
        className="rounded-md border border-zinc-300 bg-transparent px-2 py-1 text-sm dark:border-zinc-700"
      >
        <option value={ALL_MONTHS}>전체 기간</option>
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
    </Form>
  );
}

/**
 * 묶음을 계좌별 구역으로 나눈다. 목록은 이미 계좌 순서(메인 → 고정비 → 비상금)로
 * 정렬돼 온다(lib/classify/manual.mjs 의 groupRows) — 여기서는 끊기만 한다.
 */
function byAccount(groups: ClassifyGroup[]): Array<{ id: string; label: string; groups: ClassifyGroup[] }> {
  const sections: Array<{ id: string; label: string; groups: ClassifyGroup[] }> = [];
  for (const group of groups) {
    const id = group.account?.role ?? "unknown";
    const last = sections[sections.length - 1];
    if (last !== undefined && last.id === id) last.groups.push(group);
    else sections.push({ id, label: accountLabel(group.account), groups: [group] });
  }
  return sections;
}

function first(value: string | string[] | undefined): string {
  return (Array.isArray(value) ? value[0] : value) ?? "";
}

type Loaded = {
  months: string[];
  /** `YYYY-MM` · 전체 기간(ALL_MONTHS) · 거래가 없으면 null. */
  month: string | null;
  /** 달별 묶음. 한 달 보기는 한 칸, 전체 기간은 묶음이 있는 달마다 한 칸(최신 달 먼저). */
  sections: Array<{ month: string; groups: ClassifyGroup[] }>;
  truncated: boolean;
  mappings: Mapping[];
  memoMappings: MemoMapping[];
  patterns: SavedPattern[];
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
  if (requested !== "" && requested !== ALL_MONTHS && !isYearMonth(requested)) {
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
      // 기본은 전체 기간이다(2026-09 사용자 요청). 거래가 하나도 없으면 null.
      const month = months.length === 0 ? null : requested === "" ? ALL_MONTHS : requested;
      let sections: Array<{ month: string; groups: ClassifyGroup[] }> = [];
      let truncated = false;
      if (month === ALL_MONTHS) {
        const all = await listAllPeriodGroups(client, filter);
        sections = all.months as Array<{ month: string; groups: ClassifyGroup[] }>;
        truncated = all.truncated;
      } else if (month !== null) {
        sections = [{ month, groups: (await listClassifyGroups(client, month, filter)) as ClassifyGroup[] }];
      }
      const mappings = await listMappings(client);
      const patterns = (await listPatterns(client)) as SavedPattern[];
      const memoMappings = (await listMemoMappings(client)) as MemoMapping[];
      return { months, month, sections, truncated, mappings, memoMappings, patterns };
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
            <strong>계좌별로</strong> 나누고, 그 안에서 같은 적요끼리 묶어 보여 줍니다. 같은
            적요라도 <strong>입금과 출금은 따로</strong> 묶습니다(용도가 다르기 때문입니다).{" "}
            <strong>이번만</strong>은 이 달 이 계좌의 이 묶음에만 적용하고, 나중에 매핑이나
            규칙이 다시 돌아도 바뀌지 않습니다. <strong>앞으로도</strong>는 매핑으로 저장해
            다른 달의 같은 적요와 앞으로 올릴 거래 중 <strong>같은 방향</strong>의 거래에
            적용합니다 — 매핑은 <strong>계좌를 가리지 않으므로</strong> 다른 계좌의 같은 적요에도
            걸립니다(반대 방향의 거래와 ‘이번만’으로 고른 거래는 건드리지 않습니다). 항목
            이름은 {ITEM_MAX_LENGTH}자까지이며, 비워 두면 적요를 그대로 씁니다. 따로 나눌
            필요가 없는 일회성 거래는 분류에서 <strong>변동비</strong>를 고르면 됩니다(입금이면
            현금흐름표 변동비 표의 일회성 수입, 출금이면 일회성 지출로 들어가고 미분류에서
            빠집니다). 예전의 ‘기타’는 변동비로 합쳤습니다. 메인 계좌에서 고정비 · 비상금 계좌로 옮긴 돈이 받는 쪽
            계좌에 찍힌 입금은 메인 쪽 이체와 금액 · 시각이 맞으면 자동으로 알아보고
            미분류로 세지 않습니다. <strong>메모</strong>가 다른 거래는 적요가 같아도 따로
            묶고(메모는 적요 아래 회색 글씨), 메모가 있는 묶음은 ‘앞으로도’를 <strong>이 메모
            기준</strong>으로 저장할 수 있습니다. 규칙은 적요에 안 맞으면 메모도 봅니다(예: 메모에
            ‘IRP’ → 저축, 이때 항목은 메모).
          </p>
          <ReclassifyButton />
          {loaded.month === ALL_MONTHS ? (
            <p className="rounded-md bg-sky-50 p-2 text-xs text-sky-900 dark:bg-sky-950/40 dark:text-sky-200">
              <strong>전체 기간</strong> — 모든 달의 묶음을 <strong>달별로</strong> 한 화면에 모았습니다(최신 달 먼저).
              묶음은 여전히 그 달에 속하고, <strong>이번만</strong>은 <strong>그 달의 그 묶음에만</strong> 적용합니다.{" "}
              <strong>앞으로도</strong>는 한 달 보기와 같습니다(다른 달의 같은 적요에도, ‘이번만’으로 고른 거래는 그대로).
            </p>
          ) : null}
          {loaded.truncated ? (
            <p role="alert" className="text-xs text-amber-700 dark:text-amber-400">
              거래가 많아 최근 {MAX_ALL_PERIOD_ROWS.toLocaleString("ko-KR")}건 안의 달까지만 보여 줍니다. 더 오래된 달은
              조회 월에서 골라 주세요.
            </p>
          ) : null}
          {loaded.sections.every((section) => section.groups.length === 0) ? (
            <p className="text-sm text-zinc-600 dark:text-zinc-400">
              {`${loaded.month === ALL_MONTHS ? "전체 기간" : loaded.month} 에 ${
                filter === CLASSIFY_FILTERS.unclassified ? "미분류 거래가" : "저장된 거래가"
              } 없습니다.`}
            </p>
          ) : (
            <div className="flex flex-col gap-8">
              {loaded.sections.map((monthSection) => (
                <section
                  key={monthSection.month}
                  aria-label={`${monthSection.month} 묶음`}
                  data-testid="month-section"
                  className="flex flex-col gap-6"
                >
                  {loaded.month === ALL_MONTHS ? (
                    <h2 className="border-b border-zinc-300 pb-1 text-base font-semibold dark:border-zinc-700">
                      {monthSection.month}
                      <span className="ml-2 text-xs font-normal text-zinc-500">
                        {monthSection.groups.length}묶음 ·{" "}
                        <Link href={classifyMonthHref(monthSection.month, filter)} className="underline underline-offset-4">
                          이 달만 보기
                        </Link>
                      </span>
                    </h2>
                  ) : null}
                  {byAccount(monthSection.groups).map((section) => (
                    <section
                      key={section.id}
                      aria-labelledby={`account-${monthSection.month}-${section.id}`}
                      className="flex flex-col gap-3"
                    >
                      <h3
                        id={`account-${monthSection.month}-${section.id}`}
                        data-testid="account-section"
                        className="text-sm font-semibold text-zinc-700 dark:text-zinc-300"
                      >
                        {section.label}
                        <span className="ml-2 text-xs font-normal text-zinc-500">{section.groups.length}묶음</span>
                      </h3>
                      <ul className="flex flex-col gap-3">
                        {section.groups.map((group) => (
                          <li
                            key={`${section.id}\u001f${group.direction}\u001f${group.key}\u001f${group.memo ?? ""}`}
                          >
                            <GroupForm
                              month={monthSection.month}
                              group={group}
                              categories={categories}
                              hideOnApply={filter === CLASSIFY_FILTERS.unclassified}
                              showMonth={loaded.month === ALL_MONTHS}
                            />
                          </li>
                        ))}
                      </ul>
                    </section>
                  ))}
                </section>
              ))}
            </div>
          )}
          {loaded.month === ALL_MONTHS ? (
            <Link href="/report" className={`self-start ${PLAIN_LINK}`}>
              현금흐름표 보기
            </Link>
          ) : (
            <Link href={`/report?month=${loaded.month}`} className={`self-start ${PLAIN_LINK}`}>
              {loaded.month} 현금흐름표 보기
            </Link>
          )}
        </>
      )}

      <section className="flex flex-col gap-2">
        <h2 className="text-sm font-medium text-zinc-700 dark:text-zinc-300">저장된 패턴</h2>
        <p className="text-xs text-zinc-500">
          ‘앞으로도’에서 ‘패턴으로 저장’을 고른 것들입니다. <code>#</code> 는 숫자 한 자리, <code>*</code> 는 아무
          글자입니다. 정확한 적요로 저장한 매핑이 패턴보다 먼저 걸리고, 여러 패턴이 맞으면 # · * 가 아닌 글자가
          많은 패턴이, 같으면 먼저 만든 패턴이 이깁니다. 지우면 이 패턴으로 분류된 거래가 다시 분류됩니다(‘이번만’으로
          고른 거래는 그대로).
        </p>
        {loaded.patterns.length === 0 ? (
          <p className="text-sm text-zinc-600 dark:text-zinc-400">저장된 패턴이 없습니다.</p>
        ) : (
          <ul className="flex flex-col gap-2">
            {loaded.patterns.map((saved) => (
              <li key={`${saved.direction}\u001f${saved.pattern}`}>
                <PatternRow saved={saved} categories={categories} />
              </li>
            ))}
          </ul>
        )}
      </section>

      <section className="flex flex-col gap-2">
        <h2 className="text-sm font-medium text-zinc-700 dark:text-zinc-300">저장된 메모 매핑</h2>
        <p className="text-xs text-zinc-500">
          ‘앞으로도’를 <strong>이 메모 기준</strong>으로 저장한 것들입니다. 메모가 같고 방향이 같은 거래라면 적요 · 계좌와
          무관하게 걸리고, 적요 기준 매핑 · 패턴 · 규칙보다 먼저 봅니다. 지우면 이 매핑으로 분류된 거래가 다시 분류됩니다.
        </p>
        {loaded.memoMappings.length === 0 ? (
          <p className="text-sm text-zinc-600 dark:text-zinc-400">저장된 메모 매핑이 없습니다.</p>
        ) : (
          <ul className="flex flex-col gap-2">
            {loaded.memoMappings.map((mapping) => (
              <li key={`${mapping.direction}\u001f${mapping.memo}`}>
                <MemoMappingRow mapping={mapping} categories={categories} />
              </li>
            ))}
          </ul>
        )}
      </section>

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
