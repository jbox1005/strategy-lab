// 월드 데이터 로더
//   - 육지 윤곽선(GeoJSON) 다운로드 + 월드 좌표 사전 변환
//   - H3 모듈 초기화 (lazy 셀 생성을 위해)
//   - 도시를 H3 셀에 스냅 + 같은 셀 내 중복 제거 (인구 최대만 유지)
// 헥스 그리드 자체는 뷰포트별로 lazy 생성 (hexgrid.js 참고)

import { CONFIG, CDN } from '../config.js';
import { lngLatToWorld, WORLD_BOUNDS, haversineKm } from './projection.js';
import {
  initHexgrid, lngLatToCellId, cellToCenter, setLandMask,
  getOrCreateCell, getH3Module, gridDistance, gridDisk,
} from './hexgrid.js';
// import { generateRivers } from './rivers.js';  // 현재 비활성
import { computeCityExchanges } from '../data/exchanges.js';
import { TIERS, tierFor } from '../data/tiers.js';
import {
  buildPyramid, computeMobilePop, computeEconomicPop, computeDraftablePop,
  loadWppData, assignCitySizeRanks,
} from '../data/demographics.js';

async function loadLandGeometry(progressCb) {
  progressCb?.('지구 윤곽선 다운로드 중…');
  const [topojson, d3geo, topo] = await Promise.all([
    import(CDN.topojson),
    import(CDN.d3geo),
    fetch(CDN.worldAtlas).then(r => {
      if (!r.ok) throw new Error('world-atlas 로딩 실패: ' + r.status);
      return r.json();
    }),
  ]);

  progressCb?.('육지 폴리곤 변환 중…');
  const landFC = topojson.feature(topo, topo.objects.land);
  const countries = topojson.feature(topo, topo.objects.countries);

  // d3-geo equirectangular 투영기 — 우리 월드 좌표(3600×1800)에 직접 맞춤.
  // d3-geo는 안티머리디언 자동 분할 처리하므로 인공 closure 아크가 가짜 가로띠로 그려지지 않음.
  const projection = d3geo.geoEquirectangular()
    .scale(WORLD_BOUNDS.width / (2 * Math.PI))
    .translate([WORLD_BOUNDS.width / 2, WORLD_BOUNDS.height / 2]);

  return { landFC, countries, projection, d3geo };
}

// 육지 폴리곤을 d3-geo 투영(안티머리디언 자동 분할)으로 비트맵 마스크에 라스터화
//   - 인공 closure 아크가 만들어내던 가짜 가로띠(lat -16/64/-84)가 더 이상 생기지 않음
//   - Eurasia 같은 거대 polygon도 정상 fill됨 → NK 등 내륙 보존
function buildLandMask(landFC, projection, d3geo, width, height, progressCb) {
  progressCb?.('육지 마스크 라스터화 중…');
  const cv = document.createElement('canvas');
  cv.width = width;
  cv.height = height;
  const ctx = cv.getContext('2d', { willReadFrequently: true });

  ctx.fillStyle = '#000';
  ctx.fillRect(0, 0, width, height);

  ctx.fillStyle = '#fff';
  const path = d3geo.geoPath(projection, ctx);
  ctx.beginPath();
  path(landFC);
  ctx.fill('evenodd');

  const imgData = ctx.getImageData(0, 0, width, height).data;
  const mask = new Uint8Array(width * height);
  for (let i = 0, n = mask.length; i < n; i++) {
    mask[i] = imgData[i * 4] > 127 ? 1 : 0;
  }
  return mask;
}

// 시작 셀이 land가 아닐 때, 가장 가까운 land 셀을 찾는다.
//   - 동심 ring을 점차 확장하며 land 후보를 수집
//   - 후보들 중 원좌표(origLat/origLng)와 haversine 거리 가장 가까운 것 채택
//   - maxRadius 안에 land가 없으면 null
function findNearestLandCell(startId, origLat, origLng, maxRadius = 8) {
  const h3 = getH3Module();
  for (let r = 1; r <= maxRadius; r++) {
    const ring = h3.gridDisk(startId, r);
    let best = null;
    let bestDist = Infinity;
    for (const id of ring) {
      if (id === startId) continue;
      const cell = getOrCreateCell(id);
      if (cell.terrain !== 'land') continue;
      const d = haversineKm(origLat, origLng, cell.lat, cell.lng);
      if (d < bestDist) { bestDist = d; best = id; }
    }
    if (best) return best;
  }
  return null;
}

// 도시 빌딩 영역(self + 6 이웃 = ring1) 충돌 해소
//   1) gridDistance ≤ 1: 작은 도시는 큰 도시에 흡수 (pop 합산, 라벨 보존)
//      - 여러 큰 도시 영역에 걸치면 가장 큰 도시가 가져감
//   2) gridDistance == 2: 빌딩 영역끼리 ring2에서 겹침 → 작은 도시를 옮겨 distance ≥ 3 만들기
//      - 가장 가까운 land 셀 중 모든 placed 도시들과 distance ≥ 3 만족하는 곳
//      - 1, 2, 3, … 칸씩 확장하며 탐색
//   3) gridDistance ≥ 3: OK
//   처리 순서: 인구 큰 도시부터 placed 리스트에 누적

function findFreeBuildCell(city, placed, maxRadius = 8) {
  for (let r = 1; r <= maxRadius; r++) {
    const candidates = gridDisk(city.cellId, r);
    let best = null;
    let bestDist = Infinity;
    for (const id of candidates) {
      if (id === city.cellId) continue;
      const cell = getOrCreateCell(id);
      if (cell.terrain !== 'land') continue;

      // 모든 placed 도시와 distance ≥ 3 보장 (빌딩 영역 미겹침)
      let valid = true;
      for (const big of placed) {
        const d = gridDistance(id, big.cellId);
        if (d < 0) continue;
        if (d < 3) { valid = false; break; }
      }
      if (!valid) continue;

      const dKm = haversineKm(
        city.origLat ?? city.lat, city.origLng ?? city.lng,
        cell.lat, cell.lng
      );
      if (dKm < bestDist) { bestDist = dKm; best = id; }
    }
    if (best) return best;
  }
  return null;
}

function moveCityToCell(city, newId) {
  const [lat, lng] = cellToCenter(newId);
  if (city.origLat == null) {
    city.origLat = city.lat;
    city.origLng = city.lng;
  }
  city.cellId = newId;
  city.lat = lat;
  city.lng = lng;
}

function resolveCityOverlaps(cities) {
  // 큰 도시부터 placed에 들어감
  const sorted = cities.slice().sort((a, b) => b.pop - a.pop);
  const placed = [];
  let absorbed = 0;
  let displacedSmall = 0;
  let displacedBig = 0;     // 양보 이동
  let stuck = 0;

  for (const city of sorted) {
    // 1) 흡수 검사 — 가장 큰 absorber 선택
    let absorber = null;
    for (const big of placed) {
      const d = gridDistance(city.cellId, big.cellId);
      if (d < 0) continue;
      if (d <= 1 && (!absorber || big.pop > absorber.pop)) absorber = big;
    }
    if (absorber) {
      absorber.pop += city.pop;
      absorber.mergedNames = [...(absorber.mergedNames || []), city.name];
      absorber.mergedCount = (absorber.mergedCount || 1) + 1;
      absorbed++;
      continue;
    }

    // 2) distance == 2 (영역 겹침) 갈등 도시들 수집
    const conflictingBigs = [];
    for (const big of placed) {
      const d = gridDistance(city.cellId, big.cellId);
      if (d === 2) conflictingBigs.push(big);
    }
    if (conflictingBigs.length === 0) {
      placed.push(city);
      continue;
    }

    // 3) 우선 작은 도시를 displace 시도 (land 셀만 후보)
    const newId = findFreeBuildCell(city, placed);
    if (newId) {
      moveCityToCell(city, newId);
      placed.push(city);
      displacedSmall++;
      continue;
    }

    // 4) [Fallback] 작은 도시가 land로 갈 곳이 없으면 큰 도시 중 하나를 양보 이동
    //    갈등 큰 도시들 중 인구 작은 것부터 시도 (전체 영향 최소화)
    conflictingBigs.sort((a, b) => a.pop - b.pop);
    let bigMoved = null;
    for (const big of conflictingBigs) {
      const others = placed.filter(p => p !== big);
      const tempPlaced = [...others, city];   // big 새 위치는 city·others 모두로부터 dist≥3
      const bigNewId = findFreeBuildCell(big, tempPlaced);
      if (bigNewId) {
        moveCityToCell(big, bigNewId);
        bigMoved = big;
        break;
      }
    }
    if (bigMoved) {
      placed.push(city);
      displacedBig++;
      continue;
    }

    // 5) 누구도 옮길 곳이 없음 — 둘 다 land에 머무름 (영역 겹침은 남음)
    placed.push(city);
    stuck++;
  }

  if (absorbed || displacedSmall || displacedBig || stuck) {
    console.log(
      `[city-overlap] (1차) 흡수 ${absorbed}, ` +
      `소도시 이동 ${displacedSmall}, 대도시 양보 이동 ${displacedBig}, 1차 미해결 ${stuck}`
    );
  }
  // 인구 큰 순 정렬 유지하여 반환 (라벨 우선순위 등)
  placed.sort((a, b) => b.pop - a.pop);
  return placed;
}

// 도시 territory(건설영역) 계산 — 등급별 territorySize까지 그리디 확장
//   E:1 / D:2 / C:3 / B:4 / A:5 / S:6 / M:9 (자기 셀 포함 총 셀 수)
//
// 처리 순서: territorySize 큰 도시부터 (M → S → … → E)
//   각 도시: 자기 셀에서 시작, 인접한 미점유 land 중 city 중심에서 haversine 가장 가까운
//   셀을 1개씩 추가, 목표 개수 도달 또는 후보 없음 시 종료.
//
// 향후 게임 시작 시 사용자가 시작 도시의 셀들을 직접 고르거나,
// 도시 등급 상승 시 추가 셀을 선택하는 인터랙션은 별도로 구현 예정.
function computeCityTerritories(cities) {
  const claimedBy = new Map(); // cellId → cityId

  const sorted = cities.slice().sort((a, b) => {
    const sa = TIERS[a.tier]?.territorySize ?? 1;
    const sb = TIERS[b.tier]?.territorySize ?? 1;
    if (sa !== sb) return sb - sa;
    return b.pop - a.pop;
  });

  let blockedCount = 0;
  let undersized = 0;

  for (const city of sorted) {
    const target = TIERS[city.tier]?.territorySize ?? 1;
    city.territorySize = target;
    city.territory = new Set();

    // 자기 셀
    if (!claimedBy.has(city.cellId)) {
      city.territory.add(city.cellId);
      claimedBy.set(city.cellId, city.id);
    } else {
      // 매우 드문 케이스: overlap resolve 후에도 누가 이미 점유 (이론상 없음)
      blockedCount++;
    }

    // 그리디 확장
    while (city.territory.size < target) {
      let bestId = null;
      let bestDist = Infinity;
      for (const id of city.territory) {
        const neighbors = gridDisk(id, 1);
        for (const nb of neighbors) {
          if (city.territory.has(nb)) continue;
          if (claimedBy.has(nb)) continue;
          const cell = getOrCreateCell(nb);
          if (cell.terrain !== 'land') continue;
          const dKm = haversineKm(city.lat, city.lng, cell.lat, cell.lng);
          if (dKm < bestDist) { bestDist = dKm; bestId = nb; }
        }
      }
      if (!bestId) break; // 후보 고갈 (섬·점유포화)
      city.territory.add(bestId);
      claimedBy.set(bestId, city.id);
    }

    if (city.territory.size < target) undersized++;
  }

  if (undersized > 0 || blockedCount > 0) {
    console.log(`[territory] 목표 미달 도시 ${undersized}개 (해변/섬 등 후보 부족), 자체 셀 점유 ${blockedCount}`);
  }
}

// 1차 해소 이후에도 남은 d ≤ 2 페어를 0이 될 때까지 반복 정리
//   - d ≤ 1: 작은 쪽을 큰 쪽에 흡수
//   - d == 2: 더 큰 쪽이 한 칸 (또는 가능 최소 칸수) 양보 이동
//   - 매 반복마다 처음 발견한 충돌 페어 하나만 처리 후 처음부터 다시 스캔 → 결정론적
function postResolveOverlaps(placed, maxIters = 200) {
  let moves = 0;
  let absorbs = 0;
  let lastUnresolved = null;

  for (let iter = 0; iter < maxIters; iter++) {
    // 첫 충돌 페어 찾기
    let pair = null;
    for (let i = 0; i < placed.length && !pair; i++) {
      for (let j = i + 1; j < placed.length; j++) {
        const d = gridDistance(placed[i].cellId, placed[j].cellId);
        if (d >= 0 && d <= 2) { pair = [i, j, d]; break; }
      }
    }
    if (!pair) {
      if (moves || absorbs) {
        console.log(`[city-overlap] (2차) 양보 이동 ${moves}, 추가 흡수 ${absorbs} — ${iter} 반복 후 안정`);
      }
      return;
    }

    const [i, j, d] = pair;
    const a = placed[i], b = placed[j];

    if (d <= 1) {
      // 흡수
      const bigIdx  = a.pop >= b.pop ? i : j;
      const smIdx   = bigIdx === i ? j : i;
      const big     = placed[bigIdx];
      const small   = placed[smIdx];
      big.pop += small.pop;
      big.mergedNames = [...(big.mergedNames || []), small.name];
      big.mergedCount = (big.mergedCount || 1) + 1;
      placed.splice(smIdx, 1);
      absorbs++;
      continue;
    }

    // d == 2 — 더 큰 도시가 양보
    const big   = a.pop >= b.pop ? a : b;
    const others = placed.filter(p => p !== big);
    const newId = findFreeBuildCell(big, others, 12);
    if (newId) {
      moveCityToCell(big, newId);
      moves++;
      continue;
    }

    // 더 이상 옮길 곳이 없으면 종료 (최후의 수단으로 영역 겹침 1쌍 인정)
    lastUnresolved = [big.name, big === a ? b.name : a.name];
    console.warn(`[city-overlap] (2차) 진척 불가 — ${lastUnresolved.join(' ↔ ')} 영역 겹침 잔류`);
    break;
  }

  // 최종 검증: 남은 d ≤ 2 페어 카운트
  let remaining = 0;
  for (let i = 0; i < placed.length; i++) {
    for (let j = i + 1; j < placed.length; j++) {
      const d = gridDistance(placed[i].cellId, placed[j].cellId);
      if (d >= 0 && d <= 2) remaining++;
    }
  }
  if (remaining > 0) {
    console.warn(`[city-overlap] (최종) ${remaining}개 페어 영역 겹침 잔류`);
  } else if (moves || absorbs) {
    console.log(`[city-overlap] (2차) 양보 이동 ${moves}, 추가 흡수 ${absorbs}`);
  }
}

// 도시들을 H3 셀에 스냅 + 중복 제거
//   - 처음 결과가 sea 셀이면 인접 land 셀로 보정
//   - 같은 셀에 여러 도시가 있으면 인구 최대 1개만 유지
//   - 좌표를 셀 중앙으로 이동 (lat/lng 덮어쓰기, origLat/origLng 보존)
function snapCitiesToHexes(cities, resolution) {
  const byCell = new Map(); // cellId → city[]
  let movedFromSea = 0;
  let unmovable = 0;

  for (const city of cities) {
    let cellId = lngLatToCellId(city.lng, city.lat, resolution);
    let cell = getOrCreateCell(cellId);

    // 바다 셀이면 가장 가까운 land 셀로 이동
    if (cell.terrain !== 'land') {
      const landId = findNearestLandCell(cellId, city.lat, city.lng);
      if (landId) {
        cellId = landId;
        cell = getOrCreateCell(cellId);
        movedFromSea++;
      } else {
        unmovable++;
        // 8 ring 안에도 land가 없는 매우 외해 도시 — 그대로 sea 셀에 둠 (실데이터에선 거의 발생 X)
      }
    }

    const arr = byCell.get(cellId);
    if (arr) arr.push(city);
    else byCell.set(cellId, [city]);
  }
  if (movedFromSea > 0) {
    console.log(`[city-snap] ${movedFromSea}개 도시를 바다 → 인접 land 셀로 이동 (보정 실패 ${unmovable})`);
  }

  const out = [];
  let merged = 0, dropped = 0;
  for (const [cellId, group] of byCell) {
    group.sort((a, b) => b.pop - a.pop);
    const winner = group[0];
    const [lat, lng] = cellToCenter(cellId);
    out.push({
      ...winner,
      origLat: winner.lat,
      origLng: winner.lng,
      lat,
      lng,
      cellId,
      mergedCount: group.length,
      mergedNames: group.length > 1 ? group.slice(1).map(c => c.name) : [],
    });
    if (group.length > 1) {
      merged++;
      dropped += group.length - 1;
    }
  }

  // 인구 큰 도시부터 라벨이 그려지도록 정렬해두기
  out.sort((a, b) => b.pop - a.pop);

  return { snapped: out, mergedCells: merged, droppedCities: dropped };
}

export async function loadWorld({ resolution, cities, onProgress } = {}) {
  const res = resolution ?? CONFIG.hexResolution;
  const t0 = performance.now();

  // 1) 육지 윤곽선
  const { landFC, countries, projection, d3geo } = await loadLandGeometry(onProgress);
  const t1 = performance.now();

  // 2) 육지 마스크 (d3-geo가 안티머리디언 자동 처리)
  const MASK_W = WORLD_BOUNDS.width;   // 3600
  const MASK_H = WORLD_BOUNDS.height;  // 1800
  const landMask = buildLandMask(landFC, projection, d3geo, MASK_W, MASK_H, onProgress);
  setLandMask(landMask, MASK_W, MASK_H);
  const t2 = performance.now();

  // 3) H3 초기화
  onProgress?.('H3 초기화 중…');
  await initHexgrid();
  const t3 = performance.now();

  // 4) 도시 스냅 + 중복 제거
  let snapResult = { snapped: cities, mergedCells: 0, droppedCities: 0 };
  if (cities && cities.length) {
    onProgress?.(`도시 ${cities.length}개를 헥스 셀에 스냅 중…`);
    snapResult = snapCitiesToHexes(cities, res);
  }

  // 4b) 빌딩 영역 흡수/충돌 해소 (1차 + 후처리 반복)
  if (snapResult.snapped.length > 1) {
    onProgress?.('도시 빌딩 영역 충돌 해소 중…');
    snapResult.snapped = resolveCityOverlaps(snapResult.snapped);
    postResolveOverlaps(snapResult.snapped);
    snapResult.snapped.sort((a, b) => b.pop - a.pop);
  }

  // 4c) 흡수로 변화한 인구 기반 등급 재계산
  for (const city of snapResult.snapped) {
    const newTier = tierFor(city.pop);
    if (newTier && newTier !== city.tier) city.tier = newTier;
  }

  // 4d) 도시 territory 계산 (일반 ring1 / M 등급 ring2 확장)
  if (snapResult.snapped.length > 0) {
    onProgress?.('도시 건설영역 계산 중…');
    computeCityTerritories(snapResult.snapped);
  }

  const t4 = performance.now();

  // 5) 강 생성 — 현재 비활성 (필요시 generateRivers 호출 복구)

  // 6) 도시별 인구 피라미드 + 파생 통계
  onProgress?.('UN WPP 인구 데이터 로딩 중…');
  try {
    const wpp = await loadWppData();
    const wppCount = Object.keys(wpp.byCountry).length;
    console.log(`[wpp] ${wppCount}개국 실데이터 로딩 완료 (${wpp._meta?.source ?? 'unknown'})`);
  } catch (e) {
    console.warn('[wpp] 로딩 실패 — 휴리스틱 프로파일 fallback 사용:', e.message);
  }
  // 국가 내 도시 규모 순위 부여 (피라미드 skew 입력)
  assignCitySizeRanks(snapResult.snapped);

  onProgress?.('도시 인구 피라미드 생성 중…');
  for (const city of snapResult.snapped) {
    city.pyramid     = buildPyramid(city);
    city.mobilePop   = computeMobilePop(city.pyramid);
    city.economicPop = computeEconomicPop(city.pyramid);
    city.draftablePop = computeDraftablePop(city.pyramid, false); // 남성만, 여성 옵션은 게임 내 선택
  }
  const t5b = performance.now();

  // 7) 도시 간 교류 (gravity model) — 기본 교역관계 없음
  onProgress?.('도시 교류 계산 중…');
  const tradePacts = new Set();
  const exResult = computeCityExchanges(snapResult.snapped, tradePacts);
  const t5 = performance.now();

  console.log(
    `[world] 육지 GeoJSON (${(t1 - t0).toFixed(0)}ms) / ` +
    `마스크 ${MASK_W}x${MASK_H} (${(t2 - t1).toFixed(0)}ms) / ` +
    `H3 init (${(t3 - t2).toFixed(0)}ms) / ` +
    `도시 스냅 (${(t4 - t3).toFixed(0)}ms) / ` +
    `교류 (${(t5 - t4).toFixed(0)}ms) ` +
    `→ 도시 ${snapResult.snapped.length}개 (병합셀 ${snapResult.mergedCells}, 제거 ${snapResult.droppedCities}), 교류 페어 ${exResult.exchanges.length}`
  );

  return {
    landFC,
    countries,
    projection,
    d3geo,
    landMask,
    maskSize: { w: MASK_W, h: MASK_H },
    resolution: res,
    cities: snapResult.snapped,
    citySnap: {
      mergedCells: snapResult.mergedCells,
      droppedCities: snapResult.droppedCities,
    },
    rivers: [],
    riverCells: new Set(),
    tradePacts,
    exchanges: exResult.exchanges,
    exchangesByCity: exResult.byCity,
  };
}
