// 월별 현금흐름표의 **표 서식**. 숫자는 lib/report/monthly.mjs 가 만든다.
//
// 이 화면은 사용자가 손으로 쓰던 **정산 템플릿(스프레드시트)의 배치를 그대로
// 옮긴 것**이다. 원본은 한 시트에 월 블록이 세로로 쌓이고, 한 블록이 가로로
// 세 열 그룹으로 나뉜다.
//
//   좌: 수입 · 저축 · 용돈 · 주거비      (메인에서 바로 나가는 돈)
//   중: 고정비 계좌 · 비상금 계좌        (입금 / 집행 / 이자 / 잔액)
//   우: 변동비(카드사별) · 종합정산 · 메인 계좌 잔액
//
// 원본에서 확인한 항등식 두 개를 그대로 화면에 세운다.
//
//   1. 계좌 롤포워드   잔액(당월) = 잔액(전월) + 입금 − 집행 + 이자
//      원본에서는 이 자리가 손으로 넣던 `보정` 칸이었다. 정체는 통장이자이고,
//      이제 실거래(`이자입금`)로 자동으로 채워진다(PLAN.md: "이자는 보정이 아니다").
//   2. 마무리         메인 계좌 잔액(당월) − [잔액(전월) + 종합정산 합계] = 0
//      원본에서는 이 잔차를 회색 `보정` 칸에 손으로 적어 맞췄다. 이 화면은
//      그 자리에 **검산 차액**을 놓는다. 0 이 아니면 덮지 않고 드러낸다.
//
// 종합정산 표에 있던 `수입 보정` · `저축 보정` · `비상금 보정` · `변동비 보정(±)`
// 줄은 **없앴다**(2026-09, 사용자 요청: "수동으로 기입할 때 생겼던 것이라 이제
// 필요 없다"). 값을 넣는 화면이 한 번도 없어 늘 0 이었다. 종합정산의 합계는
// 곧 실현순증감이고, 검산은 원래부터 그 값으로 한다(lib/report/verify.mjs).
//
// 가운데 열의 계좌 표(고정비 · 비상금)는 머리에 **`고정비 계좌` · `비상금 계좌`**
// 줄을 단다. 왼쪽 열에도 메인 계좌에서 바로 나간 `고정비` 분류 표가 있을 수 있어,
// 머리 없이는 '고정비' 표가 두 개로 보였다(사용자 보고). 메인 계좌 표에는 머리를
// 달지 않는다(사용자 요청).
//
// ── 부호 ──────────────────────────────────────────────────────────────────
//
// 저장된 부호 규약(입금 + / 출금 −)을 **그대로 보여 준다.** 화면에서 지출을
// 양수로 뒤집지 않는다. 뒤집으면 어떤 칸이 뒤집힌 값인지 사람이 매번 기억해야
// 하고, 검산 차액의 부호를 읽을 때 정확히 반대로 이해하게 된다.
// 원본 템플릿도 지출을 음수로 적고 있어 규약이 같다.
//
// ── 여기에 없는 것 ────────────────────────────────────────────────────────
//
// 행 단위 내역이 없다. 거래 일시 · 잔액 · 메모 · 계좌번호 · 뒤 4자리는 이
// 파일이 받는 데이터에 애초에 들어 있지 않다.
//
// 원본의 `선용 월급` · `지현 ISA` 같은 **항목 줄**은 집계의 `항목별` ·
// `계좌블록[].항목` 에서 온다. 사람이 /classify 에서 항목 이름을 정하지 않았으면
// 정규화한 **적요 그대로**가 항목 이름이다(카드대금은 카드사). 즉 이 화면에
// 적요가 나온다 — 사용자가 요청한 변경이다(PLAN.md "적요 표시 원칙 변경").
// 로그인 + 화이트리스트 뒤의 동적 페이지에만 그려진다.
import Link from "next/link";

import type { aggregateMonthly } from "@/lib/report/monthly.mjs";
import type { verifyMonthlyReport } from "@/lib/report/verify.mjs";

export type MonthlyReport = ReturnType<typeof aggregateMonthly>;
export type Verification = ReturnType<typeof verifyMonthlyReport>;

/**
 * 섹션의 한 줄.
 *
 * `고정지출1` · `고정지출2` 는 고정된 분류 목록으로 만들어져서(monthly.mjs 의
 * `fixedSection`) JS 쪽 추론이 `any` 로 끝난다. 화면이 읽는 모양을 여기 적어
 * 두고 그 타입으로 받는다 — 집계가 바뀌면 이 줄이 먼저 어긋난다.
 */
type SectionItem = { key: string; total: number; count: number; tag?: string; flow?: string };

/**
 * `항목별` 의 한 줄. (분류, 항목, 방향) 단위다. 같은 항목의 입금과 출금은 서로
 * 다른 줄이다 — 한 줄 안에서 부호가 섞이지 않는다.
 */
type Line = { category: string; item: string; direction: "in" | "out"; total: number; count: number };

const DIRECTION_TEXT: Record<Line["direction"], string> = { in: "입금", out: "출금" };

/**
 * 항목 줄 -> 표의 한 줄. 분류가 표 이름과 다르면 작은 꼬리표로 붙인다.
 *
 * 방향이 그 표의 기본 방향(`natural` — 수입 표는 입금, 지출 표는 출금)과 다르면
 * 방향 꼬리표를 붙인다. 같은 항목 이름의 입금 줄과 출금 줄이 한 표에 나란히
 * 있을 때(예: 수입으로 고른 적요의 반환 출금) 둘을 구별하게 해 준다.
 */
function linesAsItems(lines: Line[], kind?: string, natural: Line["direction"] = "out"): SectionItem[] {
  return lines.map((line) => ({
    key: line.item,
    total: line.total,
    count: line.count,
    tag: kind !== undefined && line.category === kind ? undefined : line.category,
    flow: line.direction === natural ? undefined : DIRECTION_TEXT[line.direction],
  }));
}

/** 흐름 금액. 부호를 항상 붙인다(0 은 부호 없음). */
const FLOW = new Intl.NumberFormat("ko-KR", { signDisplay: "exceptZero" });
/** 잔액처럼 부호가 방향을 뜻하지 않는 값. */
const PLAIN = new Intl.NumberFormat("ko-KR");

function flow(value: number | null | undefined): string {
  if (typeof value !== "number" || !Number.isFinite(value)) return "—";
  return `${FLOW.format(value)}원`;
}

function plain(value: number | null | undefined): string {
  if (typeof value !== "number" || !Number.isFinite(value)) return "—";
  return `${PLAIN.format(value)}원`;
}

/** 검산하지 못한 사유 코드 -> 문장. lib/report/verify.mjs 의 VERIFY_REASONS. */
const VERIFY_REASON_TEXT: Record<string, string> = {
  noMainAccount: "메인 계좌가 등록되어 있지 않습니다",
  noRows: "이 달에 메인 계좌 거래가 없습니다",
  balanceMissing: "첫 거래 또는 마지막 거래의 거래 후 잔액이 비어 있습니다",
  unavailable: "검산에 필요한 값이 없습니다",
};

/**
 * 계좌별 잔액 표에서 쓰는 같은 코드의 문장.
 *
 * 검산 배너는 "메인 계좌" 를 말해도 되지만 이 표는 계좌마다 한 줄이라 같은
 * 문장을 쓰면 고정비 줄에 "메인 계좌 거래가 없습니다" 가 찍힌다.
 */
const BALANCE_REASON_TEXT: Record<string, string> = {
  noRows: "이 달 거래가 없습니다",
  balanceMissing: "첫 거래 또는 마지막 거래의 거래 후 잔액이 비어 있습니다",
};

function reasonText(table: Record<string, string>, reason: string | null): string {
  if (reason === null) return "사유를 알 수 없습니다";
  return table[reason] ?? `사유를 알 수 없습니다 (${reason.slice(0, 64)})`;
}

function verifyReasonText(reason: string | null): string {
  return reasonText(VERIFY_REASON_TEXT, reason);
}

function balanceReasonText(reason: string | null): string {
  return reasonText(BALANCE_REASON_TEXT, reason);
}

// ── 표 조각 ────────────────────────────────────────────────────────────────

const BOX = "w-full border-collapse text-sm";
const LINE = "border border-zinc-300 dark:border-zinc-700";
const CELL = `${LINE} px-2 py-1`;
const NUM = `${CELL} text-right tabular-nums whitespace-nowrap`;
const HEAD = `${CELL} whitespace-nowrap text-center text-xs font-normal text-zinc-500`;
/** 원본의 색칠한 줄. 합계·잔액처럼 눈이 먼저 가야 하는 칸이다. */
const TONE: Record<string, string> = {
  income: "bg-emerald-50 font-medium dark:bg-emerald-950/40",
  fixed: "bg-amber-50 font-medium dark:bg-amber-950/40",
  emergency: "bg-rose-50 font-medium dark:bg-rose-950/40",
  main: "bg-emerald-50 font-semibold dark:bg-emerald-950/40",
  plain: "font-medium",
};

/** 원본의 `종류 | 항목 | 금액` 머리글. */
function Head3() {
  return (
    <tr>
      <th scope="col" className={HEAD}>
        종류
      </th>
      <th scope="col" className={HEAD}>
        항목
      </th>
      <th scope="col" className={HEAD}>
        금액
      </th>
    </tr>
  );
}

/** 표 아래쪽의 `합계` · `잔액` 처럼 앞 두 칸을 합친 줄. */
function WideRow({
  label,
  value,
  tone,
  note,
}: {
  label: string;
  value: string;
  tone?: keyof typeof TONE;
  note?: string;
}) {
  return (
    <tr className={tone === undefined ? undefined : TONE[tone]}>
      <th scope="row" colSpan={2} className={`${CELL} text-center font-normal`}>
        {label}
        {note !== undefined ? (
          <span className="ml-1 text-xs text-zinc-500">{note}</span>
        ) : null}
      </th>
      <td className={NUM}>{value}</td>
    </tr>
  );
}

/**
 * 원본 좌측/우측 그룹의 표 하나.
 *
 * `종류` 칸은 세로로 병합되고, 아래에 항목 줄이 붙고, 마지막이 `합계` 다.
 * 항목이 없으면 빈 줄 하나를 둔다 — 원본에도 빈 줄이 그대로 있다.
 */
function KindTable({
  kind,
  items,
  total,
  tone,
  caption,
}: {
  kind: string;
  items: SectionItem[];
  total: number;
  tone?: keyof typeof TONE;
  caption: string;
}) {
  return (
    <table className={BOX}>
      <caption className="sr-only">{caption}</caption>
      <thead>
        <Head3 />
      </thead>
      <tbody>
        {items.length === 0 ? (
          <tr>
            <th scope="row" className={`${CELL} whitespace-nowrap text-center`}>
              {kind}
            </th>
            <td className={CELL}>&nbsp;</td>
            <td className={NUM}>&nbsp;</td>
          </tr>
        ) : (
          items.map((item, index) => (
            <tr key={`${item.tag ?? ""}\u001f${item.key}\u001f${item.flow ?? ""}`}>
              {index === 0 ? (
                <th scope="row" rowSpan={items.length} className={`${CELL} whitespace-nowrap text-center`}>
                  {kind}
                </th>
              ) : null}
              <td className={`${CELL} break-keep wrap-anywhere`}>
                <span className="block">{item.key}</span>
                <span className="block text-xs text-zinc-500">
                  {item.tag !== undefined ? (
                    <span className="mr-1 rounded bg-zinc-100 px-1 text-zinc-600 dark:bg-zinc-800 dark:text-zinc-400">
                      {item.tag}
                    </span>
                  ) : null}
                  {item.flow !== undefined ? (
                    <span className="mr-1 rounded bg-sky-50 px-1 text-sky-800 dark:bg-sky-950/40 dark:text-sky-300">
                      {item.flow}
                    </span>
                  ) : null}
                  {item.count}건
                </span>
              </td>
              <td className={NUM}>{flow(item.total)}</td>
            </tr>
          ))
        )}
        <WideRow label="합계" value={flow(total)} tone={tone ?? "plain"} />
      </tbody>
    </table>
  );
}

/**
 * 원본 중앙 그룹의 계좌 표.
 *
 * 맨 위에 `고정비 계좌` · `비상금 계좌` 머리 줄을 둔다 — 이 아래 줄은 전부 그
 * 계좌의 거래라는 표시다(왼쪽 열 메인 계좌의 `고정비` 분류 표와 헷갈리지 않게).
 *
 * 원본 순서: 입금 → 항목 → 합계(집행) → 보정 → 잔액.
 * `보정` 자리에는 실거래로 잡히는 **이자**가 온다. 그리고 원본에는 없던
 * `순증감` 을 한 줄 더 둔다 — 이자가 이 계좌의 집행을 상계한 값이다.
 */
function AccountTable({
  block,
  balance,
}: {
  block: MonthlyReport["계좌블록"][number];
  balance: MonthlyReport["계좌별잔액변화"][number] | undefined;
}) {
  const tone: keyof typeof TONE = block.role === "fixed" ? "fixed" : "emergency";
  const lines = block.항목 as Line[];

  const title = `${block.nickname} 계좌`;

  return (
    <table className={BOX} data-testid="account-table">
      <caption className="sr-only">{title}</caption>
      <thead>
        <tr className={TONE[tone]}>
          <th scope="colgroup" colSpan={3} className={`${CELL} text-left text-sm font-semibold`}>
            {title}
          </th>
        </tr>
        <Head3 />
      </thead>
      <tbody>
        <WideRow label="입금" value={flow(block.입금.total)} note="메인에서" />
        {lines.length === 0 ? (
          <tr>
            <th scope="row" className={`${CELL} whitespace-nowrap text-center`}>
              {block.nickname}
            </th>
            <td className={CELL}>&nbsp;</td>
            <td className={NUM}>&nbsp;</td>
          </tr>
        ) : (
          lines.map((line, index) => (
            <tr key={`${line.category}\u001f${line.item}\u001f${line.direction}`}>
              {index === 0 ? (
                <th scope="row" rowSpan={lines.length} className={`${CELL} whitespace-nowrap text-center`}>
                  {block.nickname}
                </th>
              ) : null}
              <td className={`${CELL} break-keep wrap-anywhere`}>
                <span className="block">{line.item}</span>
                <span className="block text-xs text-zinc-500">
                  {line.category !== block.nickname ? (
                    <span className="mr-1 rounded bg-zinc-100 px-1 text-zinc-600 dark:bg-zinc-800 dark:text-zinc-400">
                      {line.category}
                    </span>
                  ) : null}
                  {line.count}건
                </span>
              </td>
              <td className={NUM}>{flow(line.total)}</td>
            </tr>
          ))
        )}
        <WideRow label="합계" value={flow(block.집행.total)} note="집행" />
        <WideRow label="이자" value={flow(block.이자.total)} />
        <WideRow label="순증감" value={flow(block.순증감)} note="입금 + 이자 − 집행" tone="plain" />
        <WideRow
          label="잔액"
          value={balance?.derived === true ? plain(balance.closing) : "—"}
          tone={tone}
          note={
            balance === undefined || balance.derived
              ? undefined
              : `(${balanceReasonText(balance.reason)})`
          }
        />
      </tbody>
    </table>
  );
}

/** 우측 종합정산 표의 한 줄. 원본은 `항목 | 금액` 두 칸이다. */
function SummaryRow({
  label,
  value,
  tone,
  note,
}: {
  label: string;
  value: string;
  tone?: keyof typeof TONE;
  note?: string;
}) {
  return (
    <tr className={tone === undefined ? undefined : TONE[tone]}>
      <th scope="row" className={`${CELL} text-left font-normal`}>
        {label}
        {note !== undefined ? (
          <span className="ml-1 text-xs text-zinc-500">{note}</span>
        ) : null}
      </th>
      <td className={NUM}>{value}</td>
    </tr>
  );
}

// ── 값 꺼내기 ──────────────────────────────────────────────────────────────

function itemTotal(items: SectionItem[], key: string): number {
  return items.find((item) => item.key === key)?.total ?? 0;
}

/** 검산 결과. 어긋났다면 표 위에서 가장 먼저 보여야 한다. */
export function VerifyBanner({
  verification,
  mainNickname,
}: {
  verification: Verification;
  mainNickname: string | null;
}) {
  const account = mainNickname ?? "메인";

  if (!verification.checked) {
    return (
      <section className="rounded-md border border-amber-400 bg-amber-50 p-4 text-sm dark:border-amber-600 dark:bg-amber-950/30">
        <p className="font-medium">검산하지 않았습니다</p>
        <p className="mt-1 text-zinc-700 dark:text-zinc-300">
          {verifyReasonText(verification.reason)}. 값을 추정해서 채우지 않습니다.
        </p>
      </section>
    );
  }

  if (verification.ok) {
    return (
      <section className="rounded-md border border-emerald-500 bg-emerald-50 p-4 text-sm dark:border-emerald-700 dark:bg-emerald-950/30">
        <p className="font-medium">검산 통과</p>
        <p className="mt-1 text-zinc-700 dark:text-zinc-300">
          실현순증감 {flow(verification.actual)} 이 {account} 계좌 잔액 변화{" "}
          {flow(verification.expected)} 과 일치합니다.
        </p>
      </section>
    );
  }

  return (
    <section
      role="alert"
      className="rounded-md border-2 border-red-500 bg-red-50 p-4 dark:bg-red-950/30"
    >
      <p className="text-base font-semibold text-red-700 dark:text-red-400">
        검산 불일치 — 차액 {flow(verification.difference)}
      </p>
      <dl className="mt-3 grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-sm">
        <dt className="text-zinc-500">실현순증감(거래 금액 합)</dt>
        <dd className="tabular-nums">{flow(verification.actual)}</dd>
        <dt className="text-zinc-500">{account} 계좌 잔액 변화</dt>
        <dd className="tabular-nums">{flow(verification.expected)}</dd>
      </dl>
      <p className="mt-3 text-sm text-zinc-700 dark:text-zinc-300">
        두 값은 서로 다른 컬럼(거래 금액 · 거래 후 잔액)에서 나옵니다. 어긋났다면
        거래가 빠졌거나 파싱이 어긋난 신호입니다. <strong>손으로 값을 맞춰 덮지 마세요.</strong>
      </p>
    </section>
  );
}

/** 현금흐름표 본문 — 정산 템플릿 배치. */
export function ReportView({
  report,
  verification,
}: {
  report: MonthlyReport;
  verification: Verification;
}) {
  const fixed1 = report.고정지출1.items as SectionItem[];
  const fixed2 = report.고정지출2.items as SectionItem[];
  const moves = report.계좌간이동.items as SectionItem[];
  const card = report.변동지출.카드대금;
  const lines = report.항목별 as Record<"수입" | "고정지출1" | "고정지출2" | "변동지출", Line[]>;
  const mainBalance = report.계좌별잔액변화.find((entry) => entry.role === "main");

  // 우측 변동비 표 — 원본은 카드사별 줄만 있다. 카드가 아닌 변동지출(`기타`)은
  // 원본에 자리가 없지만 버리면 합계가 맞지 않으므로 줄을 하나 더 둔다.
  // 카드가 아닌 변동지출은 (분류, 항목) 줄로 풀어 쓴다. 미분류 출금은 `미분류`
  // 꼬리표가 붙은 채로 적요가 항목 이름이 된다.
  const otherVariable = linesAsItems(
    lines.변동지출.filter((line) => line.category !== "카드대금"),
  );
  const variableItems: SectionItem[] = [
    ...card.issuers.map((issuer) => ({
      key: issuer.issuer,
      total: issuer.total,
      count: issuer.count,
    })),
    ...otherVariable,
  ];
  const fixed2Shown = fixed2.filter((item) => item.count > 0);

  // 종합정산. 원본의 `고정비` · `비상금` 줄은 그 계좌로 **옮긴 돈**이다.
  // 이 레포에서는 계좌 간 이동으로 빠져 있으므로 고정지출2 와 합쳐서 되돌린다.
  const 고정비 = itemTotal(fixed2, "고정비") + itemTotal(moves, "고정비");
  const 비상금 = itemTotal(fixed2, "비상금") + itemTotal(moves, "비상금");
  const 기타이체 = itemTotal(moves, "기타");

  const summaryRows: Array<{ label: string; value: number | null; note?: string }> = [
    { label: "수입", value: report.종합정산.수입 },
    { label: "저축", value: itemTotal(fixed1, "저축") },
    { label: "용돈", value: itemTotal(fixed1, "용돈") },
    { label: "주거비", value: itemTotal(fixed1, "주거비") },
    { label: "고정비", value: 고정비, note: "계좌 이체 포함" },
    { label: "비상금", value: 비상금, note: "계좌 이체 포함" },
    { label: "변동비", value: report.종합정산.변동지출 },
    // 원본에 있지만 이 앱이 추적하지 않는 줄. 지어내지 않고 빈 칸으로 둔다.
    { label: "현금 보유", value: null, note: "추적하지 않습니다" },
  ];

  // 목적지를 모르는 이체. 0 이면 줄을 만들지 않고, 값이 있으면 반드시 보인다 —
  // 합계에서만 조용히 사라지는 돈이 없어야 한다.
  if (기타이체 !== 0) {
    summaryRows.push({ label: "기타 이체", value: 기타이체, note: "목적지 미확인" });
  }

  const shown = summaryRows.reduce((sum, item) => sum + (item.value ?? 0), 0);
  // 합계는 집계가 낸 값(실현순증감 = 메인 계좌 거래 금액의 합)을 그대로 쓴다.
  // 위 줄들의 합과 어긋나면 표가 무언가를 빠뜨린 것이므로 차액을 드러낸다
  // (조용히 맞추지 않는다).
  const 합계 = report.종합정산.실현순증감;
  const missing = 합계 - shown;

  // 원본 마지막 두 줄. 회색 `보정` 자리에 검산 차액이 온다.
  const residual = verification.checked ? verification.difference : null;

  return (
    <div className="flex flex-col gap-6">
      <VerifyBanner
        verification={verification}
        mainNickname={report.mainAccount?.nickname ?? null}
      />

      <p className="text-xs text-zinc-500">
        금액은 저장된 부호 그대로입니다 — {report.signConvention}. 지출은 −, 입금은 +
        로 표시합니다. 배치는 기존 정산 템플릿을 따릅니다. 항목 줄은{" "}
        <Link href={`/classify?month=${report.yearMonth}&filter=all`} className="underline underline-offset-4">
          분류 정리
        </Link>
        에서 정한 항목 이름이고, 정하지 않았으면 적요(카드대금은 카드사) 그대로입니다.
      </p>

      <div className="grid grid-cols-1 gap-6 lg:grid-cols-3">
        {/* 좌: 메인에서 바로 나가는 돈 */}
        <div className="flex flex-col gap-4">
          <KindTable
            kind="수입"
            items={linesAsItems(lines.수입, "수입", "in")}
            total={report.수입.total}
            tone="income"
            caption={`${report.yearMonth} 수입`}
          />
          {fixed1.map((item) => (
            <KindTable
              key={item.key}
              kind={item.key}
              items={linesAsItems(
                lines.고정지출1.filter((line) => line.category === item.key),
                item.key,
              )}
              total={item.total}
              caption={`${report.yearMonth} ${item.key}`}
            />
          ))}
          {/* 메인 계좌에서 바로 나간 고정비 · 비상금 성격의 지출. 원본에는 없는
              자리라 건이 있을 때만 그린다. */}
          {fixed2Shown.map((item) => (
            <KindTable
              key={item.key}
              kind={item.key}
              items={linesAsItems(
                lines.고정지출2.filter((line) => line.category === item.key),
                item.key,
              )}
              total={item.total}
              caption={`${report.yearMonth} 메인 계좌의 ${item.key}`}
            />
          ))}
        </div>

        {/* 중: 메인이 아닌 계좌 */}
        <div className="flex flex-col gap-4">
          {report.계좌블록.length === 0 ? (
            <p className="text-sm text-zinc-500">메인 외 계좌가 등록되어 있지 않습니다.</p>
          ) : (
            report.계좌블록.map((block) => (
              <AccountTable
                key={block.role}
                block={block}
                balance={report.계좌별잔액변화.find((entry) => entry.role === block.role)}
              />
            ))
          )}
          <p className="text-xs text-zinc-500">
            이 계좌들의 입금은 메인에서 간 돈이라 오른쪽 종합정산의 수입으로 세지
            않습니다. 이자도 수입으로 올리지 않고 <strong>그 계좌 안에서 집행을
            상계</strong>합니다(순증감).
          </p>
        </div>

        {/* 우: 변동비 · 종합정산 · 메인 계좌 잔액 */}
        <div className="flex flex-col gap-4">
          <KindTable
            kind="변동비"
            items={variableItems}
            total={report.변동지출.total}
            caption={`${report.yearMonth} 변동비`}
          />

          <table className={BOX}>
            <caption className="sr-only">{report.yearMonth} 종합정산</caption>
            <thead>
              <tr>
                <th scope="col" className={HEAD}>
                  항목
                </th>
                <th scope="col" className={HEAD}>
                  금액
                </th>
              </tr>
            </thead>
            <tbody>
              {summaryRows.map((item) => (
                <SummaryRow
                  key={item.label}
                  label={item.label}
                  value={item.value === null ? "—" : flow(item.value)}
                  note={item.note}
                />
              ))}
              {missing === 0 ? null : (
                <SummaryRow
                  label="표에 싣지 못한 항목"
                  value={flow(missing)}
                  note="합계와 위 줄들의 차액"
                />
              )}
              <SummaryRow label="합계" value={flow(합계)} tone="plain" />
            </tbody>
          </table>

          <table className={BOX}>
            <caption className="sr-only">{report.yearMonth} 검산과 메인 계좌 잔액</caption>
            <tbody>
              <tr>
                <th scope="row" className="px-2 py-1 text-left font-normal text-zinc-500">
                  검산 차액
                  <span className="ml-1 text-xs">0 이어야 합니다</span>
                </th>
                <td className="px-2 py-1 text-right tabular-nums text-zinc-500">
                  {residual === null ? "—" : flow(residual)}
                </td>
              </tr>
              <tr className={TONE.main}>
                <th scope="row" className={`${CELL} text-left`}>
                  메인 계좌 잔액
                </th>
                <td className={NUM}>
                  {mainBalance?.derived === true ? plain(mainBalance.closing) : "—"}
                </td>
              </tr>
            </tbody>
          </table>
        </div>
      </div>

      <section className="flex flex-col gap-2">
        <h2 className="text-sm font-medium text-zinc-700 dark:text-zinc-300">
          계좌별 잔액 변화
        </h2>
        <p className="text-xs text-zinc-500">
          원본 템플릿에는 없는 보조 표입니다. 위 ‘잔액’ 칸이 어디서 나왔는지와,
          잔액을 끌어내지 못한 사유를 여기서 봅니다.
        </p>
        <table className="w-full border-collapse text-sm">
          <thead>
            <tr className="text-xs text-zinc-500">
              <th scope="col" className={`${CELL} text-left font-normal`}>
                계좌
              </th>
              <th scope="col" className={`${CELL} text-right font-normal`}>
                시작 잔액
              </th>
              <th scope="col" className={`${CELL} text-right font-normal`}>
                끝 잔액
              </th>
              <th scope="col" className={`${CELL} text-right font-normal`}>
                변화
              </th>
              <th scope="col" className={`${CELL} text-right font-normal`}>
                건수
              </th>
            </tr>
          </thead>
          <tbody>
            {report.계좌별잔액변화.map((entry) => (
              <tr key={entry.role}>
                <th scope="row" className={`${CELL} text-left font-normal`}>
                  {entry.nickname}
                  {entry.derived ? null : (
                    <span className="ml-2 text-xs text-zinc-500">
                      ({balanceReasonText(entry.reason)})
                    </span>
                  )}
                </th>
                <td className={NUM}>{plain(entry.opening)}</td>
                <td className={NUM}>{plain(entry.closing)}</td>
                <td className={NUM}>{flow(entry.change)}</td>
                <td className={`${NUM} text-zinc-500`}>{entry.count}건</td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>

      <section className="flex flex-col gap-1">
        <h2 className="text-sm font-medium text-zinc-700 dark:text-zinc-300">미분류</h2>
        <p className="text-sm">
          {report.미분류.count}건 (전체 {report.거래건수}건)
          {report.미분류.count > 0 ? (
            <Link
              href={`/classify?month=${report.yearMonth}`}
              className="ml-2 underline underline-offset-4"
            >
              미분류 정리하기
            </Link>
          ) : null}
        </p>
        {report.미분류.계좌간이체입금 > 0 ? (
          <p className="text-xs text-zinc-500">
            메인 계좌에서 고정비 · 비상금 계좌로 옮긴 돈이 받는 쪽 계좌에 찍힌 입금{" "}
            {report.미분류.계좌간이체입금}건은 분류가 없어도 위 계좌 표의 ‘입금’으로 세므로
            미분류에서 뺐습니다.
          </p>
        ) : null}
        <p className="text-xs text-zinc-500">
          미분류 출금은 위 변동비 표에 ‘미분류’ 꼬리표로, 메인 계좌의 미분류 입금은 수입 표에 나옵니다.
          ‘기타’로 분류한 거래는 분류된 것으로 세며, 출금은 변동비 표에 ‘기타’ 꼬리표로,
          입금은 수입 표에 ‘기타’ 꼬리표로 나옵니다.
        </p>
      </section>
    </div>
  );
}
