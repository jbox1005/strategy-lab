// 2D 팬/줌 카메라
// 화면 좌표 ↔ 월드 좌표 변환을 책임

import { CONFIG } from '../config.js';
import { WORLD_BOUNDS } from './projection.js';

export class Camera {
  constructor(viewW, viewH) {
    this.viewW = viewW;
    this.viewH = viewH;

    // 초기 줌: 월드가 화면에 fit되도록
    this.fitZoom = Math.min(viewW / WORLD_BOUNDS.width, viewH / WORLD_BOUNDS.height);
    this.zoom = this.fitZoom;

    // 가운데 정렬
    this.x = (viewW - WORLD_BOUNDS.width * this.zoom) / 2;
    this.y = (viewH - WORLD_BOUNDS.height * this.zoom) / 2;
  }

  resize(w, h) {
    this.viewW = w;
    this.viewH = h;
    this.fitZoom = Math.min(w / WORLD_BOUNDS.width, h / WORLD_BOUNDS.height);
  }

  worldToScreen(wx, wy) {
    return [wx * this.zoom + this.x, wy * this.zoom + this.y];
  }

  screenToWorld(sx, sy) {
    return [(sx - this.x) / this.zoom, (sy - this.y) / this.zoom];
  }

  pan(dxScreen, dyScreen) {
    this.x += dxScreen;
    this.y += dyScreen;
    this._clamp();
  }

  zoomAt(sx, sy, factor) {
    const [wx, wy] = this.screenToWorld(sx, sy);
    const minZoom = this.fitZoom * CONFIG.minZoomMul;
    this.zoom = Math.max(minZoom, Math.min(CONFIG.maxZoom, this.zoom * factor));
    this.x = sx - wx * this.zoom;
    this.y = sy - wy * this.zoom;
    this._clamp();
  }

  centerOnWorld(wx, wy, zoom) {
    if (zoom !== undefined) this.zoom = zoom;
    this.x = this.viewW / 2 - wx * this.zoom;
    this.y = this.viewH / 2 - wy * this.zoom;
    this._clamp();
  }

  // 월드 영역이 화면 밖으로 너무 빠지지 않도록 고정
  //   X: 가로 무한 wrap — 클램프하지 않고 모듈러 정규화
  //   Y: 남극·북극을 넘어가지 않도록 클램프 (지구 위·아래엔 wrap 없음)
  _clamp() {
    const wW = WORLD_BOUNDS.width * this.zoom;
    const wH = WORLD_BOUNDS.height * this.zoom;

    // X: this.x를 [-wW, 0] 범위로 모듈러 정규화 (renderer가 ±wW 카피로 보강)
    if (wW > 0) {
      // -wW <= this.x < 0 보장 (수치 안정성)
      this.x = ((this.x % wW) + wW) % wW;  // [0, wW)
      if (this.x > 0) this.x -= wW;        // [-wW, 0)
    }

    // Y: 클램프
    if (wH <= this.viewH) {
      this.y = (this.viewH - wH) / 2;
    } else {
      const minY = this.viewH - wH;
      const maxY = 0;
      this.y = Math.max(minY, Math.min(maxY, this.y));
    }
  }

  visibleWorldRect() {
    const [x1, y1] = this.screenToWorld(0, 0);
    const [x2, y2] = this.screenToWorld(this.viewW, this.viewH);
    return { x1, y1, x2, y2 };
  }
}
