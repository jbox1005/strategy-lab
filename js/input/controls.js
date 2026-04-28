// 마우스 입력: 드래그 팬 + 휠 줌 + 호버
// pointer 이벤트 사용 (마우스/터치 통합)

import { CONFIG } from '../config.js';
import { worldToLngLat } from '../map/projection.js';

export function setupControls({ canvas, camera, world, cities, renderer, onHover, onClick }) {
  let dragging = false;
  let dragMoved = false;
  let lastX = 0, lastY = 0;
  let downX = 0, downY = 0;

  const getPos = (e) => {
    const rect = canvas.getBoundingClientRect();
    return [e.clientX - rect.left, e.clientY - rect.top];
  };

  canvas.addEventListener('pointerdown', (e) => {
    dragging = true;
    dragMoved = false;
    [lastX, lastY] = getPos(e);
    downX = lastX;
    downY = lastY;
    canvas.setPointerCapture(e.pointerId);
  });

  canvas.addEventListener('pointermove', (e) => {
    const [sx, sy] = getPos(e);

    if (dragging) {
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

  const endDrag = (e) => {
    if (!dragging) return;
    dragging = false;
    try { canvas.releasePointerCapture(e.pointerId); } catch {}
  };
  canvas.addEventListener('pointerup', (e) => {
    const wasDragging = dragging;
    const moved = dragMoved;
    endDrag(e);
    if (wasDragging && !moved) {
      const [sx, sy] = getPos(e);
      onClick?.(sx, sy);
    }
  });
  canvas.addEventListener('pointercancel', endDrag);
  canvas.addEventListener('pointerleave', () => {
    onHover?.(-1, -1);
  });

  canvas.addEventListener('wheel', (e) => {
    e.preventDefault();
    const [sx, sy] = getPos(e);
    const factor = e.deltaY < 0 ? CONFIG.zoomStep : 1 / CONFIG.zoomStep;
    camera.zoomAt(sx, sy, factor);
    renderer.requestRender();
  }, { passive: false });

  // 더블클릭으로 줌인
  canvas.addEventListener('dblclick', (e) => {
    const [sx, sy] = getPos(e);
    camera.zoomAt(sx, sy, CONFIG.zoomStep ** 2);
    renderer.requestRender();
  });

  // 키보드 단축키 — 화살표 팬, +/- 줌
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
