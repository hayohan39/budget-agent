"use client";

// 공제 트래커(/tax)의 입력 부분. 저장은 /api/tax/settings · /api/tax/tags 로 보내고(가드 · 검사는 서버),
// 끝나면 router.refresh() 로 서버 컴포넌트가 다시 계산한다. 이 파일은 금액을 계산하지 않는다.
import { useRouter } from "next/navigation";
import { useId, useState, useTransition, type FormEvent } from "react";

const INPUT = "h-8 rounded-md border border-control bg-canvas px-2 text-[13px]";
const BUTTON =
  "h-8 rounded-md border border-line-strong bg-canvas px-3 text-[13px] font-medium hover:bg-hover disabled:cursor-not-allowed disabled:opacity-50";
const QUIET_BUTTON =
  "h-7 rounded-md px-2 text-xs text-muted hover:bg-hover hover:text-fg disabled:cursor-not-allowed disabled:opacity-50";

type Status = { kind: "idle" } | { kind: "busy" } | { kind: "done"; text: string } | { kind: "error"; text: string };

async function post(url: string, body: unknown): Promise<{ ok: boolean; message: string | null }> {
  const response = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
    cache: "no-store",
  });
  let data: Record<string, unknown> = {};
  try {
    data = (await response.json()) as Record<string, unknown>;
  } catch {
    data = {};
  }
  return { ok: response.ok && data.ok === true, message: typeof data.message === "string" ? data.message : null };
}

function StatusLine({ status }: { status: Status }) {
  if (status.kind === "done") {
    return (
      <p role="status" className="text-xs text-ok">
        {status.text}
      </p>
    );
  }
  if (status.kind === "error") {
    return (
      <p role="alert" className="text-xs text-danger">
        {status.text}
      </p>
    );
  }
  return null;
}

/** 저장 → 새로고침 → 상태 표시를 한 번에. */
function useSender() {
  const router = useRouter();
  const [, startTransition] = useTransition();
  const [status, setStatus] = useState<Status>({ kind: "idle" });

  async function send(url: string, body: unknown, doneText: string) {
    setStatus({ kind: "busy" });
    try {
      const { ok, message } = await post(url, body);
      if (!ok) {
        setStatus({ kind: "error", text: message ?? "저장하지 못했습니다." });
        return;
      }
      setStatus({ kind: "done", text: doneText });
      startTransition(() => router.refresh());
    } catch {
      setStatus({ kind: "error", text: "서버에 연결하지 못했습니다." });
    }
  }

  const fail = (text: string) => setStatus({ kind: "error", text });

  return { status, send, fail, busy: status.kind === "busy" };
}

// ── 연도 설정 ─────────────────────────────────────────────────────────────

export type SettingsValue = {
  salary: number | null;
  marginalRate: number | null;
  homelessHouseholder: boolean | null;
  mortgageTier: string | null;
};

const MAN = 10_000;

export function SettingsForm({
  year,
  initial,
  brackets,
  tiers,
}: {
  year: number;
  initial: SettingsValue;
  /** 과세표준 상한(원, 마지막은 null = 상한 없음)과 세율. */
  brackets: Array<{ upTo: number | null; pct: number }>;
  tiers: Array<{ key: string; label: string }>;
}) {
  const uid = useId();
  const { status, send, fail, busy } = useSender();
  // 연봉은 만원 단위로 입력받는다(원 단위로 9자리를 치게 하지 않는다).
  const [salary, setSalary] = useState(initial.salary === null ? "" : String(Math.floor(initial.salary / MAN)));
  const [rate, setRate] = useState(initial.marginalRate === null ? "" : String(initial.marginalRate));
  const [homeless, setHomeless] = useState(
    initial.homelessHouseholder === null ? "" : initial.homelessHouseholder ? "yes" : "no",
  );
  const [tier, setTier] = useState(initial.mortgageTier ?? "");

  async function onSubmit(event: FormEvent) {
    event.preventDefault();
    const text = salary.replaceAll(",", "").trim();
    if (text !== "" && !/^[0-9]{1,6}$/.test(text)) {
      fail("연봉은 만원 단위 숫자로 입력해 주세요(예: 5000).");
      return;
    }
    await send(
      "/api/tax/settings",
      {
        year,
        salary: text === "" ? null : Number(text) * MAN,
        marginalRate: rate === "" ? null : Number(rate),
        homelessHouseholder: homeless === "" ? null : homeless === "yes",
        mortgageTier: tier === "" ? null : tier,
      },
      "저장했습니다.",
    );
  }

  const man = (won: number) => `${(won / MAN).toLocaleString("ko-KR")}만원`;

  return (
    <form onSubmit={onSubmit} className="flex flex-col gap-3 rounded-lg border border-line p-4 text-[13px]">
      <div className="grid gap-3 sm:grid-cols-2">
        <label htmlFor={`${uid}-salary`} className="flex flex-col gap-1">
          <span className="font-medium">연봉(총급여)</span>
          <span className="flex items-center gap-2">
            <input
              id={`${uid}-salary`}
              inputMode="numeric"
              autoComplete="off"
              placeholder="예: 5000"
              value={salary}
              onChange={(event) => setSalary(event.target.value)}
              className={`${INPUT} w-32 text-right tabular-nums`}
            />
            <span className="text-muted">만원</span>
          </span>
          <span className="text-xs text-muted">공제율 · 자격 구간과 카드 문턱(25%)에 쓴다. 세전 · 비과세 제외.</span>
        </label>

        <label htmlFor={`${uid}-rate`} className="flex flex-col gap-1">
          <span className="font-medium">한계세율</span>
          <select id={`${uid}-rate`} value={rate} onChange={(event) => setRate(event.target.value)} className={`${INPUT} w-32`}>
            <option value="">모름</option>
            {brackets.map((bracket) => (
              <option key={bracket.pct} value={bracket.pct}>
                {bracket.pct}%
              </option>
            ))}
          </select>
          <span className="text-xs text-muted">청약 · 주택대출 같은 소득공제의 효과 계산에만 쓴다.</span>
        </label>

        <label htmlFor={`${uid}-homeless`} className="flex flex-col gap-1">
          <span className="font-medium">무주택 세대주</span>
          <select
            id={`${uid}-homeless`}
            value={homeless}
            onChange={(event) => setHomeless(event.target.value)}
            className={`${INPUT} w-32`}
          >
            <option value="">미응답</option>
            <option value="yes">예</option>
            <option value="no">아니오</option>
          </select>
          <span className="text-xs text-muted">주택청약 · 전세대출 · 월세 공제 자격.</span>
        </label>

        <label htmlFor={`${uid}-tier`} className="flex flex-col gap-1">
          <span className="font-medium">주택담보대출 이자 공제 한도</span>
          <select id={`${uid}-tier`} value={tier} onChange={(event) => setTier(event.target.value)} className={INPUT}>
            <option value="">미응답</option>
            <option value="none">해당 없음</option>
            {tiers.map((option) => (
              <option key={option.key} value={option.key}>
                {option.label}
              </option>
            ))}
          </select>
          <span className="text-xs text-muted">대출 계약의 상환 기간 · 방식으로 정해진다.</span>
        </label>
      </div>

      <details className="text-xs text-muted">
        <summary className="cursor-pointer select-none">한계세율 고르는 법</summary>
        <div className="mt-2 flex flex-col gap-2">
          <p>
            작년 <strong className="font-medium text-fg">근로소득 원천징수영수증의 과세표준</strong>이 아래 어느 구간인지
            보면 됩니다(홈택스 → 지급명세서 조회). 올해 연봉이 크게 바뀌었으면 한 구간 위아래를 생각해 주세요.
          </p>
          <table className="w-full max-w-sm border-collapse">
            <thead>
              <tr className="border-b border-line text-left">
                <th scope="col" className="py-1 font-medium">과세표준</th>
                <th scope="col" className="py-1 text-right font-medium">세율</th>
              </tr>
            </thead>
            <tbody>
              {brackets.map((bracket, index) => {
                const from = index === 0 ? null : brackets[index - 1].upTo;
                const range =
                  from === null
                    ? `${man(bracket.upTo ?? 0)} 이하`
                    : bracket.upTo === null
                      ? `${man(from)} 초과`
                      : `${man(from)} 초과 ~ ${man(bracket.upTo)}`;
                return (
                  <tr key={bracket.pct} className="border-b border-line last:border-0">
                    <td className="py-1 tabular-nums">{range}</td>
                    <td className="py-1 text-right tabular-nums">{bracket.pct}%</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </details>

      <div className="flex items-center gap-3">
        <button type="submit" disabled={busy} className={BUTTON}>
          {busy ? "저장 중…" : "저장"}
        </button>
        <StatusLine status={status} />
      </div>
    </form>
  );
}

// ── 묶음 연결 ─────────────────────────────────────────────────────────────

export type DeductionOption = { key: string; label: string };

type Group = { category: string; item: string };

/** 후보 · 그 밖의 묶음: 공제 항목을 골라 연결하거나 "공제 아님" 으로 표시. */
export function ConnectControls({
  group,
  suggested,
  options,
}: {
  group: Group;
  suggested: string | null;
  options: DeductionOption[];
}) {
  const uid = useId();
  const { status, send, busy } = useSender();
  const [choice, setChoice] = useState(suggested ?? "");

  return (
    <div className="flex flex-col gap-1">
      <div className="flex flex-wrap items-center gap-2">
        <label htmlFor={`${uid}-deduction`} className="sr-only">
          공제 항목
        </label>
        <select
          id={`${uid}-deduction`}
          value={choice}
          onChange={(event) => setChoice(event.target.value)}
          className={INPUT}
        >
          <option value="">공제 항목 고르기</option>
          {options.map((option) => (
            <option key={option.key} value={option.key}>
              {option.label}
            </option>
          ))}
        </select>
        <button
          type="button"
          disabled={busy || choice === ""}
          onClick={() => send("/api/tax/tags", { action: "set", ...group, deduction: choice }, "연결했습니다.")}
          className={BUTTON}
        >
          연결
        </button>
        <button
          type="button"
          disabled={busy}
          onClick={() => send("/api/tax/tags", { action: "set", ...group, deduction: "none" }, "공제 아님으로 표시했습니다.")}
          className={QUIET_BUTTON}
        >
          공제 아님
        </button>
      </div>
      <StatusLine status={status} />
    </div>
  );
}

/** 연결 해제 · "공제 아님" 되돌리기. 둘 다 연결 행을 지운다. */
export function UnlinkButton({ group, label }: { group: Group; label: string }) {
  const { status, send, busy } = useSender();
  return (
    <span className="inline-flex items-center gap-2">
      <button
        type="button"
        disabled={busy}
        onClick={() => send("/api/tax/tags", { action: "delete", ...group }, "해제했습니다.")}
        className={QUIET_BUTTON}
      >
        {label}
      </button>
      <StatusLine status={status} />
    </span>
  );
}
