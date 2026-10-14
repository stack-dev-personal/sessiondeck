// A stand-in for the docker CLI, placed first on PATH by the sprint script tests. It records
// its argv and the SPRINT_* environment to a log and answers from a scripted plan, so the
// real docker (and the real sprint container) is never touched.
//
//   FAKE_DOCKER_LOG   file that receives one JSON line per call
//   FAKE_DOCKER_PLAN  JSON object: { "<key>": { "code": 0, "out": "text" } }
//
// A plan key is "<call>" or "<call>:<container or project name>" (the name wins). Calls are
// ps, ps-a, up, stop, rm, network-ls, network-rm. Unlisted calls succeed with no output.
import { appendFileSync } from "node:fs";

const SECRET_NAME = /token|secret|password|api_key/i;
const NAME_IN_ARGV = /sprint-[A-Za-z0-9_-]+/;

const argv = process.argv.slice(2);

/** @param {string[]} args */
function callKey(args) {
  if (args[0] === "ps") return args.includes("-a") ? "ps-a" : "ps";
  if (args[0] === "compose") return args.includes("up") ? "up" : "compose";
  if (args[0] === "network") return `network-${args[1]}`;
  return args[0] ?? "";
}

const key = callKey(argv);
const name = argv.join(" ").match(NAME_IN_ARGV)?.[0];
const plan = JSON.parse(process.env.FAKE_DOCKER_PLAN ?? "{}");
const step = (name !== undefined && plan[`${key}:${name}`]) || plan[key] || {};

const sprintEnv = Object.fromEntries(
  Object.entries(process.env).filter(([k]) => k.startsWith("SPRINT_")),
);
// Names only: values of anything that looks like a secret must never be written down.
const secretNames = Object.keys(process.env).filter((k) => SECRET_NAME.test(k));

const logFile = process.env.FAKE_DOCKER_LOG;
if (logFile === undefined) throw new Error("FAKE_DOCKER_LOG is not set");

appendFileSync(
  logFile,
  `${JSON.stringify({ key, name: name ?? null, argv, env: sprintEnv, secretNames })}\n`,
);

if (step.out) process.stdout.write(`${step.out}\n`);
process.exit(step.code ?? 0);
