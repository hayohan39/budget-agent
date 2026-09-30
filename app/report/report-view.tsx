// 월별 현금흐름표의 **표 서식**. 숫자는 lib/report/monthly.mjs 가 만든다.
//
// 이 화면은 사용자가 손으로 쓰던 **정산 템플릿(스프레드시트)의 배치를 그대로
// 옮긴 것**이다. 원본은 한 시트에 월 블록이 세로로 쌓이고, 한 블록이 가로로
// 세 열 그룹으로 나뉜다.
//
//   좌: 수입 · 저축 · 용돈 · 주거비      (메인에서 바로 나가는 돈)
//   중: 고정비 계좌 · 비상금 계좌        (입금 / 집행 / 이자 / 잔액)
//   우: 카드비(카드사별) · 변동비(일회성 수입 · 지출) · 종합정산 · 메인 계좌 잔액
//
// 2026-09(사용자 요청: "계좌별(메인, 고정비, 비상금)로 펼치기/숨기기 … 기본값은 숨기기"):
// 위 세 열 그룹은 이제 **계좌별 접이식 섹션**(메인 · 고정비 · 비상금, 기본 접힘) 안에 있다.
// 메인 섹션 안에 좌 · 우 그룹이, 고정비 · 비상금 섹션 안에 각 계좌 표가 들어간다.
// 접힌 머리에도 그 계좌의 핵심 숫자(순증감 · 잔액 등)가 보인다. 종합정산과 계좌별 잔액
// 변화는 늘 펼쳐 둔다. 같은 달 설명 문단들은 걷어 내고 짧은 꼬리표 · 상태 표시로 바꿨다
// ("설명을 위한 글들은 제거해줘 … UI를 직관적으로").
//
// 원본의 `변동비` 표는 2026-09 에 둘로 나눴다(사용자 요청). `카드비` 에는 카드대금만,
// `변동비` 에는 일회성 항목(입금 · 출금 모두)과 **아직 분류하지 않은 행**이 온다.
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
// 계좌 표(고정비 · 비상금)는 `고정비 계좌` · `비상금 계좌` 섹션 머리 아래에 있다. 메인
// 계좌에서 바로 나간 `고정비` 분류 표도 있을 수 있어(메인 섹션 안), 계좌 이름 머리 없이는
// '고정비' 표가 두 개로 보였다(사용자 보고). 예전에는 메인 계좌 표에 머리를 달지 않았지만
// (사용자 요청) 2026-09 계좌별 접기 요청으로 메인도 `메인 계좌` 섹션 머리를 갖는다.
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
// 잔액 · 계좌번호 · 뒤 4자리 · 거래 시각(시:분)은 이 파일이 받는 데이터에 애초에 들어 있지
// 않다. 2026-09(사용자 요청: "적요나 메모로 겹쳐도 항목으로 합산하지 않는 것으로 변경. 개별항목
// 모두 보여지게. n건 표시는 이제 제거")부터 항목 줄은 **거래 한 건**이고, 줄마다 날짜(`M/D`) ·
// 항목 · 그 거래의 메모 · 금액이 보인다. 건수는 어디에도 그리지 않는다.
//
// 원본의 `선용 월급` · `지현 ISA` 같은 **항목 줄**은 집계의 `항목별` ·
// `계좌블록[].항목` 에서 온다. 사람이 /classify 에서 항목 이름을 정하지 않았으면
// 정규화한 **적요 그대로**가 항목 이름이다(카드대금은 카드사). 즉 이 화면에
// 적요가 나온다 — 사용자가 요청한 변경이다(PLAN.md "적요 표시 원칙 변경").
// 로그인 + 화이트리스트 뒤의 동적 페이지에만 그려진다.
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
type SectionItem = {
  key: string;
  total: number;
  count: number;
  tag?: string;
  flow?: string;
};

/**
 * `항목별` 의 한 줄 = **거래 한 건**(2026-09 사용자 요청: "적요나 메모로 겹쳐도 항목으로
 * 합산하지 않는 것으로 변경. 개별항목 모두 보여지게"). 합산하지 않으므로 같은 항목의 거래도
 * 각자 한 줄이다.
 */
type Line = {
  /** 거래 id. 표의 React key 로만 쓴다. */
  id: string;
  /** 한국 시각 날짜 `M/D`(예: `9/15`). 모르면 null. */
  day: string | null;
  category: string;
  item: string;
  direction: "in" | "out";
  total: number;
  count: number;
  /** 그 거래의 메모(정규화). 없거나 항목과 같으면 null. */
  memo: string | null;
};

/** 표의 거래 줄 하나. */
type RowItem = {
  id: string;
  day: string | null;
  key: string;
  total: number;
  memo: string | null;
  tag?: string;
  flow?: string;
};

const DIRECTION_TEXT: Record<Line["direction"], string> = { in: "입금", out: "출금" };

/**
 * 항목 줄 -> 표의 한 줄. 분류가 표 이름과 다르면 작은 꼬리표로 붙인다.
 *
 * 방향이 그 표의 기본 방향(`natural` — 수입 표는 입금, 지출 표는 출금)과 다르면
 * 방향 꼬리표를 붙인다. 같은 항목 이름의 입금 줄과 출금 줄이 한 표에 나란히
 * 있을 때(예: 수입으로 고른 적요의 반환 출금) 둘을 구별하게 해 준다.
 */
function linesAsItems(lines: Line[], kind?: string, natural: Line["direction"] = "out"): RowItem[] {
  return lines.map((line) => ({
    id: line.id,
    day: line.day,
    key: line.item,
    total: line.total,
    memo: line.memo,
    tag: kind !== undefined && line.category === kind ? undefined : line.category,
    flow: line.direction === natural ? undefined : DIRECTION_TEXT[line.direction],
  }));
}

/**
 * 항목 이름 아래의 메모(2026-09, 사용자 요청: "메모도 중요한 정보야. sub text 로 항목 아래
 * 작은 회색글씨로"). 거래 한 건의 메모 하나다. 메모는 적요처럼 이 화면에만 그린다(로그 ·
 * 에러에 싣지 않는다).
 */
function MemoNote({ memo, item }: { memo: string | null; item: string }) {
  // 메모가 곧 항목 이름인 줄(메모로 분류된 저축 등)은 같은 글자를 두 번 쓰지 않는다.
  if (memo === null || memo === "" || memo === item) return null;
  return (
    <span data-testid="item-memo" className="mt-0.5 block text-xs text-faint">
      {memo}
    </span>
  );
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
  balanceMissing: "이 달 메인 계좌 거래의 거래 후 잔액이 모두 비어 있습니다",
  unavailable: "검산에 필요한 값이 없습니다",
};

/**
 * 계좌별 잔액 표에서 쓰는 같은 코드의 문장.
 *
 * 검산 배너는 "메인 계좌" 를 말해도 되지만 이 표는 계좌마다 한 줄이라 같은
 * 문장을 쓰면 고정비 줄에 "메인 계좌 거래가 없습니다" 가 찍힌다.
 */
const BALANCE_REASON_TEXT: Record<string, string> = {
  noRows: "거래 없음",
  balanceMissing: "잔액 칸 비어 있음",
};

/**
 * 경계 거래의 잔액 칸이 비어 가까운 잔액에서 금액으로 이어 계산(역산)했는가
 * (lib/report/monthly.mjs 의 balanceSpan). 토스 명세서는 잔액 0원이던 계좌에 들어온
 * 입금의 잔액 칸을 비워 둔다 — 0원에서 시작한 계좌의 첫 달이 이렇다.
 * 화면에는 `역산` 꼬리표 하나로 보이고, 어느 쪽인지는 꼬리표의 힌트에 있다.
 */
function inferredBalanceHint(
  entry: { inferredOpening?: boolean; inferredClosing?: boolean } | undefined,
): string | undefined {
  if (entry === undefined) return undefined;
  if (entry.inferredOpening && entry.inferredClosing) return "첫 · 마지막 거래 잔액을 금액으로 이어 계산";
  if (entry.inferredOpening) return "첫 거래 잔액을 금액으로 이어 계산";
  if (entry.inferredClosing) return "마지막 거래 잔액을 금액으로 이어 계산";
  return undefined;
}

function reasonText(table: Record<string, string>, reason: string | null): string {
  if (reason === null) return "사유 모름";
  return table[reason] ?? `사유 모름 (${reason.slice(0, 64)})`;
}

function verifyReasonText(reason: string | null): string {
  return reasonText(VERIFY_REASON_TEXT, reason);
}

function balanceReasonText(reason: string | null): string {
  return reasonText(BALANCE_REASON_TEXT, reason);
}

// ── 표 조각 ────────────────────────────────────────────────────────────────

// 표 모양(2026-09 디자인 정리): 1px 가로선 · 작은 글자 · 고정폭 숫자. 표는 테두리 둥근
// 상자(FRAME) 안에 들어가고, 좁은 화면에서 넘치면 **그 상자 안에서만** 가로로 밀린다
// (페이지 전체가 넘치지 않게). 음수 금액은 따로 색을 준다(Amount).
const FRAME = "min-w-0 overflow-x-auto rounded-lg border border-line bg-canvas";
const BOX = "w-full border-collapse text-[13px] [&>tbody>tr:last-child>*]:border-b-0";
const CELL = "border-b border-line px-3 py-1.5 align-top";
/** rowSpan 으로 세로로 합친 `종류` 칸. 옆 칸과 세로선으로 가른다. */
const KIND = `${CELL} border-r whitespace-nowrap text-left font-normal text-muted`;
const NUM = `${CELL} text-right tabular-nums whitespace-nowrap`;
const HEAD = `${CELL} whitespace-nowrap bg-subtle py-1 text-left text-xs font-medium text-muted`;
const HEAD_NUM = `${HEAD} text-right`;
/**
 * 원본의 색칠한 줄. 합계·잔액처럼 눈이 먼저 가야 하는 칸이다. 이 화면에서는 색 대신
 * 옅은 바탕 + 굵은 글자로 구분한다(무채색 시안). 역할 이름은 그대로 둔다.
 */
const TONE: Record<string, string> = {
  income: "bg-subtle [&>*]:font-semibold!",
  fixed: "bg-subtle [&>*]:font-semibold!",
  emergency: "bg-subtle [&>*]:font-semibold!",
  main: "bg-subtle [&>*]:font-semibold!",
  plain: "[&>*]:font-semibold!",
};

/** 미분류 목록(아래 `미분류` 섹션)의 앵커. app/report/unclassified-section.tsx 와 같은 값. */
export const UNCLASSIFIED_ANCHOR = "unclassified";

/** 금액 칸의 글자. 음수만 색을 달리한다(부호는 글자에도 그대로 있다 — 색만으로 구분하지 않는다). */
function Amount({ value, format = flow }: { value: number | null | undefined; format?: (value: number | null | undefined) => string }) {
  const negative = typeof value === "number" && value < 0;
  return <span className={negative ? "text-neg" : undefined}>{format(value)}</span>;
}

const TAG_TONE = {
  neutral: "border-line bg-subtle text-muted",
  warn: "border-warn-line bg-warn-bg text-warn",
  accent: "border-line bg-accent-bg text-accent-text",
} as const;

/**
 * 짧은 꼬리표(2026-09: 설명 문장을 걷어 내고 그 자리에 둔다). `hint` 는 마우스를 올리면
 * 보이고(title), 화면 읽기 프로그램에는 괄호 안 글로 읽힌다.
 */
function Tag({
  children,
  hint,
  tone = "neutral",
  testId,
}: {
  children: React.ReactNode;
  hint?: string;
  tone?: keyof typeof TAG_TONE;
  testId?: string;
}) {
  return (
    <span
      title={hint}
      data-testid={testId}
      className={`ml-1.5 inline-block rounded border px-1 align-baseline text-xs font-normal whitespace-nowrap ${TAG_TONE[tone]}`}
    >
      {children}
      {hint !== undefined ? <span className="sr-only"> ({hint})</span> : null}
    </span>
  );
}

function Frame({ children }: { children: React.ReactNode }) {
  return <div className={FRAME}>{children}</div>;
}

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
      <th scope="col" className={HEAD_NUM}>
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
  tags,
  hint,
}: {
  label: string;
  value: React.ReactNode;
  tone?: keyof typeof TONE;
  tags?: React.ReactNode;
  /** 줄 이름에 마우스를 올리면 보이는 짧은 식(예: 순증감). */
  hint?: string;
}) {
  return (
    <tr className={tone === undefined ? undefined : TONE[tone]}>
      <th scope="row" colSpan={2} className={`${CELL} text-left font-normal`}>
        <span title={hint}>{label}</span>
        {tags}
      </th>
      <td className={NUM}>{value}</td>
    </tr>
  );
}

/** 항목 줄의 꼬리표. `미분류` 는 아래 미분류 목록으로 가는 링크다. */
function CategoryTag({ tag }: { tag: string }) {
  if (tag === "미분류") {
    return (
      <a
        href={`#${UNCLASSIFIED_ANCHOR}`}
        data-testid="unclassified-tag"
        className="mr-1 rounded border border-warn-line bg-warn-bg px-1 text-warn underline-offset-2 hover:underline"
      >
        미분류
      </a>
    );
  }
  return <span className="mr-1 rounded border border-line bg-subtle px-1 text-muted">{tag}</span>;
}

/**
 * 거래 줄의 가운데 칸 — 날짜(작게) · 항목 이름, 그 아래 메모, 분류 · 방향 꼬리표.
 * 건수는 없다(2026-09 사용자 요청: "n건 표시는 이제 제거") — 한 줄이 곧 한 건이다.
 */
function ItemCell({ item }: { item: RowItem }) {
  const hasTags = item.tag !== undefined || item.flow !== undefined;
  return (
    <td className={`${CELL} break-keep wrap-anywhere`}>
      <span className="block">
        {item.day !== null ? (
          <span data-testid="item-day" className="mr-1.5 text-xs text-muted tabular-nums">
            {item.day}
          </span>
        ) : null}
        {item.key}
      </span>
      <MemoNote memo={item.memo} item={item.key} />
      {hasTags ? (
        <span className="mt-0.5 block text-xs text-muted">
          {item.tag !== undefined ? <CategoryTag tag={item.tag} /> : null}
          {item.flow !== undefined ? (
            <span className="mr-1 rounded border border-line bg-accent-bg px-1 text-accent-text">
              {item.flow}
            </span>
          ) : null}
        </span>
      ) : null}
    </td>
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
  items: RowItem[];
  total: number;
  tone?: keyof typeof TONE;
  caption: string;
}) {
  return (
    <Frame>
      <table className={BOX}>
        <caption className="sr-only">{caption}</caption>
        <thead>
          <Head3 />
        </thead>
        <tbody>
          {items.length === 0 ? (
            <tr>
              <th scope="row" className={KIND}>
                {kind}
              </th>
              <td className={CELL}>&nbsp;</td>
              <td className={NUM}>&nbsp;</td>
            </tr>
          ) : (
            items.map((item, index) => (
              <tr key={item.id}>
                {index === 0 ? (
                  <th scope="row" rowSpan={items.length} className={KIND}>
                    {kind}
                  </th>
                ) : null}
                <ItemCell item={item} />
                <td className={NUM}>
                  <Amount value={item.total} />
                </td>
              </tr>
            ))
          )}
          <WideRow label="합계" value={<Amount value={total} />} tone={tone ?? "plain"} />
        </tbody>
      </table>
    </Frame>
  );
}

/**
 * 변동비 표 — 일회성 수입 줄과 일회성 지출 줄을 **따로** 세운다.
 *
 * `종류` 칸이 방향이다(`일회성 수입` · `일회성 지출`). 같은 항목의 입금과 출금은
 * 서로 다른 줄이고 한 줄 안에서 상계하지 않는다. 아직 분류하지 않은 행은 `미분류`
 * 꼬리표(아래 미분류 목록으로 가는 링크)를 달고 여기 보인다. 아래에 방향별 소계와
 * 합계(순액)를 둔다 — 합계가 종합정산의 `변동비` 줄과 같은 값이다.
 */
function VariableTable({
  lines,
  section,
  caption,
}: {
  lines: Line[];
  section: MonthlyReport["변동비"];
  caption: string;
}) {
  const groups: Array<{ kind: string; direction: Line["direction"]; items: RowItem[] }> = [
    { kind: "일회성 수입", direction: "in", items: [] },
    { kind: "일회성 지출", direction: "out", items: [] },
  ];
  for (const group of groups) {
    group.items = linesAsItems(
      lines.filter((line) => line.direction === group.direction),
      "변동비",
      group.direction,
    );
  }
  const shown = groups.filter((group) => group.items.length > 0);

  return (
    <Frame>
      <table className={BOX} data-testid="variable-table">
        <caption className="sr-only">{caption}</caption>
        <thead>
          <tr>
            <th scope="colgroup" colSpan={3} className={`${CELL} bg-subtle text-left text-[13px] font-semibold`}>
              변동비
            </th>
          </tr>
          <Head3 />
        </thead>
        <tbody>
          {shown.length === 0 ? (
            <tr>
              <th scope="row" className={KIND}>
                변동비
              </th>
              <td className={CELL}>&nbsp;</td>
              <td className={NUM}>&nbsp;</td>
            </tr>
          ) : (
            shown.flatMap((group) =>
              group.items.map((item, index) => (
                <tr key={item.id}>
                  {index === 0 ? (
                    <th scope="row" rowSpan={group.items.length} className={KIND}>
                      {group.kind}
                    </th>
                  ) : null}
                  <ItemCell item={item} />
                  <td className={NUM}>
                    <Amount value={item.total} />
                  </td>
                </tr>
              )),
            )
          )}
          <WideRow label="일회성 수입 소계" value={<Amount value={section.일회성수입.total} />} />
          <WideRow label="일회성 지출 소계" value={<Amount value={section.일회성지출.total} />} />
          <WideRow label="합계" value={<Amount value={section.total} />} tone="plain" />
        </tbody>
      </table>
    </Frame>
  );
}

/**
 * 원본 중앙 그룹의 계좌 표(고정비 · 비상금). 계좌 이름은 이 표를 감싼 접이식 섹션의
 * 머리(AccountSection)에 있다.
 *
 * 원본 순서: 입금 → 항목 → 합계(집행) → 보정 → 잔액.
 * `보정` 자리에는 실거래로 잡히는 **이자**가 온다. 그리고 원본에는 없던
 * `순증감` 을 한 줄 더 둔다 — 이자가 이 계좌의 집행을 상계한 값이다.
 *
 * 계좌에 연결된 금고로 옮긴 돈 · 금고에서 꺼낸 돈이 있는 달에는 `금고저축` ·
 * `금고 인출` 줄이 더 붙는다(2026-09). 이 돈은 집행도 입금도 아니라 순증감에
 * 들어가지 않는다 — 순증감은 금고까지 합친 이 계좌 돈의 증감이고, `잔액` 은
 * 명세서의 계좌 잔액(금고 제외)이다.
 *
 * 2026-09(사용자 요청: "설명을 위한 글들은 제거해줘"): 줄 옆의 설명 문구를 걷어 냈다.
 * 뜻은 줄 이름(`메인에서 입금` · `집행 합계`)과 짧은 꼬리표(`금고 제외` · `역산`)로 남기고,
 * 순증감의 식은 줄 이름에 마우스를 올리면 보인다.
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
  // 계좌 ↔ 금고 이동이 있는 달에만 금고 줄을 그린다(lib/report/monthly.mjs 의 isVaultMove).
  const hasVault = block.금고저축.count > 0 || block.금고인출.count > 0;
  const inferred = balance?.derived === true ? inferredBalanceHint(balance) : undefined;

  return (
    <Frame>
      <table className={BOX} data-testid="account-table">
        <caption className="sr-only">{title}</caption>
        <thead>
          <Head3 />
        </thead>
        <tbody>
          <WideRow label="메인에서 입금" value={<Amount value={block.입금.total} />} />
          {lines.length === 0 ? (
            <tr>
              <th scope="row" className={KIND}>
                {block.nickname}
              </th>
              <td className={CELL}>&nbsp;</td>
              <td className={NUM}>&nbsp;</td>
            </tr>
          ) : (
            linesAsItems(lines, block.nickname).map((item, index) => (
              <tr key={item.id}>
                {index === 0 ? (
                  <th scope="row" rowSpan={lines.length} className={KIND}>
                    {block.nickname}
                  </th>
                ) : null}
                <ItemCell item={item} />
                <td className={NUM}><Amount value={item.total} /></td>
              </tr>
            ))
          )}
          <WideRow label="집행 합계" value={<Amount value={block.집행.total} />} />
          <WideRow label="이자" value={<Amount value={block.이자.total} />} />
          {block.금고저축.count > 0 ? (
            <WideRow label="금고저축" hint="계좌 → 금고" value={<Amount value={block.금고저축.total} />} />
          ) : null}
          {block.금고인출.count > 0 ? (
            <WideRow label="금고 인출" hint="금고 → 계좌" value={<Amount value={block.금고인출.total} />} />
          ) : null}
          {block.무효.count > 0 ? (
            <WideRow
              label="무효 처리"
              value={<Amount value={block.무효.total} />}
              tags={<Tag>순증감 제외</Tag>}
            />
          ) : null}
          <WideRow
            label="순증감"
            hint={hasVault ? "입금 + 이자 − 집행 (금고 포함)" : "입금 + 이자 − 집행"}
            value={<Amount value={block.순증감} />}
            tone="plain"
          />
          <WideRow
            label="잔액"
            value={balance?.derived === true ? plain(balance.closing) : "—"}
            tone={tone}
            tags={
              balance === undefined ? null : balance.derived ? (
                <>
                  {hasVault ? <Tag hint="계좌 잔액만, 금고는 제외">금고 제외</Tag> : null}
                  {inferred !== undefined ? <Tag hint={inferred}>역산</Tag> : null}
                </>
              ) : (
                <Tag>{balanceReasonText(balance.reason)}</Tag>
              )
            }
          />
        </tbody>
      </table>
    </Frame>
  );
}

/** 우측 종합정산 표의 한 줄. 원본은 `항목 | 금액` 두 칸이다. */
function SummaryRow({
  label,
  value,
  tone,
  tags,
}: {
  label: string;
  value: React.ReactNode;
  tone?: keyof typeof TONE;
  tags?: React.ReactNode;
}) {
  return (
    <tr className={tone === undefined ? undefined : TONE[tone]}>
      <th scope="row" className={`${CELL} text-left font-normal`}>
        {label}
        {tags}
      </th>
      <td className={NUM}>{value}</td>
    </tr>
  );
}

// ── 값 꺼내기 ──────────────────────────────────────────────────────────────

function itemTotal(items: SectionItem[], key: string): number {
  return items.find((item) => item.key === key)?.total ?? 0;
}

// ── 접이식 계좌 섹션 ───────────────────────────────────────────────────────

/**
 * 계좌 하나(메인 · 고정비 · 비상금)의 표 묶음. **기본은 접힘**이다(2026-09 사용자 요청:
 * "월별현금흐름표가 너무 길어지니까 계좌별로 펼치기/숨기기 … 기본값은 숨기기").
 *
 * 네이티브 `<details>` 라 스크립트 없이 열고 닫히고, 키보드(Enter · Space)와 화면 읽기
 * 프로그램이 펼침 상태를 그대로 안다. `open` 을 React 가 쥐지 않으므로 분류를 적용해
 * 화면이 새로 고쳐져도 사용자가 연 섹션은 열린 채로 남는다.
 *
 * 접힌 머리에도 그 계좌의 핵심 숫자를 싣는다 — 접어 두어도 무엇이 들었는지 보인다.
 */
function AccountSection({
  role,
  title,
  stats,
  children,
}: {
  role: string;
  title: string;
  stats: Array<{ label: string; value: React.ReactNode }>;
  children: React.ReactNode;
}) {
  return (
    <details
      data-testid="account-section"
      data-account={role}
      className="group rounded-lg border border-line bg-canvas open:bg-subtle/40"
    >
      <summary className="flex cursor-pointer list-none flex-wrap items-center gap-x-4 gap-y-1 rounded-lg px-3 py-2.5 text-[13px] select-none hover:bg-hover focus-visible:outline-2 focus-visible:outline-accent sm:px-4 [&::-webkit-details-marker]:hidden">
        <span className="flex items-center gap-2 font-semibold text-fg">
          <svg
            aria-hidden
            viewBox="0 0 16 16"
            className="size-3.5 shrink-0 text-muted transition-transform group-open:rotate-90"
          >
            <path d="M6 3.5 10.5 8 6 12.5" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
          {title}
        </span>
        <span className="ml-auto flex flex-wrap justify-end gap-x-4 gap-y-0.5 tabular-nums">
          {stats.map((stat) => (
            <span key={stat.label} className="whitespace-nowrap">
              <span className="mr-1.5 text-xs text-muted">{stat.label}</span>
              <span className="font-medium">{stat.value}</span>
            </span>
          ))}
        </span>
      </summary>
      <div className="border-t border-line p-3 sm:p-4">{children}</div>
    </details>
  );
}

// ── 검산 ───────────────────────────────────────────────────────────────────

/**
 * 검산 결과와 이 달의 할 일(미분류). 어긋났다면 표 위에서 가장 먼저 보여야 한다.
 *
 * 2026-09: 통과 · 미검산은 한 줄짜리 상태 표시로 줄였다(설명 문장 제거). 불일치는 두 값과
 * 차액을 그대로 드러내는 경고로 남긴다.
 */
export function VerifyBanner({
  verification,
  mainNickname,
  unclassified = 0,
}: {
  verification: Verification;
  mainNickname: string | null;
  /** 이 달 미분류 건수. 0 보다 크면 아래 미분류 목록으로 가는 링크를 붙인다(건수는 그리지 않는다). */
  unclassified?: number;
}) {
  const account = mainNickname ?? "메인";
  const todo =
    unclassified > 0 ? (
      <a
        href={`#${UNCLASSIFIED_ANCHOR}`}
        data-testid="unclassified-link"
        className="inline-flex h-7 items-center rounded-md border border-warn-line bg-warn-bg px-2 text-xs font-medium text-warn hover:underline"
      >
        미분류 있음
      </a>
    ) : null;

  if (!verification.checked) {
    return (
      <div className="flex flex-wrap items-center gap-2" data-testid="verify">
        <span className="inline-flex h-7 items-center rounded-md border border-warn-line bg-warn-bg px-2 text-xs font-medium text-warn">
          <span aria-hidden className="mr-1.5">!</span>검산 안 함 · {verifyReasonText(verification.reason)}
        </span>
        {todo}
      </div>
    );
  }

  if (verification.ok) {
    return (
      <div className="flex flex-wrap items-center gap-2" data-testid="verify">
        <span
          title={`실현순증감 ${flow(verification.actual)} = ${account} 계좌 잔액 변화 ${flow(verification.expected)}`}
          className="inline-flex h-7 items-center rounded-md border border-ok-line bg-ok-bg px-2 text-xs font-medium text-ok"
        >
          <span aria-hidden className="mr-1.5">✓</span>검산 일치
        </span>
        {verification.inferred ? (
          <span
            title="잔액 칸이 빈 첫 · 마지막 거래는 금액으로 이어 계산"
            className="inline-flex h-7 items-center rounded-md border border-line bg-subtle px-2 text-xs text-muted"
          >
            역산 포함
          </span>
        ) : null}
        {todo}
      </div>
    );
  }

  return (
    <section
      role="alert"
      data-testid="verify"
      className="rounded-lg border border-danger-line bg-danger-bg px-4 py-3 text-[13px]"
    >
      <p className="flex flex-wrap items-center gap-2 text-[13px] font-semibold text-danger">
        <span>
          <span aria-hidden className="mr-1.5">✕</span>검산 불일치 — 차액 {flow(verification.difference)}
        </span>
        {verification.inferred ? (
          <span className="rounded border border-line bg-subtle px-1 text-xs font-normal text-muted">역산 포함</span>
        ) : null}
        {todo}
      </p>
      <dl className="mt-2 grid grid-cols-[auto_1fr] gap-x-4 gap-y-1">
        <dt className="text-muted">실현순증감</dt>
        <dd className="tabular-nums">{flow(verification.actual)}</dd>
        <dt className="text-muted">{account} 계좌 잔액 변화</dt>
        <dd className="tabular-nums">{flow(verification.expected)}</dd>
      </dl>
    </section>
  );
}

/** 현금흐름표 본문 — 계좌별 접이식 섹션(정산 템플릿 배치) + 늘 펼친 종합정산 · 계좌별 잔액 변화. */
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
  const card = report.카드비;
  const lines = report.항목별 as Record<"수입" | "고정지출1" | "고정지출2" | "카드비" | "변동비", Line[]>;
  const mainBalance = report.계좌별잔액변화.find((entry) => entry.role === "main");

  // 카드비 표 — 원본의 변동비 표처럼 카드사별 줄만 있다. 일회성 항목은
  // 아래 변동비 표(VariableTable)로 따로 간다.
  // 2026-09: 카드사별로 더하지 않고 카드대금 출금 한 건이 한 줄이다(항목 = 카드사).
  const cardItems = linesAsItems(lines.카드비, "카드대금");
  const fixed2Shown = fixed2.filter((item) => item.count > 0);

  // 종합정산. 원본의 `고정비` · `비상금` 줄은 그 계좌로 **옮긴 돈**이다.
  // 이 레포에서는 계좌 간 이동으로 빠져 있으므로 고정지출2 와 합쳐서 되돌린다.
  const 고정비 = itemTotal(fixed2, "고정비") + itemTotal(moves, "고정비");
  const 비상금 = itemTotal(fixed2, "비상금") + itemTotal(moves, "비상금");
  const 기타이체 = itemTotal(moves, "기타");

  const summaryRows: Array<{ label: string; value: number; tags?: React.ReactNode }> = [
    { label: "수입", value: report.종합정산.수입 },
    { label: "저축", value: itemTotal(fixed1, "저축") },
    { label: "용돈", value: itemTotal(fixed1, "용돈") },
    { label: "주거비", value: itemTotal(fixed1, "주거비") },
    { label: "고정비", value: 고정비, tags: <Tag hint="고정비 계좌로 옮긴 돈 포함">이체 포함</Tag> },
    { label: "비상금", value: 비상금, tags: <Tag hint="비상금 계좌로 옮긴 돈 포함">이체 포함</Tag> },
    { label: "카드비", value: report.종합정산.카드비 },
    { label: "변동비", value: report.종합정산.변동비 },
  ];

  // 목적지를 모르는 이체. 0 이면 줄을 만들지 않고, 값이 있으면 반드시 보인다 —
  // 합계에서만 조용히 사라지는 돈이 없어야 한다.
  if (기타이체 !== 0) {
    summaryRows.push({ label: "기타 이체", value: 기타이체, tags: <Tag>목적지 미확인</Tag> });
  }
  // 무효(상쇄)로 표시한 메인 계좌 거래. 같은 달의 쌍이면 0 이고, 달을 걸친 쌍이면 이 달에
  // 남은 한쪽 금액이다(메인 잔액이 실제로 움직였다). 건이 있을 때만 그린다.
  if (report.무효처리.count > 0) {
    summaryRows.push({ label: "무효 처리", value: report.종합정산.무효처리 });
  }

  const shown = summaryRows.reduce((sum, item) => sum + item.value, 0);
  // 합계는 집계가 낸 값(실현순증감 = 메인 계좌 거래 금액의 합)을 그대로 쓴다.
  // 위 줄들의 합과 어긋나면 표가 무언가를 빠뜨린 것이므로 차액을 드러낸다
  // (조용히 맞추지 않는다).
  const 합계 = report.종합정산.실현순증감;
  const missing = 합계 - shown;

  // 원본 마지막 두 줄. 회색 `보정` 자리에 검산 차액이 온다.
  const residual = verification.checked ? verification.difference : null;

  const mainTitle = `${report.mainAccount?.nickname ?? "메인"} 계좌`;

  return (
    <div className="flex flex-col gap-6">
      <VerifyBanner
        verification={verification}
        mainNickname={report.mainAccount?.nickname ?? null}
        unclassified={report.미분류.count}
      />

      <div className="flex flex-col gap-2">
        <AccountSection
          role="main"
          title={mainTitle}
          stats={[
            { label: "수입", value: <Amount value={report.수입.total} /> },
            { label: "순증감", value: <Amount value={합계} /> },
            { label: "잔액", value: mainBalance?.derived === true ? plain(mainBalance.closing) : "—" },
          ]}
        >
          <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
            {/* 좌: 메인에서 바로 나가는 돈 */}
            <div className="flex min-w-0 flex-col gap-4">
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
            {/* 우: 카드비 · 변동비 */}
            <div className="flex min-w-0 flex-col gap-4">
              <KindTable
                kind="카드비"
                items={cardItems}
                total={card.total}
                caption={`${report.yearMonth} 카드비`}
              />
              <VariableTable
                lines={lines.변동비}
                section={report.변동비}
                caption={`${report.yearMonth} 변동비(일회성 수입 · 지출)`}
              />
            </div>
          </div>
        </AccountSection>

        {report.계좌블록.map((block) => {
          const balance = report.계좌별잔액변화.find((entry) => entry.role === block.role);
          return (
            <AccountSection
              key={block.role}
              role={block.role}
              title={`${block.nickname} 계좌`}
              stats={[
                { label: "순증감", value: <Amount value={block.순증감} /> },
                { label: "잔액", value: balance?.derived === true ? plain(balance.closing) : "—" },
              ]}
            >
              <AccountTable block={block} balance={balance} />
            </AccountSection>
          );
        })}
      </div>

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        <section className="flex min-w-0 flex-col gap-2" aria-labelledby="summary-title" data-testid="summary">
          <h2 id="summary-title" className="text-[13px] font-semibold text-fg">
            종합정산
          </h2>
          <Frame>
            <table className={BOX}>
              <caption className="sr-only">{report.yearMonth} 종합정산</caption>
              <thead>
                <tr>
                  <th scope="col" className={HEAD}>
                    항목
                  </th>
                  <th scope="col" className={HEAD_NUM}>
                    금액
                  </th>
                </tr>
              </thead>
              <tbody>
                {summaryRows.map((item) => (
                  <SummaryRow
                    key={item.label}
                    label={item.label}
                    value={<Amount value={item.value} />}
                    tags={item.tags}
                  />
                ))}
                {missing === 0 ? null : (
                  <SummaryRow label="표에 싣지 못한 항목" value={<Amount value={missing} />} />
                )}
                <SummaryRow label="합계" value={<Amount value={합계} />} tone="plain" />
                <tr>
                  <th scope="row" className={`${CELL} text-left font-normal text-muted`}>
                    검산 차액
                  </th>
                  <td
                    data-testid="residual"
                    className={`${NUM} ${residual !== null && residual !== 0 ? "font-semibold text-danger" : "text-muted"}`}
                  >
                    {residual === null ? (
                      "—"
                    ) : (
                      <>
                        {flow(residual)}
                        <span aria-hidden className={`ml-1.5 ${residual === 0 ? "text-ok" : "text-danger"}`}>
                          {residual === 0 ? "✓" : "✕"}
                        </span>
                        <span className="sr-only">{residual === 0 ? " (일치)" : " (불일치)"}</span>
                      </>
                    )}
                  </td>
                </tr>
                <tr className={TONE.main}>
                  <th scope="row" className={`${CELL} text-left`}>
                    {mainTitle} 잔액
                  </th>
                  <td className={NUM}>
                    {mainBalance?.derived === true ? plain(mainBalance.closing) : "—"}
                  </td>
                </tr>
              </tbody>
            </table>
          </Frame>
        </section>

        <section className="flex min-w-0 flex-col gap-2" aria-labelledby="balances-title" data-testid="balances">
          <h2 id="balances-title" className="text-[13px] font-semibold text-fg">
            계좌별 잔액 변화
          </h2>
          <Frame>
            <table className={BOX}>
              <thead>
                <tr>
                  <th scope="col" className={HEAD}>
                    계좌
                  </th>
                  <th scope="col" className={HEAD_NUM}>
                    시작 잔액
                  </th>
                  <th scope="col" className={HEAD_NUM}>
                    끝 잔액
                  </th>
                  <th scope="col" className={HEAD_NUM}>
                    변화
                  </th>
                </tr>
              </thead>
              <tbody>
                {report.계좌별잔액변화.map((entry) => {
                  const inferred = entry.derived ? inferredBalanceHint(entry) : undefined;
                  return (
                    <tr key={entry.role}>
                      <th scope="row" className={`${CELL} text-left font-normal`}>
                        <span className="whitespace-nowrap">{entry.nickname}</span>
                        {entry.derived ? (
                          inferred === undefined ? null : <Tag hint={inferred}>역산</Tag>
                        ) : (
                          <Tag>{balanceReasonText(entry.reason)}</Tag>
                        )}
                      </th>
                      <td className={NUM}>{plain(entry.opening)}</td>
                      <td className={NUM}>{plain(entry.closing)}</td>
                      <td className={NUM}>
                        <Amount value={entry.change} />
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </Frame>
        </section>
      </div>
    </div>
  );
}
