// 2026년 귀속(2027년 1월 연말정산) 공제 규칙 — 공제 트래커가 쓰는 부분만.
//
// ── 출처와 확인 상태 ────────────────────────────────────────────────────────
//
// docs/year-end-tax-guide.md 와 같은 숫자다. 한쪽을 고치면 같은 PR 에서 다른 쪽도 고친다.
// 근거: 소득세법 제52조(특별소득공제 — 주택자금) · 제59조의3(연금계좌 · 특별세액공제),
// 조세특례제한법 제87조(주택청약종합저축) · 제95조의2(월세) · 제126조의2(신용카드 등) ·
// 제132조의2(소득공제 종합한도), 소득세법 제59조의4 · 조특법 제76조 · 제58조(기부금).
//
// 2026-11 작성 시점에 국세청 · 법령 사이트를 직접 확인하지 못하고 보도로 교차 확인했다.
// ⚠️ 표시는 2026년 귀속 개정이 보도되었지만 이 파일에는 **현행 값**을 쓴 항목이다(사용자 결정
// 2026-11: 확정 전까지 현행 값). 국세청 「2026년 귀속 연말정산 신고안내」(2027년 1월)로 확인한다.
//
// ── 단위 ────────────────────────────────────────────────────────────────────
//
// 금액은 모두 원(정수). 비율은 백분율 정수(15 = 15%). 부동소수점 곱셈을 피하려고
// 엔진은 `금액 × 백분율 / 100` 을 정수 나눗셈으로 계산한다.

export default Object.freeze({
  year: 2026,

  /** 지방소득세 = 소득세의 10%. 공제 효과에 더한다. */
  localTaxPct: 10,

  /**
   * 사용자가 고르는 한계세율(기본세율 구간). 엔진은 추정하지 않는다(사용자 결정 2026-11).
   * 소득공제 항목의 효과 = 공제액 × 한계세율.
   */
  marginalRates: Object.freeze([6, 15, 24, 35, 38, 40, 42, 45]),

  /** 연금계좌 세액공제. 연금저축 단독 600만, IRP 와 합산 900만. */
  pension: Object.freeze({
    savingsLimit: 6_000_000,
    totalLimit: 9_000_000,
    /** 총급여 이 금액 이하면 highPct, 넘으면 lowPct. */
    salaryThreshold: 55_000_000,
    highPct: 15,
    lowPct: 12,
  }),

  /** 주택청약종합저축 소득공제. 총급여 7천만 이하 무주택 세대주. */
  housingSubscription: Object.freeze({
    paymentLimit: 3_000_000,
    pct: 40,
    salaryMax: 70_000_000,
  }),

  /** 주택임차차입금(전세자금대출) 원리금 상환액 소득공제. 무주택 세대주. */
  leaseLoan: Object.freeze({
    pct: 40,
    /** 주택청약 공제액과 합쳐서 이 금액까지(공제액 기준). */
    combinedLimit: 4_000_000,
  }),

  /**
   * 장기주택저당차입금 이자상환액 소득공제. 한도는 상환 기간 · 방식에 따른 구간이고,
   * 주택청약 · 주택임차차입금 공제액과 합산해서 적용한다. 사용자가 구간을 고른다.
   */
  mortgageInterest: Object.freeze({
    tiers: Object.freeze({
      '20m': Object.freeze({ limit: 20_000_000, label: '15년 이상 · 고정금리이면서 비거치식' }),
      '18m': Object.freeze({ limit: 18_000_000, label: '15년 이상 · 고정금리 또는 비거치식' }),
      '8m': Object.freeze({ limit: 8_000_000, label: '15년 이상 · 그 밖의 대출' }),
      '6m': Object.freeze({ limit: 6_000_000, label: '10년 이상 · 고정금리 또는 비거치식' }),
    }),
  }),

  /**
   * 월세 세액공제. 무주택 세대주, 총급여 8천만 이하.
   * ⚠️ 2026년 귀속 한도 · 대상 변경 보도 — 현행 값.
   */
  rent: Object.freeze({
    limit: 10_000_000,
    tiers: Object.freeze([
      Object.freeze({ salaryMax: 55_000_000, pct: 17 }),
      Object.freeze({ salaryMax: 80_000_000, pct: 15 }),
    ]),
  }),

  /** 보장성 보험료 세액공제. */
  insurance: Object.freeze({ limit: 1_000_000, pct: 12 }),

  /** 기부금 세액공제. 소득금액 대비 한도는 다루지 않는다(엔진이 메모로 안내). */
  donation: Object.freeze({
    /** 정치자금 · 고향사랑기부금: 각각 10만원까지 100/110, 넘는 금액 15%. ⚠️ 고향사랑 구간 변경 여부 확인. */
    fullCreditMax: 100_000,
    overPct: 15,
    /** 고향사랑기부금 연간 기부 한도. */
    hometownAnnualLimit: 20_000_000,
    /** 일반 기부금: 1천만원 이하 15%, 넘는 금액 30%. */
    generalThreshold: 10_000_000,
    generalLowPct: 15,
    generalHighPct: 30,
  }),

  /**
   * 신용카드 등 사용금액 소득공제.
   * ⚠️ 2026년 사용분 자녀 추가 한도는 자녀 정보를 받지 않아 넣지 않는다(설계 결정).
   */
  card: Object.freeze({
    /** 최저사용금액(문턱) = 총급여 × 25%. */
    thresholdPct: 25,
    /** 결제수단별 공제율. 문턱은 공제율이 낮은 사용분부터 채운다. */
    pct: Object.freeze({ credit: 15, debit: 30, culture: 30, market: 40, transit: 40 }),
    /** 도서 · 공연 · 체육시설 등(culture) 30% 는 총급여 이 금액 이하만. 넘으면 신용카드로 본다. */
    cultureSalaryMax: 70_000_000,
    /** 기본 공제한도. */
    baseLimit: Object.freeze([
      Object.freeze({ salaryMax: 70_000_000, limit: 3_000_000 }),
      Object.freeze({ salaryMax: Number.POSITIVE_INFINITY, limit: 2_500_000 }),
    ]),
    /** 추가 공제한도(전통시장 · 대중교통 · 문화체육). 7천만 초과면 문화체육 제외. */
    extraLimit: Object.freeze([
      Object.freeze({ salaryMax: 70_000_000, limit: 3_000_000 }),
      Object.freeze({ salaryMax: Number.POSITIVE_INFINITY, limit: 2_000_000 }),
    ]),
  }),

  /** 소득공제 종합한도: 주택자금 · 주택청약 · 신용카드 등 공제액 합계. */
  incomeDeductionCap: 25_000_000,
});
