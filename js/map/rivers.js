// 강 생성 — high-elev 시드에서 시작해 인접 셀 중 더 낮은 elev로 흐름 추적
//   - 종료 조건: 바다 도달 / 분지(낮은 이웃 없음) / 다른 강과 합류 / 최대 길이
//   - 결과: 각 강은 셀 ID 배열 + 사전 투영된 worldX,Y Float32Array + bbox
//   - 같은 셀이 여러 강에 속하면 첫 강에서 흡수, 이후 강들은 그 셀에서 종료(합류)

import { getOrCreateCell, getH3Module } from './hexgrid.js';

function sampleLandLatLng(mask, w, h, lat, lng) {
  const x = (lng + 180) / 360 * w;
  const y = (90 - lat) / 180 * h;
  const ix = Math.floor(x);
  const iy = Math.floor(y);
  if (ix < 0 || ix >= w || iy < 0 || iy >= h) return false;
  return mask[iy * w + ix] > 0;
}

export async function generateRivers({ landMask, maskSize, resolution, options = {}, onProgress }) {
  const t0 = performance.now();
  const h3 = getH3Module();
  if (!h3) throw new Error('hexgrid not initialized');

  const {
    seedStepDeg     = 1.0,    // 시드 샘플링 격자 (위도/경도 도 단위)
    minSourceElev   = 0.18,   // 시드 최소 elev (이 이하는 시드 후보 제외)
    maxRivers       = 700,    // 최대 강 수
    maxRiverLength  = 90,     // 한 강의 최대 셀 수
    minRiverLength  = 5,      // 너무 짧은 강은 버림
    skipPolarLat    = 70,     // 고위도(±이 위도 이상) 시드 스킵
  } = options;

  // 1) 시드 샘플링 — 모든 land lat/lng 격자점 → 셀 ID dedup
  onProgress?.('강 시드 샘플링 중…');
  const candidateIds = new Set();
  for (let lat = -skipPolarLat; lat <= skipPolarLat; lat += seedStepDeg) {
    for (let lng = -180; lng < 180; lng += seedStepDeg) {
      if (!sampleLandLatLng(landMask, maskSize.w, maskSize.h, lat, lng)) continue;
      const id = h3.latLngToCell(lat, lng, resolution);
      candidateIds.add(id);
    }
  }

  // 2) 각 후보 셀 elev로 정렬해서 상위 시드 추출
  onProgress?.(`강 후보 ${candidateIds.size}셀 평가 중…`);
  const sources = [];
  let i = 0;
  for (const id of candidateIds) {
    const cell = getOrCreateCell(id);
    if (cell.terrain === 'land' && !cell.crossesAntimeridian && cell.elev >= minSourceElev) {
      sources.push({ id, elev: cell.elev });
    }
    if ((++i % 5000) === 0) await new Promise(r => setTimeout(r, 0)); // UI yield
  }
  sources.sort((a, b) => b.elev - a.elev);

  // 3) downhill 트레이스
  onProgress?.(`강 흐름 추적 중 (시드 ${sources.length})…`);
  const rivers = [];
  const riverCells = new Set();

  let yieldCount = 0;
  for (const { id: sourceId } of sources) {
    if (rivers.length >= maxRivers) break;
    if (riverCells.has(sourceId)) continue;

    const path = [sourceId];
    let currentId = sourceId;
    let currentCell = getOrCreateCell(currentId);
    let currentElev = currentCell.elev;
    let aborted = false;
    let endedInSea = false;

    for (let step = 0; step < maxRiverLength; step++) {
      const neighbors = h3.gridDisk(currentId, 1);

      let bestId = null;
      let bestElev = Infinity;
      let seaId = null;

      for (const nbId of neighbors) {
        if (nbId === currentId) continue;
        const nbCell = getOrCreateCell(nbId);
        if (nbCell.crossesAntimeridian) { aborted = true; break; }
        if (nbCell.terrain !== 'land') {
          // 바다 만남 — 즉시 종료(가장 가까운 바다 셀이면 충분)
          seaId = nbId;
          // 바다는 여러 후보 중 더 낮은(=먼) 것보다, 가장 먼저 발견한 인접 바다를 사용
          break;
        }
        if (nbCell.elev < bestElev) {
          bestElev = nbCell.elev;
          bestId = nbId;
        }
      }
      if (aborted) break;

      if (seaId !== null) {
        path.push(seaId);
        endedInSea = true;
        break;
      }
      // 다른 강과 합류
      if (bestId !== null && riverCells.has(bestId)) {
        path.push(bestId);
        endedInSea = true; // 합류도 정상 종료로 간주
        break;
      }
      // 하향 이동 가능
      if (bestId !== null && bestElev < currentElev) {
        path.push(bestId);
        currentId = bestId;
        currentElev = bestElev;
        continue;
      }
      // 분지 — 종료
      break;
    }

    if (aborted) continue;
    if (path.length < minRiverLength) continue;
    if (!endedInSea) continue; // 바다·합류로 끝나지 않은 길은 버림 (분지 잔류 강 제거)

    // 사전 투영된 점 + bbox
    const points = new Float32Array(path.length * 2);
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (let i = 0; i < path.length; i++) {
      const c = getOrCreateCell(path[i]);
      const x = c.worldX, y = c.worldY;
      points[i * 2]     = x;
      points[i * 2 + 1] = y;
      if (x < minX) minX = x;
      if (y < minY) minY = y;
      if (x > maxX) maxX = x;
      if (y > maxY) maxY = y;
    }

    rivers.push({ cellIds: path, points, bbox: { x1: minX, y1: minY, x2: maxX, y2: maxY } });

    // 마킹
    for (const id of path) {
      riverCells.add(id);
      const c = getOrCreateCell(id);
      if (c.terrain === 'land') c.isRiver = true;
    }

    if ((++yieldCount % 30) === 0) {
      onProgress?.(`강 ${rivers.length}/${maxRivers} 생성 중…`);
      await new Promise(r => setTimeout(r, 0));
    }
  }

  console.log(
    `[rivers] ${rivers.length}개 강, ${riverCells.size}셀 ` +
    `(시드 ${sources.length}, 후보 ${candidateIds.size}, ${(performance.now() - t0).toFixed(0)}ms)`
  );

  return { rivers, riverCells };
}
