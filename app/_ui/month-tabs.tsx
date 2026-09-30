"use client";

// 조회 월 탭(2026-09 사용자 요청: "월별현금흐름 조회를 월별 드롭다운이 아니라 탭으로 바꾸자").
//
// 링크 목록이다 — 탭을 누르면 `?month=YYYY-MM` 주소로 간다(예전 드롭다운과 같은 주소라
// 북마크 · 다른 화면의 링크가 그대로 동작한다). 지금 달은 aria-current="page".
//
//   - 달은 **오래된 달 → 최근 달** 순으로 왼쪽에서 오른쪽으로 놓고, 해가 바뀌는 자리에
//     연도 머리를 단다(탭 글자는 `9월` 처럼 짧게).
//   - 탭 줄은 자기 상자 안에서만 가로로 밀린다(좁은 화면에서 페이지가 넘치지 않게).
//     처음 그릴 때 지금 달 탭이 보이도록 그 줄만 밀어 둔다.
//   - 키보드: Tab 으로 탭마다 옮겨 갈 수 있고, 탭 줄 안에서 ← → Home End 로도 옮긴다.
//
// 데이터는 달 이름뿐이다(거래 · 금액 없음).
import Link from "next/link";
import { useEffect, useRef, type KeyboardEvent } from "react";

function byYear(months: string[]): Array<{ year: string; months: string[] }> {
  const sorted = [...new Set(months)].sort();
  const years: Array<{ year: string; months: string[] }> = [];
  for (const month of sorted) {
    const year = month.slice(0, 4);
    const last = years[years.length - 1];
    if (last !== undefined && last.year === year) last.months.push(month);
    else years.push({ year, months: [month] });
  }
  return years;
}

export function MonthTabs({
  months,
  selected,
  basePath,
  label = "조회 월",
}: {
  /** `YYYY-MM` 목록. 순서는 상관없다. */
  months: string[];
  selected: string;
  /** 탭이 가리킬 화면(예: `/report`). */
  basePath: string;
  label?: string;
}) {
  const stripRef = useRef<HTMLDivElement>(null);
  // 거래가 없는 달을 주소로 직접 물었으면 그 달도 탭으로 남긴다(화면과 주소가 어긋나지 않게).
  const years = byYear(months.includes(selected) ? months : [...months, selected]);

  useEffect(() => {
    const strip = stripRef.current;
    const current = strip?.querySelector<HTMLElement>('[aria-current="page"]');
    if (strip == null || current == null) return;
    // 탭 줄만 민다(scrollIntoView 는 페이지 세로 위치까지 건드릴 수 있어 쓰지 않는다).
    const left = current.offsetLeft - strip.clientWidth + current.offsetWidth + 24;
    strip.scrollLeft = Math.max(0, left);
  }, [selected]);

  function onKeyDown(event: KeyboardEvent<HTMLElement>) {
    const keys = ["ArrowLeft", "ArrowRight", "Home", "End"];
    if (!keys.includes(event.key)) return;
    const links = [...(stripRef.current?.querySelectorAll<HTMLAnchorElement>("a[data-month]") ?? [])];
    const index = links.findIndex((link) => link === document.activeElement);
    if (index === -1) return;
    event.preventDefault();
    const next =
      event.key === "Home"
        ? 0
        : event.key === "End"
          ? links.length - 1
          : Math.min(links.length - 1, Math.max(0, index + (event.key === "ArrowRight" ? 1 : -1)));
    links[next]?.focus();
  }

  return (
    <nav aria-label={label} className="min-w-0" onKeyDown={onKeyDown}>
      <div
        ref={stripRef}
        data-testid="month-tabs"
        className="relative overflow-x-auto border-b border-line [scrollbar-width:thin]"
      >
        <ul className="flex w-max items-end gap-3 pr-1">
          {years.map((group) => (
            <li key={group.year} className="flex items-end gap-0.5">
              <span
                aria-hidden
                className="mr-1 self-center text-xs font-medium tabular-nums text-faint"
              >
                {group.year}
              </span>
              <ul aria-label={`${group.year}년`} className="flex items-end gap-0.5">
                {group.months.map((month) => {
                  const current = month === selected;
                  return (
                    <li key={month}>
                      <Link
                        href={`${basePath}?month=${month}`}
                        data-month={month}
                        aria-current={current ? "page" : undefined}
                        aria-label={`${group.year}년 ${Number(month.slice(5))}월`}
                        className={`-mb-px block border-b-2 px-2.5 py-1.5 text-[13px] whitespace-nowrap tabular-nums focus-visible:outline-2 focus-visible:outline-accent ${
                          current
                            ? "border-fg font-semibold text-fg"
                            : "border-transparent text-muted hover:border-line-strong hover:text-fg"
                        }`}
                      >
                        {Number(month.slice(5))}월
                      </Link>
                    </li>
                  );
                })}
              </ul>
            </li>
          ))}
        </ul>
      </div>
    </nav>
  );
}
