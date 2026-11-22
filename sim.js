// The replay engine: no DOM, so tools/test_sim.mjs runs it under Node too.
//
// Motion model: a line-for-line port of SimRover.step() in BotInfo at commit 5b77213
// (botinfo/backends/simrover.py): a unicycle base with acceleration limits, 10 ms steps and the driver caps
// SimRover starts with. Commands come only from BotInfo's own audit events: an allowed drive starts its speed,
// a lease end or a delivered stop sets zero (that is what BotInfo sent to the rover's /cmd_vel at those moments).

export const MODEL = Object.freeze({
  LINEAR_ACCEL: 2.0,    // m/s^2   SimRover.LINEAR_ACCEL
  ANGULAR_ACCEL: 8.0,   // rad/s^2 SimRover.ANGULAR_ACCEL
  STEP_S: 0.01,         // s       SimRover.STEP_S
  MAX_SPEED: 1.0,       // m/s     /rover/max_speed default
  MAX_ANGULAR: 2.0,     // rad/s   /rover/max_angular default
  REST_BELOW: 0.01,     // both speeds under this = at rest ([settle] below in bindings/simrover-ros-style.toml)
});

// The words BotInfo returns when a motion arrives after a latched stop (botinfo/core.py, call_tool, rule "stopped").
export const LATCH_REFUSAL = "the robot was stopped (stop by owner: owner stop); only the owner can resume";

export function parseAuditText(text) {
  return text.split(/\r?\n/).filter((s) => s.trim()).map((s) => JSON.parse(s));
}

// Turn audit records into a replayable run.
export function buildRun(records, meta = {}) {
  if (!records.length) throw new Error("empty audit log");
  const t0 = records[0].t;
  if (typeof t0 !== "number") throw new Error("audit line 1 has no t");
  const events = records.map((e, i) => ({ ...e, rt: e.t - t0, idx: i }));
  const cmds = [];
  const drives = [];
  const byLease = {};
  for (const e of events) {
    if (e.event === "decision" && e.tool === "drive" && e.decision === "allowed") {
      const p = e.params || {};
      const d = { lease: e.lease_id, start: e.rt, planned: Number(e.runs_for_s ?? p.duration_s ?? 0),
        v: Number(p.linear_mps || 0), w: Number(p.angular_rps || 0), end: null, endedBy: null, idx: e.idx };
      d.n = drives.length + 1;
      drives.push(d);
      byLease[d.lease] = d;
      cmds.push({ t: e.rt, v: d.v, w: d.w, kind: "drive", lease: d.lease });
    } else if (e.event === "lease_end" && e.stop_sent) {
      cmds.push({ t: e.rt, v: 0, w: 0, kind: "lease_end", lease: e.lease_id });
      const d = byLease[e.lease_id];
      if (d && d.end === null) { d.end = e.rt; d.endedBy = "lease_end"; d.ranS = e.ran_s; }
    } else if (e.event === "replaced") {
      cmds.push({ t: e.rt, v: 0, w: 0, kind: "replaced" });
      const d = byLease[e.old];
      if (d && d.end === null) { d.end = e.rt; d.endedBy = "replaced"; }
    } else if (e.event === "stop" && e.delivered) {
      cmds.push({ t: e.rt, v: 0, w: 0, kind: "stop", by: e.by });
      const d = e.cancelled_lease ? byLease[e.cancelled_lease] : null;
      if (d && d.end === null) { d.end = e.rt; d.endedBy = "stop:" + e.by; }
    }
  }
  const ownerStops = events.filter((e) => e.event === "stop" && e.by === "owner");
  const labStop = ownerStops.length ? ownerStops[0] : null;
  const labReceipt = labStop
    ? events.find((e) => e.event === "stop_receipt" && e.stop_id === labStop.stop_id) || null
    : null;
  const tEnd = events[events.length - 1].rt;
  return { meta, events, cmds, drives, labStop, labReceipt, tEnd };
}

// Simulate from t = 0 to tEnd. userStopT (seconds since the run's first audit line) latches a stop: zero speed from
// the next 10 ms step on, and every later drive command is refused (no speed reaches the rover).
export function simulate(run, tEnd, userStopT = null) {
  const { LINEAR_ACCEL, ANGULAR_ACCEL, STEP_S, MAX_SPEED, MAX_ANGULAR } = MODEL;
  let cmds = run.cmds;
  if (userStopT !== null) {
    cmds = cmds.filter((c) => c.t < userStopT);
    cmds.push({ t: userStopT, v: 0, w: 0, kind: "user_stop" });
  }
  const n = Math.ceil(tEnd / STEP_S + 1e-9) + 1;
  const xs = new Float64Array(n), ys = new Float64Array(n), ths = new Float64Array(n);
  const vs = new Float64Array(n), ws = new Float64Array(n), cvs = new Float64Array(n);
  let x = 0, y = 0, th = 0, v = 0, w = 0, cv = 0, cw = 0, i = 0;
  for (let k = 0; k < n; k++) {
    const t = k * STEP_S;
    xs[k] = x; ys[k] = y; ths[k] = th; vs[k] = v; ws[k] = w;
    while (i < cmds.length && cmds[i].t <= t + 1e-12) { cv = cmds[i].v; cw = cmds[i].w; i++; }
    cvs[k] = cv;
    const dt = STEP_S;
    const tv = Math.max(-MAX_SPEED, Math.min(MAX_SPEED, cv));
    const tw = Math.max(-MAX_ANGULAR, Math.min(MAX_ANGULAR, cw));
    v += Math.max(-LINEAR_ACCEL * dt, Math.min(LINEAR_ACCEL * dt, tv - v));
    w += Math.max(-ANGULAR_ACCEL * dt, Math.min(ANGULAR_ACCEL * dt, tw - w));
    x += v * Math.cos(th) * dt;
    y += v * Math.sin(th) * dt;
    th = ((th + w * dt + Math.PI) % (2 * Math.PI) + 2 * Math.PI) % (2 * Math.PI) - Math.PI;
  }
  return { xs, ys, ths, vs, ws, cvs, n, step: STEP_S };
}

// State at time t (linear interpolation between 10 ms samples).
export function stateAt(sim, t) {
  const f = Math.max(0, Math.min(sim.n - 1, t / sim.step));
  const k = Math.min(sim.n - 2, Math.floor(f));
  const a = f - k;
  const lerp = (arr) => arr[k] + (arr[k + 1] - arr[k]) * a;
  let dth = sim.ths[k + 1] - sim.ths[k];
  if (dth > Math.PI) dth -= 2 * Math.PI;
  if (dth < -Math.PI) dth += 2 * Math.PI;
  return { x: lerp(sim.xs), y: lerp(sim.ys), th: sim.ths[k] + dth * a, v: lerp(sim.vs), w: lerp(sim.ws) };
}

// How a stop at time T played out in a simulation that has that stop in it: speed when pressed, when the model first
// reads both speeds under REST_BELOW, and the path length in between.
// Measured from the first 10 ms step the zero command acts on (a press between two steps waits for the next one).
export function stopMetrics(sim, T) {
  const step = sim.step;
  const k0 = Math.max(0, Math.min(sim.n - 1, Math.ceil(T / step - 1e-9)));
  const at = { v: sim.vs[k0], w: sim.ws[k0] };
  let dist = 0, kRest = null;
  for (let k = k0; k < sim.n; k++) {
    if (Math.abs(sim.vs[k]) < MODEL.REST_BELOW && Math.abs(sim.ws[k]) < MODEL.REST_BELOW) { kRest = k; break; }
    if (k + 1 < sim.n) dist += Math.hypot(sim.xs[k + 1] - sim.xs[k], sim.ys[k + 1] - sim.ys[k]);
  }
  const restT = kRest === null ? null : (kRest - k0) * step;
  const kEnd = kRest === null ? sim.n - 1 : kRest;
  return {
    T, speed: Math.abs(at.v), turnRate: Math.abs(at.w), wasMoving: Math.abs(at.v) >= MODEL.REST_BELOW || Math.abs(at.w) >= MODEL.REST_BELOW,
    restAfter: restT, distance: dist, x: sim.xs[kEnd], y: sim.ys[kEnd], heading: sim.ths[kEnd],
  };
}

// Where the run was at time T, in words the page shows.
export function phaseAt(run, T) {
  for (const d of run.drives) {
    const end = d.end ?? d.start + d.planned;
    if (T >= d.start && T < end) return { kind: "moving", drive: d, into: T - d.start };
  }
  const before = run.drives.filter((d) => d.start <= T).length;
  if (before === 0) return { kind: "before" };
  if (before === run.drives.length) return { kind: "after", count: before };
  return { kind: "between", after: before };
}

// What BotInfo's stop latch would say to each recorded event after a user stop at T.
export function underUserStop(run, T) {
  const out = new Map();
  if (T === null) return out;
  for (const e of run.events) {
    if (e.rt < T) continue;
    if (e.event === "request" && e.tool === "drive") out.set(e.idx, { refused: true });
    else if (e.event === "decision" && e.tool === "drive") out.set(e.idx, { replacedBy: "refusal" });
    else if (e.event === "lease_end") out.set(e.idx, { hidden: true });
    else if (e.event === "stop_receipt") out.set(e.idx, { hidden: true });
    else if (e.event === "stop") out.set(e.idx, { alreadyStopped: true });
    else out.set(e.idx, { recorded: true });
  }
  return out;
}

// Log figures for the cut move: how long BotInfo had it running before the owner's stop, and how long the AI's
// own wait ran when that stop ended it.
export function cutMoveFacts(run) {
  if (!run.labStop) return null;
  const d = run.drives.find((x) => x.lease === run.labStop.cancelled_lease);
  const wait = run.events.find((e) => e.event === "decision" && e.tool === "botinfo_wait" && e.ended_by === "stopped" && e.rt >= run.labStop.rt);
  const done = run.drives.filter((x) => x.endedBy === "lease_end");
  return {
    drive: d || null,
    ranBeforeStop: d ? run.labStop.rt - d.start : null,
    waitEndedByStop: wait && wait.waited_s > 0 ? wait.waited_s : (wait ? 0 : null),
    finished: done.map((x) => ({ n: x.n, ranS: x.ranS })),
  };
}
