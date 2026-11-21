/* Runs solver attempts off the main thread. One worker = one attempt at a time. */
importScripts('engine.js', 'solver.js');

let DATA = null;
self.onmessage = (ev) => {
  const msg = ev.data || {};
  if (msg.type === 'init') { DATA = msg.data; self.postMessage({ type: 'ready' }); return; }
  if (msg.type === 'solve') {
    try {
      let last = 0;
      const res = self.AOSolver.solve(DATA, msg.cfg, {
        timeMs: msg.timeMs, seed: msg.seed,
        onProgress: (f) => {
          const now = Date.now();
          if (now - last > 120) { last = now; self.postMessage({ type: 'progress', job: msg.job, f }); }
        }
      });
      self.postMessage({ type: 'result', job: msg.job, res });
    } catch (err) {
      self.postMessage({ type: 'result', job: msg.job, res: { error: String(err && err.message || err) } });
    }
  }
};
