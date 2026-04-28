// Canvas 렌더러 — Top Gun: Maverick 작전화면 스타일
// 검은 배경 + 글로우 사이안 라인. 줌인 시 해안선 대신 헥스 단위 지형 표현(consolidation).
//
// 레이어 순서:
//   1) 깊은 검정 배경 + 가벼운 vignette
//   2) 위경도 격자 (옅은 사이안)
//   3) 줌이 낮으면: 실제 해안선 (글로우 윤곽)
//      줌이 높으면: 헥스 그리드 (land hex만 채움 + 모든 hex 윤곽)
//   4) 도시 (글로우 점 + 동심원)
//   5) 도시 라벨 (모노폰트, 스크린 공간)

import { CONFIG } from '../config.js';
import { TIERS } from '../data/tiers.js';
import { lngLatToWorld, worldToLngLat, WORLD_BOUNDS } from './projection.js';
import { getCellsInBox, getOrCreateCell, cellCacheSize, pickDisplayResolution } from './hexgrid.js';

// ─── 작전화면 팔레트 (색 반전: 바다=사이안, 육지=검정) ────
const C = {
  bg:           '#000408',
  bgVignette:   'rgba(0, 30, 50, 0.4)',

  graticule:    'rgba(80, 220, 220, 0.06)',
  // graticuleHi 제거 (적도/본초자오선 강조 안 함)

  // 저줌 — 해안선 (이젠 sea 위 land fill 방식, 라인은 보조)
  coastGlow:    'rgba(0, 230, 220, 0.10)',
  coastLine:    'rgba(80, 130, 130, 0.45)',

  // 헥스 — 색 반전
  seaBase:      '#04161c',                         // 월드 전체 sea 베이스 (더 짙은 cyan dark)
  seaEdge:      'rgba(140, 245, 235, 0.20)',        // sea hex 옅은 outline
  landFill:     'rgba(0, 0, 0, 0.95)',              // land hex 검정 채움
  landGlow:     'rgba(0, 0, 0, 0)',                 // 글로우 없음
  landEdge:     'rgba(70, 120, 120, 0.50)',         // land hex 어두운 사이안 outline

  // 호버
  hoverFill:    'rgba(255, 200, 60, 0.18)',
  hoverEdge:    'rgba(255, 220, 100, 1.0)',

  // 지형 특성(feature) 도형 — 단색 사이안 작전화면 톤
  // forest/desert는 데이터에만 분류되고 시각화는 보류 (게임 메커니즘 추가 시 활성화)
  featureLine:  'rgba(160, 250, 240, 0.78)',
  featureGlow:  'rgba(120, 240, 230, 0.20)',

  // 강 — 밝은 청록 라인
  riverLine:    'rgba(140, 220, 255, 0.95)',
  riverGlow:    'rgba(80, 180, 240, 0.30)',

  // 교류선 — 빨간 글로우 라인
  exchangeLine: 'rgba(255, 110, 120, 0.85)',
  exchangeGlow: 'rgba(255, 60, 70, 0.25)',
  selectedRing: 'rgba(255, 220, 100, 1.0)',

  // 선택 도시의 territory 강조
  territoryFill: 'rgba(255, 220, 100, 0.12)',
  territoryEdge: 'rgba(255, 220, 100, 0.55)',

  // 도시
  cityCore:     '#fff5b0',
  cityRing:     'rgba(255, 220, 100, 0.85)',
  cityRingDim:  'rgba(255, 220, 100, 0.30)',

  // 라벨
  labelFg:      '#cfeae0',
  labelDim:     'rgba(180, 230, 220, 0.7)',
  labelBg:      'rgba(0, 18, 28, 0.78)',
  labelBorder:  'rgba(120, 240, 230, 0.4)',

  // 월드 박스
  worldBox:     'rgba(120, 240, 230, 0.25)',
};

const MONO = '"JetBrains Mono", "D2Coding", "Consolas", "Courier New", monospace';

// 교류 흐름량 포맷 (사람 수)
function formatFlow(n) {
  if (n >= 100_000) return Math.round(n / 1000) + 'K';
  if (n >= 10_000)  return (n / 1000).toFixed(0) + 'K';
  if (n >= 1_000)   return (n / 1000).toFixed(1) + 'K';
  return Math.round(n).toString();
}

export class Renderer {
  constructor(canvas, world, camera, cities) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.world = world;
    this.camera = camera;
    this.cities = cities;
    this.dpr = window.devicePixelRatio || 1;
    this.hoverHex = null;
    this.hoverCity = null;
    this.selectedCityId = null;
    this._rafPending = false;
    this._needsRender = false;
    this.lastDrawStats = { gridCells: 0, total: 0, cached: 0, capped: false, skipped: false, displayRes: -1, landCount: 0, seaCount: 0 };
  }

  setHover({ hex, city }) {
    if (this.hoverHex !== hex || this.hoverCity !== city) {
      this.hoverHex = hex;
      this.hoverCity = city;
      this.requestRender();
    }
  }

  setSelectedCity(cityId) {
    if (this.selectedCityId !== cityId) {
      this.selectedCityId = cityId;
      this.requestRender();
    }
  }

  requestRender() {
    if (this._rafPending) { this._needsRender = true; return; }
    this._rafPending = true;
    requestAnimationFrame(() => {
      this._rafPending = false;
      this.render();
      if (this._needsRender) {
        this._needsRender = false;
        this.requestRender();
      }
    });
  }

  render() {
    const { ctx, canvas, camera } = this;
    const dpr = this.dpr;

    // ─── 화면 리셋 + 배경 ──────────────────────────
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.fillStyle = C.bg;
    ctx.fillRect(0, 0, canvas.width, canvas.height);

    const displayRes = pickDisplayResolution(camera.zoom, CONFIG.displayResLadder, CONFIG.hexResolution);

    // ─── 카메라 변환 (월드 좌표 → 화면) ──────────────
    ctx.setTransform(
      camera.zoom * dpr, 0,
      0, camera.zoom * dpr,
      camera.x * dpr, camera.y * dpr
    );

    // 가로 wrap을 위한 보이는 카피들의 월드 X 오프셋
    const offsets = this._getVisibleWorldOffsets();

    // 각 카피마다 월드 콘텐츠 렌더 (translate로 이동)
    for (const ofs of offsets) {
      ctx.save();
      if (ofs !== 0) ctx.translate(ofs, 0);
      this._drawWorldContent(ctx, displayRes);
      ctx.restore();
    }

    // 라벨 (스크린 공간) — 카피마다 그리기
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    for (const ofs of offsets) {
      this._drawCityLabels(ctx, ofs);
      this._drawExchangeLabels(ctx, ofs);
    }
  }

  // 월드 한 카피의 모든 콘텐츠 (sea base, graticule, land/sea hex, 도시 등)
  _drawWorldContent(ctx, displayRes) {
    // 1) sea base — 월드 사각형 안을 사이안으로 fill (외해 색)
    ctx.fillStyle = C.seaBase;
    ctx.fillRect(0, 0, WORLD_BOUNDS.width, WORLD_BOUNDS.height);

    // 2) 위경도 격자
    this._drawGraticule(ctx);

    // 3) 지형
    if (displayRes < 0) {
      this._drawCoastline(ctx);
      this.lastDrawStats = {
        gridCells: 0, total: 0, cached: cellCacheSize(),
        capped: false, skipped: true, displayRes: -1, landCount: 0, seaCount: 0,
      };
    } else {
      this._drawHexTerrain(ctx, displayRes);
    }

    // 4) 월드 경계 — 가로 wrap이라 좌우 끝선은 무의미, 위/아래만 (남극·북극 한계선)
    ctx.strokeStyle = C.worldBox;
    ctx.lineWidth = 1 / this.camera.zoom;
    ctx.beginPath();
    ctx.moveTo(0, 0); ctx.lineTo(WORLD_BOUNDS.width, 0);
    ctx.moveTo(0, WORLD_BOUNDS.height); ctx.lineTo(WORLD_BOUNDS.width, WORLD_BOUNDS.height);
    ctx.stroke();

    // 5) 선택 도시의 territory 강조 (헥스 위·교류선 아래)
    this._drawSelectedTerritory(ctx);

    // 6) 교류선 + 도시
    this._drawExchangeLines(ctx);
    this._drawCities(ctx);
  }

  // 선택된 도시의 territory(건설영역) 셀들을 황금색 톤으로 강조
  _drawSelectedTerritory(ctx) {
    const sel = this.selectedCityId;
    if (!sel) return;
    const city = this.cities.find(c => c.id === sel);
    if (!city || !city.territory || city.territory.size === 0) return;

    ctx.beginPath();
    for (const cellId of city.territory) {
      const cell = getOrCreateCell(cellId);
      if (!cell || cell.crossesAntimeridian) continue;
      const wb = cell.worldBoundary;
      ctx.moveTo(wb[0], wb[1]);
      for (let j = 1; j < cell.pointCount; j++) ctx.lineTo(wb[j * 2], wb[j * 2 + 1]);
      ctx.closePath();
    }
    ctx.fillStyle = C.territoryFill;
    ctx.fill();
    ctx.strokeStyle = C.territoryEdge;
    ctx.lineWidth = 1.4 / this.camera.zoom;
    ctx.lineJoin = 'round';
    ctx.stroke();
  }

  // 화면에 보이는 월드 카피들의 X 오프셋(월드 좌표) — 가로 wrap용
  _getVisibleWorldOffsets() {
    const wW = WORLD_BOUNDS.width;
    const wWPx = wW * this.camera.zoom;
    if (wWPx <= 0) return [0];
    const offsets = [];
    for (let n = -2; n <= 2; n++) {
      const screenLeft = n * wWPx + this.camera.x;
      const screenRight = screenLeft + wWPx;
      if (screenRight > -10 && screenLeft < this.camera.viewW + 10) {
        offsets.push(n * wW);
      }
    }
    return offsets.length > 0 ? offsets : [0];
  }

  // ─── 교류 흐름 숫자 라벨 (선택 도시의 상대 도시들 옆) ──
  _drawExchangeLabels(ctx, worldOffsetX = 0) {
    const sel = this.selectedCityId;
    if (!sel) return;
    const list = this.world.exchangesByCity?.get(sel);
    if (!list || !list.length) return;

    ctx.font = `bold 11px ${MONO}`;
    ctx.textBaseline = 'middle';
    ctx.textAlign = 'center';

    for (const ex of list) {
      const other = ex.a.id === sel ? ex.b : ex.a;
      const [wx, wy] = lngLatToWorld(other.lng, other.lat);
      const [sx, sy] = this.camera.worldToScreen(wx + worldOffsetX, wy);
      if (sx < -60 || sx > this.camera.viewW + 60 || sy < -30 || sy > this.camera.viewH + 30) continue;

      const text = formatFlow(ex.total);
      const tw = ctx.measureText(text).width;
      const padX = 5, padY = 3;

      // 위치: 도시 점 아래쪽 (도시 라벨이 오른쪽이라 충돌 안 함)
      const tx = sx;
      const ty = sy + 16;

      const bx = tx - tw / 2 - padX;
      const by = ty - 8;
      const bw = tw + padX * 2;
      const bh = 14 + padY;

      ctx.fillStyle = 'rgba(8, 4, 8, 0.86)';
      ctx.fillRect(bx, by, bw, bh);
      ctx.strokeStyle = 'rgba(255, 110, 120, 0.55)';
      ctx.lineWidth = 1;
      ctx.strokeRect(bx, by, bw, bh);

      ctx.fillStyle = '#ff9aa0';
      ctx.fillText(text, tx, ty);
    }
  }

  _drawGraticule(ctx) {
    const { camera } = this;
    const stepDeg = camera.zoom > 8 ? 5 : (camera.zoom > 3 ? 10 : 30);

    ctx.strokeStyle = C.graticule;
    ctx.lineWidth = 1 / camera.zoom;
    ctx.beginPath();
    for (let lng = -180; lng <= 180; lng += stepDeg) {
      const [x] = lngLatToWorld(lng, 0);
      ctx.moveTo(x, 0);
      ctx.lineTo(x, WORLD_BOUNDS.height);
    }
    for (let lat = -90; lat <= 90; lat += stepDeg) {
      const [, y] = lngLatToWorld(0, lat);
      ctx.moveTo(0, y);
      ctx.lineTo(WORLD_BOUNDS.width, y);
    }
    ctx.stroke();
    // (0° 강조 제거됨)
  }

  // 저줌 — 색 반전: sea는 _drawWorldContent에서 이미 깔렸고, 여기선 land를 검정으로 fill
  // d3-geo가 안티머리디언을 자동 분할 처리
  _drawCoastline(ctx) {
    const { camera, world } = this;
    if (!world.d3geo || !world.projection || !world.landFC) return;
    const lw = 0.6 / camera.zoom;

    ctx.lineJoin = 'round';
    const path = world.d3geo.geoPath(world.projection, ctx);
    path(world.landFC); // beginPath 포함

    // 검정 land fill
    ctx.fillStyle = C.landFill;
    ctx.fill('evenodd');

    // 옅은 outline (sea 사이안과 land 검정의 경계 부각)
    ctx.strokeStyle = C.coastLine;
    ctx.lineWidth = lw;
    ctx.stroke();
  }

  // 고줌 — 헥스 단위 지형 표현
  _drawHexTerrain(ctx, displayRes) {
    const { camera } = this;

    const v = camera.visibleWorldRect();
    const pad = 20;
    const x1 = Math.max(0, v.x1 - pad);
    const y1 = Math.max(0, v.y1 - pad);
    const x2 = Math.min(WORLD_BOUNDS.width, v.x2 + pad);
    const y2 = Math.min(WORLD_BOUNDS.height, v.y2 + pad);
    const visArea = Math.max(0, x2 - x1) * Math.max(0, y2 - y1);

    const [lngMin, latMax] = worldToLngLat(x1, y1);
    const [lngMax, latMin] = worldToLngLat(x2, y2);

    const result = getCellsInBox(latMin, lngMin, latMax, lngMax, displayRes, CONFIG.viewportCellLimit, visArea);
    const { cells, total, capped, skipped } = result;

    let landCount = 0, seaCount = 0;
    for (const c of cells) {
      if (c.terrain === 'land') landCount++;
      else seaCount++;
    }
    this.lastDrawStats = {
      gridCells: cells.length, total, cached: cellCacheSize(),
      capped, skipped, displayRes, landCount, seaCount,
    };

    if (capped || skipped) return;

    const lw = Math.max(0.0008, 0.7 / camera.zoom);

    // 1) Sea hex — outline만 (sea base가 이미 깔려있음)
    this._buildHexPath(ctx, cells, c => c.terrain !== 'land' && !c.crossesAntimeridian);
    ctx.strokeStyle = C.seaEdge;
    ctx.lineWidth = lw * 0.7;
    ctx.lineJoin = 'round';
    ctx.stroke();

    // 2) Land hex — 검정 채움 + 어두운 outline
    this._buildHexPath(ctx, cells, c => c.terrain === 'land' && !c.crossesAntimeridian);
    ctx.fillStyle = C.landFill;
    ctx.fill();
    ctx.strokeStyle = C.landEdge;
    ctx.lineWidth = lw;
    ctx.stroke();

    // 지형 특성 도형(산)·강 시각화 — 현재 비활성. 데이터(cell.feature)는 보존.
    //   재활성 시:  if (camera.zoom >= CONFIG.featuresFromZoom) {
    //                 this._drawFeatureLayers(ctx, cells, v, displayRes);
    //                 this._drawRivers(ctx, v, displayRes);
    //               }

    // 4) 호버 셀 강조 (앰버)
    if (this.hoverHex) {
      const hc = getOrCreateCell(this.hoverHex);
      if (hc && !hc.crossesAntimeridian) {
        ctx.fillStyle = C.hoverFill;
        ctx.strokeStyle = C.hoverEdge;
        ctx.lineWidth = lw * 2.5;
        ctx.beginPath();
        ctx.moveTo(hc.worldBoundary[0], hc.worldBoundary[1]);
        for (let j = 1; j < hc.pointCount; j++) ctx.lineTo(hc.worldBoundary[j * 2], hc.worldBoundary[j * 2 + 1]);
        ctx.closePath();
        ctx.fill();
        ctx.stroke();
      }
    }
  }

  // 셀 배열에서 predicate를 만족하는 셀들의 union path를 만듦
  _buildHexPath(ctx, cells, predicate) {
    ctx.beginPath();
    for (let i = 0; i < cells.length; i++) {
      const c = cells[i];
      if (!predicate(c)) continue;
      const wb = c.worldBoundary;
      ctx.moveTo(wb[0], wb[1]);
      for (let j = 1; j < c.pointCount; j++) ctx.lineTo(wb[j * 2], wb[j * 2 + 1]);
      ctx.closePath();
    }
  }

  // ─── feature(나무·산·사막) 패턴 ─────────────────────
  //   같은 feature의 모든 헥스를 합친 클립 패스를 만들고
  //   그 안에 월드좌표 그리드 정렬 패턴을 그린다.
  //   인접한 같은 feature 헥스는 같은 그리드 좌표에 도형이 놓이므로
  //   자연스럽게 이어져 보인다.
  _drawFeatureLayers(ctx, cells, viewBbox, displayRes) {
    // 현재는 mountain만 시각화 — forest/desert는 cell.feature 데이터에만 보존
    const mountains = [];
    for (const c of cells) {
      if (c.crossesAntimeridian) continue;
      if (c.feature === 'mountain') mountains.push(c);
    }

    if (mountains.length) {
      this._drawWithClip(ctx, mountains,
        viewBbox.x1, viewBbox.y1, viewBbox.x2, viewBbox.y2,
        this._patternMountain, displayRes);
    }
  }

  _drawWithClip(ctx, cells, x1, y1, x2, y2, patternFn, displayRes) {
    ctx.save();
    this._buildHexPath(ctx, cells, () => true);
    ctx.clip();
    patternFn.call(this, ctx, x1, y1, x2, y2, displayRes);
    ctx.restore();
  }

  // 결정론적 jitter
  _hash01(gx, gy, seed = 0) {
    let h = (gx * 374761393 + gy * 668265263 + seed * 1013904223) | 0;
    h = (h ^ (h >>> 13)) * 1274126177 | 0;
    h = h ^ (h >>> 16);
    return ((h >>> 0) / 0xFFFFFFFF);
  }

  // ─── 강 ─────────────────────────────────────────────
  // 사전 생성된 polyline을 cell center를 통과하는 quadratic curve로 그림
  _drawRivers(ctx, viewBbox, displayRes) {
    const rivers = this.world.rivers;
    if (!rivers || !rivers.length) return;

    const v = viewBbox;
    const pad = 5;

    // 라인 두께 — displayRes의 셀 폭에 비례
    const CELL_W = { 3: 10.0, 4: 2.10, 5: 0.77, 6: 0.29 };
    const cellW = CELL_W[displayRes] ?? 1.0;
    const lwGlow = cellW * 0.32;
    const lwLine = cellW * 0.10;

    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';

    ctx.beginPath();
    let drawn = 0;
    for (const river of rivers) {
      const b = river.bbox;
      if (b.x2 < v.x1 - pad || b.x1 > v.x2 + pad || b.y2 < v.y1 - pad || b.y1 > v.y2 + pad) continue;

      const pts = river.points;
      const n = pts.length / 2;
      if (n < 2) continue;

      ctx.moveTo(pts[0], pts[1]);
      if (n === 2) {
        ctx.lineTo(pts[2], pts[3]);
      } else {
        // 중간점 quadratic 스무딩 — i번째 셀 중심을 control point로
        for (let i = 1; i < n - 1; i++) {
          const cx = pts[i * 2], cy = pts[i * 2 + 1];
          const mx = (cx + pts[(i + 1) * 2])     * 0.5;
          const my = (cy + pts[(i + 1) * 2 + 1]) * 0.5;
          ctx.quadraticCurveTo(cx, cy, mx, my);
        }
        ctx.lineTo(pts[(n - 1) * 2], pts[(n - 1) * 2 + 1]);
      }
      drawn++;
    }

    if (drawn === 0) return;

    // 글로우 + 또렷한 라인 (더블 스트로크)
    ctx.strokeStyle = C.riverGlow;
    ctx.lineWidth = lwGlow;
    ctx.stroke();
    ctx.strokeStyle = C.riverLine;
    ctx.lineWidth = lwLine;
    ctx.stroke();
  }

  // 산 — 단색 사이안 outline-only 글리프, 월드 그리드 정렬
  // 인접한 mountain 헥스끼리는 같은 그리드 좌표를 공유하므로 도형이 자연스럽게 이어짐
  // SP/PR을 displayRes에 비례시켜 셀당 ~1.5개 글리프가 나오도록 조정
  _patternMountain(ctx, x1, y1, x2, y2, displayRes) {
    // 각 res의 평균 셀 폭 (월드 단위)
    const CELL_W = { 3: 10.0, 4: 2.10, 5: 0.77, 6: 0.29 };
    const cellW = CELL_W[displayRes] ?? 1.0;
    const SP = cellW * 0.7;      // 셀당 약 1.5개 글리프
    const PR = cellW * 0.22;     // 봉우리 크기 (셀의 ~22%)
    const lwGlow = cellW * 0.10;
    const lwLine = cellW * 0.035;

    const gxStart = Math.floor(x1 / SP) - 1;
    const gxEnd   = Math.ceil(x2 / SP) + 1;
    const gyStart = Math.floor(y1 / SP) - 1;
    const gyEnd   = Math.ceil(y2 / SP) + 1;

    ctx.lineJoin = 'round';
    ctx.beginPath();
    for (let gy = gyStart; gy <= gyEnd; gy++) {
      const rowOffset = (gy & 1) ? SP * 0.5 : 0;
      for (let gx = gxStart; gx <= gxEnd; gx++) {
        const jx = (this._hash01(gx, gy, 11) - 0.5) * SP * 0.30;
        const jy = (this._hash01(gx, gy, 12) - 0.5) * SP * 0.30;
        const wx = gx * SP + rowOffset + jx;
        const wy = gy * SP + jy;
        // V자 같은 라인 글리프
        ctx.moveTo(wx - PR * 0.85, wy + PR * 0.45);
        ctx.lineTo(wx,             wy - PR);
        ctx.lineTo(wx + PR * 0.85, wy + PR * 0.45);
      }
    }
    // 글로우 + 또렷한 라인 (더블 스트로크)
    ctx.strokeStyle = C.featureGlow;
    ctx.lineWidth = lwGlow;
    ctx.stroke();
    ctx.strokeStyle = C.featureLine;
    ctx.lineWidth = lwLine;
    ctx.stroke();
  }

  // ─── 교류선 ──────────────────────────────────────
  // 선택된 도시가 있을 때만 그 도시의 교류 페어들을 빨간 글로우 라인으로
  _drawExchangeLines(ctx) {
    const sel = this.selectedCityId;
    if (!sel) return;
    const list = this.world.exchangesByCity?.get(sel);
    if (!list || !list.length) return;

    // 정규화용 max
    let maxFlow = 0;
    for (const ex of list) if (ex.total > maxFlow) maxFlow = ex.total;
    if (maxFlow <= 0) return;

    ctx.lineCap = 'round';

    // 글로우(굵은) + 라인(가는) 더블 스트로크
    for (const ex of list) {
      const [ax, ay] = lngLatToWorld(ex.a.lng, ex.a.lat);
      const [bx, by] = lngLatToWorld(ex.b.lng, ex.b.lat);
      const rel  = Math.min(1, ex.total / maxFlow);
      const wPx  = 0.6 + 4 * Math.sqrt(rel);   // sqrt 스케일 — 큰 흐름에 너무 두꺼워지지 않게
      const lw   = wPx / this.camera.zoom;

      ctx.strokeStyle = `rgba(255, 60, 70, ${0.18 + 0.18 * rel})`;
      ctx.lineWidth = lw * 3.0;
      ctx.beginPath();
      ctx.moveTo(ax, ay);
      ctx.lineTo(bx, by);
      ctx.stroke();

      ctx.strokeStyle = `rgba(255, 110, 120, ${0.55 + 0.4 * rel})`;
      ctx.lineWidth = lw;
      ctx.stroke();
    }
  }

  _drawCities(ctx) {
    const { camera, cities } = this;

    for (const city of cities) {
      const tier = TIERS[city.tier];
      if (!tier) continue;
      if (camera.zoom < tier.showFromZoom) continue;

      const [wx, wy] = lngLatToWorld(city.lng, city.lat);
      const r = tier.radius / camera.zoom;

      // 외부 글로우 링
      const ringR = r * 2.4;
      ctx.strokeStyle = C.cityRingDim;
      ctx.lineWidth = (tier.glow ? 1.6 : 1.0) / camera.zoom;
      ctx.beginPath();
      ctx.arc(wx, wy, ringR, 0, Math.PI * 2);
      ctx.stroke();

      // 내부 링
      ctx.strokeStyle = C.cityRing;
      ctx.lineWidth = (tier.glow ? 1.2 : 0.8) / camera.zoom;
      ctx.beginPath();
      ctx.arc(wx, wy, r * 1.5, 0, Math.PI * 2);
      ctx.stroke();

      // 코어 점
      ctx.fillStyle = C.cityCore;
      ctx.beginPath();
      ctx.arc(wx, wy, r * 0.8, 0, Math.PI * 2);
      ctx.fill();

      // 호버 강조
      if (this.hoverCity && this.hoverCity.id === city.id) {
        ctx.strokeStyle = C.hoverEdge;
        ctx.lineWidth = 1.6 / camera.zoom;
        ctx.beginPath();
        ctx.arc(wx, wy, r * 3.2, 0, Math.PI * 2);
        ctx.stroke();
      }

      // 선택 강조 (이중 노란 링)
      if (this.selectedCityId === city.id) {
        ctx.strokeStyle = C.selectedRing;
        ctx.lineWidth = 2.0 / camera.zoom;
        ctx.beginPath();
        ctx.arc(wx, wy, r * 3.6, 0, Math.PI * 2);
        ctx.stroke();
        ctx.strokeStyle = 'rgba(255, 220, 100, 0.45)';
        ctx.lineWidth = 4.0 / camera.zoom;
        ctx.beginPath();
        ctx.arc(wx, wy, r * 4.6, 0, Math.PI * 2);
        ctx.stroke();
      }
    }
  }

  _drawCityLabels(ctx, worldOffsetX = 0) {
    const { camera, cities } = this;
    ctx.font = `11px ${MONO}`;
    ctx.textBaseline = 'middle';
    ctx.textAlign = 'left';

    const drawn = [];
    const sorted = cities.slice().sort((a, b) => b.pop - a.pop);

    for (const city of sorted) {
      const tier = TIERS[city.tier];
      if (!tier) continue;
      if (camera.zoom < tier.labelFromZoom) continue;

      const [wx, wy] = lngLatToWorld(city.lng, city.lat);
      const [sx, sy] = camera.worldToScreen(wx + worldOffsetX, wy);
      if (sx < -120 || sx > camera.viewW + 120 || sy < -30 || sy > camera.viewH + 30) continue;

      const text = city.name.toUpperCase();
      const w = ctx.measureText(text).width;
      const padX = 6, padY = 4;
      const lx = sx + tier.radius + 6;
      const ly = sy;

      const box = { x1: lx - padX, y1: ly - 9, x2: lx + w + padX, y2: ly + 9 };
      let collision = false;
      for (const d of drawn) {
        if (box.x1 < d.x2 && box.x2 > d.x1 && box.y1 < d.y2 && box.y2 > d.y1) { collision = true; break; }
      }
      if (collision) continue;
      drawn.push(box);

      // 라벨 박스
      ctx.fillStyle = C.labelBg;
      ctx.fillRect(box.x1, box.y1, box.x2 - box.x1, box.y2 - box.y1);
      ctx.strokeStyle = C.labelBorder;
      ctx.lineWidth = 1;
      ctx.strokeRect(box.x1, box.y1, box.x2 - box.x1, box.y2 - box.y1);

      // 라벨 글자 (티어가 작으면 약하게)
      ctx.fillStyle = (tier.glow || city.tier === 'B') ? C.labelFg : C.labelDim;
      ctx.fillText(text, lx, ly);
    }
  }
}
