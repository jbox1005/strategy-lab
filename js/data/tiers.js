// 도시 등급 정의 — 인구 기반
// 기본 속성(식량생산/세금/인구증가)은 추후 밸런싱 화면에서 조정 가능하도록 한 곳에서 관리

export const TIER_ORDER = ['M', 'S', 'A', 'B', 'C', 'D', 'E'];

export const TIERS = {
  M: {
    label: '메타시티',
    minPop: 100_000_000,    // 1억+
    color: '#ff44aa',
    glow: true,
    radius: 12,
    foodPerYear: 110,
    taxPerYear: 450,
    growthRate: 0.002,
    showFromZoom: 0,
    labelFromZoom: 0,
    territorySize: 9,       // 자기 셀 포함 9셀 (center + 8)
  },
  S: {
    label: '메가시티',
    minPop: 10_000_000,
    color: '#ff5b5b',
    glow: true,
    radius: 9,
    foodPerYear: 60,
    taxPerYear: 240,
    growthRate: 0.004,
    showFromZoom: 0,
    labelFromZoom: 0,
    territorySize: 6,       // S = 6셀 (center + 5)
  },
  A: {
    label: '광역시',
    minPop: 5_000_000,
    color: '#ff9f3a',
    glow: true,
    radius: 7,
    foodPerYear: 32,
    taxPerYear: 130,
    growthRate: 0.006,
    showFromZoom: 0,
    labelFromZoom: 0,
    territorySize: 5,
  },
  B: {
    label: '대도시',
    minPop: 1_000_000,
    color: '#fece4d',
    glow: false,
    radius: 5,
    foodPerYear: 14,
    taxPerYear: 55,
    growthRate: 0.010,
    showFromZoom: 0,
    labelFromZoom: 1.4,
    territorySize: 4,
  },
  C: {
    label: '중도시',
    minPop: 500_000,
    color: '#4dd2ff',
    glow: false,
    radius: 4,
    foodPerYear: 7,
    taxPerYear: 22,
    growthRate: 0.014,
    showFromZoom: 1.5,
    labelFromZoom: 3.0,
    territorySize: 3,
  },
  D: {
    label: '소도시',
    minPop: 100_000,
    color: '#4ddb8d',
    glow: false,
    radius: 3,
    foodPerYear: 2.5,
    taxPerYear: 7,
    growthRate: 0.018,
    showFromZoom: 3.0,
    labelFromZoom: 5.0,
    territorySize: 2,
  },
  E: {
    label: '읍·소도시',
    minPop: 50_000,
    color: '#a98fff',
    glow: false,
    radius: 2,
    foodPerYear: 1,
    taxPerYear: 2.5,
    growthRate: 0.020,
    showFromZoom: 5.0,
    labelFromZoom: 7.0,
    territorySize: 1,       // 자기 셀만
  },
};

// 인구수에 따른 자동 티어 산출
export function tierFor(pop) {
  if (pop >= TIERS.M.minPop) return 'M';
  if (pop >= TIERS.S.minPop) return 'S';
  if (pop >= TIERS.A.minPop) return 'A';
  if (pop >= TIERS.B.minPop) return 'B';
  if (pop >= TIERS.C.minPop) return 'C';
  if (pop >= TIERS.D.minPop) return 'D';
  if (pop >= TIERS.E.minPop) return 'E';
  return null; // 5만 미만은 게임에서 제외
}
