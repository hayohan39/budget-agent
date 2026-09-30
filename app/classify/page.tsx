// 분류 규칙 화면 — 저장된 규칙(패턴 · 메모 매핑 · 적요 매핑)을 고치고 지우며, 전체 기간의
// 묶음을 적요별로 분류한다.
//
// 2026-09(사용자 요청: "분류 정리 탭이 괜히 더 복잡하게 만드는 것 같아 … 월별 현금 흐름 밑에
// 미분류 섹션에서 해당 월에 대한 미분류 처리를 바로할 수 있게해줘"): 한 달 단위의 미분류 정리는
// /report 의 미분류 섹션으로 옮겼다. 이 화면은 이름을 '분류 규칙' 으로 바꾸고 달 선택을 없앴다 —
// 예전 주소 `/classify?month=YYYY-MM` 는 그 달 현금흐름표의 미분류 섹션으로 보낸다. 전체 기간
// 보기와 '전체'(이미 분류된 묶음까지) 보기는 여기 남는다 — 잘못 분류한 묶음을 고칠 곳이다.
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
  listAllPeriodGroups,
  listMappings,
  listMemoMappings,
  listPatterns,
} from "@/lib/classify/manual.mjs";

import { groupsByAccount } from "./account-label";
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
  "text-[13px] text-accent-text underline-offset-4 hover:underline";

function Shell({ children }: { children: React.ReactNode }) {
  return (
    <main className="mx-auto flex w-full max-w-3xl flex-1 flex-col gap-8 px-4 py-6 sm:px-8 sm:py-8">
      <h1 className="text-xl font-semibold tracking-tight">분류 규칙</h1>
      {children}
    </main>
  );
}

/** `미분류 | 전체` 보기 전환. 드롭다운 대신 두 칸짜리 링크 묶음이다. */
function FilterSwitch({ filter }: { filter: string }) {
  const options = [
    { value: CLASSIFY_FILTERS.unclassified, label: "미분류", href: "/classify" },
    { value: CLASSIFY_FILTERS.all, label: "전체", href: `/classify?filter=${CLASSIFY_FILTERS.all}` },
  ];
  return (
    <nav aria-label="보기" className="inline-flex self-start rounded-md border border-line-strong p-0.5 text-xs">
      {options.map((option) => {
        const current = option.value === filter;
        return (
          <Link
            key={option.value}
            href={option.href}
            aria-current={current ? "page" : undefined}
            data-testid={`filter-${option.value}`}
            className={`rounded px-2.5 py-1 ${
              current ? "bg-inverse font-medium text-on-inverse" : "text-muted hover:bg-hover hover:text-fg"
            }`}
          >
            {option.label}
          </Link>
        );
      })}
    </nav>
  );
}

/** 섹션 머리의 개수 꼬리표. */
function Count({ value }: { value: number }) {
  return (
    <span className="rounded border border-line bg-subtle px-1.5 text-xs font-medium text-muted tabular-nums">
      {value}
    </span>
  );
}

function RuleSection<T>({
  title,
  items,
  testId,
  render,
  keyOf,
}: {
  title: string;
  items: T[];
  testId: string;
  render: (item: T) => React.ReactNode;
  keyOf: (item: T) => string;
}) {
  return (
    <section className="flex flex-col gap-2" data-testid={testId}>
      <h3 className="flex items-center gap-2 text-[13px] font-semibold text-fg">
        {title}
        <Count value={items.length} />
      </h3>
      {items.length === 0 ? (
        <p className="text-xs text-muted">없음</p>
      ) : (
        <ul className="flex flex-col gap-2">
          {items.map((item) => (
            <li key={keyOf(item)}>{render(item)}</li>
          ))}
        </ul>
      )}
    </section>
  );
}

function first(value: string | string[] | undefined): string {
  return (Array.isArray(value) ? value[0] : value) ?? "";
}

type Loaded = {
  /** 거래가 한 건이라도 있는가. */
  hasRows: boolean;
  /** 달별 묶음(최신 달 먼저). */
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
        <p role="alert" className="text-[13px] text-danger">
          접근 권한이 없습니다.
        </p>
      </Shell>
    );
  }

  const params = await searchParams;
  const requested = first(params.month);
  // 예전 한 달 보기 주소는 그 달 현금흐름표의 미분류 섹션으로 보낸다(달은 형식을 거른 값만 싣는다).
  if (isYearMonth(requested)) redirect(`/report?month=${requested}#unclassified`);
  if (requested !== "" && requested !== ALL_MONTHS) {
    return (
      <Shell>
        <p role="alert" className="text-[13px] text-danger">
          조회할 월의 형식이 올바르지 않습니다. 주소의 <code>month</code> 값은
          <code> YYYY-MM</code> 이어야 합니다.
        </p>
        <Link href="/classify" className={`self-start ${PLAIN_LINK}`}>
          분류 규칙 보기
        </Link>
      </Shell>
    );
  }
  const filter =
    first(params.filter) === CLASSIFY_FILTERS.all ? CLASSIFY_FILTERS.all : CLASSIFY_FILTERS.unclassified;

  let loaded: Loaded;
  try {
    loaded = await withClient(async (client) => {
      const all = await listAllPeriodGroups(client, filter);
      const hasRows = all.months.length > 0 || (await listYearMonths(client, { limit: 1 })).length > 0;
      const mappings = await listMappings(client);
      const patterns = (await listPatterns(client)) as SavedPattern[];
      const memoMappings = (await listMemoMappings(client)) as MemoMapping[];
      return {
        hasRows,
        sections: all.months as Array<{ month: string; groups: ClassifyGroup[] }>,
        truncated: all.truncated,
        mappings,
        memoMappings,
        patterns,
      };
    });
  } catch {
    return (
      <Shell>
        <p role="alert" className="text-[13px] text-danger">
          데이터를 불러오지 못했습니다. 잠시 후 다시 시도해 주세요.
        </p>
      </Shell>
    );
  }

  const categories = [...CLASSIFY_CATEGORIES];
  const groupCount = loaded.sections.reduce((sum, section) => sum + section.groups.length, 0);

  return (
    <Shell>
      <section className="flex flex-col gap-4" aria-labelledby="rules-title">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h2 id="rules-title" className="text-[15px] font-semibold tracking-tight">
            저장된 규칙
          </h2>
          <ReclassifyButton />
        </div>
        <RuleSection
          title="패턴"
          testId="patterns"
          items={loaded.patterns}
          keyOf={(saved) => `${saved.basis}\u001f${saved.direction}\u001f${saved.pattern}`}
          render={(saved) => <PatternRow saved={saved} categories={categories} />}
        />
        <RuleSection
          title="메모 매핑"
          testId="memo-mappings"
          items={loaded.memoMappings}
          keyOf={(mapping) => `${mapping.direction}\u001f${mapping.memo}`}
          render={(mapping) => <MemoMappingRow mapping={mapping} categories={categories} />}
        />
        <RuleSection
          title="적요 매핑"
          testId="mappings"
          items={loaded.mappings}
          keyOf={(mapping) => `${mapping.direction}\u001f${mapping.key}`}
          render={(mapping) => <MappingRow mapping={mapping} categories={categories} />}
        />
      </section>

      <section className="flex flex-col gap-4" aria-labelledby="groups-title">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h2 id="groups-title" className="flex items-center gap-2 text-[15px] font-semibold tracking-tight">
            전체 기간
            <Count value={groupCount} />
          </h2>
          <FilterSwitch filter={filter} />
        </div>
        {!loaded.hasRows ? (
          <div className="flex flex-col gap-2">
            <p className="text-[13px] text-muted">저장된 거래 없음</p>
            <Link href="/import" className={`self-start ${PLAIN_LINK}`}>
              거래내역 올리기
            </Link>
          </div>
        ) : null}
        {loaded.truncated ? (
          <p role="alert" className="text-xs text-warn">
            최근 {MAX_ALL_PERIOD_ROWS.toLocaleString("ko-KR")}건까지만 표시
          </p>
        ) : null}
        {loaded.hasRows && groupCount === 0 ? (
          <p className="text-[13px] text-muted">{filter === CLASSIFY_FILTERS.unclassified ? "미분류 없음" : "거래 없음"}</p>
        ) : null}
        <div className="flex flex-col gap-8">
          {loaded.sections.map((monthSection) => (
            <section
              key={monthSection.month}
              aria-label={`${monthSection.month} 묶음`}
              data-testid="month-section"
              className="flex flex-col gap-4"
            >
              <h3 className="flex flex-wrap items-baseline gap-2 border-b border-line pb-1.5 text-[13px] font-semibold tracking-tight">
                <span className="tabular-nums">{monthSection.month}</span>
                <span className="text-xs font-normal text-muted tabular-nums">{monthSection.groups.length}묶음</span>
                <Link
                  href={`/report?month=${monthSection.month}`}
                  className="ml-auto text-xs font-normal text-accent-text underline-offset-4 hover:underline"
                >
                  현금흐름표
                </Link>
              </h3>
              {groupsByAccount(monthSection.groups).map((section) => (
                <section
                  key={section.id}
                  aria-labelledby={`account-${monthSection.month}-${section.id}`}
                  className="flex flex-col gap-2"
                >
                  <h4
                    id={`account-${monthSection.month}-${section.id}`}
                    data-testid="account-section"
                    className="text-xs font-medium text-muted"
                  >
                    {section.label}
                    <span className="ml-1.5 tabular-nums">{section.groups.length}</span>
                  </h4>
                  <ul className="flex flex-col gap-2">
                    {section.groups.map((group) => (
                      <li key={`${section.id}\u001f${group.direction}\u001f${group.key}\u001f${group.memo ?? ""}`}>
                        <GroupForm
                          month={monthSection.month}
                          group={group}
                          categories={categories}
                          hideOnApply={filter === CLASSIFY_FILTERS.unclassified}
                          showMonth
                        />
                      </li>
                    ))}
                  </ul>
                </section>
              ))}
            </section>
          ))}
        </div>
      </section>
    </Shell>
  );
}
