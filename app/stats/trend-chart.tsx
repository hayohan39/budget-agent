// 한 항목(수입 · 저축 · …)의 월별 막대 그래프. **서버에서 그리는 인라인 SVG** 다 —
// 차트 라이브러리를 들이지 않는다(CLAUDE.md: 의존성에 보수적으로).
//
// 설계(데이터 시각화 원칙):
//   - 항목마다 작은 그래프 하나(small multiples). 다섯 항목을 한 그래프에 겹치면
//     색 다섯 개 + 범례가 필요하고, 수입(수백만)과 주거비(수십만)가 한 축에서
//     눌린다. 두 번째 y 축은 쓰지 않는다.
//   - 한 그래프에 계열이 하나라 색은 한 가지(파랑)이고 범례 상자는 없다 — 제목이
//     무엇을 그렸는지 말한다. 색은 디자인 토큰 --chart(app/globals.css): 라이트 #3e63dd /
//     다크 #5b7cf0, 각 표면(#ffffff · #0f1012)에서 3:1 이상(dataviz 검증기 통과).
//     격자 · 축 · 글자도 토큰(--line · --control · --muted · --faint)을 쓴다.
//   - 막대는 24px 이하, 값 쪽 끝만 4px 둥글고 기준선 쪽은 각지다. 격자 · 축은 1px
//     실선의 옅은 회색. 글자는 막대 색을 쓰지 않는다(본문 · 보조 · 흐린 잉크).
//   - 값은 막대마다 적지 않는다. 머리에 최근 달 값과 전월 대비를 적고, 나머지는
//     y 축 눈금 · 마우스를 올리거나 키보드로 초점을 주면 뜨는 툴팁(<title>) ·
//     아래 표가 맡는다. 툴팁에만 있는 값은 없다(표가 전부 싣는다).
//   - 거래가 없는 달은 막대 없이 자리만 남기고 x 축 이름을 흐리게 한다(0원과
//     "자료 없음" 은 다르다).
//
// 받는 데이터는 달 이름과 합계뿐이다. 적요 · 계좌 · 행 단위 값은 없다.

const WON = new Intl.NumberFormat("ko-KR");
const SIGNED = new Intl.NumberFormat("ko-KR", { signDisplay: "exceptZero" });

export function won(value: number): string {
  return `${WON.format(value)}원`;
}

export type TrendBar = { yearMonth: string; value: number | null };

const WIDTH = 560;
const HEIGHT = 220;
const MARGIN = { top: 12, right: 12, bottom: 44, left: 100 };
const PLOT_W = WIDTH - MARGIN.left - MARGIN.right;
const PLOT_H = HEIGHT - MARGIN.top - MARGIN.bottom;

/** 1 · 2 · 2.5 · 5 × 10^n 중 가장 가까운 "깔끔한" 간격. */
function niceStep(range: number, target = 4): number {
  if (!(range > 0)) return 1;
  const raw = range / target;
  const power = 10 ** Math.floor(Math.log10(raw));
  for (const factor of [1, 2, 2.5, 5, 10]) {
    if (raw <= factor * power) return factor * power;
  }
  return 10 * power;
}

/** y 축 범위와 눈금. 늘 0 을 포함한다(막대는 0 에서 자란다). */
function scaleOf(values: number[]) {
  const max = Math.max(0, ...values);
  const min = Math.min(0, ...values);
  if (max === 0 && min === 0) {
    // 전부 0(또는 자료 없음) — 눈금은 0 하나뿐이고 기준선은 바닥에 둔다.
    const y = (value: number) => MARGIN.top + (1 - value) * PLOT_H;
    return { ticks: [0], y };
  }
  // 원 단위라 1원보다 잘게 나누지 않는다.
  const step = Math.max(1, niceStep(max - min));
  const top = Math.ceil(max / step) * step;
  const bottom = Math.floor(min / step) * step;
  const ticks: number[] = [];
  for (let tick = bottom; tick <= top + step / 2; tick += step) ticks.push(tick);
  const y = (value: number) => MARGIN.top + ((top - value) / (top - bottom)) * PLOT_H;
  return { ticks, y };
}

/** 값 쪽 끝만 둥근 막대. 기준선(y0) 쪽은 각지다. */
function barPath(x: number, width: number, y0: number, y1: number): string {
  const height = Math.abs(y1 - y0);
  const r = Math.min(4, width / 2, height);
  if (y1 <= y0) {
    // 위로 자라는 막대(양수)
    return `M${x},${y0} V${y1 + r} Q${x},${y1} ${x + r},${y1} H${x + width - r} Q${x + width},${y1} ${x + width},${y1 + r} V${y0} Z`;
  }
  // 아래로 자라는 막대(음수)
  return `M${x},${y0} V${y1 - r} Q${x},${y1} ${x + r},${y1} H${x + width - r} Q${x + width},${y1} ${x + width},${y1 - r} V${y0} Z`;
}

function monthLabel(yearMonth: string): { month: string; year: string } {
  const [year, month] = yearMonth.split("-");
  return { month: `${Number(month)}월`, year };
}

export function TrendChart({
  id,
  title,
  note,
  bars,
}: {
  id: string;
  title: string;
  note: string;
  bars: TrendBar[];
}) {
  const present = bars.filter((bar): bar is { yearMonth: string; value: number } => bar.value !== null);
  const { ticks, y } = scaleOf(present.map((bar) => bar.value));
  const band = PLOT_W / Math.max(bars.length, 1);
  const barWidth = Math.min(24, band * 0.6);
  const baseline = y(0);
  // 달이 많으면 x 축 이름을 건너뛴다(겹치지 않게). 첫 달 · 1월에는 연도를 붙인다.
  const every = bars.length > 12 ? 2 : 1;

  const latest = present[present.length - 1];
  const latestIndex = latest === undefined ? -1 : bars.indexOf(latest);
  const previous = latestIndex > 0 ? bars[latestIndex - 1] : undefined;
  const delta =
    latest !== undefined && previous !== undefined && previous.value !== null
      ? latest.value - previous.value
      : null;

  const titleId = `${id}-title`;
  const descId = `${id}-desc`;

  return (
    <figure className="flex min-w-0 flex-col rounded-lg border border-line bg-canvas">
      <figcaption className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1 border-b border-line px-3 py-2">
        <span id={titleId} className="text-[13px] font-semibold">
          {title}
          <span className="ml-2 text-xs font-normal text-muted">{note}</span>
        </span>
        {latest !== undefined ? (
          <span className="text-[13px]">
            <span className="text-xs text-muted">{latest.yearMonth} </span>
            <span className={`font-semibold tabular-nums ${latest.value < 0 ? "text-neg" : ""}`}>{won(latest.value)}</span>
            {delta !== null ? (
              <span className="ml-2 text-xs tabular-nums text-muted">
                전월 대비 {delta === 0 ? "변화 없음" : `${SIGNED.format(delta)}원`}
              </span>
            ) : null}
          </span>
        ) : null}
      </figcaption>
      <svg
        viewBox={`0 0 ${WIDTH} ${HEIGHT}`}
        className="h-auto w-full px-2 py-2"
        role="img"
        aria-labelledby={`${titleId} ${descId}`}
      >
        <desc id={descId}>
          {bars
            .map((bar) => `${bar.yearMonth} ${bar.value === null ? "데이터 없음" : won(bar.value)}`)
            .join(", ")}
        </desc>
        {/* 격자와 y 축 눈금 */}
        {ticks.map((tick) => (
          <g key={tick}>
            <line
              x1={MARGIN.left}
              x2={WIDTH - MARGIN.right}
              y1={y(tick)}
              y2={y(tick)}
              strokeWidth={1}
              className={
                tick === 0
                  ? "stroke-control"
                  : "stroke-line"
              }
            />
            <text
              x={MARGIN.left - 8}
              y={y(tick)}
              dy="0.32em"
              textAnchor="end"
              className="fill-muted text-[13px] tabular-nums"
            >
              {won(tick)}
            </text>
          </g>
        ))}
        {bars.map((bar, index) => {
          const center = MARGIN.left + band * index + band / 2;
          const label = monthLabel(bar.yearMonth);
          const showLabel = index % every === 0 || index === bars.length - 1;
          const showYear = index === 0 || label.month === "1월";
          const tip = `${bar.yearMonth} ${title}: ${bar.value === null ? "데이터 없음" : won(bar.value)}`;
          return (
            <g key={bar.yearMonth}>
              {bar.value !== null ? (
                <g tabIndex={0} aria-label={tip} className="group outline-none">
                  <title>{tip}</title>
                  {/* 막대보다 넓은 투명 목표(마우스 · 초점). */}
                  <rect
                    x={center - band / 2}
                    y={MARGIN.top}
                    width={band}
                    height={PLOT_H}
                    fill="transparent"
                  />
                  <path
                    d={barPath(center - barWidth / 2, barWidth, baseline, y(bar.value))}
                    strokeWidth={2}
                    className="fill-chart stroke-transparent transition-opacity group-hover:opacity-75 group-focus-visible:stroke-fg"
                  />
                </g>
              ) : (
                // 거래가 없는 달. 막대 대신 기준선 위에 흐린 표시만 둔다(0원과 구별).
                <text
                  x={center}
                  y={baseline - 6}
                  textAnchor="middle"
                  className="fill-faint text-[12px]"
                >
                  없음
                </text>
              )}
              {showLabel ? (
                <text
                  x={center}
                  y={HEIGHT - MARGIN.bottom + 18}
                  textAnchor="middle"
                  className={`text-[13px] ${bar.value === null ? "fill-faint" : "fill-muted"}`}
                >
                  {label.month}
                </text>
              ) : null}
              {showLabel && showYear ? (
                <text
                  x={center}
                  y={HEIGHT - MARGIN.bottom + 34}
                  textAnchor="middle"
                  className="fill-muted text-[12px]"
                >
                  {label.year}
                </text>
              ) : null}
            </g>
          );
        })}
      </svg>
    </figure>
  );
}
