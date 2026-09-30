// /report 의 '미분류' 섹션(2026-09 사용자 요청: "분류 정리 탭이 괜히 더 복잡하게 만드는 것
// 같아. 무효처리 섹션처럼 월별 현금 흐름 밑에 미분류 섹션에서 해당 월에 대한 미분류 처리를
// 바로할 수 있게해줘").
//
// 2026-09(사용자 요청: "적요나 메모로 겹쳐도 항목으로 합산하지 않는 것으로 변경. 개별항목 모두
// 보여지게. n건 표시는 이제 제거"): 묶음이 아니라 **미분류 거래 한 건이 한 줄**이다. 줄마다
// /classify 와 같은 조각(GroupForm)을 '거래 한 건 모드'(`txn`)로 그린다.
//
// 쓰기 경로는 그대로 `/api/classify` 하나뿐이다. 요청에는 그 거래가 속한 묶음(달 · 계좌 ·
// 적요 · 메모 · 방향)이 가고, '이번만' 이면 거래 id 가 하나 더 간다 — 서버가 묶음을 다시 찾고
// 그 id 가 그 안에 있을 때만 그 한 건을 바꾼다(lib/classify/manual.mjs 의 `txn`). '앞으로도' 는
// 예전처럼 같은 적요(메모) · 같은 방향의 거래 전부에 걸린다. 적용하면 GroupForm 이 그 줄을
// 바로 접고(낙관적) `router.refresh()` 로 이 페이지 전체를 다시 그린다 — 위 현금흐름표의
// 합계도 함께 바뀐다.
//
// 보이는 것: 계좌 별칭 · 날짜(M/D) · 방향 · 적요 · 메모 · 금액. 거래 시각 · 잔액 · 계좌번호는
// 없다. 건수는 그리지 않는다. 이 파일에는 console 호출이 없다.
import { groupsByAccount } from "../classify/account-label";
import { GroupForm, type ClassifyGroup } from "../classify/forms";

import { UNCLASSIFIED_ANCHOR } from "./report-view";

/** 미분류 거래 한 건(lib/classify/manual.mjs 의 unclassifiedRows). */
export type UnclassifiedRow = {
  id: string;
  day: string | null;
  account: ClassifyGroup["account"];
  key: string;
  memo: string | null;
  direction: ClassifyGroup["direction"];
  amount: number;
  transfer: boolean;
};

/** 거래 한 건 -> GroupForm 이 받는 묶음 모양(한 건짜리 미분류 묶음). */
function asGroup(row: UnclassifiedRow): ClassifyGroup {
  return {
    account: row.account,
    key: row.key,
    memo: row.memo,
    direction: row.direction,
    count: 1,
    total: row.amount,
    unclassified: 1,
    transferIn: 0,
    vault: 0,
    transfer: row.transfer ? 1 : 0,
    manual: 0,
    mixed: false,
    category: null,
    item: null,
    mixedItem: false,
    source: null,
  };
}

export function UnclassifiedSection({
  month,
  rows,
  categories,
}: {
  month: string;
  rows: UnclassifiedRow[];
  categories: string[];
}) {
  return (
    <section
      id={UNCLASSIFIED_ANCHOR}
      aria-labelledby="unclassified-title"
      data-testid="unclassified-section"
      className="flex scroll-mt-4 flex-col gap-3"
    >
      <h2 id="unclassified-title" className="flex items-center gap-2 text-[13px] font-semibold text-fg">
        미분류
        {rows.length === 0 ? (
          <span
            data-testid="unclassified-none"
            className="rounded border border-ok-line bg-ok-bg px-1.5 text-xs font-medium text-ok"
          >
            없음
          </span>
        ) : null}
      </h2>
      {rows.length === 0 ? null : (
        <div className="flex flex-col gap-4">
          {groupsByAccount(rows).map((section) => (
            <section
              key={section.id}
              aria-label={`${section.label} 미분류`}
              data-testid="unclassified-account"
              className="flex flex-col gap-2"
            >
              <h3 className="text-xs font-medium text-muted">{section.label}</h3>
              <ul className="flex flex-col gap-2">
                {section.groups.map((row) => (
                  <li key={row.id} data-testid="unclassified-row">
                    <GroupForm
                      month={month}
                      group={asGroup(row)}
                      categories={categories}
                      hideOnApply
                      txn={row.id}
                      day={row.day}
                    />
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
