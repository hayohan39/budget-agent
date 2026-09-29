// 가계부 통계 — 월별 수입 · 저축 · 주거비 · 고정비 · 카드비 · 변동비 추이.
//
// ── 숫자의 출처 ────────────────────────────────────────────────────────────
//
// 달마다 월별 현금흐름표와 같은 집계를 돌려 여섯 값을 꺼낸다(lib/report/trends.mjs).
// 분류 규칙을 여기서 다시 만들지 않는다 — 그래서 이 화면의 한 달 숫자는 그 달
// 현금흐름표 종합정산의 같은 줄과 같다.
//
// ── 보안 ───────────────────────────────────────────────────────────────────
//
//   - middleware 의 matcher 가 `/stats` 를 덮는다(예외 목록에 없다). 그래도 여기서
//     세션 + 화이트리스트를 **요청마다 다시** 본다(/report · /classify 와 같다).
//   - 항상 동적으로 렌더한다. 정적으로 구워 두지 않는다.
//   - 화면에 나가는 것은 달 이름 · 여섯 합계 · 거래 건수뿐이다. 적요 · 계좌 ·
//     행 단위 값은 없다.
//   - console 호출이 없다. 에러는 바인딩 없는 `catch {}` 로 받는다.
//   - `range` 는 정해진 값(6 · 12 · 24 · all)만 받고, 그 밖의 값은 되비추지 않고
//     기본값으로 본다.
import Form from "next/form";
import Link from "next/link";
import { redirect } from "next/navigation";

import { auth, isAllowedEmail } from "@/auth";
import { withClient } from "@/lib/db/client.mjs";
import {
  DEFAULT_TREND_RANGE,
  TREND_RANGES,
  TREND_SERIES,
  loadMonthlyTrends,
} from "@/lib/report/trends.mjs";

import { TrendChart, won } from "./trend-chart";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type SeriesKey = "수입" | "저축" | "주거비" | "고정비" | "카드비" | "변동비";
type TrendPoint = { yearMonth: string; hasData: boolean; count: number } & Record<SeriesKey, number | null>;

const RANGE_TEXT: Record<string, string> = {
  "6": "최근 6개월",
  "12": "최근 12개월",
  "24": "최근 24개월",
  all: "전체",
};

/** 그래프 머리의 작은 설명. 어느 현금흐름표 줄에서 왔는지. */
const NOTE: Record<SeriesKey, string> = {
  수입: "메인 계좌로 들어온 돈 · 내 계좌 간 이체 · 일회성 수입 제외",
  저축: "나간 돈",
  주거비: "나간 돈",
  고정비: "나간 돈 · 고정비 계좌로 옮긴 돈 포함",
  카드비: "나간 돈 · 카드대금",
  변동비: "일회성 지출 − 일회성 수입 · 미분류 포함 · 음수면 수입이 더 컸던 달",
};

function Shell({ children }: { children: React.ReactNode }) {
  return (
    <main className="mx-auto flex w-full max-w-5xl flex-1 flex-col gap-6 px-4 py-6 sm:px-8 sm:py-8">
      <h1 className="text-xl font-semibold tracking-tight">가계부 통계</h1>
      {children}
    </main>
  );
}

function RangePicker({ selected }: { selected: string }) {
  return (
    <Form action="/stats" className="flex items-center gap-2">
      <label htmlFor="range" className="text-[13px] text-muted">
        기간
      </label>
      <select
        id="range"
        name="range"
        defaultValue={selected}
        className="h-8 rounded-md border border-control bg-canvas px-2 text-[13px]"
      >
        {Object.keys(RANGE_TEXT).map((key) => (
          <option key={key} value={key}>
            {RANGE_TEXT[key]}
          </option>
        ))}
      </select>
      <button
        type="submit"
        className="h-8 rounded-md border border-line-strong bg-canvas px-3 text-[13px] font-medium hover:bg-hover"
      >
        보기
      </button>
    </Form>
  );
}

function TrendTable({ points }: { points: TrendPoint[] }) {
  const cell = "border-b border-line px-3 py-1.5";
  const num = `${cell} text-right tabular-nums whitespace-nowrap`;
  const head = `${cell} whitespace-nowrap bg-subtle py-1 text-xs font-medium text-muted`;
  return (
    // 좁은 화면에서는 표만 가로로 밀린다(페이지 전체가 넘치지 않게).
    <div className="min-w-0 overflow-x-auto rounded-lg border border-line">
      <table className="w-full border-collapse text-[13px] [&>tbody>tr:last-child>*]:border-b-0">
        <caption className="border-b border-line px-3 py-2 text-left text-[13px] font-semibold text-fg">
          표로 보기
          <span className="ml-2 text-xs font-normal text-muted">
            수입은 들어온 돈, 나머지는 나간 돈의 크기입니다(변동비는 일회성 수입을 뺀 값)
          </span>
        </caption>
        <thead>
          <tr>
            <th scope="col" className={`${head} text-left`}>
              월
            </th>
            {TREND_SERIES.map((series) => (
              <th key={series.key} scope="col" className={`${head} text-right`}>
                {series.label}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {[...points].reverse().map((point) => (
            <tr key={point.yearMonth}>
              <th scope="row" className={`${cell} whitespace-nowrap text-left font-normal`}>
                <Link href={`/report?month=${point.yearMonth}`} className="text-accent-text underline-offset-4 hover:underline">
                  {point.yearMonth}
                </Link>
              </th>
              {point.hasData ? (
                TREND_SERIES.map((series) => (
                  <td
                    key={series.key}
                    className={`${num} ${(point[series.key as SeriesKey] ?? 0) < 0 ? "text-neg" : ""}`}
                  >
                    {won(point[series.key as SeriesKey] ?? 0)}
                  </td>
                ))
              ) : (
                <td colSpan={TREND_SERIES.length} className={`${cell} text-center text-muted`}>
                  데이터 없음
                </td>
              )}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function first(value: string | string[] | undefined): string {
  return (Array.isArray(value) ? value[0] : value) ?? "";
}

export default async function StatsPage({ searchParams }: PageProps<"/stats">) {
  const session = await auth();
  if (!session) redirect("/signin?callbackUrl=%2Fstats");
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
  const requested = first(params.range);
  const range = Object.hasOwn(TREND_RANGES, requested) ? requested : DEFAULT_TREND_RANGE;
  const months = TREND_RANGES[range as keyof typeof TREND_RANGES];

  let points: TrendPoint[];
  try {
    points = (await withClient((client) => loadMonthlyTrends(client, { months }))) as TrendPoint[];
  } catch {
    return (
      <Shell>
        <p role="alert" className="text-[13px] text-danger">
          데이터를 불러오지 못했습니다. 잠시 후 다시 시도해 주세요.
        </p>
      </Shell>
    );
  }

  return (
    <Shell>
      <RangePicker selected={range} />
      {points.length === 0 ? (
        <>
          <p className="text-[13px] text-muted">
            아직 저장된 거래가 없습니다. 거래내역을 먼저 올려주세요.
          </p>
          <Link
            href="/import"
            className="self-start inline-flex h-9 items-center rounded-md border border-line-strong bg-canvas px-4 text-[13px] font-medium hover:bg-hover"
          >
            거래내역 올리기
          </Link>
        </>
      ) : (
        <>
          <p className="text-xs text-muted">
            달마다 월별 현금흐름표와 같은 집계에서 나온 값입니다. 수입은 메인 계좌로 들어온
            돈이고(메인 ↔ 고정비 · 비상금 계좌 사이의 이체와 그 계좌들의 입금 · 이자, 변동비로
            분류한 일회성 수입 · 미분류 입금은 넣지 않습니다), 저축 · 주거비 · 고정비 · 카드비는
            나간 돈의 크기입니다. 변동비는 일회성 지출에서 일회성 수입을 뺀 값이라 수입이 더
            큰 달에는 음수입니다. 고정비는 현금흐름표 종합정산의 ‘고정비(계좌 이체 포함)’ 줄과
            같습니다. 막대에 마우스를
            올리거나 Tab 으로 옮기면 값이 보이고, 모든 값은 아래 표에도 있습니다.
            {points.length === 1 ? " 아직 한 달치 자료뿐이라 추이 대신 그 달 값만 보입니다." : ""}
          </p>
          <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
            {TREND_SERIES.map((series, index) => (
              <TrendChart
                key={series.key}
                id={`trend-${index}`}
                title={series.label}
                note={NOTE[series.key as SeriesKey]}
                bars={points.map((point) => ({
                  yearMonth: point.yearMonth,
                  value: point.hasData ? (point[series.key as SeriesKey] ?? 0) : null,
                }))}
              />
            ))}
          </div>
          <TrendTable points={points} />
        </>
      )}
    </Shell>
  );
}
