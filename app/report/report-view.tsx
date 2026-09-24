// 월별 현금흐름표의 **표 서식**. 숫자는 lib/report/monthly.mjs 가 만든다.
//
// 최종 정산표 양식이 아직 확정되지 않았다. 그래서 여기는 "읽을 수 있는 평범한
// 표"로만 두고, 양식이 오면 이 파일 하나만 갈아끼우면 되게 했다 — page.tsx 는
// 인증 · 달 선택 · 조회만 하고 서식을 모른다.
//
// ── 부호 ──────────────────────────────────────────────────────────────────
//
// 저장된 부호 규약(입금 + / 출금 −)을 **그대로 보여 준다.** 화면에서 지출을
// 양수로 뒤집지 않는다. 뒤집으면 어떤 칸이 뒤집힌 값인지 사람이 매번 기억해야
// 하고, 검산 차액의 부호를 읽을 때 정확히 반대로 이해하게 된다.
// 대신 흐름(수입·지출·증감)에는 `+`/`−` 를 항상 붙여 표시가 모호하지 않게 한다.
//
// ── 여기에 없는 것 ────────────────────────────────────────────────────────
//
// 행 단위 내역이 없다. 적요 · 거래 일시 · 계좌번호 · 뒤 4자리는 이 파일이
// 받는 데이터에 애초에 들어 있지 않고, 미분류는 **건수**로만 나온다.
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
type SectionItem = { key: string; total: number; count: number };

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
 * 계좌별 잔액 변화 표에서 쓰는 같은 코드의 문장.
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

const CELL = "px-3 py-2";
const NUM = `${CELL} text-right tabular-nums whitespace-nowrap`;

function SectionRow({
  title,
  note,
  total,
  count,
}: {
  title: string;
  note?: string;
  total: number;
  count?: number;
}) {
  return (
    <tr className="border-t border-zinc-300 bg-zinc-50 font-medium dark:border-zinc-700 dark:bg-zinc-900">
      <th scope="row" className={`${CELL} text-left`}>
        {title}
        {note !== undefined ? (
          <span className="ml-2 text-xs font-normal text-zinc-500">{note}</span>
        ) : null}
      </th>
      <td className={NUM}>{flow(total)}</td>
      <td className={`${NUM} text-zinc-500`}>{count === undefined ? "" : `${count}건`}</td>
    </tr>
  );
}

function ItemRow({
  label,
  total,
  count,
  depth = 1,
}: {
  label: string;
  total: number;
  count?: number;
  depth?: number;
}) {
  return (
    <tr className="border-t border-zinc-200 dark:border-zinc-800">
      <td className={`${CELL} ${depth > 1 ? "pl-12" : "pl-8"}`}>{label}</td>
      <td className={NUM}>{flow(total)}</td>
      <td className={`${NUM} text-zinc-500`}>{count === undefined ? "" : `${count}건`}</td>
    </tr>
  );
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
        거래가 빠졌거나 파싱이 어긋난 신호입니다. <strong>보정으로 덮지 마세요.</strong>
      </p>
    </section>
  );
}

/** 현금흐름표 본문. */
export function ReportView({
  report,
  verification,
}: {
  report: MonthlyReport;
  verification: Verification;
}) {
  const card = report.변동지출.카드대금;

  return (
    <div className="flex flex-col gap-6">
      <VerifyBanner
        verification={verification}
        mainNickname={report.mainAccount?.nickname ?? null}
      />

      <p className="text-xs text-zinc-500">
        금액은 저장된 부호 그대로입니다 — {report.signConvention}. 지출은 −, 입금은 +
        로 표시합니다.
      </p>

      <table className="w-full border-collapse text-sm">
        <caption className="sr-only">{report.yearMonth} 월별 현금흐름표</caption>
        <thead>
          <tr className="text-xs text-zinc-500">
            <th scope="col" className={`${CELL} text-left font-normal`}>
              항목
            </th>
            <th scope="col" className={`${CELL} text-right font-normal`}>
              금액
            </th>
            <th scope="col" className={`${CELL} text-right font-normal`}>
              건수
            </th>
          </tr>
        </thead>
        <tbody>
          <SectionRow title="수입" total={report.수입.total} count={report.수입.count} />
          {report.수입.items.map((item) => (
            <ItemRow key={item.key} label={item.key} total={item.total} count={item.count} />
          ))}

          <SectionRow
            title="고정지출1"
            note="저축 · 용돈 · 주거비"
            total={report.고정지출1.total}
            count={report.고정지출1.count}
          />
          {report.고정지출1.items.map((item: SectionItem) => (
            <ItemRow key={item.key} label={item.key} total={item.total} count={item.count} />
          ))}

          <SectionRow
            title="고정지출2"
            note="고정비 · 비상금"
            total={report.고정지출2.total}
            count={report.고정지출2.count}
          />
          {report.고정지출2.items.map((item: SectionItem) => (
            <ItemRow key={item.key} label={item.key} total={item.total} count={item.count} />
          ))}

          <SectionRow
            title="변동지출"
            total={report.변동지출.total}
            count={report.변동지출.count}
          />
          <ItemRow label="카드대금" total={card.total} count={card.count} />
          {card.issuers.map((issuer) => (
            <ItemRow
              key={issuer.issuer}
              label={issuer.issuer}
              total={issuer.total}
              count={issuer.count}
              depth={2}
            />
          ))}
          <ItemRow
            label="기타"
            total={report.변동지출.기타.total}
            count={report.변동지출.기타.count}
          />

          <SectionRow
            title="계좌간이동"
            note="수입도 지출도 아니다. 메인 잔액은 실제로 줄어든다"
            total={report.계좌간이동.total}
            count={report.계좌간이동.count}
          />
          {report.계좌간이동.items.map((item) => (
            <ItemRow key={item.key} label={item.key} total={item.total} count={item.count} />
          ))}

          <SectionRow title="보정" total={report.보정.total} count={report.보정.count} />
          {report.보정.items.map((item, index) => (
            <ItemRow
              key={`${item.target}-${index}`}
              label={`${item.target} — ${item.reason}`}
              total={item.amount}
            />
          ))}
        </tbody>
      </table>

      <section className="flex flex-col gap-2">
        <h2 className="text-sm font-medium text-zinc-700 dark:text-zinc-300">종합정산</h2>
        <dl className="grid grid-cols-[1fr_auto] gap-x-4 gap-y-1 text-sm">
          <dt className="text-zinc-500">수입</dt>
          <dd className="text-right tabular-nums">{flow(report.종합정산.수입)}</dd>
          <dt className="text-zinc-500">고정지출1</dt>
          <dd className="text-right tabular-nums">{flow(report.종합정산.고정지출1)}</dd>
          <dt className="text-zinc-500">고정지출2</dt>
          <dd className="text-right tabular-nums">{flow(report.종합정산.고정지출2)}</dd>
          <dt className="text-zinc-500">변동지출</dt>
          <dd className="text-right tabular-nums">{flow(report.종합정산.변동지출)}</dd>
          <dt className="text-zinc-500">계좌간이동</dt>
          <dd className="text-right tabular-nums">{flow(report.종합정산.계좌간이동)}</dd>

          <dt className="border-t border-zinc-300 pt-1 font-medium dark:border-zinc-700">
            실현순증감
          </dt>
          <dd className="border-t border-zinc-300 pt-1 text-right font-medium tabular-nums dark:border-zinc-700">
            {flow(report.종합정산.실현순증감)}
          </dd>
          <dt className="text-zinc-500">보정</dt>
          <dd className="text-right tabular-nums">{flow(report.종합정산.보정)}</dd>
          <dt className="font-medium">보정후순증감</dt>
          <dd className="text-right font-medium tabular-nums">
            {flow(report.종합정산.보정후순증감)}
          </dd>
        </dl>
      </section>

      <section className="flex flex-col gap-2">
        <h2 className="text-sm font-medium text-zinc-700 dark:text-zinc-300">
          계좌별 잔액 변화
        </h2>
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
              <tr key={entry.role} className="border-t border-zinc-200 dark:border-zinc-800">
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

      {report.계좌블록.length > 0 ? (
        <section className="flex flex-col gap-2">
          <h2 className="text-sm font-medium text-zinc-700 dark:text-zinc-300">계좌블록</h2>
          <p className="text-xs text-zinc-500">
            메인이 아닌 계좌. 이 계좌들의 입금은 메인에서 간 돈이라 위 종합정산에서는
            세지 않습니다.
          </p>
          <table className="w-full border-collapse text-sm">
            <thead>
              <tr className="text-xs text-zinc-500">
                <th scope="col" className={`${CELL} text-left font-normal`}>
                  계좌
                </th>
                <th scope="col" className={`${CELL} text-right font-normal`}>
                  입금
                </th>
                <th scope="col" className={`${CELL} text-right font-normal`}>
                  집행
                </th>
                <th scope="col" className={`${CELL} text-right font-normal`}>
                  이자
                </th>
              </tr>
            </thead>
            <tbody>
              {report.계좌블록.map((block) => (
                <tr key={block.role} className="border-t border-zinc-200 dark:border-zinc-800">
                  <th scope="row" className={`${CELL} text-left font-normal`}>
                    {block.nickname}
                  </th>
                  <td className={NUM}>{flow(block.입금.total)}</td>
                  <td className={NUM}>{flow(block.집행.total)}</td>
                  <td className={NUM}>{flow(block.이자.total)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>
      ) : null}

      <section className="flex flex-col gap-1">
        <h2 className="text-sm font-medium text-zinc-700 dark:text-zinc-300">미분류</h2>
        <p className="text-sm">
          {report.미분류.count}건 (전체 {report.거래건수}건)
        </p>
        <p className="text-xs text-zinc-500">
          건수만 보여 줍니다. 어떤 거래인지는 이 화면에 싣지 않습니다.
        </p>
      </section>
    </div>
  );
}
