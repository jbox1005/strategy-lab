// 인구 피라미드 모델
//
// 각 도시는 80세까지의 연령별·남녀별 인구 배열(Float32Array(80))을 가진다.
// 통계는 국가별 5세 버킷 × 16개 (0-4, 5-9, …, 75-79) → 각 버킷을 5등분해 개별 연령에 균등 배분.
// 게임 시간(1시간 = 1년) 진행 시 모든 연령을 한 칸씩 시프트하면 자연스러운 노화가 됨.
//
// 데이터 출처:
//   - 1차: UN WPP 2024 (OWID 재배포, 2023년 실측치, /js/data/wpp_2026.json) — 113개국
//   - 2차 fallback: 5개 휴리스틱 프로파일 (UN 데이터 미커버 국가용)
//
// "이동성(mobility)"는 연령에 따른 가중치 — 청년/경제활동 인구가 도시 간 이동을 주도.

// ─── UN WPP 실데이터 ───────────────────────────────
let _wppByCountry = null;
let _wppMeta = null;

export async function loadWppData(url = 'js/data/wpp_2026.json') {
  if (_wppByCountry) return { byCountry: _wppByCountry, meta: _wppMeta };
  const res = await fetch(url);
  if (!res.ok) throw new Error(`WPP 데이터 로딩 실패 (${res.status}): ${url}`);
  const data = await res.json();
  _wppByCountry = data.byCountry;
  _wppMeta = data._meta;
  return data;
}

export function hasWppFor(country) {
  return !!(_wppByCountry && _wppByCountry[country]);
}

// ─── 5세 버킷 프로파일 (16개 × 5세 = 0..79세 분포) ─────────
//   각 항목은 상대 비율 — buildPyramid에서 city.pop으로 정규화.
//   합계는 100 근처지만 정확할 필요 없음.
const PROFILES = {
  young_growing: {
    label: '고출산·젊은인구 (사하라 이남, 남아시아)',
    bucket5: [13, 12, 11, 10, 9, 8, 7, 6, 5, 4, 4, 3, 3, 2, 2, 1],
  },
  young_stable: {
    label: '안정 성장형 (라틴아메리카·중동·동남아 일부)',
    bucket5: [8, 8, 8, 8, 8, 8, 7, 7, 7, 6, 5, 5, 4, 3, 3, 2],
  },
  mature: {
    label: '성숙형 (북미·서유럽·러시아)',
    bucket5: [6, 6, 6, 6, 6, 7, 7, 7, 7, 7, 7, 7, 6, 6, 5, 4],
  },
  aging: {
    label: '고령화 진행 (한국·중국·독일·이탈리아)',
    bucket5: [4, 5, 5, 5, 6, 6, 7, 7, 8, 8, 9, 8, 8, 7, 5, 4],
  },
  super_aging: {
    label: '초고령 (일본)',
    bucket5: [3, 4, 4, 4, 5, 5, 5, 6, 7, 7, 7, 7, 7, 8, 9, 9],
  },
};

// ─── 국가 → 프로파일 매핑 ──────────────────────────────
const COUNTRY_PROFILE_RAW = {
  super_aging:    ['JP'],
  aging:          ['KR','CN','HK','TW','SG','DE','IT','ES','PT','GR'],
  mature:         [
    'US','CA','AU','NZ','GB','FR','RU','UA','BY',
    'AT','CH','BE','NL','SE','NO','FI','DK','IE',
    'PL','HU','CZ','RO','AR','CL','UY',
  ],
  young_stable:   [
    'BR','MX','TR','IR','IL','LB','JO','EG','MA','TN','DZ','ZA',
    'TH','VN','MY','AZ','AM','GE','KZ','UZ',
    'CO','VE','EC','BO','PY','PE',
    'KP', // 북한 — 데이터 부족, 일단 안정형
  ],
  young_growing:  [
    'IN','PK','BD','NG','ET','KE','TZ','AO','CI','SD','GH',
    'KH','LA','MM','NP','LK','MN','AF','SY','IQ',
    'SA','KW','AE','QA','PH','ID','RU',  // 일부 보정
  ],
};

// 평면화
const COUNTRY_TO_PROFILE = {};
for (const [profile, codes] of Object.entries(COUNTRY_PROFILE_RAW)) {
  for (const code of codes) COUNTRY_TO_PROFILE[code] = profile;
}
const DEFAULT_PROFILE = 'mature';

export function profileFor(country) {
  return COUNTRY_TO_PROFILE[country] ?? DEFAULT_PROFILE;
}

// ─── 성비(M/F at age) ─────────────────────────────────
//   출생 시 약 1.05:1 (남:여), 50대 즈음 균형, 70대 이상은 여성이 다수
function maleFraction(age) {
  if (age < 20) return 0.512;   // 약 51.2% 남
  if (age < 50) return 0.502;
  if (age < 65) return 0.485;
  if (age < 75) return 0.450;
  return 0.395;                  // 75+ 여성 우위
}

// ─── 도시 규모 기반 백분위(0~1) 부여 ─────────────────────
//   국가 내에서 인구 큰 도시 = 1.0, 작은 도시 = 0.0, 단일도시 = 0.5
//   buildPyramid에서 이 값으로 베이스라인 분포를 skew (상위=젊게, 하위=늙게)
export function assignCitySizeRanks(cities) {
  const byCountry = new Map();
  for (const c of cities) {
    if (!byCountry.has(c.country)) byCountry.set(c.country, []);
    byCountry.get(c.country).push(c);
  }
  for (const [, list] of byCountry) {
    if (list.length === 1) {
      list[0].sizeRank = 0.5;
      list[0].sizeRankInfo = { rank: 1, total: 1 };
      continue;
    }
    list.sort((a, b) => b.pop - a.pop);
    const n = list.length;
    for (let i = 0; i < n; i++) {
      list[i].sizeRank     = 1 - i / (n - 1);
      list[i].sizeRankInfo = { rank: i + 1, total: n };
    }
  }
}

// 국가 베이스라인 분포에 도시 규모 skew 적용
//   sizeRank 1 → 가장 어린 버킷 +maxSkew, 가장 늙은 -maxSkew
//   sizeRank 0 → 반대
//   sizeRank 0.5 → 변동 없음
//   합은 보존(정규화)
function skewBucketsByCitySize(buckets, sizeRank, maxSkew = 0.25) {
  const skew = (sizeRank - 0.5) * 2 * maxSkew;
  if (Math.abs(skew) < 1e-6) return buckets;

  const N = buckets.length;
  const halfRange = (N - 1) / 2;
  const orig = buckets.reduce((a, x) => a + x, 0);

  const adjusted = new Array(N);
  let sum = 0;
  for (let b = 0; b < N; b++) {
    const ageRel = (b - halfRange) / halfRange;        // -1(youngest) .. +1(oldest)
    const mult   = Math.max(0.05, 1 - ageRel * skew);  // 음수 가드
    adjusted[b] = buckets[b] * mult;
    sum += adjusted[b];
  }
  // 합 보존 정규화
  if (sum > 0) {
    const factor = orig / sum;
    for (let b = 0; b < N; b++) adjusted[b] *= factor;
  }
  return adjusted;
}

// ─── 도시 → 80세 × 남녀 피라미드 생성 ────────────────────
//   1순위: UN WPP 실데이터 (국가별 분포)
//   2순위: 5개 휴리스틱 프로파일 (UN 데이터 없는 경우)
//   + 도시 규모 skew (sizeRank 부여되어 있으면)
export function buildPyramid(city) {
  let buckets;
  let source;
  let profileTag;

  if (_wppByCountry && _wppByCountry[city.country]) {
    buckets = _wppByCountry[city.country];
    source = 'wpp';
    profileTag = `wpp:${city.country}`;
  } else {
    const profileKey = profileFor(city.country);
    buckets = PROFILES[profileKey].bucket5;
    source = 'profile';
    profileTag = profileKey;
  }

  // 도시 규모 skew (국가 내 인구 순위에 따라 분포 기울기)
  if (typeof city.sizeRank === 'number') {
    buckets = skewBucketsByCitySize(buckets, city.sizeRank);
  }

  const total = buckets.reduce((a, b) => a + b, 0);
  const male   = new Float32Array(80);
  const female = new Float32Array(80);

  for (let b = 0; b < 16; b++) {
    const bucketTotal = city.pop * (buckets[b] / total);
    const perAge = bucketTotal / 5;          // 5세 균등 분배
    for (let i = 0; i < 5; i++) {
      const age = b * 5 + i;
      const mFrac = maleFraction(age);
      male[age]   = perAge * mFrac;
      female[age] = perAge * (1 - mFrac);
    }
  }
  return { male, female, profile: profileTag, source };
}

// ─── 이동성(mobility) — 연령별 도시간 이동 가중치 ──────
//   유아·노년: 매우 낮음, 20대: 가장 높음, 30대: 높음, 40-50대: 중간
function mobilityFactor(age) {
  if (age < 15) return 0.10;
  if (age < 20) return 0.55;
  if (age < 25) return 1.60;
  if (age < 30) return 1.45;
  if (age < 40) return 1.10;
  if (age < 50) return 0.75;
  if (age < 60) return 0.55;
  if (age < 70) return 0.25;
  return 0.10;
}

// 이동 가능 인구 (pyramid 기반 가중 합) — 교류 outflow 계산에 사용
export function computeMobilePop(pyramid) {
  let total = 0;
  for (let age = 0; age < 80; age++) {
    const f = mobilityFactor(age);
    total += (pyramid.male[age] + pyramid.female[age]) * f;
  }
  return total;
}

// 경제활동 인구 (20-59) — 향후 세금/생산 계산용
export function computeEconomicPop(pyramid) {
  let total = 0;
  for (let age = 20; age < 60; age++) {
    total += pyramid.male[age] + pyramid.female[age];
  }
  return total;
}

// 징집 가능 인구 (20-39, 성별 옵션) — 향후 군사 계산용
export function computeDraftablePop(pyramid, includeFemale = false) {
  let total = 0;
  for (let age = 20; age < 40; age++) {
    total += pyramid.male[age];
    if (includeFemale) total += pyramid.female[age];
  }
  return total;
}

// 디버그용: 5세 버킷 합계 반환
export function bucketize5(pyramid) {
  const m = new Float32Array(16), f = new Float32Array(16);
  for (let age = 0; age < 80; age++) {
    const b = Math.floor(age / 5);
    m[b] += pyramid.male[age];
    f[b] += pyramid.female[age];
  }
  return { male: m, female: f };
}
