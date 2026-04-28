// 마우스 + 터치 입력 (Pointer Events 사용)
//   - 단일 포인터: 드래그 팬 + 호버 + 클릭
//   - 두 포인터: 핀치 줌 + 두 손가락 패닝
//   - 마우스 휠: 줌, 더블클릭: 줌인
//   - 키보드: 화살표 팬, +/- 줌

import { CONFIG } from '../config.js';

export function setupControls({ canvas, camera, world, cities, renderer, onHover, onClick }) {
  const pointers = new Map(); // pointerId → [clientX, clientY]
  let dragging = false;
  let dragMoved = false;
  let lastX = 0, lastY = 0;
  let downX = 0, downY = 0;

  // 핀치 상태
  let pinchActive = false;
  let everPinched = false;       // 이번 제스처에서 핀치를 거쳤는지 (클릭 억제용)
  let pinchLastDist = 0;
  let pinchMidX = 0, pinchMidY = 0;

  const getPos = (e) => {
    const rect = canvas.getBoundingClientRect();
    return [e.clientX - rect.left, e.clientY - rect.top];
  };

  const computePinch = () => {
    const pts = [...pointers.values()];
    const ax = pts[0][0], ay = pts[0][1];
    const bx = pts[1][0], by = pts[1][1];
    const rect = canvas.getBoundingClientRect();
    return {
      dist: Math.hypot(ax - bx, ay - by),
      midX: (ax + bx) / 2 - rect.left,
      midY: (ay + by) / 2 - rect.top,
    };
  };

  // ─── pointerdown ─────────────────────────────────
  canvas.addEventListener('pointerdown', (e) => {
    canvas.setPointerCapture(e.pointerId);
    pointers.set(e.pointerId, [e.clientX, e.clientY]);

    if (pointers.size === 2) {
      // 핀치 진입
      pinchActive = true;
      everPinched = true;
      dragging = false;
      const p = computePinch();
      pinchLastDist = p.dist;
      pinchMidX = p.midX;
      pinchMidY = p.midY;
    } else if (pointers.size === 1) {
      // 단일 드래그 시작
      dragging = true;
      dragMoved = false;
      everPinched = false;
      const [sx, sy] = getPos(e);
      lastX = sx;
      lastY = sy;
      downX = sx;
      downY = sy;
    }
  });

  // ─── pointermove ─────────────────────────────────
  canvas.addEventListener('pointermove', (e) => {
    const [sx, sy] = getPos(e);

    if (pointers.has(e.pointerId)) {
      pointers.set(e.pointerId, [e.clientX, e.clientY]);
    }

    if (pinchActive && pointers.size === 2) {
      const p = computePinch();
      if (pinchLastDist > 0) {
        // 줌: 거리 비율
        const factor = p.dist / pinchLastDist;
        camera.zoomAt(p.midX, p.midY, factor);
        // 패닝: 미드포인트 이동분
        const dx = p.midX - pinchMidX;
        const dy = p.midY - pinchMidY;
        if (dx !== 0 || dy !== 0) camera.pan(dx, dy);
        renderer.requestRender();
      }
      pinchLastDist = p.dist;
      pinchMidX = p.midX;
      pinchMidY = p.midY;
      return;
    }

    if (dragging && pointers.size === 1) {
      const dx = sx - lastX;
      const dy = sy - lastY;
      if (Math.abs(sx - downX) + Math.abs(sy - downY) > 3) dragMoved = true;
      camera.pan(dx, dy);
      lastX = sx;
      lastY = sy;
      renderer.requestRender();
    }

    onHover?.(sx, sy);
  });

  // ─── pointerup / pointercancel ───────────────────
  const onPointerEnd = (e) => {
    const wasSingleDrag = dragging && pointers.size === 1 && !pinchActive;
    const moved = dragMoved;
    const pinchedThisGesture = everPinched;

    pointers.delete(e.pointerId);
    try { canvas.releasePointerCapture(e.pointerId); } catch {}

    if (pointers.size < 2) {
      pinchActive = false;
      pinchLastDist = 0;
    }

    if (pointers.size === 1) {
      // 핀치에서 한 손가락 떨어짐 → 남은 손가락으로 드래그 재개 (점프 없게 lastX/Y 재설정)
      const [pos] = pointers.values();
      const rect = canvas.getBoundingClientRect();
      lastX = pos[0] - rect.left;
      lastY = pos[1] - rect.top;
      downX = lastX;
      downY = lastY;
      dragging = true;
      dragMoved = false;
    } else if (pointers.size === 0) {
      dragging = false;
      // 단일 포인터로 끝났고, 움직이지 않았고, 핀치도 안 거쳤으면 클릭
      if (wasSingleDrag && !moved && !pinchedThisGesture) {
        const [sx, sy] = getPos(e);
        onClick?.(sx, sy);
      }
      everPinched = false;
    }
  };
  canvas.addEventListener('pointerup', onPointerEnd);
  canvas.addEventListener('pointercancel', onPointerEnd);

  canvas.addEventListener('pointerleave', () => {
    onHover?.(-1, -1);
  });

  // ─── 마우스 휠 줌 ────────────────────────────────
  canvas.addEventListener('wheel', (e) => {
    e.preventDefault();
    const [sx, sy] = getPos(e);
    const factor = e.deltaY < 0 ? CONFIG.zoomStep : 1 / CONFIG.zoomStep;
    camera.zoomAt(sx, sy, factor);
    renderer.requestRender();
  }, { passive: false });

  // ─── 더블클릭/더블탭 줌인 ────────────────────────
  canvas.addEventListener('dblclick', (e) => {
    const [sx, sy] = getPos(e);
    camera.zoomAt(sx, sy, CONFIG.zoomStep ** 2);
    renderer.requestRender();
  });

  // ─── 키보드 ──────────────────────────────────────
  window.addEventListener('keydown', (e) => {
    const panAmt = 60;
    if (e.key === 'ArrowLeft')  { camera.pan( panAmt, 0); renderer.requestRender(); }
    if (e.key === 'ArrowRight') { camera.pan(-panAmt, 0); renderer.requestRender(); }
    if (e.key === 'ArrowUp')    { camera.pan(0,  panAmt); renderer.requestRender(); }
    if (e.key === 'ArrowDown')  { camera.pan(0, -panAmt); renderer.requestRender(); }
    if (e.key === '+' || e.key === '=') {
      camera.zoomAt(camera.viewW / 2, camera.viewH / 2, CONFIG.zoomStep);
      renderer.requestRender();
    }
    if (e.key === '-' || e.key === '_') {
      camera.zoomAt(camera.viewW / 2, camera.viewH / 2, 1 / CONFIG.zoomStep);
      renderer.requestRender();
    }
  });
}
