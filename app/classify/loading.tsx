import { Bar, LoadingShell } from "../_ui/skeleton";

// /classify 를 읽는 동안의 뼈대. 데이터 없음.
export default function Loading() {
  return (
    <LoadingShell title="분류 규칙" width="max-w-3xl">
      <Bar className="h-8 w-full" />
      <div className="flex flex-col gap-3">
        {Array.from({ length: 3 }, (_, index) => (
          <Bar key={index} className="h-16 w-full" />
        ))}
      </div>
      <Bar className="h-8 w-40" />
      <div className="flex flex-col gap-3">
        {Array.from({ length: 3 }, (_, index) => (
          <Bar key={index} className="h-32 w-full" />
        ))}
      </div>
    </LoadingShell>
  );
}
