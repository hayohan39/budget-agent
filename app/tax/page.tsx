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
import { buildTracker, describeMonths, loadSettings, loadTags, loadYearGroups } from "@/lib/tax/store.mjs";

import { ConnectControls, SettingsForm, UnlinkButton, type SettingsValue } from "./forms";

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
};
type Source = { category: string; item: string; net: number };
type Candidate = Source & { suggested: string | null };

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

function ItemCard({ item, sources }: { item: Item; sources: Source[] }) {
  const status = STATUS_TEXT[item.status];
  const limit = item.remaining === null || item.eligibleAmount === null ? null : item.eligibleAmount + item.remaining;
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
          {limit !== null && item.key !== "lease_loan" ? <span className="text-muted"> / 한도 {won(limit)}</span> : null}
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
        <p className="text-xs text-muted">연결된 가계부 항목</p>
        <ul className="flex flex-col gap-1">
          {sources.map((source) => (
            <li key={`${source.category}\u001f${source.item}`} className="flex flex-wrap items-center justify-between gap-2">
              <GroupName group={source} />
              <span className="flex items-center gap-2">
                <span className="tabular-nums text-muted">{won(source.net)}</span>
                <UnlinkButton group={source} label="연결 해제" />
              </span>
            </li>
          ))}
        </ul>
      </div>
    </li>
  );
}

function GroupRows({ rows, options }: { rows: Candidate[]; options: Array<{ key: string; label: string }> }) {
  return (
    <ul className="flex flex-col gap-2">
      {rows.map((row) => (
        <li
          key={`${row.category}\u001f${row.item}`}
          className="flex flex-col gap-2 rounded-lg border border-line p-3 text-[13px] sm:flex-row sm:items-center sm:justify-between"
        >
          <span className="flex flex-col">
            <GroupName group={row} />
            <span className="text-xs tabular-nums text-muted">올해 {won(row.net)}</span>
          </span>
          <ConnectControls group={{ category: row.category, item: row.item }} suggested={row.suggested} options={options} />
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
      const [{ groups, months }, tags, settings] = await Promise.all([
        loadYearGroups(client, year),
        loadTags(client),
        loadSettings(client, year),
      ]);
      return { months, settings, view: buildTracker({ year, groups, tags, settings }) };
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
  const { months, settings, view } = loaded;
  // 카드 공제는 다음 단계(T3)에서 가계부 결제대금 추정과 함께 보여 준다.
  const items = (view.result.items as Item[]).filter((item) => item.key !== "card");
  const sources = view.sources as Record<string, Source[]>;
  const connected = items.filter((item) => sources[item.key].length > 0);
  const unconnected = items.filter((item) => sources[item.key].length === 0);
  const totalEffect = connected.reduce((sum, item) => sum + (item.effect ?? 0), 0);
  const needsInput = connected.filter((item) => item.status.startsWith("needs_")).length;

  const options = DEDUCTION_KEYS.map((key: string) => ({ key, label: (DEDUCTION_LABELS as Record<string, string>)[key] }));
  const brackets = rules.taxBrackets.map((b: { upTo: number; pct: number }) => ({
    upTo: Number.isFinite(b.upTo) ? b.upTo : null,
    pct: b.pct,
  }));
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
          <span>연결된 공제 항목 {connected.length}개</span>
          {needsInput > 0 ? <span className="text-warn">입력 필요 {needsInput}개</span> : null}
          {view.candidates.length > 0 ? <span>확인할 후보 {view.candidates.length}개</span> : null}
          <span>거래내역이 있는 달: {months.length > 0 ? describeMonths(months) : "없음"}</span>
        </p>
        <p className="text-xs text-muted">
          참고용 추정입니다. 공제 효과는 낼 세금이 충분할 때의 최대치이고, 결정세액이 이미 0 이면 늘어나지 않습니다.
          신용카드 공제는 다음 업데이트에서 추가됩니다.
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
            가계부 항목 이름으로 찾은 후보입니다. 연결해야 금액이 잡힙니다. 한 번 연결하면 다음 거래부터 자동입니다.
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
              <ItemCard key={item.key} item={item} sources={sources[item.key]} />
            ))}
          </ul>
        ) : (
          <p className="text-[13px] text-muted">아직 연결된 항목이 없습니다. 위 후보나 아래 목록에서 연결해 주세요.</p>
        )}
        {unconnected.length > 0 ? (
          <p className="text-xs text-muted">연결 안 됨: {unconnected.map((item) => item.label).join(" · ")}</p>
        ) : null}
      </section>

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
            공제 아님으로 표시한 항목 ({view.dismissed.length})
          </summary>
          <ul className="mt-2 flex flex-col gap-1 text-[13px]">
            {(view.dismissed as Source[]).map((row) => (
              <li key={`${row.category}\u001f${row.item}`} className="flex flex-wrap items-center justify-between gap-2">
                <GroupName group={row} />
                <UnlinkButton group={row} label="되돌리기" />
              </li>
            ))}
          </ul>
        </details>
      ) : null}
    </Shell>
  );
}
