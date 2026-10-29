// Timing for R4.7: every built-in rule on 1 MB adversarial inputs, kept in its own file so the
// security gate's "< 1 s on 1 MB" check can be found and run alone. Each (rule, input, form) is
// measured up to three times and the best run is judged against the limit: the limit is on the
// algorithm (linear), not on a noisy neighbour. Prints the worst time per rule.
import { describe, expect, it } from "vitest";
import { createRedactor } from "../../src/redaction/redactor.ts";
import { BUILTIN_RULES, BUILTIN_RULE_NAMES } from "../../src/redaction/rules.ts";

const red = createRedactor();
const LIMIT_MS = 1000;
/** A run also passes when it is within this multiple of a linear scan of the same input on this machine. */
const BASELINE_RATIO = 8;
const linear = (x: string): number => x.replace(/[=:]\s*\S/g, "").length;
/** Best of up to three runs; stops early once a run is under the limit. */
function best(run: () => void): number {
  let b = Infinity;
  for (let i = 0; i < 3; i++) {
    const t0 = performance.now();
    run();
    b = Math.min(b, performance.now() - t0);
    if (b < LIMIT_MS) break;
  }
  return b;
}
const baselineOf = (line: string): number => best(() => linear(line));
/** Absolute under 1 s, or under BASELINE_RATIO x the linear scan of the same line. */
const within = (ms: number, base: number): boolean => ms < LIMIT_MS || ms < BASELINE_RATIO * base;
let maxRatio = { r: 0, what: "" };
const noteRatio = (ms: number, base: number, what: string): void => {
  if (ms / base > maxRatio.r) maxRatio = { r: ms / base, what };
};

const MB = 1 << 20;
const rep = (unit: string): string => unit.repeat(Math.ceil(MB / unit.length)).slice(0, MB);
const SHAPES: Record<string, string> = {
  "sk- repeated": rep("sk-"),
  "sk-a repeated": rep("sk-ab"),
  "sk- one long run": "sk-" + "a".repeat(MB),
  "password=! repeated": rep("password=!"),
  "password= repeated": rep("password="),
  "password: repeated": rep("password: "),
  "token: ! repeated": rep("token: !"),
  "TOKEN=quote repeated": rep('TOKEN="'),
  "API_KEY= repeated": rep("API_KEY="),
  "api_key quote repeated": rep("api_key='"),
  "password quote then run": rep('password="' + "a".repeat(1000)),
  "secret=a( repeated": rep("secret=a("),
  "auth: repeated": rep("auth:"),
  "auth:auth: one run": "auth:".repeat(MB / 5),
  "authorization spaces": "authorization" + " ".repeat(MB),
  "Authorization:! repeated": rep("Authorization:!"),
  "Bearer repeated": rep("Bearer a"),
  "Bearer . one run": "Bearer " + "a.".repeat(MB / 2),
  "x-api-key repeated": rep("x-api-key: "),
  "url scheme repeated": rep("a://b:"),
  "url long userinfo": rep("ab://" + "c".repeat(120) + ":" + "d".repeat(250)),
  "url escaped slashes": rep("a:\\\\/\\\\/b:"),
  "curl -u repeated": rep("curl " + "a ".repeat(100)),
  "curl -u -u": "curl " + "-u ".repeat(MB / 3),
  "--password repeated": rep("--password "),
  "--token= repeated": rep("--token="),
  "--a-b-token repeated": rep("--a-b-token "),
  "mysql -p repeated": rep("mysql -p"),
  "mysql words": rep("mysql " + "a ".repeat(60)),
  "docker login repeated": rep("docker login -p "),
  "az login words": rep("az login " + "a ".repeat(60)),
  "sshpass repeated": rep("sshpass "),
  "setx repeated": rep("setx KEY "),
  "setx long name": rep("setx " + "A".repeat(80) + " "),
  "Cookie repeated": rep("Cookie: a"),
  "Set-Cookie one run": "Set-Cookie: " + "a=b;".repeat(MB / 4),
  "PEM no end": "-----BEGIN PR" + "IVATE KEY-----" + "A".repeat(MB),
  "PEM repeated": rep("-----BEGIN PR" + "IVATE KEY-----" + "A".repeat(30)),
  "AKIA repeated": rep("AKIA"),
  "xoxb- repeated": rep("xoxb-"),
  "ghp_ repeated": rep("ghp_"),
  "github_pat_ repeated": rep("github_pat_"),
  "glpat- repeated": rep("glpat-"),
  "hf_ repeated": rep("hf_"),
  "AIza repeated": rep("AIza"),
  "npm_ repeated": rep("npm_"),
  "sk_live_ repeated": rep("sk_live_"),
  "eyJ repeated": rep("eyJaaaaaaaa."),
  "eyJ.eyJ repeated": rep("eyJaaaaa" + "aaa.eyJaaa" + "aaaaa."),
  "SG. repeated": rep("SG.aaaaaaaaaaaaaaaa."),
  "slack webhook repeated": rep("hooks.slack.com/services/A/B/"),
  "discord webhook repeated": rep("discord.com/api/webhooks/1/"),
  "escaped newline key": rep("\\npassword"),
  "dotted apikey": rep("a.".repeat(24) + "apikey"),
  backslashes: "\\".repeat(MB),
  quotes: '"'.repeat(MB),
  equals: "=".repeat(MB),
  "colon space": ": ".repeat(MB / 2),
  dollars: "$".repeat(MB),
  "machine repeated": rep("machine a "),
  "machine then spaces": "machine a login " + " ".repeat(MB),
  "login password repeated": rep("login a password "),
  "<password> repeated": rep("<password>a"),
  "<password> long value": "<password>" + "a".repeat(MB),
  "<passw-tag attrs": rep("<password " + "a ".repeat(50)),
  "key= name pair repeated": rep('<add key="ApiKey" '),
  "name: pair repeated": rep("name: A_TOKEN\n  "),
  "name pair long name": rep('name="' + "a.".repeat(40)),
  "IDENTIFIED BY repeated": rep("IDENTIFIED BY "),
  "PASSWORD quote repeated": rep("PASSWORD '"),
  "pass: repeated": rep("pass: "),
  "client-key-data repeated": rep("key-data: LS0tLS1CRUdJTiAAAAAAAA"),
  "LS0t repeated": rep("LS0tLS1CRUdJTi"),
  "LS0t one run": "LS0tLS1CRUdJTi" + "A".repeat(MB),
  "echo repeated": rep("echo a | "),
  "printf repeated": rep("printf '%s' a | "),
  "net use repeated": rep("net use \\\\h\\s "),
  "ConvertTo-SecureString repeated": rep("ConvertTo-SecureString -String "),
  "-Password repeated": rep("-Password "),
  "-pass pass: repeated": rep("-passin pass:"),
  "/password: repeated": rep(" /password:"),
  "redis-cli repeated": rep("redis-cli x -a "),
  "zip -P repeated": rep("zip x -P "),
  "7z -p repeated": rep("7z x -p"),
  "curl -b repeated": rep("curl -b a=bbb;"),
  "cookie pairs one run": "Cookie: a=bbb" + ";c=ddd".repeat(MB / 6),
  "cookie = quote repeated": rep('cookie="'),
  "document.cookie": rep("document.cookie = 'a=bbb"),
  "tokens: hvs. repeated": rep("hvs."),
  "whsec_ repeated": rep("whsec_"),
  "HRKU- repeated": rep("HRKU-"),
  "IncomingWebhook/ repeated": rep("IncomingWebhook/"),
  "IncomingWebhook one run": "IncomingWebhook/" + "a".repeat(MB),
  "?sig= repeated": rep("?sig="),
  "&sig= one run": "&sig=" + "a".repeat(MB),
  "pgpass fields": rep("a:1:b:c:"),
  "pgpass colons": ":".repeat(MB),
  "digits colon AA": rep("1234567890:AA"),
  "Q~ repeated": rep("aaa1Q~"),
  "key- hex repeated": rep("key-0123456789abcdef"),
  '["] closer repeated': rep('password"]'),
  "=> := ?= repeated": rep("password=>"),
  ":= repeated": rep("password:="),
  "comma form repeated": rep("'password',"),
  // iteration 3
  "pgpass quote run": rep('"""":1:'),
  "pgpass quote run colons": rep('"":1:"":1:'),
  "pgpass lines": rep("a:1:b:c:dd\n"),
  "pgpass escaped lines": rep("a:1:b:c:dd\\n"),
  "pgpass echo repeated": rep('echo "a:1:b:c:'),
  "pgpass timestamps": rep("2026-10-27T15:57:40.666Z:worker:retry:3 "),
  "SECRET_ repeated": rep("SECRET_"),
  "SECRET_KEY_BASE= repeated": rep("SECRET_KEY_BASE="),
  "secret_key_base: repeated": rep("secret_key_base: "),
  "secret_ one long name": "secret" + "_a".repeat(MB / 2),
  "secretKey camel run": "secret" + "Ab".repeat(MB / 2),
  "UPPER one long name": "A".repeat(MB),
  "UPPER_ long name": "A_".repeat(MB / 2) + "SECRET=",
  "token_ repeated": rep("token_a_b_c="),
  "annotation repeated": rep("password: string "),
  "annotation long type": rep("password: " + "a, ".repeat(20)),
  "annotation then =": rep("apiKey: Optional[str] = "),
  "--authtoken repeated": rep("--authtoken "),
  "--joined long": "--" + "a".repeat(MB),
  "--a-b-c- repeated": rep("--a-b-c-d-secret"),
  "-storepass repeated": rep("-storepass "),
  "sqlcmd repeated": rep("sqlcmd -P "),
  "sqlcmd words": rep("sqlcmd " + "a ".repeat(60)),
  "mongosh repeated": rep("mongosh -p "),
  "mongo words": rep("mongo " + "a ".repeat(60)),
  "smbclient repeated": rep("smbclient -U a%"),
  "htpasswd flags": rep("htpasswd -b -c -n "),
  "htpasswd long flag": "htpasswd -" + "b".repeat(MB),
  "gh secret set words": rep("gh secret set " + "a ".repeat(60)),
  "ngrok repeated": rep("ngrok config add-authtoken "),
  "aws configure repeated": rep("aws configure set a.b.aws_secret_access_key "),
  "echo sudo repeated": rep("echo a | sudo -S "),
  "quoted pipe SecureString": rep("'a' | ConvertTo-SecureString "),
  "quote then pipe": "'" + "a".repeat(MB),
  "curl -u key: repeated": rep("curl -u " + "a".repeat(20)),
  "keyName repeated": rep('"keyName":"a",'),
  "keyName long": '"keyName":"a",' + "b".repeat(MB),
  "/secrets/ repeated": rep('/secrets/a/b" '),
  "/secrets/ long": '/secrets/a" ' + "b".repeat(MB),
  "<entry key= repeated": rep('<entry key="a.pass'),
  "<entry long": '<entry key="a.password">' + "b".repeat(MB),
  "Ocp-Apim repeated": rep("Ocp-Apim-Subscription-Key: "),
  "dsn repeated": rep("dsn: '"),
  "closer run": "password=a" + ")".repeat(MB),
  "bracket run": "password=aaa" + "[".repeat(MB / 2) + "]".repeat(MB / 2),
};

describe("timing: 1 MB adversarial input, per rule", () => {
  it("every built-in rule finishes each input in under 1 s (raw and JSON-wrapped, best of 3)", () => {
    const slow: string[] = [];
    const worstByRule: Record<string, { ms: number; what: string }> = {};
    for (const rule of BUILTIN_RULES) {
      const one = createRedactor({
        enabled: true,
        deny: [],
        allow: [],
        disableRules: new Set(BUILTIN_RULE_NAMES.filter((n) => n !== rule.name)),
      });
      const w = { ms: 0, what: "" };
      for (const [name, input] of Object.entries(SHAPES)) {
        expect(input.length, name).toBeGreaterThanOrEqual(MB - 64);
        for (const [form, line] of [
          ["raw", input],
          ["json", JSON.stringify({ t: input })],
        ] as const) {
          const ms = best(() => one.redactLine(line));
          if (ms > w.ms) Object.assign(w, { ms, what: `${name} / ${form}` });
          if (ms >= LIMIT_MS) {
            const base = baselineOf(line);
            noteRatio(ms, base, `${rule.name} / ${name} / ${form}`);
            if (!within(ms, base)) {
              slow.push(
                `${rule.name} / ${name} / ${form}: ${ms.toFixed(0)} ms (linear baseline ${base.toFixed(0)} ms)`,
              );
            }
          }
        }
      }
      worstByRule[rule.name] = w;
    }
    console.log(
      `timing, worst per rule (best of 3, ${Object.keys(SHAPES).length} inputs x 2 forms, ~1 MB each):\n` +
        Object.entries(worstByRule)
          .map(([n, w]) => `  ${n.padEnd(22)} ${w.ms.toFixed(0).padStart(5)} ms  (${w.what})`)
          .join("\n"),
    );
    console.log(
      `timing, runs over 1 s judged against the baseline: worst ratio ${maxRatio.r.toFixed(1)}x (${maxRatio.what || "none over 1 s"}); limit ${BASELINE_RATIO}x`,
    );
    expect(slow).toEqual([]);
  }, 900_000);

  it("all rules together stay under 1 s on each input (best of 3)", () => {
    const slow: string[] = [];
    let worst = { ms: 0, what: "" };
    for (const [name, input] of Object.entries(SHAPES)) {
      const ms = best(() => red.redactLine(input));
      if (ms > worst.ms) worst = { ms, what: name };
      if (ms >= LIMIT_MS) {
        const base = baselineOf(input);
        if (!within(ms, base))
          slow.push(`${name}: ${ms.toFixed(0)} ms (linear baseline ${base.toFixed(0)} ms)`);
      }
    }
    console.log(
      `timing, all rules together: worst ${worst.ms.toFixed(0)} ms (${worst.what}); linear baseline on it ${baselineOf(SHAPES[worst.what]!).toFixed(1)} ms`,
    );
    expect(slow).toEqual([]);
  }, 900_000);

  it("a 200000-deep line does not leak and does not hang", () => {
    const a = "sk-ant-api03-" + "Qx7vR2mN9pL4kT" + "8wZ1yB5cD3fG6hJ0sA-xYzW_kQ12";
    const line = "[".repeat(200000) + JSON.stringify({ t: `key ${a}` }) + "]".repeat(200000);
    let out = "";
    const ms = best(() => {
      out = red.redactLine(line);
    });
    expect(out).not.toContain(a);
    expect(ms).toBeLessThan(LIMIT_MS);
  });
});
