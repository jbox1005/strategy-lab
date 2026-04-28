// 도시 간 교류 (인구 흐름) — 인구 피라미드 가중 중력 모델
//
// 각 도시는 "이동 가능 인구(mobilePop)" = sum(연령별 인구 × 이동성 가중치) 를 가진다.
// 청년·경제활동 인구가 도시간 이동을 주도하므로, 같은 인구라도 고령화된 도시는
// 적은 흐름을 만든다.
//
// outflow_A = mobilePop_A × FLOW_RATIO (= 그 도시에서 늘 이동 중인 인구)
// 매력도(attraction): 도착지의 총 인구(pop_B) — 일자리·서비스의 크기
// 가중치: B의 매력 / 거리^α
//
// 교류 가능 조건:
//   - 거리 < 100km : 자동, 모든 페어 가능 (α = 1.5)
//   - 거리 ≥ 100km : 두 도시 군주 간 교역관계(tradePact)가 있어야만 (α = 1.0)
//
// 페어 (A,B) 흐름 = (A→B) + (B→A) 합산을 시각화·통계에 사용.

import { haversineKm } from '../map/projection.js';

const FLOW_RATIO          = 0.02;          // mobilePop의 2%가 늘 외부와 교류
const SHORT_DIST_KM       = 100;           // 직접 교류 임계 (자동)
const VISIBLE_MIN_FLOW    = 30;            // 30명 미만 페어는 시각화 제외

// 교역관계 키 (도시 ID 페어를 정렬해서 고유 키)
export function pactKey(idA, idB) {
  return idA < idB ? `${idA}::${idB}` : `${idB}::${idA}`;
}

function exchangeWeight(A, B, distKm, pacts) {
  // 매력도는 도착지의 총 인구(B.pop) 기반
  if (distKm < SHORT_DIST_KM) {
    return B.pop / Math.pow(Math.max(distKm, 5), 1.5);
  }
  // 원거리 — 두 도시 군주 간 교역관계 필요
  if (pacts && pacts.has(pactKey(A.id, B.id))) {
    return B.pop / distKm;
  }
  return 0;
}

export function computeCityExchanges(cities, tradePacts = null) {
  const t0 = performance.now();
  if (!cities || cities.length === 0) {
    return { exchanges: [], byCity: new Map() };
  }
  const cityById = new Map(cities.map(c => [c.id, c]));

  // 1) 각 도시의 가중치 맵 + 총 가중치
  for (const A of cities) {
    let total = 0;
    const wmap = new Map();
    for (const B of cities) {
      if (A.id === B.id) continue;
      const d = haversineKm(A.lat, A.lng, B.lat, B.lng);
      const w = exchangeWeight(A, B, d, tradePacts);
      if (w > 0) {
        wmap.set(B.id, { weight: w, dist: d });
        total += w;
      }
    }
    A._wmap = wmap;
    A._wtotal = total;
    // outflow는 이동 가능 인구 × 비율. mobilePop이 없으면 fallback으로 pop 사용.
    A._totalFlow = (A.mobilePop ?? A.pop) * FLOW_RATIO;
  }

  // 2) 페어 단위 집계 (ordered key로 dedupe)
  const exchanges = [];
  const byCity = new Map();
  const ensureList = (id) => {
    let list = byCity.get(id);
    if (!list) { list = []; byCity.set(id, list); }
    return list;
  };

  const seen = new Set();
  for (const A of cities) {
    for (const [bid, info] of A._wmap) {
      const key = A.id < bid ? `${A.id}::${bid}` : `${bid}::${A.id}`;
      if (seen.has(key)) continue;
      seen.add(key);

      const B = cityById.get(bid);
      if (!B) continue;

      const flowAB = A._wtotal > 0 ? A._totalFlow * (info.weight / A._wtotal) : 0;
      const wBA    = B._wmap.get(A.id);
      const flowBA = wBA && B._wtotal > 0
        ? B._totalFlow * (wBA.weight / B._wtotal)
        : 0;
      const total = flowAB + flowBA;
      if (total < VISIBLE_MIN_FLOW) continue;

      const ex = {
        key,
        a: A, b: B,
        distance: info.dist,
        flowAB, flowBA, total,
      };
      exchanges.push(ex);
      ensureList(A.id).push(ex);
      ensureList(B.id).push(ex);
    }
  }

  // 3) 임시 필드 정리
  for (const c of cities) {
    delete c._wmap;
    delete c._wtotal;
    delete c._totalFlow;
  }

  // 4) 정렬: 도시별 큰 흐름이 위로
  for (const list of byCity.values()) list.sort((a, b) => b.total - a.total);
  exchanges.sort((a, b) => b.total - a.total);

  console.log(
    `[exchanges] ${exchanges.length}개 페어 ` +
    `(${cities.length}개 도시, pact ${tradePacts?.size ?? 0}, ${(performance.now() - t0).toFixed(0)}ms)`
  );

  return { exchanges, byCity };
}
