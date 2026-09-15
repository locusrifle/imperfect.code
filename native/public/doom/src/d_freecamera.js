// Browser-only debug helper: a free-fly camera that drives Three.js directly,
// as an alternative to R_RenderPlayerView(players[consoleplayer]).
//
// WASD + mouse-look (pointer lock). Q/E to descend/ascend.

import { camera, renderer, I_RegisterGraphicsShutdownHook } from './i_video.js';
import { playerstarts } from './doomstat.js';

const state = {
  yaw: 0,
  pitch: 0,
  keys: new Set(),
};

let _listenersInstalled = false;
let _unregisterShutdownHook = null;
function onKeyDown(e) { state.keys.add(e.code); }
function onKeyUp(e) { state.keys.delete(e.code); }
function onMouseMove(e) {
  if (renderer === null || document.pointerLockElement !== renderer.domElement) return;
  state.yaw   -= e.movementX * 0.002;
  state.pitch -= e.movementY * 0.002;
  state.pitch = Math.max(-Math.PI / 2 + 0.01, Math.min(Math.PI / 2 - 0.01, state.pitch));
}

export const D_FreeCamera = {
  init() {
    if (camera === null) return;
    // Position camera at the first player start (mapthing type 1).
    const ps = playerstarts[0];
    if (ps !== undefined && ps !== null) {
      camera.position.set(ps.x, 41, -ps.y); // 41 = roughly player eye height
      state.yaw = -(ps.angle * Math.PI / 180) - Math.PI / 2;
    } else {
      camera.position.set(0, 41, 0);
    }
    camera.rotation.set(state.pitch, state.yaw, 0, 'YXZ');

    if (_listenersInstalled === false) {
      document.addEventListener('keydown', onKeyDown);
      document.addEventListener('keyup', onKeyUp);
      document.addEventListener('mousemove', onMouseMove);
      _listenersInstalled = true;
      _unregisterShutdownHook = I_RegisterGraphicsShutdownHook(() => D_FreeCamera.shutdown());
    }
  },

  update() {
    if (camera === null) return;
    const speed = state.keys.has('ShiftLeft') ? 12 : 5;
    const cosY = Math.cos(state.yaw);
    const sinY = Math.sin(state.yaw);
    let fwd = 0, right = 0, up = 0;
    if (state.keys.has('KeyW')) fwd -= 1;
    if (state.keys.has('KeyS')) fwd += 1;
    if (state.keys.has('KeyA')) right -= 1;
    if (state.keys.has('KeyD')) right += 1;
    if (state.keys.has('KeyQ')) up -= 1;
    if (state.keys.has('KeyE')) up += 1;
    camera.position.x += (sinY * fwd + cosY * right) * speed;
    camera.position.z += (cosY * fwd - sinY * right) * speed;
    camera.position.y += up * speed;
    camera.rotation.set(state.pitch, state.yaw, 0, 'YXZ');
  },

  shutdown() {
    if (_listenersInstalled === true) {
      document.removeEventListener('keydown', onKeyDown);
      document.removeEventListener('keyup', onKeyUp);
      document.removeEventListener('mousemove', onMouseMove);
      _listenersInstalled = false;
    }
    if (_unregisterShutdownHook !== null) {
      const unregister = _unregisterShutdownHook;
      _unregisterShutdownHook = null;
      unregister();
    }
    state.keys.clear();
    state.yaw = 0;
    state.pitch = 0;
  },
};
