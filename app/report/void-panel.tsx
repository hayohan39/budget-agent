"use client";

// /report 의 '무효 처리(상쇄)' — 출금됐다가 거부 · 반환되어 되돌아온 입금처럼 **둘 다 없던
// 일**로 볼 한 쌍을 사람이 고른다(2026-09 사용자 요청: "지현 IRP, 선용 IRP 의 경우 출금되었다가
// 거부되어서 다시 입금되는 경우 … 입출금 무효화 하고 싶어").
//
// 서버로 보내는 것은 거래 id 둘(또는 쌍 id)뿐이다. 계좌 · 금액 · 방향은 서버가 행을 잠근 뒤
// 다시 검사한다(lib/report/voids.mjs). 후보는 **제안**일 뿐이다 — 저절로 무효가 되는 거래는
// 없다. console 호출이 이 파일에 없다.
import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";

export type VoidLeg = {
  id: string;
  yearMonth: string;
  at: string;
  description: string;
  memo: string | null;
  amount: number;
};

export type VoidAccount = { role: string; nickname: string };

export type VoidedPair = { pairId: string; account: VoidAccount; out: VoidLeg; in: VoidLeg };

export type VoidCandidate = {
  account: VoidAccount;
  out: VoidLeg;
  in: VoidLeg;
  similar: boolean;
  outFirst: boolean;
  gapMinutes: number;
};

const FLOW = new Intl.NumberFormat("ko-KR", { signDisplay: "exceptZero" });
const BUTTON =
  "h-7 shrink-0 rounded-md border border-line-strong bg-canvas px-2 text-xs font-medium hover:bg-hover disabled:cursor-not-allowed disabled:opacity-50";

function Leg({ leg, struck = false }: { leg: VoidLeg; struck?: boolean }) {
  return (
    <span className={`block ${struck ? "text-faint line-through" : ""}`}>
      <span className="tabular-nums text-muted">{leg.at}</span> {leg.description || "(적요 없음)"}{" "}
      <span className="tabular-nums">{FLOW.format(leg.amount)}원</span>
      {leg.memo !== null ? <span className="block text-xs text-faint no-underline">메모: {leg.memo}</span> : null}
    </span>
  );
}

async function post(body: unknown): Promise<{ ok: boolean; message: string }> {
  try {
    const response = await fetch("/api/report/voids", {
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
    const ok = response.ok && data.ok === true;
    return { ok, message: typeof data.message === "string" ? data.message : ok ? "" : "저장하지 못했습니다." };
  } catch {
    return { ok: false, message: "서버에 연결하지 못했습니다." };
  }
}

export function VoidPanel({
  yearMonth,
  voided,
  candidates,
}: {
  yearMonth: string;
  voided: VoidedPair[];
  candidates: VoidCandidate[];
}) {
  const router = useRouter();
  const [, startTransition] = useTransition();
  const [busy, setBusy] = useState<string | null>(null);
  const [message, setMessage] = useState<{ kind: "done" | "error"; text: string } | null>(null);

  async function run(id: string, body: unknown, done: string) {
    setBusy(id);
    setMessage(null);
    const outcome = await post(body);
    setBusy(null);
    if (!outcome.ok) {
      setMessage({ kind: "error", text: outcome.message });
      return;
    }
    setMessage({ kind: "done", text: done });
    startTransition(() => router.refresh());
  }

  return (
    <section className="flex flex-col gap-3" data-testid="void-panel" aria-labelledby="void-title">
      <h2 id="void-title" className="text-[13px] font-semibold text-fg">
        무효 처리(상쇄)
      </h2>
      <p className="text-xs text-muted">
        출금됐다가 거부 · 반환되어 같은 금액이 다시 들어온 경우처럼, 두 거래를 <strong>없던 일</strong>로 볼 수
        있습니다. 무효로 표시한 두 거래는 수입 · 지출 · 미분류 · 통계에서 빠지고 여기에만 남습니다(언제든 해제).
        같은 계좌 · 같은 금액 · 반대 방향의 거래만 짝지을 수 있고, 저절로 무효가 되는 거래는 없습니다.
      </p>
      {message !== null ? (
        <p
          role={message.kind === "error" ? "alert" : "status"}
          className={`text-xs ${message.kind === "error" ? "text-danger" : "text-ok"}`}
        >
          {message.text}
        </p>
      ) : null}

      {voided.length > 0 ? (
        <ul className="flex flex-col gap-2" data-testid="voided-list">
          {voided.map((pair) => (
            <li
              key={pair.pairId}
              data-testid="voided-pair"
              className="flex flex-wrap items-start justify-between gap-2 rounded-lg border border-dashed border-line-strong p-2.5 text-[13px]"
            >
              <div className="min-w-0 flex-1">
                <span className="mr-2 text-xs text-muted">{pair.account.nickname} · 무효</span>
                <Leg leg={pair.out} struck />
                <Leg leg={pair.in} struck />
              </div>
              <button
                type="button"
                className={BUTTON}
                disabled={busy !== null}
                onClick={() => run(`un-${pair.pairId}`, { action: "unvoid", pairId: pair.pairId }, "무효 처리를 해제했습니다.")}
              >
                {busy === `un-${pair.pairId}` ? "해제하는 중…" : "해제"}
              </button>
            </li>
          ))}
        </ul>
      ) : null}

      <h3 className="text-xs font-medium text-muted">
        {yearMonth} 후보 — 같은 날(한국 시각) 같은 계좌에서 금액이 같고 방향이 반대인 두 거래
      </h3>
      {candidates.length === 0 ? (
        <p className="text-xs text-muted">후보가 없습니다.</p>
      ) : (
        <ul className="flex flex-col gap-2" data-testid="void-candidates">
          {candidates.map((candidate) => {
            const id = `${candidate.out.id}-${candidate.in.id}`;
            return (
              <li
                key={id}
                data-testid="void-candidate"
                className="flex flex-wrap items-start justify-between gap-2 rounded-lg border border-line p-2.5 text-[13px]"
              >
                <div className="min-w-0 flex-1">
                  <span className="mr-2 text-xs text-muted">
                    {candidate.account.nickname}
                    {candidate.similar ? " · 적요/메모 같음" : ""}
                    {candidate.outFirst ? "" : " · 입금이 먼저"} · {candidate.gapMinutes}분 차이
                  </span>
                  <Leg leg={candidate.out} />
                  <Leg leg={candidate.in} />
                </div>
                <button
                  type="button"
                  className={BUTTON}
                  disabled={busy !== null}
                  onClick={() =>
                    run(id, { action: "void", outId: candidate.out.id, inId: candidate.in.id }, "무효 처리했습니다.")
                  }
                >
                  {busy === id ? "처리하는 중…" : "무효 처리"}
                </button>
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}
