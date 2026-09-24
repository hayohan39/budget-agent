"use client";

// 업로드 폼. 상태가 필요해서 클라이언트 컴포넌트다.
//
// 여기에는 보안 판단이 없다 — 인증 · 권한 · 크기 제한은 전부 서버(route.ts)가
// 한다. 이 파일의 상한 값은 사용자가 고르기 전에 미리 알려 주기 위한 것일 뿐,
// 방어선이 아니다.
//
// 서버가 돌려주는 결과에는 거래 내용이 들어 있지 않다. 그래서 이 화면이 보여
// 줄 수 있는 것도 파일명 · 계좌 별명 · 조회기간 · 건수 · 경고뿐이다.
import { useState } from "react";

const FILE_FIELD = "files";
const MAX_FILE_COUNT = 3;

/**
 * 경고 코드 -> 사람이 읽는 문장. 서버는 코드만 보낸다.
 *
 * 앞 6개는 파싱 단계(lib/import/statement.mjs 의 collectWarnings)에서,
 * 뒤 2개는 분류 단계에서 나온다. 문장에는 거래 내용이 들어가지 않는다 —
 * 서버가 코드만 보내므로 여기서 지어낼 수 있는 것도 일반적인 설명뿐이다.
 */
const WARNING_TEXT: Record<string, string> = {
  truncationSuspected: "표시 상한에 걸려 뒷부분이 잘렸을 수 있습니다",
  timestampTies: "같은 시각에 여러 건이 있습니다",
  orderUnsorted: "행이 시간 순서대로 정렬되어 있지 않습니다",
  balanceMissing: "거래 후 잔액이 비어 있는 행이 있습니다",
  balanceMismatch: "잔액 검산이 맞지 않는 구간이 있습니다",
  jointAccount: "모임통장입니다",
  // 규칙을 읽지 못해 이 파일은 통째로 미분류로 저장됐다. 거래는 들어갔다.
  classificationSkipped: "분류 규칙을 읽지 못해 미분류로 저장했습니다 (거래는 저장되었습니다)",
  // 규칙 중 일부가 정규식으로 컴파일되지 않아 그 규칙만 건너뛰었다.
  rulePatternSkipped: "사용할 수 없는 분류 규칙이 있어 그 규칙만 건너뛰었습니다",
  // 아래 5개는 lib/classify/pattern.mjs 가 규칙을 거부할 때 쓰는 코드다.
  // 지금 업로드 응답은 이것들을 rulePatternSkipped 하나로 묶어 보내지만,
  // 규칙별 사유를 내보내는 화면이 생기면 그대로 이 표를 쓴다.
  patternEmpty: "분류 규칙의 패턴이 비어 있습니다",
  patternTooLong: "분류 규칙의 패턴이 너무 깁니다",
  patternNestedQuantifier: "분류 규칙의 패턴이 위험한 형태(중첩 반복)라 쓰지 않았습니다",
  patternRepeatTooLarge: "분류 규칙의 패턴에 반복 횟수가 너무 큰 부분이 있습니다",
  patternInvalid: "분류 규칙의 패턴이 올바른 정규식이 아닙니다",
};

/** 표에 없는 코드도 빈칸 대신 읽을 수 있는 문장으로 내보낸다. */
function warningText(code: string): string {
  const known = WARNING_TEXT[code];
  if (known !== undefined) return known;
  // 서버는 위 코드들만 보낸다. 여기 오는 것은 배포 시점이 어긋난 경우뿐이라
  // 코드를 그대로 덧붙여 둔다(코드는 스키마의 식별자이지 거래 내용이 아니다).
  const label = code.trim().slice(0, 64);
  return label === "" ? "알 수 없는 경고입니다" : `알 수 없는 경고입니다 (${label})`;
}

type FileResult = {
  filename: string;
  ok: boolean;
  account?: { role: string; nickname: string };
  period?: { from: string; to: string };
  inserted?: number;
  skipped?: number;
  warnings?: string[];
  error?: string;
  message?: string;
};

export function ImportForm() {
  const [busy, setBusy] = useState(false);
  const [results, setResults] = useState<FileResult[] | null>(null);
  const [failure, setFailure] = useState<string | null>(null);

  async function onSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (busy) return;

    const form = event.currentTarget;
    const data = new FormData(form);
    if (data.getAll(FILE_FIELD).length === 0) {
      setFailure("올릴 파일을 선택해 주세요.");
      setResults(null);
      return;
    }

    setBusy(true);
    setFailure(null);
    setResults(null);
    try {
      const response = await fetch("/api/import", { method: "POST", body: data });
      const payload: unknown = await response.json().catch(() => null);

      if (!response.ok) {
        const message =
          payload !== null && typeof payload === "object" && "error" in payload
            ? String((payload as { error: unknown }).error)
            : "업로드에 실패했습니다.";
        setFailure(message);
        return;
      }

      const list =
        payload !== null && typeof payload === "object" && "results" in payload
          ? (payload as { results: FileResult[] }).results
          : [];
      setResults(list);
      form.reset();
    } catch {
      // 네트워크 오류. 원인 객체는 화면에도 콘솔에도 내보내지 않는다.
      setFailure("서버에 연결하지 못했습니다. 잠시 후 다시 시도해 주세요.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="flex flex-col gap-6">
      <form onSubmit={onSubmit} className="flex flex-col items-start gap-4">
        <input
          type="file"
          name={FILE_FIELD}
          accept=".xlsx,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
          multiple
          disabled={busy}
          className="text-sm file:mr-3 file:rounded-md file:border file:border-zinc-300 file:bg-transparent file:px-3 file:py-2 file:text-sm dark:file:border-zinc-700"
        />
        <button
          type="submit"
          disabled={busy}
          className="rounded-md bg-zinc-900 px-4 py-2 text-sm font-medium text-white hover:bg-zinc-700 disabled:opacity-50 dark:bg-zinc-100 dark:text-zinc-900 dark:hover:bg-zinc-300"
        >
          {busy ? "올리는 중…" : "올리기"}
        </button>
        <p className="text-xs text-zinc-500 dark:text-zinc-500">
          최대 {MAX_FILE_COUNT}개, 한 파일당 4MB 까지.
        </p>
      </form>

      {failure !== null ? (
        <p role="alert" className="text-sm text-red-600">
          {failure}
        </p>
      ) : null}

      {results !== null ? (
        <section className="flex flex-col gap-3">
          <h2 className="text-sm font-medium text-zinc-700 dark:text-zinc-300">결과</h2>
          {results.length === 0 ? (
            <p className="text-sm text-zinc-500">처리된 파일이 없습니다.</p>
          ) : (
            <ul className="flex flex-col gap-3">
              {results.map((result, index) => (
                <li
                  key={`${result.filename}-${index}`}
                  className={`rounded-md border p-4 text-sm ${
                    result.ok
                      ? "border-zinc-300 dark:border-zinc-700"
                      : "border-red-400 bg-red-50 dark:bg-red-950/30"
                  }`}
                >
                  <p className="font-medium break-all">
                    {result.ok ? "성공" : "실패"} · {result.filename}
                  </p>
                  {result.ok ? (
                    <dl className="mt-2 grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-zinc-700 dark:text-zinc-300">
                      <dt className="text-zinc-500">계좌</dt>
                      <dd>{result.account?.nickname ?? "-"}</dd>
                      <dt className="text-zinc-500">조회기간</dt>
                      <dd>
                        {result.period ? `${result.period.from} ~ ${result.period.to}` : "-"}
                      </dd>
                      <dt className="text-zinc-500">신규</dt>
                      <dd>{result.inserted ?? 0}건</dd>
                      <dt className="text-zinc-500">중복</dt>
                      <dd>{result.skipped ?? 0}건</dd>
                      <dt className="text-zinc-500">경고</dt>
                      <dd>
                        {result.warnings && result.warnings.length > 0 ? (
                          <ul className="list-inside list-disc">
                            {result.warnings.map((code) => (
                              <li key={code}>{warningText(code)}</li>
                            ))}
                          </ul>
                        ) : (
                          "없음"
                        )}
                      </dd>
                    </dl>
                  ) : (
                    <p className="mt-2 text-red-700 dark:text-red-400">
                      {result.message ?? "처리하지 못했습니다."}
                    </p>
                  )}
                </li>
              ))}
            </ul>
          )}
        </section>
      ) : null}
    </div>
  );
}
