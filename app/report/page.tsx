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
//     요청한 변경. PLAN.md "적요 표시 원칙 변경").
//   - **미분류 섹션(2026-09).** 그 달의 미분류 묶음을 /classify 와 같은 모양(계좌 별칭 · 적요 ·
//     메모 · 방향별 건수 · 합계)으로 이 화면 아래에 싣고 바로 분류한다(unclassified-section.tsx).
//     쓰기는 기존 `/api/classify` 로만 간다.
//   - **예외: 무효 처리(상쇄) 패널(2026-09).** 두 거래를 짝지으려면 사람이 그 거래를 알아봐야
//     해서, 무효로 표시한 쌍과 후보 쌍(같은 계좌 · 같은 금액 · 반대 방향, 많아야 20쌍)에 한해
//     거래 일시(분 단위) · 적요 · 메모 · 금액을 보인다. 계좌번호 · 잔액은 없다. 사용자가 요청한
//     기능이고 이 화면(로그인 + 화이트리스트, 동적 렌더)에만 그린다(app/report/void-panel.tsx).
import Link from "next/link";
import { redirect } from "next/navigation";

import { auth, isAllowedEmail } from "@/auth";
import { withClient } from "@/lib/db/client.mjs";
import { CLASSIFY_FILTERS, listClassifyGroups } from "@/lib/classify/manual.mjs";
import { isYearMonth, listYearMonths } from "@/lib/report/months.mjs";
import { CLASSIFY_CATEGORIES, buildMonthlyReport } from "@/lib/report/monthly.mjs";
import { verifyMonthlyReport } from "@/lib/report/verify.mjs";
import { listVoidCandidates, listVoidedPairs } from "@/lib/report/voids.mjs";

import { MonthTabs } from "../_ui/month-tabs";
import type { ClassifyGroup } from "../classify/forms";
import { ReportView, type MonthlyReport, type Verification } from "./report-view";
import { UnclassifiedSection } from "./unclassified-section";
import { VoidPanel, type VoidCandidate, type VoidedPair } from "./void-panel";

// pg 는 Edge 에서 돌지 않는다.
export const runtime = "nodejs";

function Shell({ children }: { children: React.ReactNode }) {
  return (
    <main className="mx-auto flex w-full max-w-5xl flex-1 flex-col gap-6 px-4 py-6 sm:px-8 sm:py-8">
      <h1 className="text-xl font-semibold tracking-tight">월별 현금흐름표</h1>
      {children}
    </main>
  );
}

type Loaded = {
  months: string[];
  yearMonth: string;
  report: MonthlyReport;
  verification: Verification;
  voided: VoidedPair[];
  candidates: VoidCandidate[];
  /** 그 달의 미분류 묶음(/classify 와 같은 목록). */
  unclassified: ClassifyGroup[];
};

export default async function ReportPage({ searchParams }: PageProps<"/report">) {
  const session = await auth();
  if (!session) redirect("/signin?callbackUrl=%2Freport");

  // 세션이 있어도 화이트리스트를 다시 본다. 쿠키가 명단보다 오래 산다.
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
  const raw = params.month;
  const requested = (Array.isArray(raw) ? raw[0] : raw) ?? "";
  if (requested !== "" && !isYearMonth(requested)) {
    // 받은 값을 되비추지 않는다.
    return (
      <Shell>
        <p role="alert" className="text-[13px] text-danger">
          조회할 월의 형식이 올바르지 않습니다. 주소의 <code>month</code> 값은
          <code> YYYY-MM</code> 이어야 합니다.
        </p>
        <Link
          href="/report"
          className="self-start text-[13px] text-accent-text underline-offset-4 hover:underline"
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
      const unclassified = (await listClassifyGroups(
        client,
        yearMonth,
        CLASSIFY_FILTERS.unclassified,
      )) as ClassifyGroup[];
      return {
        months: available,
        loaded: {
          months: available,
          yearMonth,
          report,
          verification: verifyMonthlyReport(report),
          voided,
          candidates,
          unclassified,
        },
      };
    });
    months = outcome.months;
    loaded = outcome.loaded;
  } catch {
    // 연결 실패 · 조회 실패. 원인 객체는 어디로도 내보내지 않는다.
    return (
      <Shell>
        <p role="alert" className="text-[13px] text-danger">
          데이터를 불러오지 못했습니다. 잠시 후 다시 시도해 주세요.
        </p>
      </Shell>
    );
  }

  if (loaded === null) {
    return (
      <Shell>
        <p className="text-[13px] text-muted">저장된 거래 없음</p>
        <Link
          href="/import"
          className="self-start inline-flex h-9 items-center rounded-md border border-line-strong bg-canvas px-4 text-[13px] font-medium hover:bg-hover"
        >
          거래내역 올리기
        </Link>
      </Shell>
    );
  }

  return (
    <Shell>
      <MonthTabs months={months} selected={loaded.yearMonth} basePath="/report" />
      {loaded.report.거래건수 === 0 ? (
        <p className="text-[13px] text-muted" data-testid="empty-month">
          거래 없음
        </p>
      ) : (
        <ReportView report={loaded.report} verification={loaded.verification} />
      )}
      {loaded.report.거래건수 > 0 ? (
        <UnclassifiedSection
          month={loaded.yearMonth}
          groups={loaded.unclassified}
          categories={[...CLASSIFY_CATEGORIES]}
        />
      ) : null}
      {loaded.report.거래건수 > 0 || loaded.voided.length > 0 ? (
        <VoidPanel yearMonth={loaded.yearMonth} voided={loaded.voided} candidates={loaded.candidates} />
      ) : null}
    </Shell>
  );
}
