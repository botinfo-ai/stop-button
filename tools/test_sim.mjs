// node tools/test_sim.mjs  -- checks the replay engine against every recorded run in data/.
import { readFileSync, readdirSync } from "node:fs";
import { buildRun, simulate, stopMetrics, phaseAt, underUserStop, cutMoveFacts } from "../sim.js";

const dir = new URL("../data/", import.meta.url);
let fails = 0;
const ok = (cond, msg) => { if (!cond) { fails++; console.log("FAIL", msg); } };

for (const f of readdirSync(dir).filter((f) => f.endsWith(".json") && f !== "runs.json").sort()) {
  const meta = JSON.parse(readFileSync(new URL(f, dir), "utf8"));
  const run = buildRun(meta.audit.map((s) => JSON.parse(s)), meta);
  const rec = run.labReceipt;
  ok(run.labStop && rec, `${f}: has an owner stop and its receipt`);
  const tRead = run.labStop.rt + rec.last_read.after_stop_s;
  const sim = simulate(run, run.tEnd + 1);
  const k = Math.round(tRead / sim.step);
  const diff = Math.abs(sim.xs[k] - rec.last_read.x) * 1000;
  ok(diff < 5, `${f}: replay x ${sim.xs[k].toFixed(4)} vs logged ${rec.last_read.x.toFixed(4)} (${diff.toFixed(1)} mm)`);

  // the lab's own stop, in the model
  const lab = stopMetrics(sim, run.labStop.rt);
  ok(Math.abs(lab.restAfter - 0.1) < 1e-6 && Math.abs(lab.distance - 0.009) < 1e-6, `${f}: lab stop rest ${lab.restAfter} s, ${lab.distance} m`);

  // a press before the first move: nothing moves, every drive refused
  const early = simulate(run, run.tEnd + 1, 1.0);
  const m0 = stopMetrics(early, 1.0);
  ok(!m0.wasMoving && m0.restAfter === 0 && m0.distance === 0, `${f}: early press, rover at rest`);
  ok(Math.max(...early.xs) === 0, `${f}: early press, rover never moves`);
  const verdicts = underUserStop(run, 1.0);
  const refused = [...verdicts.values()].filter((v) => v.refused).length;
  ok(refused === run.drives.length, `${f}: early press refuses all ${run.drives.length} drives (got ${refused})`);

  // a press mid move 1 at cruise speed: 0.2 m/s -> 0.10 s, about 9 mm (Euler steps of the sim)
  const d1 = run.drives[0];
  const T1 = d1.start + 2.0;
  const s1 = simulate(run, run.tEnd + 1, T1);
  const m1 = stopMetrics(s1, T1);
  ok(Math.abs(m1.speed - 0.2) < 1e-6, `${f}: mid move 1 speed ${m1.speed}`);
  ok(Math.abs(m1.restAfter - 0.1) < 1e-6, `${f}: mid move 1 rest ${m1.restAfter}`);
  ok(Math.abs(m1.distance - 0.009) < 1e-6, `${f}: mid move 1 distance ${m1.distance}`);
  // a press 0.04 s into move 2's start ramp: slower, so a shorter stop
  const T2 = run.drives[1].start + 0.04;
  const m2 = stopMetrics(simulate(run, run.tEnd + 1, T2), T2);
  ok(m2.speed < 0.11 && m2.restAfter <= 0.06 && m2.distance < 0.004, `${f}: ramp press ${m2.speed} ${m2.restAfter} ${m2.distance}`);
  ok(phaseAt(run, T1).kind === "moving" && phaseAt(run, T1).drive.n === 1, `${f}: phase mid move 1`);
  ok(Math.abs(m1.x - (0.2 * 2.0 - 0.01 + 0.009)) < 0.012, `${f}: mid move 1 x ${m1.x}`);

  // a press after the lab's stop changes nothing
  const late = simulate(run, run.tEnd + 1, run.labStop.rt + 1.0);
  ok(Math.abs(late.xs[late.n - 1] - sim.xs[sim.n - 1]) < 1e-9, `${f}: late press changes nothing`);

  const facts = cutMoveFacts(run);
  console.log(`${f.padEnd(62)} x ${sim.xs[k].toFixed(4)} vs ${rec.last_read.x.toFixed(4)} (${diff.toFixed(1)} mm)` +
    `  lab stop: rest ${lab.restAfter.toFixed(2)} s, ${(lab.distance * 1000).toFixed(1)} mm` +
    `  cut move ran ${facts.ranBeforeStop.toFixed(2)} s, wait ${facts.waitEndedByStop} s`);
}
console.log(fails ? `${fails} FAILED` : "all checks pass");
process.exit(fails ? 1 : 0);
