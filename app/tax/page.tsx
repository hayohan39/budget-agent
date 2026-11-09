// 연말정산 공제 트래커 — 가계부 거래로 확인되는 공제 항목의 올해 누적 · 남은 한도 · 공제 효과.
// 설계: docs/year-end-tax.md. 계산은 lib/tax/deductions.mjs, 데이터는 lib/tax/store.mjs.
//
// ── 보안 ───────────────────────────────────────────────────────────────────
//
//   - middleware 의 matcher 가 `/tax` 를 덮는다. 그래도 여기서 세션 + 화이트리스트를 **요청마다
//     다시** 본다(/report · /classify · /stats 와 같다). 항상 동적으로 렌더한다.
//   - 화면에 나가는 것: 공제 항목별 합계 · 가계부 (분류, 항목) 이름과 그 연간 합계 · 사용자가 입력한
//     설정. 거래 일시 · 적요 원문 · 계좌는 없다. 항목 이름은 /report 에 이미 보이는 값이다.
//   - console 호출이 없다. 에러는 바인딩 없는 `catch {}` 로 받는다.
//   - `year` 는 지원 연도 목록에 있는 값만 받고, 그 밖의 값은 되비추지 않는다.
import Link from "next/link";
import { redirect } from "next/navigation";

import { auth, isAllowedEmail } from "@/auth";
import { withClient } from "@/lib/db/client.mjs";
import { DEDUCTION_KEYS, DEDUCTION_LABELS, rulesFor, SUPPORTED_YEARS } from "@/lib/tax/deductions.mjs";
import {
  buildTracker,
  combineCard,
  describeMonths,
  loadCardConfirmation,
  loadCardUsage,
  loadManualEntries,
  loadPatternTags,
  loadSavedPatterns,
  loadSettings,
  loadTags,
  loadYearRows,
} from "@/lib/tax/store.mjs";

import {
  CardConfirmForm,
  ConnectControls,
  ManualAddForm,
  ManualEntryControls,
  SettingsForm,
  UnlinkButton,
  type CardConfirmationValue,
  type LinkTarget,
  type SettingsValue,
} from "./forms";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Item = {
  key: string;
  label: string;
  kind: "income" | "credit";
  status: "ok" | "needs_salary" | "needs_rate" | "needs_eligibility" | "ineligible";
  amount: number;
  eligibleAmount: number | null;
  deduction: number | null;
  effect: number | null;
  remaining: number | null;
  effectIfFilled: number | null;
  notes: string[];
  estimated: boolean;
  cardProgress?: {
    threshold: number;
    toThreshold: number;
    baseLimit: number;
    base: number;
    extraLimit: number;
    extra: number;
  };
};
type CardUsage = { month: string; total: number; byIssuer: Array<{ issuer: string; amount: number }> };
type Source =
  | { kind: "group"; category: string; item: string; net: number }
  | { kind: "pattern"; basis: string; direction: string; pattern: string; net: number }
  | { kind: "manual"; id: string; label: string; net: number };
type Candidate =
  | { kind: "group"; category: string; item: string; net: number; suggested: string | null }
  | {
      kind: "pattern";
      basis: string;
      direction: string;
      pattern: string;
      category: string;
      item: string | null;
      net: number;
      suggested: string | null;
    };

const STATUS_TEXT: Record<Item["status"], string | null> = {
  ok: null,
  needs_salary: "연봉 입력 필요",
  needs_rate: "한계세율 선택 필요",
  needs_eligibility: "자격 확인 필요",
  ineligible: "대상 아님",
};

const won = (value: number) => `${value.toLocaleString("ko-KR")}원`;

/** 큰 금액을 `약 92만원` 처럼. 1만원 미만은 원 단위. */
function roughWon(value: number) {
  if (Math.abs(value) < 10_000) return won(value);
  return `약 ${Math.round(value / 10_000).toLocaleString("ko-KR")}만원`;
}

function first(value: string | string[] | undefined) {
  return Array.isArray(value) ? (value[0] ?? "") : (value ?? "");
}

function Shell({ year, children }: { year?: number; children: React.ReactNode }) {
  return (
    <main className="mx-auto flex w-full max-w-3xl flex-1 flex-col gap-6 px-4 pt-4 pb-6 break-keep sm:px-8 sm:pt-5 sm:pb-8">
      <h1 className="text-xl font-semibold tracking-tight">
        공제 트래커
        {year !== undefined ? <span className="ml-2 text-[13px] font-normal text-muted">{year}년 귀속</span> : null}
      </h1>
      {children}
    </main>
  );
}

function Badge({ children, tone = "muted" }: { children: React.ReactNode; tone?: "muted" | "warn" }) {
  const color = tone === "warn" ? "border-warn-line bg-warn-bg text-warn" : "border-line bg-subtle text-muted";
  return <span className={`rounded border px-1.5 text-xs font-medium ${color}`}>{children}</span>;
}

function GroupName({ group }: { group: { category: string; item: string } }) {
  return (
    <span className="break-all">
      <span className="text-muted">{group.category} › </span>
      <span className="font-medium">{group.item}</span>
    </span>
  );
}

const BASIS_TEXT: Record<string, string> = { description: "적요", memo: "메모" };
const DIRECTION_TEXT: Record<string, string> = { in: "입금", out: "출금", any: "방향 무관" };

/** 가계부 패턴 이름: `패턴 길동 IRP ##회 · 메모 · 출금`. */
function PatternName({ pattern }: { pattern: { basis: string; direction: string; pattern: string } }) {
  return (
    <span className="break-all">
      <span className="text-muted">패턴 </span>
      <code className="rounded border border-line bg-subtle px-1 font-mono text-[12px] font-medium">{pattern.pattern}</code>
      <span className="text-xs text-muted">
        {" "}
        · {BASIS_TEXT[pattern.basis] ?? pattern.basis} · {DIRECTION_TEXT[pattern.direction] ?? pattern.direction}
      </span>
    </span>
  );
}

function SourceName({ source }: { source: Source }) {
  if (source.kind === "pattern") return <PatternName pattern={source} />;
  if (source.kind === "manual") {
    return (
      <span className="break-all">
        <span className="text-muted">직접 입력 › </span>
        <span className="font-medium">{source.label}</span>
      </span>
    );
  }
  return <GroupName group={source} />;
}

/** 연결 · 제외를 저장하는 대상. 직접 입력은 대상이 아니다. */
function targetOf(source: Exclude<Source, { kind: "manual" }> | Candidate): LinkTarget {
  return source.kind === "pattern"
    ? { kind: "pattern", basis: source.basis, direction: source.direction, pattern: source.pattern }
    : { kind: "group", category: source.category, item: source.item };
}

function sourceKey(source: Source | Candidate) {
  if (source.kind === "pattern") return `p\u001f${source.basis}\u001f${source.direction}\u001f${source.pattern}`;
  if (source.kind === "manual") return `m\u001f${source.id}`;
  return `g\u001f${source.category}\u001f${source.item}`;
}

function ItemCard({ item, sources, limit }: { item: Item; sources: Source[]; limit: number | null }) {
  const status = STATUS_TEXT[item.status];
  const filled = limit === null || limit === 0 ? null : Math.min(100, Math.round(((item.eligibleAmount ?? 0) / limit) * 100));

  return (
    <li className="flex flex-col gap-2 rounded-lg border border-line p-3 text-[13px]">
      <div className="flex flex-wrap items-center gap-2">
        <span className="font-semibold">{item.label}</span>
        <Badge>{item.kind === "income" ? "소득공제" : "세액공제"}</Badge>
        {status !== null ? <Badge tone="warn">{status}</Badge> : null}
      </div>

      <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1">
        <dt className="text-muted">올해 누적</dt>
        <dd className="tabular-nums">
          {won(item.amount)}
          {limit !== null ? (
            <span className="text-muted">
              {" "}
              / 한도 {won(limit)}
              {item.key === "irp" ? "(연금저축 합산)" : ""}
            </span>
          ) : null}
        </dd>
        {item.deduction !== null ? (
          <>
            <dt className="text-muted">소득공제액</dt>
            <dd className="tabular-nums">{won(item.deduction)}</dd>
          </>
        ) : null}
        <dt className="text-muted">공제 효과</dt>
        <dd className="font-medium tabular-nums">{item.effect === null ? "—" : won(item.effect)}</dd>
        {item.remaining !== null && item.remaining > 0 && item.status !== "ineligible" ? (
          <>
            <dt className="text-muted">남은 한도</dt>
            <dd className="tabular-nums">
              {won(item.remaining)}
              {item.effectIfFilled !== null ? (
                <span className="text-ok"> → 다 채우면 +{won(item.effectIfFilled)}</span>
              ) : null}
            </dd>
          </>
        ) : null}
      </dl>

      {filled !== null && item.status !== "ineligible" ? (
        <div className="h-1.5 overflow-hidden rounded-full bg-subtle" aria-hidden="true">
          <div className="h-full rounded-full bg-chart" style={{ width: `${filled}%` }} />
        </div>
      ) : null}

      {item.notes.length > 0 ? (
        <ul className="list-disc pl-4 text-xs text-muted">
          {item.notes.map((note) => (
            <li key={note}>{note}</li>
          ))}
        </ul>
      ) : null}

      <div className="flex flex-col gap-1 border-t border-line pt-2">
        <p className="text-xs text-muted">연결된 항목</p>
        <ul className="flex flex-col gap-1">
          {sources.map((source) => (
            <li key={sourceKey(source)} className="flex flex-wrap items-center justify-between gap-2">
              <SourceName source={source} />
              {source.kind === "manual" ? (
                <ManualEntryControls entry={source} />
              ) : (
                <span className="flex items-center gap-2">
                  <span className="tabular-nums text-muted">{won(source.net)}</span>
                  <UnlinkButton target={targetOf(source)} label="연결 해제" />
                </span>
              )}
            </li>
          ))}
        </ul>
      </div>
    </li>
  );
}

const monthLabel = (month: string) => `${Number(month.slice(5))}월`;

/** 0~100 막대. */
function Bar({ value, max, tone = "chart" }: { value: number; max: number; tone?: "chart" | "ok" }) {
  const width = max <= 0 ? 0 : Math.min(100, Math.round((value / max) * 100));
  return (
    <div className="h-1.5 overflow-hidden rounded-full bg-subtle" aria-hidden="true">
      <div className={`h-full rounded-full ${tone === "ok" ? "bg-ok" : "bg-chart"}`} style={{ width: `${width}%` }} />
    </div>
  );
}

function CardSection({
  year,
  item,
  usage,
  confirmation,
  confirmedTotal,
  estimatedTotal,
  estimatedMonths,
}: {
  year: number;
  item: Item;
  usage: CardUsage[];
  confirmation: CardConfirmationValue | null;
  confirmedTotal: number;
  estimatedTotal: number;
  estimatedMonths: string[];
}) {
  const status = STATUS_TEXT[item.status];
  const progress = item.cardProgress;
  const used = confirmedTotal + estimatedTotal;

  return (
    <section aria-labelledby="card-title" className="flex flex-col gap-2">
      <h2 id="card-title" className="text-[15px] font-semibold tracking-tight">
        신용카드 등 사용액
      </h2>
      <div className="flex flex-col gap-3 rounded-lg border border-line p-3 text-[13px]">
        <div className="flex flex-wrap items-center gap-2">
          <Badge>소득공제</Badge>
          {used > 0 ? item.estimated ? <Badge tone="warn">추정 포함</Badge> : <Badge>확인값</Badge> : null}
          {status !== null ? <Badge tone="warn">{status}</Badge> : null}
        </div>

        {used === 0 ? (
          <p className="text-muted">
            {year}년 사용분으로 볼 카드대금 결제가 아직 없습니다. 확인한 사용액이 있으면 아래에 입력해 주세요.
          </p>
        ) : null}

        <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1">
          <dt className="text-muted">올해 사용액</dt>
          <dd className="tabular-nums">
            {won(used)}
            <span className="text-muted">
              {" "}
              ({confirmation !== null ? `${monthLabel(confirmation.throughMonth)}까지 확인값 ${won(confirmedTotal)}` : "확인값 없음"}
              {estimatedTotal > 0
                ? ` · ${describeMonths(estimatedMonths)} 카드대금 추정 ${won(estimatedTotal)}`
                : ""}
              )
            </span>
          </dd>
          {item.deduction !== null ? (
            <>
              <dt className="text-muted">소득공제액</dt>
              <dd className="tabular-nums">{won(item.deduction)}</dd>
            </>
          ) : null}
          <dt className="text-muted">공제 효과</dt>
          <dd className="font-medium tabular-nums">{item.effect === null ? "—" : won(item.effect)}</dd>
        </dl>

        {progress !== undefined ? (
          <div className="flex flex-col gap-3">
            <div className="flex flex-col gap-1">
              <p className="flex flex-wrap justify-between gap-2 text-xs">
                <span>문턱(연봉의 25%) {won(progress.threshold)}</span>
                <span className={progress.toThreshold > 0 ? "text-muted" : "text-ok"}>
                  {progress.toThreshold > 0 ? `${won(progress.toThreshold)} 남음` : "넘음"}
                </span>
              </p>
              <Bar value={progress.threshold - progress.toThreshold} max={progress.threshold} tone={progress.toThreshold > 0 ? "chart" : "ok"} />
            </div>
            <div className="flex flex-col gap-1">
              <p className="flex flex-wrap justify-between gap-2 text-xs">
                <span>기본 공제한도 {won(progress.baseLimit)}</span>
                <span className="text-muted tabular-nums">{won(progress.base)} 공제</span>
              </p>
              <Bar value={progress.base} max={progress.baseLimit} />
            </div>
            {progress.extra > 0 ? (
              <p className="text-xs text-muted">
                전통시장 · 대중교통 추가 한도에서 {won(progress.extra)} 더 공제(한도 {won(progress.extraLimit)})
              </p>
            ) : null}
            {used > 0 && item.remaining !== null && item.remaining > 0 && item.effectIfFilled !== null ? (
              <p className="text-xs text-ok">
                체크카드 · 현금영수증으로 {won(item.remaining)} 더 쓰면 기본 한도를 다 채워 +{won(item.effectIfFilled)}
              </p>
            ) : null}
          </div>
        ) : null}

        {item.notes.length > 0 ? (
          <ul className="list-disc pl-4 text-xs text-muted">
            {item.notes.map((note) => (
              <li key={note}>{note}</li>
            ))}
          </ul>
        ) : null}

        {usage.length > 0 ? (
          <details className="border-t border-line pt-2">
            <summary className="cursor-pointer text-xs text-muted select-none">
              카드대금으로 본 월별 사용액(결제월을 한 달 앞당김)
            </summary>
            <table className="mt-2 w-full border-collapse text-xs">
              <thead>
                <tr className="border-b border-line text-left text-muted">
                  <th scope="col" className="py-1 font-medium">사용월</th>
                  <th scope="col" className="py-1 font-medium">카드사</th>
                  <th scope="col" className="py-1 text-right font-medium">합계</th>
                </tr>
              </thead>
              <tbody>
                {usage.map((row) => {
                  const replaced = confirmation !== null && row.month <= confirmation.throughMonth;
                  return (
                    <tr key={row.month} className={`border-b border-line last:border-0 ${replaced ? "text-faint" : ""}`}>
                      <td className="py-1 whitespace-nowrap">{monthLabel(row.month)}</td>
                      <td className="py-1">{row.byIssuer.map((x) => `${x.issuer} ${won(x.amount)}`).join(" · ")}</td>
                      <td className="py-1 text-right tabular-nums whitespace-nowrap">
                        {won(row.total)}
                        {replaced ? " (확인값 사용)" : ""}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </details>
        ) : null}

        <details className="border-t border-line pt-2" open={used === 0}>
          <summary className="cursor-pointer text-xs font-medium select-none">
            확인한 사용액으로 보정하기
          </summary>
          <div className="mt-2 flex flex-col gap-2">
            <p className="text-xs text-muted">
              홈택스 연말정산 미리보기(11월, 1~9월분)나 카드사 앱에서 결제수단별 누계를 확인해 넣으면 그 달까지는
              확인값을 쓰고, 그 뒤 달만 카드대금으로 추정합니다.
            </p>
            <CardConfirmForm year={year} initial={confirmation} />
          </div>
        </details>
      </div>
    </section>
  );
}

function GroupRows({ rows, options }: { rows: Candidate[]; options: Array<{ key: string; label: string }> }) {
  return (
    <ul className="flex flex-col gap-2">
      {rows.map((row) => (
        <li
          key={sourceKey(row)}
          className="flex flex-col gap-2 rounded-lg border border-line p-3 text-[13px] sm:flex-row sm:items-center sm:justify-between"
        >
          <span className="flex flex-col gap-0.5">
            {row.kind === "pattern" ? <PatternName pattern={row} /> : <GroupName group={row} />}
            <span className="text-xs tabular-nums text-muted">
              올해 {won(row.net)}
              {row.kind === "pattern" ? ` · 가계부 분류 ${row.category}${row.item !== null ? ` › ${row.item}` : ""}` : ""}
            </span>
          </span>
          <ConnectControls target={targetOf(row)} suggested={row.suggested} options={options} />
        </li>
      ))}
    </ul>
  );
}

export default async function TaxPage({ searchParams }: PageProps<"/tax">) {
  const session = await auth();
  if (!session || !isAllowedEmail(session.user?.email)) redirect("/signin?callbackUrl=/tax");

  const params = await searchParams;
  const requested = first(params.year);
  const latest = SUPPORTED_YEARS[SUPPORTED_YEARS.length - 1];
  const year = requested === "" ? latest : SUPPORTED_YEARS.find((y) => String(y) === requested);
  if (year === undefined) {
    return (
      <Shell>
        <p role="alert" className="text-[13px] text-danger">
          지원하지 않는 귀속연도입니다.
        </p>
        <Link href="/tax" className="self-start text-[13px] text-accent-text underline-offset-4 hover:underline">
          {latest}년 귀속 보기
        </Link>
      </Shell>
    );
  }

  let loaded;
  try {
    loaded = await withClient(async (client) => {
      const [{ rows, months }, tags, patternTags, savedPatterns, manualEntries, settings, cardUsage, cardConfirmation] =
        await Promise.all([
          loadYearRows(client, year),
          loadTags(client),
          loadPatternTags(client),
          loadSavedPatterns(client),
          loadManualEntries(client, year),
          loadSettings(client, year),
          loadCardUsage(client, year),
          loadCardConfirmation(client, year),
        ]);
      const card = combineCard({ usage: cardUsage, confirmation: cardConfirmation });
      return {
        months,
        settings,
        cardUsage,
        cardConfirmation,
        card,
        view: buildTracker({
          year,
          rows,
          tags,
          patternTags,
          savedPatterns,
          manualEntries,
          settings,
          card: card.input,
        }),
      };
    });
  } catch {
    return (
      <Shell year={year}>
        <p role="alert" className="text-[13px] text-danger">
          데이터를 불러오지 못했습니다. 잠시 후 다시 시도해 주세요.
        </p>
      </Shell>
    );
  }

  const rules = rulesFor(year);
  const { months, settings, view, card } = loaded;
  const cardUsage = loaded.cardUsage as CardUsage[];
  const cardConfirmation = loaded.cardConfirmation as CardConfirmationValue | null;
  const allItems = view.result.items as Item[];
  const cardItem = allItems.find((item) => item.key === "card") as Item;
  const items = allItems.filter((item) => item.key !== "card");
  const hasCard = card.confirmedTotal + card.estimatedTotal > 0;
  const sources = view.sources as Record<string, Source[]>;
  const connected = items.filter((item) => sources[item.key].length > 0);
  const unconnected = items.filter((item) => sources[item.key].length === 0);
  const counted = hasCard ? [...connected, cardItem] : connected;
  const totalEffect = counted.reduce((sum, item) => sum + (item.effect ?? 0), 0);
  const needsInput = counted.filter((item) => item.status.startsWith("needs_")).length;

  const options = DEDUCTION_KEYS.map((key: string) => ({ key, label: (DEDUCTION_LABELS as Record<string, string>)[key] }));
  const brackets = rules.taxBrackets.map((b: { upTo: number; pct: number }) => ({
    upTo: Number.isFinite(b.upTo) ? b.upTo : null,
    pct: b.pct,
  }));
  // 카드에 보여 줄 "한도" 는 법정 한도 그대로다(남은 한도는 따로 보여 준다). 한도가 금액이 아닌 항목은 뺀다.
  const limits: Record<string, number> = {
    pension_savings: rules.pension.savingsLimit,
    irp: rules.pension.totalLimit,
    housing_subscription: rules.housingSubscription.paymentLimit,
    rent: rules.rent.limit,
    insurance: rules.insurance.limit,
  };
  const tiers = Object.entries(rules.mortgageInterest.tiers as Record<string, { label: string }>).map(([key, tier]) => ({
    key,
    label: tier.label,
  }));

  return (
    <Shell year={year}>
      <section aria-labelledby="summary-title" className="flex flex-col gap-2 rounded-lg border border-line bg-subtle p-4">
        <h2 id="summary-title" className="text-xs text-muted">
          연결된 항목의 공제 효과(추정)
        </h2>
        <p className="text-2xl font-semibold tabular-nums">{roughWon(totalEffect)}</p>
        <p className="flex flex-wrap gap-x-3 gap-y-1 text-xs text-muted">
          <span>연결된 공제 항목 {connected.length}개{hasCard ? " + 카드" : ""}</span>
          {needsInput > 0 ? <span className="text-warn">입력 필요 {needsInput}개</span> : null}
          {view.candidates.length > 0 ? <span>확인할 후보 {view.candidates.length}개</span> : null}
          <span>거래내역이 있는 달: {months.length > 0 ? describeMonths(months) : "없음"}</span>
        </p>
        <p className="text-xs text-muted">
          참고용 추정입니다. 공제 효과는 낼 세금이 충분할 때의 최대치이고, 결정세액이 이미 0 이면 늘어나지 않습니다.
        </p>
      </section>

      <section aria-labelledby="settings-title" className="flex flex-col gap-2">
        <h2 id="settings-title" className="text-[15px] font-semibold tracking-tight">
          내 정보
        </h2>
        <SettingsForm year={year} initial={settings as SettingsValue} brackets={brackets} tiers={tiers} />
      </section>

      {view.candidates.length > 0 ? (
        <section aria-labelledby="candidates-title" className="flex flex-col gap-2">
          <h2 id="candidates-title" className="text-[15px] font-semibold tracking-tight">
            확인할 후보
          </h2>
          <p className="text-xs text-muted">
            가계부 항목 이름 · 가계부 패턴으로 찾은 후보입니다. 연결해야 금액이 잡히고, 한 번 연결하면 다음 거래부터
            자동입니다. 가계부에서 패턴으로 묶인 거래는 여기서도 패턴 하나로 보입니다. 아니면 [후보에서 제외].
          </p>
          <GroupRows rows={view.candidates as Candidate[]} options={options} />
        </section>
      ) : null}

      <section aria-labelledby="items-title" className="flex flex-col gap-2">
        <h2 id="items-title" className="text-[15px] font-semibold tracking-tight">
          공제 항목
        </h2>
        {connected.length > 0 ? (
          <ul className="flex flex-col gap-3">
            {connected.map((item) => (
              <ItemCard key={item.key} item={item} sources={sources[item.key]} limit={limits[item.key] ?? null} />
            ))}
          </ul>
        ) : (
          <p className="text-[13px] text-muted">아직 연결된 항목이 없습니다. 위 후보나 아래 목록에서 연결해 주세요.</p>
        )}
        {unconnected.length > 0 ? (
          <p className="text-xs text-muted">연결 안 됨: {unconnected.map((item) => item.label).join(" · ")}</p>
        ) : null}
        <details className="rounded-lg border border-line p-3">
          <summary className="cursor-pointer text-[13px] font-medium select-none">가계부 밖 금액 직접 추가</summary>
          <div className="mt-2 flex flex-col gap-2">
            <p className="text-xs text-muted">
              가계부 계좌에서 나가지 않는 공제 대상 금액(예: 다른 은행에서 내는 연금저축)을 적어 두면 같은 공제 항목에
              더해집니다. 올해 낸 누계를 적고, 늘어나면 고쳐 주세요.
            </p>
            <ManualAddForm year={year} options={options} />
          </div>
        </details>
      </section>

      <CardSection
        year={year}
        item={cardItem}
        usage={cardUsage}
        confirmation={cardConfirmation}
        confirmedTotal={card.confirmedTotal}
        estimatedTotal={card.estimatedTotal}
        estimatedMonths={card.estimatedMonths}
      />

      {view.others.length > 0 ? (
        <details className="flex flex-col gap-2">
          <summary className="cursor-pointer text-[13px] font-medium select-none">
            다른 가계부 항목에서 고르기 ({view.others.length})
          </summary>
          <div className="mt-2">
            <GroupRows rows={view.others as Candidate[]} options={options} />
          </div>
        </details>
      ) : null}

      {view.dismissed.length > 0 ? (
        <details>
          <summary className="cursor-pointer text-[13px] font-medium select-none">
            후보에서 제외한 항목 ({view.dismissed.length})
          </summary>
          <ul className="mt-2 flex flex-col gap-1 text-[13px]">
            {(view.dismissed as Array<Exclude<Source, { kind: "manual" }>>).map((row) => (
              <li key={sourceKey(row)} className="flex flex-wrap items-center justify-between gap-2">
                <SourceName source={row} />
                <span className="flex items-center gap-2">
                  <span className="tabular-nums text-muted">{won(row.net)}</span>
                  <UnlinkButton target={targetOf(row)} label="되돌리기" />
                </span>
              </li>
            ))}
          </ul>
        </details>
      ) : null}
    </Shell>
  );
}
