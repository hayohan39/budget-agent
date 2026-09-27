import { Bar, LoadingShell } from "../_ui/skeleton";

// /classify 를 읽는 동안의 뼈대. 데이터 없음.
export default function Loading() {
  return (
    <LoadingShell title="분류 정리" width="max-w-3xl">
      <Bar className="h-8 w-80" />
      <Bar className="h-16 w-full" />
      <div className="flex flex-col gap-3">
        {Array.from({ length: 4 }, (_, index) => (
          <Bar key={index} className="h-32 w-full" />
        ))}
      </div>
    </LoadingShell>
  );
}
