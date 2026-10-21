// Loss harness (R1.4, R1.5). Runs the built daemon against a stub hub through daemon kills,
// a hub kill, a lost ack, and a hub outage, and prints evidence lines. Exit 1 on any loss.
//   node scripts/harness-loss.mjs            (after `pnpm -F @sessiondeck/probe build`)
// SD_OUTAGE_MS (default 15000) is the compressed stand-in for the 10 minute outage of R1.5; the
// daemon's retry cap is shortened to 1.5 s for the run (SESSIONDECK_BACKOFF_CAP_MS) so recovery
// does not wait out a 30 s backoff. SD_OUTAGE_MS=600000 runs the real 10 minutes.
import { runKillScenario, runOutageScenario } from "./loss-lib.mjs";

const line = (r) =>
  `sent=${r.sent} accepted=${r.accepted} duplicates=${r.duplicates} gaps=${r.gaps} order=${r.order}`;

const kill = await runKillScenario();
console.log(
  `R1.4 kill/restart: ${line(kill)} daemon_kills=${kill.daemon_kills} resent_ids=${kill.resent_ids} requests=${kill.requests}`,
);
const outageMs = Number(process.env.SD_OUTAGE_MS ?? 15000);
const out = await runOutageScenario({ outageMs });
console.log(
  `R1.5 outage ${out.outage_ms}ms: ${line(out)} delivered_during_outage=${out.delivered_during_outage} recover_ms=${out.recover_ms}`,
);
const good = (r) => r.accepted === r.sent && r.duplicates === 0 && r.gaps === 0 && r.order === "ok";
const pass = good(kill) && good(out) && out.delivered_during_outage === 0 && out.recovered;
console.log(pass ? "RESULT pass" : "RESULT FAIL");
process.exit(pass ? 0 : 1);
