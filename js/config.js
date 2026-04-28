// 게임 전역 설정 — 추후 개발자 콘솔에서 조정 가능

export const CONFIG = {
  // 맵 — 기본 단위 (Base Unit)
  // 이 해상도가 지형 속성, 도시 영역, 군대 이동의 최소 단위.
  // 디스플레이 그리드도 이 해상도 이하로만 쪼갠다 (더 줌인해도 셀이 화면에서 커질 뿐 분할 X).
  hexResolution: 5,            // H3 해상도 (5 = ~8.5km 폭, ~252km²/cell, res 3 대비 ~1/49 면적)

  // 월드 좌표계 (equirectangular: 1° = 10px)
  worldWidth: 3600,
  worldHeight: 1800,

  // 줌
  minZoomMul: 0.7,             // 화면 fit zoom × 이 값이 최소 줌
  maxZoom: 400,                // res 5 셀이 픽셀 단위로 보이려면 큰 줌이 필요
  zoomStep: 1.25,

  // 렌더링 LOD — 게임플레이는 항상 res 5에서 돌지만,
  // 디스플레이는 줌에 따라 적응적으로 해상도를 낮춰서 성능을 확보한다.
  hexGridFromZoom: 3,          // 이 줌 미만이면 그리드 미표시
  hexFillFromZoom: 18,         // 이 줌 이상일 때만 헥스 면 채우기

  // 줌 → 디스플레이 해상도 (오름차순). 첫 항목보다 작으면 미표시.
  // 어떤 경우에도 hexResolution(기본 단위)을 초과해 쪼개지 않는다 — 그 위로 줌인하면 셀이 화면에서 커질 뿐.
  displayResLadder: [
    { minZoom: 3,   res: 3 }, // res 3 (~110km, 10unit) — zoom 3~7
    { minZoom: 7,   res: 4 }, // res 4 (~22km, 2unit)  — zoom 7~25
    { minZoom: 25,  res: 5 }, // res 5 (~8.5km, 0.77u) — zoom 25+ (기본 단위)
  ],

  // 뷰포트 셀 한도 — 초과하면 그리드 렌더 스킵 (성능 보호)
  viewportCellLimit: 20_000,

  // 지형 특성 도형 표시 임계 줌 — 그리드가 보이기 시작할 때부터 표시
  featuresFromZoom: 5,

  // 시작 조건 (개발자/테스트용 기본값)
  startCity: 'Seoul',          // 영문명 기준
  startCoins: 50_000_000,      // 5000만 코인 (테스트용)
  visibilityRadiusKm: 150,
  initialCityDistanceLimitKm: 100,

  // 시간
  yearPerHour: 1,
  humanLifespan: 80,
};

// 외부 라이브러리 CDN
export const CDN = {
  h3: 'https://cdn.jsdelivr.net/npm/h3-js@4.1.0/+esm',
  topojson: 'https://cdn.jsdelivr.net/npm/topojson-client@3.1.0/+esm',
  d3geo: 'https://cdn.jsdelivr.net/npm/d3-geo@3.1.1/+esm',
  worldAtlas: 'https://cdn.jsdelivr.net/npm/world-atlas@2.0.2/countries-110m.json',
};
