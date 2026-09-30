// /report 의 '미분류' 섹션(2026-09 사용자 요청: "분류 정리 탭이 괜히 더 복잡하게 만드는 것
// 같아. 무효처리 섹션처럼 월별 현금 흐름 밑에 미분류 섹션에서 해당 월에 대한 미분류 처리를
// 바로할 수 있게해줘").
//
// 그 달의 미분류 묶음을 /classify 와 **같은 조각**(GroupForm)으로 그린다. 쓰기 경로도 같다 —
// `/api/classify` 하나뿐이고, 서버가 달 · 계좌 · 적요 · 메모 · 방향으로 묶음을 다시 찾아
// 검사한다(lib/classify/manual.mjs). 여기서 새로 여는 쓰기 경로는 없다. 적용하면
// GroupForm 이 묶음을 바로 접고(낙관적) `router.refresh()` 로 이 페이지 전체를 다시
// 그린다 — 위 현금흐름표의 합계도 함께 바뀐다.
//
// 보이는 것은 /classify 와 같다: (계좌 별칭, 적요, 메모, 방향)별 건수 · 합계. 거래 일시 ·
// 잔액 · 계좌번호는 없다. 이 파일에는 console 호출이 없다.
import { groupsByAccount } from "../classify/account-label";
import { GroupForm, type ClassifyGroup } from "../classify/forms";

import { UNCLASSIFIED_ANCHOR } from "./report-view";

export function UnclassifiedSection({
  month,
  groups,
  categories,
}: {
  month: string;
  groups: ClassifyGroup[];
  categories: string[];
}) {
  const count = groups.reduce((sum, group) => sum + group.unclassified, 0);
  return (
    <section
      id={UNCLASSIFIED_ANCHOR}
      aria-labelledby="unclassified-title"
      data-testid="unclassified-section"
      className="flex scroll-mt-4 flex-col gap-3"
    >
      <h2 id="unclassified-title" className="flex items-center gap-2 text-[13px] font-semibold text-fg">
        미분류
        <span
          data-testid="unclassified-count"
          className={`rounded border px-1.5 text-xs font-medium tabular-nums ${
            count > 0 ? "border-warn-line bg-warn-bg text-warn" : "border-ok-line bg-ok-bg text-ok"
          }`}
        >
          {count > 0 ? `${count}건` : "없음"}
        </span>
      </h2>
      {groups.length === 0 ? null : (
        <div className="flex flex-col gap-4">
          {groupsByAccount(groups).map((section) => (
            <section
              key={section.id}
              aria-label={`${section.label} 미분류`}
              data-testid="unclassified-account"
              className="flex flex-col gap-2"
            >
              <h3 className="text-xs font-medium text-muted">
                {section.label}
                <span className="ml-1.5 tabular-nums">{section.groups.length}</span>
              </h3>
              <ul className="flex flex-col gap-2">
                {section.groups.map((group) => (
                  <li key={`${section.id}\u001f${group.direction}\u001f${group.key}\u001f${group.memo ?? ""}`}>
                    <GroupForm month={month} group={group} categories={categories} hideOnApply />
                  </li>
                ))}
              </ul>
            </section>
          ))}
        </div>
      )}
    </section>
  );
}
