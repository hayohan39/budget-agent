"use client";

// 연말정산 탭의 하위 탭: 공제 트래커(/tax) · 가이드(/tax/guide). 링크뿐이라 데이터가 없다.
import Link from "next/link";
import { usePathname } from "next/navigation";

const TABS = [
  { href: "/tax", label: "공제 트래커" },
  { href: "/tax/guide", label: "가이드" },
] as const;

export function TaxTabs() {
  const pathname = usePathname() ?? "/tax";
  return (
    <nav aria-label="연말정산" className="inline-flex self-start rounded-md border border-line-strong p-0.5 text-xs">
      {TABS.map((tab) => {
        const current = pathname === tab.href;
        return (
          <Link
            key={tab.href}
            href={tab.href}
            aria-current={current ? "page" : undefined}
            className={`rounded px-2.5 py-1 ${
              current ? "bg-inverse font-medium text-on-inverse" : "text-muted hover:bg-hover hover:text-fg"
            }`}
          >
            {tab.label}
          </Link>
        );
      })}
    </nav>
  );
}
