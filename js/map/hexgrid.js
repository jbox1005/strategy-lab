// H3 (Uber) 기반 구면 헥스 그리드 — lazy 캐시 방식
// res 5 같은 고해상도(전 지구 ~2M 셀)에서 메모리 폭발을 막기 위해
// 뷰포트가 요구할 때만 셀을 생성/캐시한다.

import { CDN } from '../config.js';
import { lngLatToWorld, WORLD_BOUNDS } from './projection.js';

let _h3 = null;
const cellCache = new Map(); // h3 id → cell data

// 육지 마스크 (world.js에서 setLandMask로 주입)
let _landMask = null;
let _maskW = 0, _maskH = 0;

export function setLandMask(mask, w, h) {
  _landMask = mask;
  _maskW = w;
  _maskH = h;
  // 이미 캐시된 셀들은 분류 갱신 (elev/moist는 그대로, terrain → feature 순)
  for (const c of cellCache.values()) {
    if (c.elev === 0 && c.moist === 0) computeElevMoist(c);
    c.terrain = classifyTerrainForCell(c);
    c.feature = classifyFeatureForCell(c);
  }
}

export async function initHexgrid() {
  if (!_h3) _h3 = await import(CDN.h3);
  return _h3;
}

export function isInitialized() { return _h3 !== null; }
export function getH3Module() { return _h3; }

export function cellCacheSize() { return cellCache.size; }
export function clearCellCache() { cellCache.clear(); }

// ─── 지형 분류 ────────────────────────────────────────
// 셀 안 7개 점(중심 + 6꼭지점) 다수결 → land / sea
function sampleLandAtWorld(wx, wy) {
  if (!_landMask) return null;
  const mx = Math.floor(wx * _maskW / WORLD_BOUNDS.width);
  const my = Math.floor(wy * _maskH / WORLD_BOUNDS.height);
  if (mx < 0 || mx >= _maskW || my < 0 || my >= _maskH) return 0;
  return _landMask[my * _maskW + mx];
}

function classifyTerrainForCell(cell) {
  if (!_landMask) return 'unknown';
  if (cell.crossesAntimeridian) return 'sea';

  let landCount = 0;
  let total = 0;

  // 중심점
  const c = sampleLandAtWorld(cell.worldX, cell.worldY);
  if (c !== null) { total++; if (c) landCount++; }

  // 꼭지점들 (월드 좌표가 사전 계산되어 있음)
  const wb = cell.worldBoundary;
  for (let i = 0; i < cell.pointCount; i++) {
    const v = sampleLandAtWorld(wb[i * 2], wb[i * 2 + 1]);
    if (v !== null) { total++; if (v) landCount++; }
  }

  if (total === 0) return 'unknown';
  return landCount * 2 >= total ? 'land' : 'sea';
}

// ─── 지형 특성 (feature) 분류 ──────────────────────────
// 결정론적 fBm value-noise — 같은 (lng, lat) 입력은 항상 같은 값 반환
//   → 인접 헥스가 같은 노이즈 영역에 있으면 같은 feature가 부여되어
//     자연스러운 클러스터(숲 띠, 사막 띠 등)가 형성됨

function _hashCoord(x, y) {
  let h = (x * 374761393 + y * 668265263) | 0;
  h = (h ^ (h >>> 13)) * 1274126177 | 0;
  h = h ^ (h >>> 16);
  return ((h >>> 0) / 0xFFFFFFFF) * 2 - 1; // [-1, 1]
}

function _valueNoise2D(x, y) {
  const gx = Math.floor(x), gy = Math.floor(y);
  const fx = x - gx, fy = y - gy;
  const h00 = _hashCoord(gx,     gy);
  const h10 = _hashCoord(gx + 1, gy);
  const h01 = _hashCoord(gx,     gy + 1);
  const h11 = _hashCoord(gx + 1, gy + 1);
  const sx = fx * fx * (3 - 2 * fx);
  const sy = fy * fy * (3 - 2 * fy);
  const a = h00 * (1 - sx) + h10 * sx;
  const b = h01 * (1 - sx) + h11 * sx;
  return a * (1 - sy) + b * sy;
}

function _fbm(x, y, octaves = 3) {
  let v = 0, amp = 1, freq = 1, total = 0;
  for (let i = 0; i < octaves; i++) {
    v += _valueNoise2D(x * freq, y * freq) * amp;
    total += amp;
    amp *= 0.5;
    freq *= 2.07;
  }
  return v / total;
}

// cell에 elev/moist 저장 (river 알고리즘과 feature 분류가 공유)
function computeElevMoist(cell) {
  cell.elev  = _fbm(cell.lng / 14,         cell.lat / 9,           3);  // 큰 클러스터
  cell.moist = _fbm(cell.lng / 18 + 137.0, cell.lat / 11 - 89.0,   3);  // 다른 시드
}

function classifyFeatureForCell(cell) {
  if (cell.terrain !== 'land') return null;

  const absLat = Math.abs(cell.lat);
  const elev  = cell.elev;
  const moist = cell.moist;

  // 산: elevation 노이즈가 높을 때 (fBm 3옥타브 ≈ [-0.5, 0.5] 분포에서 상위 ~20%)
  if (elev > 0.22) return 'mountain';

  // 사막: 아열대 고기압대 + 건조 (또는 대륙 내륙 매우 건조)
  const inDryBelt = absLat >= 15 && absLat <= 35;
  if (inDryBelt && moist < -0.05) return 'desert';
  if (absLat <= 50 && moist < -0.50) return 'desert';

  // 숲: 온대/열대 + 습윤
  if (absLat <= 65 && moist > -0.05) return 'forest';

  // 평원 (디폴트)
  return 'plain';
}

// ─── 단일 셀 생성 (h3 id → 정제된 셀 데이터) ──────────────
function detectAntimeridian(boundary) {
  let minLng = Infinity, maxLng = -Infinity;
  for (const pt of boundary) {
    const lng = pt[1];
    if (lng < minLng) minLng = lng;
    if (lng > maxLng) maxLng = lng;
  }
  return (maxLng - minLng) > 180;
}

function computeCell(id) {
  const h3 = _h3;
  const [lat, lng] = h3.cellToLatLng(id);
  const boundary = h3.cellToBoundary(id); // [[lat, lng], ...]
  const isPent = h3.isPentagon(id);
  const crossesAM = detectAntimeridian(boundary);
  const [cx, cy] = lngLatToWorld(lng, lat);

  let worldBoundary;
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;

  if (!crossesAM) {
    worldBoundary = new Float32Array(boundary.length * 2);
    for (let j = 0; j < boundary.length; j++) {
      const [bla, blo] = boundary[j];
      const [wx, wy] = lngLatToWorld(blo, bla);
      worldBoundary[j * 2]     = wx;
      worldBoundary[j * 2 + 1] = wy;
      if (wx < minX) minX = wx;
      if (wy < minY) minY = wy;
      if (wx > maxX) maxX = wx;
      if (wy > maxY) maxY = wy;
    }
  } else {
    worldBoundary = new Float32Array(0);
  }

  const cell = {
    id, lat, lng,
    worldX: cx, worldY: cy,
    worldBoundary,
    pointCount: boundary.length,
    isPentagon: isPent,
    crossesAntimeridian: crossesAM,
    minX, minY, maxX, maxY,
    terrain: 'unknown',
    feature: null,
    elev: 0,
    moist: 0,
    isRiver: false,
  };
  computeElevMoist(cell);
  cell.terrain = classifyTerrainForCell(cell);
  cell.feature = classifyFeatureForCell(cell);
  return cell;
}

export function getOrCreateCell(id) {
  let c = cellCache.get(id);
  if (c) return c;
  c = computeCell(id);
  cellCache.set(id, c);
  return c;
}

// ─── 위경도 → 셀 ID ─────────────────────────────────────
export function lngLatToCellId(lng, lat, resolution) {
  return _h3.latLngToCell(lat, lng, resolution);
}

// 셀 ID → [lat, lng] 중심
export function cellToCenter(id) {
  return _h3.cellToLatLng(id); // [lat, lng]
}

// 두 셀 사이 그리드 거리 (헥스 칸 수). 실패 시 -1.
export function gridDistance(cellA, cellB) {
  if (!_h3) return -1;
  try { return _h3.gridDistance(cellA, cellB); }
  catch { return -1; }
}

// 셀에서 반경 r 안의 모든 셀 ID (자기 자신 + 1..r 링)
export function gridDisk(cellId, r) {
  if (!_h3) return [];
  try { return _h3.gridDisk(cellId, r); }
  catch { return []; }
}

// ─── 뷰포트(위경도 박스) 내 셀 ID 모으기 ────────────────
// h3.polygonToCells: 첫 인자 polygon = [outerRing[, ...holes]]
// 각 ring은 [lat, lng] 점 리스트, 마지막 점이 첫점과 같을 필요 없음.
export function getCellIdsInBox(latMin, lngMin, latMax, lngMax, resolution) {
  // 안전장치
  latMin = Math.max(-89.9, latMin);
  latMax = Math.min( 89.9, latMax);
  lngMin = Math.max(-179.9, lngMin);
  lngMax = Math.min( 179.9, lngMax);
  if (latMax <= latMin || lngMax <= lngMin) return [];

  const polygon = [[
    [latMin, lngMin],
    [latMin, lngMax],
    [latMax, lngMax],
    [latMax, lngMin],
  ]];

  try {
    return _h3.polygonToCells(polygon, resolution);
  } catch (err) {
    console.warn('[hexgrid] polygonToCells 실패:', err.message);
    return [];
  }
}

// 해상도별 평균 셀 밀도 (전 지구 셀 수 / equirectangular 월드 면적 6,480,000 unit²)
// 면적 기반 사전 스킵에 사용 — polygonToCells 호출 비용을 회피
const RES_DENSITY = {
  0: 0.0000188,
  1: 0.000130,
  2: 0.000908,
  3: 0.00635,
  4: 0.0445,
  5: 0.311,
  6: 2.18,
  7: 15.3,
};

// 면적 기반 셀 수 추정
export function estimateCellCount(worldAreaUnits2, resolution) {
  return worldAreaUnits2 * (RES_DENSITY[resolution] ?? 1);
}

// 뷰포트 메모이즈 (해상도+박스 동일하면 동일 결과 반환)
let _memoKey = null;
let _memoVal = null;

// 박스 안 셀들의 셀 객체 배열 (캐시 활용 + 사전 스킵 + 메모이즈)
//   worldAreaUnits2: 호출자가 미리 계산한 뷰포트 면적 (사전 스킵용, 선택)
export function getCellsInBox(latMin, lngMin, latMax, lngMax, resolution, limit = Infinity, worldAreaUnits2 = null) {
  // 1) 사전 스킵: 추정 셀 수가 한도×4 초과하면 polygonToCells조차 부르지 않음
  if (worldAreaUnits2 != null) {
    const est = estimateCellCount(worldAreaUnits2, resolution);
    if (est > limit * 4) {
      return { cells: [], total: Math.round(est), capped: true, skipped: true };
    }
  }

  // 2) 메모이즈 (소수점 셋째 자리까지 동일하면 캐시)
  const key = `${resolution}|${latMin.toFixed(3)}|${lngMin.toFixed(3)}|${latMax.toFixed(3)}|${lngMax.toFixed(3)}|${limit}`;
  if (key === _memoKey) return _memoVal;

  const ids = getCellIdsInBox(latMin, lngMin, latMax, lngMax, resolution);
  if (ids.length > limit) {
    const result = { cells: [], total: ids.length, capped: true, skipped: false };
    _memoKey = key; _memoVal = result;
    return result;
  }

  const out = new Array(ids.length);
  for (let i = 0; i < ids.length; i++) out[i] = getOrCreateCell(ids[i]);
  const result = { cells: out, total: ids.length, capped: false, skipped: false };
  _memoKey = key; _memoVal = result;
  return result;
}

// 줌 → 디스플레이용 해상도 결정
//   ladder는 [{minZoom, res}, ...] 오름차순. 첫 항목보다 줌이 작으면 -1 반환(=미표시).
//   maxRes로 기본 단위(base unit) 캡을 강제 — 그 이상은 쪼개지 않음.
export function pickDisplayResolution(zoom, ladder, maxRes = Infinity) {
  let res = -1;
  for (const step of ladder) {
    if (zoom >= step.minZoom) res = step.res;
    else break;
  }
  if (res < 0) return -1;
  return Math.min(res, maxRes);
}
