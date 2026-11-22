import * as THREE from "three";
import { MODEL, LATCH_REFUSAL, parseAuditText, buildRun, simulate, stateAt, stopMetrics, phaseAt, underUserStop,
  cutMoveFacts } from "./sim.js";

const $ = (id) => document.getElementById(id);
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const f2 = (x) => Number(x).toFixed(2);
const f3 = (x) => Number(x).toFixed(3);
const mm = (m) => `${Math.round(m * 1000)} mm`;
const BOTINFO = "https://github.com/botinfo-ai/botinfo";
const NAMES = { "gpt-6-luna": "GPT-6 Luna", "gpt-6-astra": "GPT-6 Astra", "claude-sonnet-5-5": "Claude Sonnet 5.5",
  "claude-haiku-5-5": "Claude Haiku 5.5", "claude-opus-5-5": "Claude Opus 5.5", "claude-fable-5-2": "Claude Fable 5.2" };
const vendor = (m) => (m.startsWith("claude") ? "Anthropic" : m.startsWith("gpt") ? "OpenAI" : "");
const niceModel = (m) => NAMES[m] || m;

// ------------------------------------------------------------------ state
const st = {
  index: [], cache: new Map(), meta: null, run: null, simRec: null, sim: null, cum: null, planned: null,
  t: 0, tStop: 0, playing: false, speed: 1, userT: null, userM: null, ended: false, feedKey: "",
};

// ------------------------------------------------------------------ 3D scene
const sceneEl = $("scene");
const renderer = new THREE.WebGLRenderer({ antialias: true });
renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
sceneEl.prepend(renderer.domElement);
const scene = new THREE.Scene();
scene.background = new THREE.Color(0xeff6ff);
const camera = new THREE.PerspectiveCamera(38, 4 / 3, 0.05, 60);
scene.add(new THREE.HemisphereLight(0xffffff, 0xbfdbfe, 1.15));
const sun = new THREE.DirectionalLight(0xffffff, 1.1);
sun.position.set(-2, 5, 3);
scene.add(sun);

const P = (x, y, h = 0) => new THREE.Vector3(x, h, -y);   // sim (x, y) -> three (x, up, -y)

const floor = new THREE.Mesh(new THREE.PlaneGeometry(7, 7), new THREE.MeshLambertMaterial({ color: 0xffffff }));
floor.rotation.x = -Math.PI / 2;
scene.add(floor);
const grid = new THREE.GridHelper(4, 16, 0x93c5fd, 0xdbeafe);
grid.position.y = 0.001;
scene.add(grid);
function square(h, color, dashed) {
  const pts = [[-h, -h], [h, -h], [h, h], [-h, h], [-h, -h]].map(([x, y]) => P(x, y, 0.004));
  const g = new THREE.BufferGeometry().setFromPoints(pts);
  const m = dashed ? new THREE.LineDashedMaterial({ color, dashSize: 0.08, gapSize: 0.06 }) : new THREE.LineBasicMaterial({ color });
  const line = new THREE.Line(g, m);
  if (dashed) line.computeLineDistances();
  scene.add(line);
}
square(2.0, 0x3b82f6, false);    // policies/simrover.toml [workspace] x, y = [-2, 2]
square(1.75, 0x60a5fa, true);    // ... shrunk by margin_m = 0.25

function ribbon(color, width, height) {
  const mesh = new THREE.Mesh(new THREE.BufferGeometry(), new THREE.MeshBasicMaterial({ color, side: THREE.DoubleSide }));
  mesh.userData = { width, height };
  scene.add(mesh);
  return mesh;
}
const plannedMesh = ribbon(0xbfdbfe, 0.07, 0.006);
const trailMesh = ribbon(0x1d4ed8, 0.03, 0.009);
const EVERY = 2;   // ribbon point every 2 sim steps (20 ms)
function fillRibbon(mesh, sim) {
  const { width, height } = mesh.userData;
  const pts = [];
  for (let k = 0; k < sim.n; k += EVERY) pts.push([sim.xs[k], sim.ys[k], sim.ths[k]]);
  const pos = new Float32Array(Math.max(0, pts.length - 1) * 18);
  const side = ([x, y, th], s) => P(x - Math.sin(th) * s * width / 2, y + Math.cos(th) * s * width / 2, height);
  let o = 0;
  for (let i = 0; i + 1 < pts.length; i++) {
    const a1 = side(pts[i], 1), a2 = side(pts[i], -1), b1 = side(pts[i + 1], 1), b2 = side(pts[i + 1], -1);
    for (const v of [a1, a2, b1, b1, a2, b2]) { pos[o++] = v.x; pos[o++] = v.y; pos[o++] = v.z; }
  }
  mesh.geometry.dispose();
  mesh.geometry = new THREE.BufferGeometry();
  mesh.geometry.setAttribute("position", new THREE.BufferAttribute(pos, 3));
}

function pole(color) {
  const g = new THREE.Group();
  const mat = new THREE.MeshLambertMaterial({ color });
  const stick = new THREE.Mesh(new THREE.CylinderGeometry(0.012, 0.012, 0.32, 10), mat);
  stick.position.y = 0.16;
  const ball = new THREE.Mesh(new THREE.SphereGeometry(0.04, 16, 12), mat);
  ball.position.y = 0.34;
  const disc = new THREE.Mesh(new THREE.CircleGeometry(0.06, 24), new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.35 }));
  disc.rotation.x = -Math.PI / 2;
  disc.position.y = 0.007;
  g.add(stick, ball, disc);
  g.visible = false;
  scene.add(g);
  return g;
}
const labMarker = pole(0xdc2626);
const youMarker = pole(0x0f172a);

// The rover: drawn for this page (SimRover itself is a point with a heading).
const rover = new THREE.Group();
{
  const mat = (c) => new THREE.MeshLambertMaterial({ color: c });
  const chassis = new THREE.Mesh(new THREE.BoxGeometry(0.3, 0.08, 0.2), mat(0x1e3a8a));
  chassis.position.y = 0.075;
  const deck = new THREE.Mesh(new THREE.BoxGeometry(0.2, 0.03, 0.15), mat(0x3b82f6));
  deck.position.set(-0.02, 0.13, 0);
  const nose = new THREE.Mesh(new THREE.BoxGeometry(0.025, 0.05, 0.17), mat(0xffffff));
  nose.position.set(0.155, 0.08, 0);
  rover.add(chassis, deck, nose);
  const wg = new THREE.CylinderGeometry(0.045, 0.045, 0.03, 20);
  wg.rotateX(Math.PI / 2);
  rover.userData.wheels = [];
  for (const [x, z] of [[0.09, 0.115], [0.09, -0.115], [-0.09, 0.115], [-0.09, -0.115]]) {
    const w = new THREE.Mesh(wg, mat(0x1f2937));
    w.position.set(x, 0.045, z);
    rover.add(w);
    rover.userData.wheels.push(w);
  }
  const ring = new THREE.Mesh(new THREE.RingGeometry(0.22, 0.26, 48),
    new THREE.MeshBasicMaterial({ color: 0x3b82f6, transparent: true, opacity: 0.8, side: THREE.DoubleSide }));
  ring.rotation.x = -Math.PI / 2;
  ring.position.y = 0.005;
  rover.add(ring);
  rover.userData.ring = ring;
}
scene.add(rover);

const camTarget = new THREE.Vector3();
let frameExtent = 1.6;
function frameCamera() {
  const ext = Math.max(frameExtent, 1.2);
  const aspect = camera.aspect || 4 / 3;
  const k = Math.max(1, 1.5 / aspect);
  camera.position.set(camTarget.x - 0.32 * ext * k, camTarget.y + (0.85 * ext + 0.35) * k, camTarget.z + (1.15 * ext + 0.55) * k);
  camera.lookAt(camTarget);
}
function resize() {
  const w = sceneEl.clientWidth, h = sceneEl.clientHeight;
  if (!w || !h) return;
  renderer.setSize(w, h, false);
  camera.aspect = w / h;
  camera.updateProjectionMatrix();
  frameCamera();
}
new ResizeObserver(resize).observe(sceneEl);

// ------------------------------------------------------------------ loading runs
async function loadIndex() {
  const r = await fetch("data/runs.json", { cache: "no-cache" });
  if (!r.ok) throw new Error(`data/runs.json: HTTP ${r.status}`);
  st.index = (await r.json()).runs;
  const groups = new Map();
  for (const x of st.index) {
    const key = x.lab_request || x.id;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(x);
  }
  const sel = $("run");
  sel.innerHTML = "";
  for (const [key, runs] of groups) {
    const og = document.createElement("optgroup");
    og.label = `${runs[0].date} · ${niceModel(runs[0].model)}`;
    runs.sort((a, b) => (a.run || 0) - (b.run || 0));
    for (const x of runs) {
      const o = document.createElement("option");
      o.value = x.id;
      o.textContent = `${niceModel(x.model)}, run ${x.run} · ${x.date}`;
      og.appendChild(o);
    }
    sel.appendChild(og);
  }
  const want = new URLSearchParams(location.search).get("run");
  const first = st.index.find((x) => x.id === want) || [...groups.values()][0][0];
  sel.value = first.id;
  await selectRun(first.id);
}

async function selectRun(id) {
  let meta = st.cache.get(id);
  if (!meta) {
    const entry = st.index.find((x) => x.id === id);
    const r = await fetch(entry.file, { cache: "no-cache" });
    if (!r.ok) throw new Error(`${entry.file}: HTTP ${r.status}`);
    meta = await r.json();
    meta.file = entry.file;
    st.cache.set(id, meta);
  }
  setRun(meta);
  if (!meta.local) {
    const u = new URL(location.href);
    u.searchParams.set("run", id);
    history.replaceState(null, "", u);
  }
}

function setRun(meta) {
  const records = meta.audit.map((s) => (typeof s === "string" ? JSON.parse(s) : s));
  st.meta = meta;
  st.run = buildRun(records, meta);
  st.tStop = st.run.tEnd + 0.6;
  st.simRec = simulate(st.run, st.tStop + 0.2);
  // where the AI's allowed moves were headed: each drive runs its whole lease from the moment BotInfo allowed it
  const plannedCmds = [];
  for (const d of st.run.drives) {
    plannedCmds.push({ t: d.start, v: d.v, w: d.w }, { t: d.start + d.planned, v: 0, w: 0 });
  }
  plannedCmds.sort((a, b) => a.t - b.t);
  const tPlan = Math.max(st.tStop, ...st.run.drives.map((d) => d.start + d.planned + 1));
  st.planned = simulate({ cmds: plannedCmds }, tPlan);
  fillRibbon(plannedMesh, st.planned);
  // frame the camera on the plan plus the start
  let x0 = 0, x1 = 0, y0 = 0, y1 = 0;
  for (let k = 0; k < st.planned.n; k += 10) {
    x0 = Math.min(x0, st.planned.xs[k]); x1 = Math.max(x1, st.planned.xs[k]);
    y0 = Math.min(y0, st.planned.ys[k]); y1 = Math.max(y1, st.planned.ys[k]);
  }
  frameExtent = Math.max(x1 - x0, y1 - y0);
  camTarget.copy(P((x0 + x1) / 2, (y0 + y1) / 2, 0));
  frameCamera();
  const rec = st.run.labReceipt;
  if (rec && rec.last_read) {
    labMarker.position.copy(P(rec.last_read.x, rec.last_read.y || 0));
    labMarker.visible = true;
  } else labMarker.visible = false;
  renderMeta();
  document.querySelector(".card.lab h2").textContent = meta.local ? "What happened in your recorded run" : "What happened in the lab";
  renderLab();
  renderReport();
  verifyChain();
  reset();
}

// ------------------------------------------------------------------ playback
function useSim(sim) {
  st.sim = sim;
  const cum = new Float64Array(sim.n);
  for (let k = 1; k < sim.n; k++) cum[k] = cum[k - 1] + Math.hypot(sim.xs[k] - sim.xs[k - 1], sim.ys[k] - sim.ys[k - 1]);
  st.cum = cum;
  fillRibbon(trailMesh, sim);
}

function reset() {
  st.t = 0; st.playing = false; st.ended = false; st.userT = null; st.userM = null; st.feedKey = "";
  useSim(st.simRec);
  youMarker.visible = false;
  $("stop").disabled = false;
  $("play").textContent = "▶ Play the recorded run";
  renderYou();
  renderTimeline();
  showBanner("Press ▶ Play. Then press STOP whenever you like.");
}

function play() {
  if (st.ended) reset();
  st.playing = !st.playing;
  $("play").textContent = st.playing ? "❚❚ Pause" : "▶ Resume";
  if (st.playing) showBanner(null);
}

function pressStop() {
  if (st.userT !== null || st.ended || !st.run) return;
  const T = st.t;
  st.userT = T;
  useSim(simulate(st.run, st.tStop + 0.2, T));
  st.userM = stopMetrics(st.sim, T);
  youMarker.position.copy(P(st.userM.x, st.userM.y));
  youMarker.visible = true;
  $("stop").disabled = true;
  if (!st.playing) play();
  renderYou();
  renderTimeline();
}

function seek(t) {
  if (st.userT !== null) return;
  st.t = Math.max(0, Math.min(st.tStop, t));
  st.ended = false;
  if (!st.playing) $("play").textContent = st.t > 0 ? "▶ Resume" : "▶ Play the recorded run";
  showBanner(null);
}

function showBanner(text) {
  const b = $("banner");
  if (text) { b.textContent = text; b.hidden = false; } else b.hidden = true;
}

function onEnd() {
  $("play").textContent = "▶ Play again";
  $("stop").disabled = true;
  showBanner(st.userT === null
    ? "Replay over. You did not press STOP, so this is how the lab's run went. Press ↺ Replay and try a moment of your own."
    : "Replay over. Press ↺ Replay to try another moment, or pick another run.");
}

// ------------------------------------------------------------------ per-frame
function latchedAt(t) {
  if (st.userT !== null && t >= st.userT) return "you";
  const s = st.run.events.find((e) => e.event === "stop" && e.delivered && e.latched && e.rt <= t);
  return s ? (s.by === "owner" ? "lab" : "botinfo") : null;
}

function updateHud() {
  const run = st.run;
  const s = stateAt(st.sim, st.t);
  const lat = latchedAt(st.t);
  const ph = phaseAt(run, st.t);
  let chip;
  if (lat) chip = `<span class="latched">STOPPED by ${lat === "you" ? "you" : lat === "lab" ? "the lab" : "BotInfo"} · latched</span>`;
  else if (ph.kind === "moving") chip = `<span class="moving">move ${ph.drive.n} · ${f2(ph.into)} of ${f2(ph.drive.planned)} s</span>`;
  else chip = `<span>${ph.kind === "before" ? "AI has not moved yet" : "rover idle"}</span>`;
  $("hud").innerHTML = `<span>t = ${f2(st.t)} s</span><span>${f3(Math.abs(s.v))} m/s</span><span>x = ${f3(s.x)} m</span>${chip}`;
  const ring = rover.userData.ring;
  ring.visible = Boolean(lat) || Math.abs(s.v) > 0.01 || Math.abs(s.w) > 0.01;
  ring.material.color.setHex(lat ? 0xdc2626 : 0x3b82f6);
}

function updateScene() {
  const s = stateAt(st.sim, st.t);
  rover.position.copy(P(s.x, s.y));
  rover.rotation.y = s.th;
  const k = Math.min(st.sim.n - 1, Math.max(0, st.t / st.sim.step));
  const k0 = Math.floor(k);
  const dist = st.cum[k0] + (k0 + 1 < st.sim.n ? (st.cum[k0 + 1] - st.cum[k0]) * (k - k0) : 0);
  for (const w of rover.userData.wheels) w.rotation.z = -dist / 0.045;
  trailMesh.geometry.setDrawRange(0, Math.max(0, Math.floor(k / EVERY)) * 6);
  const head = document.querySelector("#timeline .head");
  if (head) head.style.left = `${(100 * st.t) / st.tStop}%`;
}

let last = performance.now();
function frame(now) {
  const dt = Math.min(0.25, (now - last) / 1000);   // a hidden tab pauses frames; never jump more than 0.25 s
  last = now;
  if (st.run) {
    if (st.playing) {
      st.t += dt * st.speed;
      if (st.t >= st.tStop) { st.t = st.tStop; st.playing = false; st.ended = true; onEnd(); }
    }
    updateScene();
    updateHud();
    renderFeed();
  }
  renderer.render(scene, camera);
  requestAnimationFrame(frame);
}

// ------------------------------------------------------------------ the feed
function describe(e, v) {
  const out = [];
  const add = (who, txt, cls = "") => out.push({ t: e.rt, who, txt, cls });
  const a = e.args || {};
  if (v && (v.hidden || v.replacedBy)) return out;
  const rec = v && v.recorded ? " (recorded)" : "";
  const rcls = v && v.recorded ? "recorded" : "";
  if (e.event === "start") add("botinfo", `Session starts: the owner's policy ${esc(e.policy || "")} stands between the AI and the simulated rover.`);
  else if (e.event === "request") {
    if (e.tool === "drive") {
      const turn = Number(a.angular_rps || 0) ? `, turning ${esc(a.angular_rps)} rad/s` : "";
      add("ai", `Asks to drive at ${esc(a.linear_mps)} m/s${turn} for ${esc(a.duration_s)} s.${v && v.refused ? " (recorded)" : ""}`, v && v.refused ? "recorded" : "");
      if (v && v.refused) add("botinfo", `Refused under your stop: "${esc(LATCH_REFUSAL)}"`, "refused");
    } else if (e.tool === "botinfo_policy") add("ai", `Reads the owner's policy.${rec}`, rcls);
    else if (e.tool === "botinfo_status") add("ai", `Reads the rover's status.${rec}`, rcls);
    else if (e.tool === "botinfo_wait") add("ai", `Waits for the move to end (up to ${esc(a.max_s ?? "?")} s).${rec}`, rcls);
    else if (e.tool === "set_led") add("ai", `Sets the light to ${esc(a.color)}.${rec}`, rcls);
    else if (e.tool === "botinfo_stop") add("ai", `Presses BotInfo's stop tool.${rec}`, rcls);
    else add("ai", `Calls ${esc(e.tool)}.${rec}`, rcls);
  } else if (e.event === "decision") {
    if (e.tool === "botinfo_wait") add("botinfo", `The wait returns after ${esc(e.waited_s)} s: ${e.ended_by === "stopped" ? "the rover was stopped" : e.ended_by === "idle" ? "no move running" : esc(e.ended_by)}.${rec}`, rcls);
    else if (e.decision === "allowed" && e.lease_id) add("botinfo", `Allowed. Lease ${esc(e.lease_id)} runs ${esc(e.runs_for_s)} s, then BotInfo stops the rover itself.${rec}`, rcls);
    else if (e.decision === "denied") add("botinfo", `Refused (${esc(e.rule)}): ${esc(e.reason || "")}${rec}`, "refused " + rcls);
    else if (e.decision === "pending_confirmation") add("botinfo", `Holds it for the owner's OK: ${esc(e.reason || "")}${rec}`, rcls);
    else if (e.decision === "failed") add("botinfo", `Failed: ${esc(e.error || "")}${rec}`, rcls);
  } else if (e.event === "lease_end") add("botinfo", `Lease ${esc(e.lease_id)} ends after ${esc(e.ran_s)} s. BotInfo sends the rover zero speed.${rec}`, rcls);
  else if (e.event === "replaced") add("botinfo", `A new move replaced ${esc(e.old)} after ${esc(e.ran_s)} s.${rec}`, rcls);
  else if (e.event === "stop") {
    if (v && v.alreadyStopped && e.by === "owner") add("lab", "Presses the owner's stop (recorded). Your stop already holds the latch, so nothing changes.", "recorded");
    else if (e.by === "owner") add("lab", `Presses the owner's stop. BotInfo latches it${e.cancelled_lease ? ` and cancels lease ${esc(e.cancelled_lease)}` : ""}.`);
    else if (e.by === "botinfo") add("botinfo", `Stops the rover: ${esc(e.reason)}.${rec}`, rcls);
    else add("ai", `Stops the rover${e.reason ? `: ${esc(e.reason)}` : ""}.${rec}`, rcls);
  } else if (e.event === "stop_receipt") {
    const after = e.by === "lease_end" ? "the lease ended" : "the stop";
    if (e.outcome === "at_rest") add("botinfo", `Stop receipt: the rover read at rest ${esc(e.at_rest_after_s)} s after ${after} (odometry read about every 0.1 s).${rec}`, rcls);
    else add("botinfo", `Stop receipt: ${esc(e.outcome)}.${rec}`, rcls);
  } else if (e.event === "client_disconnect") add("ai", `Finishes and disconnects.${rec}`, rcls);
  else if (e.event === "pending_expired") add("botinfo", `A request waiting for the owner's OK expired.${rec}`, rcls);
  else if (e.event === "output_redacted") add("botinfo", `Redacted a status field.${rec}`, rcls);
  return out;
}

function userItem() {
  const m = st.userM;
  const ph = phaseAt(st.run, st.userT);
  const lease = ph.kind === "moving" ? ` and cancels lease ${ph.drive.lease}` : "";
  const after = m.wasMoving
    ? `The rover reads at rest ${f2(m.restAfter)} s and ${mm(m.distance)} later (model).`
    : "The rover was not moving.";
  const already = latchedBeforeUser() ? " The latch was already set, so nothing changes." : "";
  return { t: st.userT, who: "you", txt: `Press the owner's stop. BotInfo latches it${lease}. ${after}${already}`, cls: "" };
}

function latchedBeforeUser() {
  return st.run.events.some((e) => e.event === "stop" && e.delivered && e.latched && e.rt < st.userT);
}

function renderFeed() {
  const t = st.t;
  const n = st.run.events.filter((e) => e.rt <= t).length;
  const key = `${n}|${st.userT}|${st.userT !== null && t >= st.userT}`;
  if (key === st.feedKey) return;
  st.feedKey = key;
  const verdicts = underUserStop(st.run, st.userT);
  const items = [];
  let inserted = false;
  for (const e of st.run.events) {
    if (e.rt > t) break;
    if (st.userT !== null && !inserted && e.rt >= st.userT) { items.push(userItem()); inserted = true; }
    items.push(...describe(e, verdicts.get(e.idx)));
  }
  if (st.userT !== null && !inserted && t >= st.userT) items.push(userItem());
  const ol = $("feed");
  ol.innerHTML = items.length
    ? items.map((x) => `<li class="${x.cls}"><span class="t">${f2(x.t)} s</span><span class="who ${x.who}">${x.who === "ai" ? "AI" : x.who === "botinfo" ? "BotInfo" : x.who === "lab" ? "Lab" : "You"}</span><span class="txt">${x.txt}</span></li>`).join("")
    : `<li class="empty">Press ▶ Play. The AI's calls and BotInfo's decisions appear here as they happened.</li>`;
  ol.scrollTop = ol.scrollHeight;
}

// ------------------------------------------------------------------ panels
function renderMeta() {
  const m = st.meta;
  const c = m.botinfo_commit || "";
  const when = m.lab_time ? `${m.lab_time.slice(0, 10)} ${m.lab_time.slice(11, 16)} US Pacific` : m.date;
  const commit = c ? `BotInfo commit <a href="${BOTINFO}/tree/${esc(c)}">${esc(c.slice(0, 7))}</a>` : "BotInfo commit not given";
  const v = vendor(m.model);
  $("runmeta").innerHTML = m.local
    ? `Your file <strong>${esc(m.label)}</strong>, replayed in your browser. Nothing was uploaded.`
    : `<strong>${esc(niceModel(m.model))}</strong>${v ? ` (${v}, model id <code>${esc(m.model)}</code>)` : ""} through ${esc(m.client || "an MCP client")},
       driving with only BotInfo's tools. Recorded ${esc(when)}. ${commit}. Lab request <code>${esc(m.lab_request)}</code>,
       run ${esc(m.run)} of ${esc(m.runs_in_request)}.`;
  $("task").textContent = m.task || "(no task text in this file)";
  const ss = m.stop_setting || {};
  $("stopsetting").textContent = ss.delay_s
    ? `The lab was set to press the owner's stop ${ss.delay_s} s after BotInfo allowed drive ${ss.after_allowed_drive}. The AI was not told it was being tested or that a stop would come.`
    : "";
  $("datalink").href = m.file || "#";
  $("simlink").href = c ? `${BOTINFO}/blob/${c}/botinfo/backends/simrover.py` : `${BOTINFO}/blob/main/botinfo/backends/simrover.py`;
  $("refusal").textContent = LATCH_REFUSAL;
}

function labFacts() {
  const run = st.run;
  if (!run.labStop) return null;
  const T = run.labStop.rt;
  const ph = phaseAt(run, T - 1e-6);
  const m = stopMetrics(st.simRec, T);
  const after = run.events.filter((e) => e.event === "request" && e.tool === "drive" && e.rt > T);
  const allowedAfter = run.events.filter((e) => e.event === "decision" && e.tool === "drive" && e.decision === "allowed" && e.rt > T);
  return { T, ph, m, attempts: after.length, allowedAfter: allowedAfter.length };
}

function renderLab() {
  const run = st.run, L = labFacts();
  if (!L) { $("lab").innerHTML = `<p class="muted">This log has no owner stop to compare with.</p>`; return; }
  const ss = (st.meta.stop_setting || {}).delay_s;
  const where = L.ph.kind === "moving" ? `In move ${L.ph.drive.n}, ${f2(L.ph.into)} s after BotInfo allowed it${ss ? ` (the lab was set to ${ss} s)` : ""}.` : "While the rover was not moving.";
  const rec = run.labReceipt;
  const k = rec && rec.last_read ? Math.round((L.T + rec.last_read.after_stop_s) / st.simRec.step) : null;
  const rows = [
    [st.meta.local ? "The owner's stop in your log" : "The lab pressed the owner's stop", `${f2(L.T)} s`], [null, where],
    ["Speed when the stop acted (model)", `${f3(L.m.speed)} m/s`],
    ["At rest after (model)", `${f2(L.m.restAfter)} s`],
    ["Stopping distance (model)", mm(L.m.distance)],
  ];
  if (rec && rec.outcome === "at_rest") {
    rows.push(["At rest after (BotInfo's stop receipt)", `${f3(rec.at_rest_after_s)} s`],
      [null, "BotInfo read the rover's odometry about every 0.1 s, so its receipt marks a later moment than the model."]);
  }
  if (rec && rec.last_read) {
    rows.push(["Last odometry read", `x = ${f3(rec.last_read.x)} m`]);
    if (k !== null && k < st.simRec.n) {
      const d = Math.abs(st.simRec.xs[k] - rec.last_read.x) * 1000;
      rows.push(["This page's replay, same moment", `x = ${f3(st.simRec.xs[k])} m`], [null, `${d.toFixed(1)} mm from BotInfo's read.`]);
      $("checkmm").textContent = `${d.toFixed(1)} mm (this run)`;
    }
  }
  rows.push(["AI motion requests after the stop", String(L.attempts)],
    ["Motion BotInfo allowed after the stop", String(L.allowedAfter)]);
  $("lab").innerHTML = facts(rows);
}

function facts(rows) {
  return `<dl class="facts">${rows.map(([k, v]) => (k === null ? `<dd class="wide">${v}</dd>` : `<dt>${k}</dt><dd>${v}</dd>`)).join("")}</dl>`;
}

function renderYou() {
  const el = $("you");
  if (st.userT === null) {
    el.innerHTML = `<p class="muted">Not pressed yet. Try a few moments: before the first move, in the middle of a move,
      between the two moves, or right as a move starts.</p>`;
    return;
  }
  const run = st.run, m = st.userM, T = st.userT;
  const ph = phaseAt(run, T);
  let where;
  if (ph.kind === "moving") where = `In move ${ph.drive.n}, ${f2(ph.into)} s after BotInfo allowed it.`;
  else if (ph.kind === "before") where = "Before the AI's first move.";
  else if (ph.kind === "between") where = `Between move ${ph.after} and move ${ph.after + 1}, rover idle.`;
  else where = "After the AI's last move.";
  const verdicts = underUserStop(run, T);
  const refused = run.events.filter((e) => verdicts.get(e.idx) && verdicts.get(e.idx).refused);
  const already = latchedBeforeUser();
  const rows = [
    ["Pressed at", `${f2(T)} s`], [null, where],
    ["Speed when the stop acted", `${f3(m.speed)} m/s`],
    ["At rest after", m.wasMoving ? `${f2(m.restAfter)} s` : "0 s"],
    ["Stopping distance", m.wasMoving ? mm(m.distance) : "0 mm"],
    ["Rover ended at", `x = ${f3(m.x)} m${Math.abs(m.y) > 0.0005 ? `, y = ${f3(m.y)} m` : ""}`],
    ["AI moves BotInfo refused after it", String(refused.length)],
  ];
  let delta = "";
  const L = labFacts();
  if (already) delta = "The latch was already set before your press (the lab's or BotInfo's stop came first), so your stop changed nothing.";
  else if (L) {
    const rec = run.labReceipt;
    const labX = rec && rec.last_read ? rec.last_read.x : st.simRec.xs[st.simRec.n - 1];
    const dx = labX - m.x;
    const parts = [`Your stop came ${f2(L.T - T)} s before the lab's.`];
    parts.push(Math.abs(dx) < 0.0005 ? "The rover ended where the lab's stop left it." : `The rover ended ${f3(Math.abs(dx))} m ${dx > 0 ? "short of" : "past"} where the lab's stop left it.`);
    if (refused.length) {
      let inLab = 0;
      const names = refused.map((e) => {
        const d = run.drives.find((x) => x.idx > e.idx && Math.abs(x.start - e.rt) < 0.5);
        if (d) inLab++;
        return d ? `move ${d.n} (asked at ${f2(e.rt)} s)` : `a drive request at ${f2(e.rt)} s`;
      });
      const list = names.length > 1 ? `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}` : names[0];
      const lab = inLab === names.length ? (names.length > 1 ? "; the lab's run allowed both" : "; the lab's run allowed it")
        : inLab ? `; the lab's run allowed ${inLab} of them` : "";
      parts.push(`BotInfo refused ${list}${names.length > 2 && inLab === names.length ? "; the lab's run allowed all of them" : lab}.`);
    }
    delta = parts.join(" ");
  }
  el.innerHTML = facts(rows) + (delta ? `<p class="delta">${delta}</p>` : "");
}

function renderTimeline() {
  const run = st.run, T = st.tStop;
  const pct = (t) => `${(100 * t) / T}%`;
  let h = "";
  for (const d of run.drives) {
    const end = d.end ?? d.start + d.planned;
    const cut = st.userT !== null && st.userT < end;
    if (cut && st.userT > d.start) {
      h += `<div class="seg" style="left:${pct(d.start)};width:${pct(st.userT - d.start)}"></div>`;
      h += `<div class="seg cut" style="left:${pct(st.userT)};width:${pct(end - st.userT)}"></div>`;
    } else h += `<div class="seg${cut ? " cut" : ""}" style="left:${pct(d.start)};width:${pct(end - d.start)}"></div>`;
  }
  if (run.labStop) h += `<div class="tick lab" style="left:${pct(run.labStop.rt)}"></div><div class="lbl lab" style="left:${pct(run.labStop.rt)}">lab stop</div>`;
  if (st.userT !== null) h += `<div class="tick you" style="left:${pct(st.userT)}"></div><div class="lbl you" style="left:${pct(st.userT)}">you</div>`;
  h += `<div class="head" style="left:${pct(st.t)}"></div>`;
  $("timeline").innerHTML = h;
}

// tiny Markdown for the AI's report: paragraphs, lists, tables, **bold**, `code`
function md(src) {
  const inline = (s) => esc(s).replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>").replace(/`([^`]+)`/g, "<code>$1</code>");
  const lines = String(src || "").split(/\r?\n/);
  const out = [];
  let i = 0;
  while (i < lines.length) {
    const l = lines[i];
    if (/^\s*\|/.test(l)) {
      const rows = [];
      while (i < lines.length && /^\s*\|/.test(lines[i])) rows.push(lines[i++]);
      const cells = (r) => r.trim().replace(/^\||\|$/g, "").split("|").map((c) => c.trim());
      const body = rows.filter((r) => !/^\s*\|?\s*:?-{2,}/.test(r));
      const [head, ...rest] = body;
      out.push(`<div class="tbl"><table><thead><tr>${cells(head).map((c) => `<th>${inline(c)}</th>`).join("")}</tr></thead><tbody>${rest.map((r) => `<tr>${cells(r).map((c) => `<td>${inline(c)}</td>`).join("")}</tr>`).join("")}</tbody></table></div>`);
    } else if (/^\s*[-*] /.test(l)) {
      const items = [];
      while (i < lines.length && /^\s*[-*] /.test(lines[i])) items.push(lines[i++].replace(/^\s*[-*] /, ""));
      out.push(`<ul>${items.map((x) => `<li>${inline(x)}</li>`).join("")}</ul>`);
    } else if (!l.trim()) i++;
    else {
      const para = [];
      while (i < lines.length && lines[i].trim() && !/^\s*\|/.test(lines[i]) && !/^\s*[-*] /.test(lines[i])) para.push(lines[i++]);
      out.push(`<p>${inline(para.join(" "))}</p>`);
    }
  }
  return out.join("");
}

function renderReport() {
  const m = st.meta, run = st.run;
  $("report").innerHTML = m.final_report ? md(m.final_report) : `<p class="muted">No report in this file.</p>`;
  const F = cutMoveFacts(run);
  const rows = [];
  const receipts = run.events.filter((e) => e.event === "stop_receipt" && e.last_read);
  let prevX = 0;
  for (const d of run.drives) {
    const r = receipts.find((e) => e.rt >= (d.end ?? d.start));
    if (d.endedBy === "lease_end") rows.push([`Move ${d.n} ran (lease end)`, `${f2(d.ranS)} s`]);
    else if (d.endedBy && d.endedBy.startsWith("stop:")) {
      rows.push([`Move ${d.n} ran before the ${d.endedBy === "stop:owner" ? "owner's " : ""}stop`, `${f2(d.end - d.start)} s`],
        [null, "The stop's time minus the time BotInfo allowed the move. At this BotInfo version the log has no single field for it."]);
    }
    if (r) { rows.push([`Move ${d.n} distance (odometry)`, `${f3(r.last_read.x - prevX)} m`]); prevX = r.last_read.x; }
  }
  if (F && F.waitEndedByStop !== null) {
    rows.push(["The AI's wait that the stop ended", `${f3(F.waitEndedByStop)} s`],
      [null, F.waitEndedByStop > 0
        ? "botinfo_wait's waited_s: how long the AI's wait call ran before the stop ended it, not how long the move ran."
        : "Its wait call came after the stop and returned at once."]);
  }
  $("logfacts").innerHTML = rows.length ? facts(rows) : `<p class="muted">No moves in this log.</p>`;
}

async function verifyChain() {
  const el = $("chain");
  const lines = st.meta.audit.filter((s) => typeof s === "string");
  if (!lines.length || !(window.crypto && crypto.subtle)) { el.textContent = ""; return; }
  const id = st.meta.id;
  let good = 0;
  for (let i = 1; i < lines.length; i++) {
    const h = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(lines[i - 1]));
    const hex = [...new Uint8Array(h)].map((b) => b.toString(16).padStart(2, "0")).join("");
    if (JSON.parse(lines[i]).prev === hex) good++;
  }
  if (st.meta.id !== id) return;
  const pre = st.meta.audit_chain;
  el.textContent = `Audit hash chain, checked in your browser: ${good} of ${lines.length - 1} links verify.` +
    (pre ? ` The link from line 1 to line 2 breaks because we cut two local file paths from line 1 before publishing; before that cut, all ${pre.links_verified_before_path_cut} lines verified (tools/extract.py).` : "");
}

// ------------------------------------------------------------------ your own file
$("file").addEventListener("change", async (ev) => {
  const file = ev.target.files && ev.target.files[0];
  if (!file) return;
  const info = $("fileinfo");
  try {
    const text = await file.text();
    const lines = text.split(/\r?\n/).filter((s) => s.trim());
    parseAuditText(text);
    const meta = { id: `local-${Date.now()}`, local: true, label: file.name, model: "your AI", audit: lines,
      stop_setting: {}, task: "", final_report: "", file: "#" };
    const run = buildRun(lines.map((s) => JSON.parse(s)), meta);
    if (!run.drives.length) throw new Error("no allowed drive in this log");
    st.cache.set(meta.id, meta);
    const sel = $("run");
    const o = document.createElement("option");
    o.value = meta.id;
    o.textContent = `Your file: ${file.name}`;
    sel.prepend(o);
    sel.value = meta.id;
    setRun(meta);
    info.textContent = `Loaded ${lines.length} audit lines, ${run.drives.length} allowed drives${run.labStop ? ", one owner stop" : ", no owner stop"}.`;
    $("scene").scrollIntoView({ behavior: "smooth", block: "start" });
  } catch (e) {
    info.textContent = `Could not replay that file: ${e.message}`;
  }
});

// ------------------------------------------------------------------ wiring
$("run").addEventListener("change", (e) => {
  const meta = st.cache.get(e.target.value);
  if (meta && meta.local) setRun(meta);
  else selectRun(e.target.value).catch(showError);
});
$("play").addEventListener("click", play);
$("reset").addEventListener("click", reset);
$("stop").addEventListener("click", pressStop);
for (const b of document.querySelectorAll(".speed button")) {
  b.addEventListener("click", () => {
    st.speed = Number(b.dataset.speed);
    for (const x of document.querySelectorAll(".speed button")) x.setAttribute("aria-pressed", String(x === b));
  });
}
$("timeline").addEventListener("click", (e) => {
  const r = e.currentTarget.getBoundingClientRect();
  seek(((e.clientX - r.left) / r.width) * st.tStop);
});
document.addEventListener("keydown", (e) => {
  if (e.code !== "Space" && e.key !== " ") return;
  const tag = (e.target && e.target.tagName) || "";
  if (["INPUT", "SELECT", "TEXTAREA", "SUMMARY", "A"].includes(tag)) return;
  e.preventDefault();
  pressStop();
});

function showError(e) {
  showBanner(`Could not load the recorded runs: ${e.message}`);
  console.error(e);
}

resize();
requestAnimationFrame(frame);
loadIndex().catch(showError);

// for tests in the browser console
window.__stopButton = { st, MODEL };
