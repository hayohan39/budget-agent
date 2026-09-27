// 로딩 뼈대(loading.tsx 들이 쓴다). 데이터는 하나도 들어가지 않는다 — 회색 막대뿐이다.
// 서버 컴포넌트가 DB 를 읽는 동안 이 뼈대가 먼저 그려져, 달 · 기간을 바꾸거나
// 링크를 눌렀을 때 화면이 멈춘 것처럼 보이지 않게 한다.

export function Bar({ className = "" }: { className?: string }) {
  return <div aria-hidden className={`animate-pulse rounded bg-zinc-200 dark:bg-zinc-800 ${className}`} />;
}

export function LoadingShell({
  title,
  width = "max-w-5xl",
  children,
}: {
  title: string;
  width?: string;
  children: React.ReactNode;
}) {
  return (
    <main className={`mx-auto flex w-full ${width} flex-1 flex-col gap-6 p-8`} aria-busy="true">
      <div className="flex items-baseline justify-between">
        <h1 className="text-2xl font-semibold tracking-tight">{title}</h1>
        <Bar className="h-4 w-24" />
      </div>
      <p role="status" className="sr-only">
        불러오는 중…
      </p>
      {children}
    </main>
  );
}
