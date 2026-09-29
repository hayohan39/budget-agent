"use client";

// 모든 화면 우측 상단의 공통 페이지 네비게이션(app/layout.tsx 가 한 번 그린다).
//
// 2026-09 사용자 요청: "우측상단 페이지 네비게이션에 모든 페이지 항상 다 보여지게 해줘.
// 예를들어 월별현금흐름에서는 분류정리 페이지 네비게이션이 우측상단에 없어."
// 예전에는 페이지마다 링크 몇 개를 제각각 골라 두었다. 이제 모든 페이지를 같은 순서로
// 늘 보여 주고, 지금 페이지는 aria-current="page" 로 표시한다.
//
// 링크 목록뿐이라 데이터는 없다. 인증은 이 컴포넌트와 상관없다 — middleware 와 각
// 페이지의 검사가 그대로 막는다. 로그인 화면(/signin)에서는 그리지 않는다.
import Link from "next/link";
import { usePathname } from "next/navigation";

export const NAV_PAGES = [
  { href: "/", label: "홈" },
  { href: "/import", label: "거래내역 올리기" },
  { href: "/report", label: "월별 현금흐름" },
  { href: "/classify", label: "분류 정리" },
  { href: "/stats", label: "통계" },
] as const;

/** 로그인 전 화면. 여기서는 네비게이션을 그리지 않는다. */
const HIDDEN_ON = ["/signin"];

function isCurrent(pathname: string, href: string) {
  if (href === "/") return pathname === "/";
  return pathname === href || pathname.startsWith(`${href}/`);
}

export function SiteNav() {
  const pathname = usePathname() ?? "/";
  if (HIDDEN_ON.some((hidden) => isCurrent(pathname, hidden))) return null;

  return (
    <header className="border-b border-line">
      <div className="mx-auto flex w-full max-w-5xl items-center justify-between gap-4 px-4 py-2 sm:px-8">
        <span className="hidden text-[13px] font-semibold tracking-tight sm:block">가계부</span>
        <nav aria-label="페이지" className="min-w-0">
          <ul className="flex flex-wrap justify-end gap-x-0.5 gap-y-1 text-xs sm:gap-x-1 sm:text-[13px]">
            {NAV_PAGES.map((page) => {
              const current = isCurrent(pathname, page.href);
              return (
                <li key={page.href}>
                  <Link
                    href={page.href}
                    aria-current={current ? "page" : undefined}
                    className={`block rounded-md border px-1 py-1 leading-5 sm:px-2 ${
                      current
                        ? "border-line-strong bg-subtle font-medium text-fg"
                        : "border-transparent text-muted hover:bg-hover hover:text-fg"
                    }`}
                  >
                    {page.label}
                  </Link>
                </li>
              );
            })}
          </ul>
        </nav>
      </div>
    </header>
  );
}
