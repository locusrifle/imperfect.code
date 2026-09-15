// Browser loop ownership shared by d_main.js and graphics teardown.  The
// generation token prevents an async loop startup, a queued RAF callback, or
// a callback that is already executing from scheduling work after shutdown.

export function D_CreateRafLoop({ requestFrame, cancelFrame } = {}) {
  const request = requestFrame ?? ((callback) => globalThis.requestAnimationFrame(callback));
  const cancel = cancelFrame ?? ((id) => globalThis.cancelAnimationFrame(id));
  let generation = 0;
  let frameId = null;
  let running = false;
  let closed = false;

  return {
    begin() {
      if (closed === true) return null;
      this.stop();
      running = true;
      return generation;
    },

    active(token) {
      return running === true && token === generation;
    },

    schedule(token, callback) {
      if (this.active(token) !== true || frameId !== null) return null;
      const id = request((now) => {
        if (frameId === id) frameId = null;
        if (this.active(token) === true) callback(now);
      });
      frameId = id;
      return id;
    },

    stop() {
      running = false;
      generation++;
      if (frameId !== null) {
        cancel(frameId);
        frameId = null;
      }
    },

    close() {
      this.stop();
      closed = true;
    },

    isRunning() { return running; },
    isClosed() { return closed; },
  };
}

export const D_DoomRafLoop = D_CreateRafLoop();
