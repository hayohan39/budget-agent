import type { Metadata } from "next";
import "./globals.css";

import { SiteNav } from "./_ui/site-nav";

export const metadata: Metadata = {
  title: "가계부",
  description: "월별 현금흐름 가계부",
};

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html lang="ko" className="h-full antialiased">
      <body className="flex min-h-full flex-col">
        <SiteNav />
        {children}
      </body>
    </html>
  );
}
