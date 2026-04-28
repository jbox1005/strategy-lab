// 전략랩 — 메인 진입점
// 1) 월드 데이터 로딩 (육지 윤곽선 + H3 모듈 초기화 + 도시 헥스 스냅)
// 2) 카메라 + 렌더러 + 입력 컨트롤 연결
// 3) HUD 업데이트 (줌, 좌표, 호버 정보, 캐시)
// 4) 시작 도시(서울) 중심으로 카메라 정렬

import { CONFIG } from './config.js';
import { CITIES as RAW_CITIES, CITY_STATS } from './data/cities.js';
import { TIERS } from './data/tiers.js';
import { computeCityExchanges, pactKey } from './data/exchanges.js';
import { bucketize5, profileFor } from './data/demographics.js';
import { loadWorld } from './map/world.js';
import { lngLatToCellId, cellCacheSize, pickDisplayResolution, getOrCreateCell } from './map/hexgrid.js';
import { Camera } from './map/camera.js';
import { Renderer } from './map/renderer.js';
import { lngLatToWorld, worldToLngLat, wrapWorldX, WORLD_BOUNDS } from './map/projection.js';
import { setupControls } from './input/controls.js';

const canvas = document.getElementById('map-canvas');
const $loader = document.getElementById('loader');
const $loaderMsg = document.getElementById('loader-msg');
const $status = document.getElementById('status-text');
const $zoom = document.getElementById('zoom-text');
const $coord = document.getElementById('coord-text');
const $hover = document.getElementById('hover-text');

const setLoader = (msg) => { $loaderMsg.textContent = msg; };
const hideLoader = () => $loader.classList.remove('loader-visible');

// ─── Canvas DPR 설정 ────────────────────────────────────
function fitCanvas() {
  const dpr = window.devicePixelRatio || 1;
  const w = window.innerWidth;
  const h = window.innerHeight;
  canvas.style.width = w + 'px';
  canvas.style.height = h + 'px';
  canvas.width = Math.round(w * dpr);
  canvas.height = Math.round(h * dpr);
  return { w, h, dpr };
}

(async function init() {
  try {
    const { w, h } = fitCanvas();

    // ─── 월드 데이터 로딩 (육지 + H3 init + 도시 스냅) ─
    setLoader('지구 데이터를 불러오는 중…');
    const world = await loadWorld({
      resolution: CONFIG.hexResolution,
      cities: RAW_CITIES,
      onProgress: setLoader,
    });
    const cities = world.cities; // 스냅 + 중복제거된 도시들

    setLoader('렌더러 초기화 중…');

    // ─── 카메라 ──────────────────────────────────────
    const camera = new Camera(w, h);

    // ─── 렌더러 ──────────────────────────────────────
    const renderer = new Renderer(canvas, world, camera, cities);

    // ─── 시작 도시(서울) 중심 + 적당한 줌 ─────────────
    const startCity = cities.find(c => c.nameEn === CONFIG.startCity)
                   ?? cities.find(c => c.tier === 'S');
    if (startCity) {
      const [sx, sy] = lngLatToWorld(startCity.lng, startCity.lat);
      // res 5에서 그리드가 보이려면 줌이 좀 커야 함
      camera.centerOnWorld(sx, sy, 12);
    }

    // ─── 호버 처리 ───────────────────────────────────
    function findHoveredCity(sx, sy) {
      const [rawWx, wy] = camera.screenToWorld(sx, sy);
      const wx = wrapWorldX(rawWx); // 가로 wrap 보정
      let best = null, bestDist = Infinity;
      for (const city of cities) {
        const tier = TIERS[city.tier];
        if (!tier || camera.zoom < tier.showFromZoom) continue;
        const [cx, cy] = lngLatToWorld(city.lng, city.lat);
        // 가로 wrap을 고려한 최단거리
        let dx = cx - wx;
        if (dx > WORLD_BOUNDS.width / 2)  dx -= WORLD_BOUNDS.width;
        if (dx < -WORLD_BOUNDS.width / 2) dx += WORLD_BOUNDS.width;
        const dy = cy - wy;
        const d2 = dx * dx + dy * dy;
        const r = (tier.radius + 4) / camera.zoom;
        if (d2 < r * r && d2 < bestDist) { bestDist = d2; best = city; }
      }
      return best;
    }

    function findHoveredHex(sx, sy) {
      const [rawWx, wy] = camera.screenToWorld(sx, sy);
      if (wy < 0 || wy > WORLD_BOUNDS.height) return null;
      const wx = wrapWorldX(rawWx);
      const [lng, lat] = worldToLngLat(wx, wy);
      // 화면에 그려진 셀과 동일한 해상도로 강조 (기본 단위 캡 적용)
      const dispRes = pickDisplayResolution(camera.zoom, CONFIG.displayResLadder, CONFIG.hexResolution);
      if (dispRes < 0) return null;
      try { return lngLatToCellId(lng, lat, dispRes); }
      catch { return null; }
    }

    function updateHover(sx, sy) {
      if (sx < 0 || sy < 0) {
        renderer.setHover({ hex: null, city: null });
        $hover.textContent = '육각 셀 위에 마우스를 올려보세요';
        $coord.textContent = '—';
        return;
      }

      const hoveredCity = findHoveredCity(sx, sy);
      const hoveredHex  = findHoveredHex(sx, sy);
      renderer.setHover({ hex: hoveredHex, city: hoveredCity });

      const [rawWx, wy] = camera.screenToWorld(sx, sy);
      if (wy >= 0 && wy <= WORLD_BOUNDS.height) {
        const wx = wrapWorldX(rawWx);
        const [lng, lat] = worldToLngLat(wx, wy);
        $coord.textContent = `${lat.toFixed(2)}°, ${lng.toFixed(2)}°`;
      } else {
        $coord.textContent = '—';
      }

      if (hoveredCity) {
        const tier = TIERS[hoveredCity.tier];
        const popM = (hoveredCity.pop / 10000).toFixed(0);
        let txt = `🏙 ${hoveredCity.name} (${hoveredCity.nameEn}) · ${hoveredCity.country} · ` +
                  `${tier.label} · 인구 ${popM}만`;
        if (hoveredCity.mergedCount > 1) {
          txt += ` · 같은 셀에서 ${hoveredCity.mergedCount - 1}개 병합 (${hoveredCity.mergedNames.join(', ')})`;
        }
        $hover.textContent = txt;
      } else if (hoveredHex) {
        const stats = renderer.lastDrawStats;
        const resTag = stats.displayRes >= 0 ? `res ${stats.displayRes}` : '그리드 숨김';
        const capTag = stats.skipped ? ' (사전스킵)' : (stats.capped ? ' (한도초과)' : '');
        const cellObj = getOrCreateCell(hoveredHex);
        const terrainTag = cellObj?.terrain ? ` · ${cellObj.terrain}` : '';
        const featureTag = cellObj?.feature && cellObj.feature !== 'plain' ? ` / ${cellObj.feature}` : '';
        const riverTag = cellObj?.isRiver ? ' / river' : '';
        $hover.textContent =
          `⬡ ${hoveredHex}${terrainTag}${featureTag}${riverTag} · ${resTag} · 뷰포트 ${stats.gridCells}셀${capTag} · 캐시 ${cellCacheSize()}`;
      } else {
        $hover.textContent = '육각 셀 위에 마우스를 올려보세요';
      }
    }

    // ─── 도시 선택 ─────────────────────────────────
    const $cityPanel    = document.getElementById('city-panel');
    const $cityName     = document.getElementById('city-name');
    const $cityRank     = document.getElementById('city-rank');
    const $cityPop      = document.getElementById('city-pop');
    const $cityTerr     = document.getElementById('city-territory');
    const $cityEcon     = document.getElementById('city-econ');
    const $cityMobile   = document.getElementById('city-mobile');
    const $cityDraft    = document.getElementById('city-draft');
    const $cityExCount  = document.getElementById('city-exchanges');
    const $exchangeList = document.getElementById('exchange-list');
    const $pyramidCv    = document.getElementById('pyramid-canvas');
    const $pyramidProf  = document.getElementById('pyramid-profile');

    // ─── 피라미드 캔버스 그리기 ───────────────────────
    const PROFILE_LABEL = {
      young_growing: '고출산·젊은인구',
      young_stable:  '안정 성장형',
      mature:        '성숙형',
      aging:         '고령화형',
      super_aging:   '초고령',
    };

    function drawPyramid(canvas, city) {
      const dpr = window.devicePixelRatio || 1;
      const cssW = canvas.clientWidth || canvas.width;
      const cssH = canvas.clientHeight || canvas.height;
      if (canvas.width !== Math.round(cssW * dpr)) {
        canvas.width = Math.round(cssW * dpr);
        canvas.height = Math.round(cssH * dpr);
      }
      const ctx = canvas.getContext('2d');
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, cssW, cssH);

      const buckets = bucketize5(city.pyramid);
      let maxB = 0;
      for (let i = 0; i < 16; i++) {
        if (buckets.male[i]   > maxB) maxB = buckets.male[i];
        if (buckets.female[i] > maxB) maxB = buckets.female[i];
      }
      if (maxB <= 0) return;

      const padTop = 14, padBot = 4, padSide = 4;
      const usableH = cssH - padTop - padBot;
      const rowH = usableH / 16;
      const labelW = 36;
      const halfW = (cssW - labelW - padSide * 2) / 2;
      const cx = cssW / 2;

      // 헤더
      ctx.font = '9px "JetBrains Mono", "Consolas", monospace';
      ctx.fillStyle = 'rgba(140, 220, 230, 0.85)';
      ctx.textBaseline = 'top';
      ctx.textAlign = 'right';
      ctx.fillText('남', cx - labelW / 2 - 4, 2);
      ctx.textAlign = 'left';
      ctx.fillStyle = 'rgba(245, 160, 200, 0.85)';
      ctx.fillText('여', cx + labelW / 2 + 4, 2);

      ctx.textAlign = 'center';
      ctx.fillStyle = 'rgba(180, 220, 220, 0.65)';
      ctx.fillText('연령', cx, 2);

      // 행
      for (let b = 0; b < 16; b++) {
        // 0-4가 아래(b=0이 아래)
        const yTop = padTop + (15 - b) * rowH;
        const barH = Math.max(1, rowH - 1);

        const mw = (buckets.male[b]   / maxB) * halfW;
        const fw = (buckets.female[b] / maxB) * halfW;

        // 남(좌, 사이안)
        ctx.fillStyle = 'rgba(90, 200, 220, 0.85)';
        ctx.fillRect(cx - labelW / 2 - mw, yTop + 1, mw, barH - 1);
        // 여(우, 핑크)
        ctx.fillStyle = 'rgba(245, 130, 180, 0.85)';
        ctx.fillRect(cx + labelW / 2, yTop + 1, fw, barH - 1);

        // 연령 라벨
        ctx.fillStyle = 'rgba(180, 220, 220, 0.55)';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.font = '8px "JetBrains Mono", "Consolas", monospace';
        const lbl = b === 15 ? '75+' : `${b * 5}-${b * 5 + 4}`;
        ctx.fillText(lbl, cx, yTop + barH / 2);
      }
    }

    // 인구 단위 변환 (만 단위)
    function fmt만(n) {
      const m = n / 10000;
      if (m >= 100) return m.toFixed(0) + '만';
      if (m >= 10)  return m.toFixed(1) + '만';
      if (m >= 1)   return m.toFixed(2) + '만';
      return Math.round(n).toLocaleString('ko-KR');
    }

    function selectCity(id) {
      renderer.setSelectedCity(id);
      if (!id) { $cityPanel.style.display = 'none'; return; }
      const city = cities.find(c => c.id === id);
      if (!city) { $cityPanel.style.display = 'none'; return; }

      $cityPanel.style.display = '';
      $cityName.textContent = `${city.name} (${city.nameEn}) · ${city.country}`;
      if (city.sizeRankInfo) {
        const { rank, total } = city.sizeRankInfo;
        const tag = total === 1 ? '단일' : (rank === 1 ? '최대' : (rank === total ? '최소' : ''));
        $cityRank.textContent = total === 1 ? `1/1` : `${rank}/${total}${tag ? ` (${tag})` : ''}`;
      } else {
        $cityRank.textContent = '—';
      }
      $cityPop.textContent    = fmt만(city.pop);
      const tCount = city.territory?.size ?? 0;
      const tTarget = city.territorySize ?? TIERS[city.tier]?.territorySize ?? 1;
      const tag = tCount < tTarget ? ` (목표 ${tTarget})` : '';
      $cityTerr.textContent   = `${tCount}셀${tag}`;
      $cityEcon.textContent   = fmt만(city.economicPop ?? 0);
      $cityMobile.textContent = fmt만(city.mobilePop ?? 0);
      $cityDraft.textContent  = fmt만(city.draftablePop ?? 0) + ' (남)';

      // 피라미드
      if (city.pyramid) {
        drawPyramid($pyramidCv, city);
        if (city.pyramid.source === 'wpp') {
          $pyramidProf.textContent = `UN WPP · ${city.country}`;
        } else {
          const profKey = city.pyramid.profile ?? profileFor(city.country);
          $pyramidProf.textContent = `[fallback] ${PROFILE_LABEL[profKey] ?? profKey}`;
        }
      }

      const list = world.exchangesByCity?.get(id) ?? [];
      $cityExCount.textContent = `${list.length}개 도시`;

      $exchangeList.innerHTML = '';
      const top = list.slice(0, 12);
      for (const ex of top) {
        const other = ex.a.id === id ? ex.b : ex.a;
        const row = document.createElement('div');
        row.className = 'exchange-row';
        const flow = ex.total >= 1000
          ? (ex.total / 1000).toFixed(1) + 'K'
          : Math.round(ex.total).toString();
        row.innerHTML =
          `<span class="ex-name">${other.name}</span>` +
          `<span class="ex-meta">${ex.distance.toFixed(0)}km · ${flow}명</span>`;
        $exchangeList.appendChild(row);
      }
      if (list.length > 12) {
        const more = document.createElement('div');
        more.className = 'exchange-row exchange-more';
        more.textContent = `… 외 ${list.length - 12}개`;
        $exchangeList.appendChild(more);
      }
    }

    function handleClick(sx, sy) {
      const city = findHoveredCity(sx, sy);
      selectCity(city ? city.id : null);
    }

    // ─── 입력 컨트롤 연결 ─────────────────────────────
    setupControls({
      canvas, camera, world, cities, renderer,
      onHover: updateHover,
      onClick: handleClick,
    });

    // ─── HUD: 줌 표시 ────────────────────────────────
    function tickHud() {
      $zoom.textContent = camera.zoom.toFixed(2) + 'x';
      requestAnimationFrame(tickHud);
    }
    tickHud();

    // ─── 리사이즈 ────────────────────────────────────
    window.addEventListener('resize', () => {
      const { w, h } = fitCanvas();
      camera.resize(w, h);
      renderer.dpr = window.devicePixelRatio || 1;
      renderer.requestRender();
    });

    // ─── 시작 ────────────────────────────────────────
    $status.textContent =
      `준비완료 · 도시 ${cities.length}개 ` +
      `(원본 ${CITY_STATS.total} → 병합셀 ${world.citySnap.mergedCells}, 제거 ${world.citySnap.droppedCities}) · ` +
      `res ${world.resolution}`;
    console.log('[전략랩] 원본 티어:', CITY_STATS.byTier);
    console.log('[전략랩] 스냅 후:', cities.length, '도시');
    hideLoader();
    renderer.requestRender();

    // ─── 교역관계 변경 시 재계산 ──────────────────────
    function recomputeExchanges() {
      const r = computeCityExchanges(cities, world.tradePacts);
      world.exchanges = r.exchanges;
      world.exchangesByCity = r.byCity;
      // 선택된 도시 패널 갱신
      if (renderer.selectedCityId) selectCity(renderer.selectedCityId);
      renderer.requestRender();
    }

    function findCityByName(name) {
      if (!name) return null;
      const lower = name.toLowerCase();
      return cities.find(c => c.name === name)
          ?? cities.find(c => c.nameEn?.toLowerCase() === lower)
          ?? cities.find(c => c.id === name);
    }

    // ─── 디버그/테스트용 전역 API ────────────────────
    window.__game = {
      camera, renderer, world, cities,

      // 도시 검색
      city: findCityByName,

      // 교역관계 추가/삭제 — 한글명·영문명·ID 모두 가능
      addPact(a, b) {
        const A = findCityByName(a), B = findCityByName(b);
        if (!A || !B) { console.warn('city not found:', a, b); return; }
        if (A.id === B.id) { console.warn('same city'); return; }
        world.tradePacts.add(pactKey(A.id, B.id));
        console.log(`[pact+] ${A.name} ↔ ${B.name}`);
        recomputeExchanges();
      },
      removePact(a, b) {
        const A = findCityByName(a), B = findCityByName(b);
        if (!A || !B) return;
        world.tradePacts.delete(pactKey(A.id, B.id));
        console.log(`[pact-] ${A.name} ↔ ${B.name}`);
        recomputeExchanges();
      },
      clearPacts() {
        world.tradePacts.clear();
        console.log('[pact] 모든 교역관계 해제');
        recomputeExchanges();
      },
      listPacts() {
        for (const k of world.tradePacts) {
          const [a, b] = k.split('::');
          const A = cities.find(c => c.id === a);
          const B = cities.find(c => c.id === b);
          console.log(`  ${A?.name ?? a} ↔ ${B?.name ?? b}`);
        }
        return world.tradePacts.size;
      },
    };
  } catch (err) {
    console.error(err);
    setLoader('오류: ' + err.message);
    $status.textContent = '오류 발생';
  }
})();
