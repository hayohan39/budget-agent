// 월별 현금흐름표 화면.
//
// 이 파일은 인증 · 달 선택 · 조회만 한다. 표 서식은 report-view.tsx 에 있다
// (최종 정산표 양식이 확정되면 그 파일만 갈아끼운다).
//
// ── 보안 ───────────────────────────────────────────────────────────────────
//
//   - middleware 의 matcher 가 `/report` 를 이미 덮지만(부정 전방탐색 예외
//     목록에 report 가 없다), 여기서도 세션을 다시 확인한다. 그리고 화이트리스트를
//     **요청마다 다시 본다** — 세션 쿠키는 ALLOWED_EMAILS 에서 이메일을 뺀 뒤에도
//     만료 전까지 살아 있다(app/api/import/route.ts 와 같은 이유).
//   - `month` 는 SQL 에 닿기 전에 `^[0-9]{4}-[0-9]{2}$` 로 거른다. 통과한 뒤에도
//     파라미터 바인딩으로만 넣는다(lib/report/months.mjs · monthly.mjs).
//     형식이 틀리면 **받은 값을 되비추지 않고** 거부한다.
//   - console 호출이 이 파일에 없다. 에러는 바인딩 없는 `catch {}` 로 받는다 —
//     pg 메시지에는 호스트명과 값이 섞여 나온다.
//   - 화면에 나가는 것은 집계뿐이다. 행 단위 내역 · 거래 일시 · 계좌번호는 없다.
//     단, 항목 줄의 이름은 사람이 정하지 않았으면 **정규화한 적요**다(사용자가
//     요청한 변경. PLAN.md "적요 표시 원칙 변경"). 미분류는 건수와 /classify 링크.
//   - **예외: 무효 처리(상쇄) 패널(2026-09).** 두 거래를 짝지으려면 사람이 그 거래를 알아봐야
//     해서, 무효로 표시한 쌍과 후보 쌍(같은 계좌 · 같은 금액 · 반대 방향, 많아야 20쌍)에 한해
//     거래 일시(분 단위) · 적요 · 메모 · 금액을 보인다. 계좌번호 · 잔액은 없다. 사용자가 요청한
//     기능이고 이 화면(로그인 + 화이트리스트, 동적 렌더)에만 그린다(app/report/void-panel.tsx).
import Form from "next/form";
import Link from "next/link";
import { redirect } from "next/navigation";

import { auth, isAllowedEmail } from "@/auth";
import { withClient } from "@/lib/db/client.mjs";
import { isYearMonth, listYearMonths } from "@/lib/report/months.mjs";
import { buildMonthlyReport } from "@/lib/report/monthly.mjs";
import { verifyMonthlyReport } from "@/lib/report/verify.mjs";
import { listVoidCandidates, listVoidedPairs } from "@/lib/report/voids.mjs";

import { ReportView, type MonthlyReport, type Verification } from "./report-view";
import { VoidPanel, type VoidCandidate, type VoidedPair } from "./void-panel";

// pg 는 Edge 에서 돌지 않는다.
export const runtime = "nodejs";

function Shell({ children }: { children: React.ReactNode }) {
  return (
    <main className="mx-auto flex w-full max-w-5xl flex-1 flex-col gap-6 p-8">
      <div className="flex items-baseline justify-between">
        <h1 className="text-2xl font-semibold tracking-tight">월별 현금흐름표</h1>
        <div className="flex gap-4">
          <Link
            href="/stats"
            className="text-sm text-zinc-600 underline underline-offset-4 hover:text-zinc-900 dark:text-zinc-400 dark:hover:text-zinc-100"
          >
            통계
          </Link>
          <Link
            href="/"
            className="text-sm text-zinc-600 underline underline-offset-4 hover:text-zinc-900 dark:text-zinc-400 dark:hover:text-zinc-100"
          >
            홈
          </Link>
        </div>
      </div>
      {children}
    </main>
  );
}

function MonthPicker({ months, selected }: { months: string[]; selected: string }) {
  // 고른 달이 목록에 없을 수도 있다(거래가 없는 달을 주소로 직접 물은 경우).
  // 그 값도 선택지로 남겨 둬야 화면과 주소가 어긋나지 않는다.
  const options = months.includes(selected) ? months : [selected, ...months];

  return (
    <Form action="/report" className="flex items-center gap-2">
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
      <button
        type="submit"
        className="rounded-md border border-zinc-300 px-3 py-1 text-sm hover:bg-zinc-100 dark:border-zinc-700 dark:hover:bg-zinc-900"
      >
        보기
      </button>
    </Form>
  );
}

type Loaded = {
  months: string[];
  yearMonth: string;
  report: MonthlyReport;
  verification: Verification;
  voided: VoidedPair[];
  candidates: VoidCandidate[];
};

export default async function ReportPage({ searchParams }: PageProps<"/report">) {
  const session = await auth();
  if (!session) redirect("/signin?callbackUrl=%2Freport");

  // 세션이 있어도 화이트리스트를 다시 본다. 쿠키가 명단보다 오래 산다.
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
  const raw = params.month;
  const requested = (Array.isArray(raw) ? raw[0] : raw) ?? "";
  if (requested !== "" && !isYearMonth(requested)) {
    // 받은 값을 되비추지 않는다.
    return (
      <Shell>
        <p role="alert" className="text-sm text-red-600">
          조회할 월의 형식이 올바르지 않습니다. 주소의 <code>month</code> 값은
          <code> YYYY-MM</code> 이어야 합니다.
        </p>
        <Link
          href="/report"
          className="self-start text-sm text-zinc-600 underline underline-offset-4 dark:text-zinc-400"
        >
          최근 달 보기
        </Link>
      </Shell>
    );
  }

  let loaded: Loaded | null = null;
  let months: string[] = [];
  try {
    const outcome = await withClient(async (client) => {
      const available = await listYearMonths(client);
      // 거래가 한 건도 없으면 볼 달이 없다.
      if (available.length === 0 && requested === "") return { months: available, loaded: null };

      const yearMonth = requested === "" ? available[0] : requested;
      const report = await buildMonthlyReport(client, yearMonth);
      const voided = (await listVoidedPairs(client, yearMonth)) as VoidedPair[];
      const candidates = (await listVoidCandidates(client, yearMonth)) as VoidCandidate[];
      return {
        months: available,
        loaded: { months: available, yearMonth, report, verification: verifyMonthlyReport(report), voided, candidates },
      };
    });
    months = outcome.months;
    loaded = outcome.loaded;
  } catch {
    // 연결 실패 · 조회 실패. 원인 객체는 어디로도 내보내지 않는다.
    return (
      <Shell>
        <p role="alert" className="text-sm text-red-600">
          데이터를 불러오지 못했습니다. 잠시 후 다시 시도해 주세요.
        </p>
      </Shell>
    );
  }

  if (loaded === null) {
    return (
      <Shell>
        <p className="text-sm text-zinc-600 dark:text-zinc-400">
          아직 저장된 거래가 없습니다. 거래내역을 먼저 올려주세요.
        </p>
        <Link
          href="/import"
          className="self-start rounded-md border border-zinc-300 px-4 py-2 text-sm hover:bg-zinc-100 dark:border-zinc-700 dark:hover:bg-zinc-900"
        >
          거래내역 올리기
        </Link>
      </Shell>
    );
  }

  return (
    <Shell>
      <MonthPicker months={months} selected={loaded.yearMonth} />
      {loaded.report.거래건수 === 0 ? (
        <p className="text-sm text-zinc-600 dark:text-zinc-400">
          {loaded.yearMonth} 에 저장된 거래가 없습니다. 다른 달을 골라 주세요.
        </p>
      ) : (
        <ReportView report={loaded.report} verification={loaded.verification} />
      )}
      {loaded.report.거래건수 > 0 || loaded.voided.length > 0 ? (
        <VoidPanel yearMonth={loaded.yearMonth} voided={loaded.voided} candidates={loaded.candidates} />
      ) : null}
    </Shell>
  );
}
