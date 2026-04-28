// Equirectangular projection — 가장 단순하고 디버깅 용이
// 추후 globe(orthographic) 모드로 확장 가능

import { CONFIG } from '../config.js';

const WORLD_W = CONFIG.worldWidth;
const WORLD_H = CONFIG.worldHeight;

// (경도, 위도) → 월드 좌표 (x, y)
export function lngLatToWorld(lng, lat) {
  const x = (lng + 180) / 360 * WORLD_W;
  const y = (90 - lat) / 180 * WORLD_H;
  return [x, y];
}

// 월드 좌표 → (경도, 위도)
export function worldToLngLat(x, y) {
  const lng = x / WORLD_W * 360 - 180;
  const lat = 90 - y / WORLD_H * 180;
  return [lng, lat];
}

// 두 위경도 좌표 사이 거리 (km, Haversine)
export function haversineKm(lat1, lng1, lat2, lng2) {
  const R = 6371;
  const dLat = (lat2 - lat1) * Math.PI / 180;
  const dLng = (lng2 - lng1) * Math.PI / 180;
  const a = Math.sin(dLat / 2) ** 2 +
            Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) *
            Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(a));
}

export const WORLD_BOUNDS = { width: WORLD_W, height: WORLD_H };

// 월드 X를 [0, WORLD_W) 범위로 wrap (가로 무한 스크롤)
export function wrapWorldX(wx) {
  return ((wx % WORLD_W) + WORLD_W) % WORLD_W;
}
