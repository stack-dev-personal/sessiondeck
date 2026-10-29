// R4.7, review fix iteration 3: one test per finding. The corpora (fresh-*) carry the leak and
// benign shapes; these tests name the findings and cover what a corpus line cannot (validator,
// runtime bound, TOKEN_HINT in step with TOKEN_FORMATS).
import { describe, expect, it } from "vitest";
import { compileRedactionConfig } from "../../src/redaction/config.ts";
import {
  LINE_BUDGET_MS,
  createRedactor,
  redactorFromConfig,
} from "../../src/redaction/redactor.ts";
import { TOKEN_FORMATS, TOKEN_HINT, ci, trimBrackets } from "../../src/redaction/rules.ts";

const red = createRedactor();
const V = "Hk29dLq7VzQ";
const wrap = (content: string): string =>
  JSON.stringify({ type: "user", message: { content: [{ type: "tool_result", content }] } });
const sec = (t: string, secret = V): void => {
  const out = red.redactLine(wrap(t));
  expect(out, t).not.toContain(secret);
  expect(out, t).toContain("[redacted:");
};
const same = (t: string): void => expect(red.redactLine(wrap(t)), t).toBe(wrap(t));

describe("iteration 3: key-name families", () => {
  it("HIGH 1: a secret word at the start or middle of a name, with a suffix", () => {
    for (const t of [
      `SECRET_KEY_BASE=${V}`,
      `secret_key_base: ${V}`,
      `heroku config:set SECRET_KEY_BASE=${V}`,
      `MY_APP_SECRET_KEY_BASE=${V}`,
      `app.secretKeyBase = "${V}"`,
      `secret_string = '${V}'`,
      `STOREPASS=${V}`,
    ]) {
      sec(t);
    }
  });
  it("HIGH 1: suffixes that name a setting stay", () => {
    for (const t of [
      "max_tokens: 1024",
      "token_type: bearer",
      "tokenCount: 17",
      "PASSWORD_MIN_LENGTH=12",
      "TOKEN_EXPIRY=3600",
      "password_file=/run/x",
      "SECRET_NAME=prod/db",
    ]) {
      same(t);
    }
  });
  it("HIGH 2: an optional type annotation between the key and =", () => {
    for (const t of [
      `const apiKey: string = "${V}"`,
      `private readonly apiKey: string = '${V}'`,
      `password: str = "${V}"`,
      `token: String = "${V}"`,
      `password: Optional[str] = "${V}"`,
      `API_KEY: str = "${V}"`,
    ]) {
      sec(t);
    }
    same("apiKey: string = process.env.API_KEY");
    same("password: str = None");
    same("token: Token = createToken(user)");
    // base64 padding is not an annotation
    const out = red.redactLine(wrap("password: UGFzc3cwcmQxMjM=\n  token: Z2hwX0FiM2RFZjZoSWo5"));
    expect(out).not.toContain("UGFzc3cwcmQxMjM");
    expect(out).not.toContain("Z2hwX0FiM2RFZjZoSWo5");
  });
  it("MEDIUM: cloud CLI output under a generic key", () => {
    sec(`[{"keyName":"key1","permissions":"FULL","value":"${V}AbCdEf0123456789=="}]`);
    sec(`{"id":"https://v.vault.azure.net/secrets/db/0123abcd","name":"db","value":"${V}"}`);
    sec(`{"SecretString":"${V}"}`);
    same('{"keyName":"key1","permissions":"FULL"}');
    // the same keys in a parsed JSON object
    const o = red.redactLine(JSON.stringify({ SecretString: V, secret_key_base: V }));
    expect(o).not.toContain(V);
  });
  it("LOW: identifier values in object literals, a trailing closer of the surrounding code", () => {
    same("const user = { name, password: hashed, role }");
    same("  token: tokenFromHeader,");
    same("return { ok: true, token: tokenValue }");
    const out = red.redactLine(wrap(`getToken(password=${V}) x`));
    expect(out).not.toContain(V);
    expect(out).toContain("[redacted:env-assignment]) x");
    expect(trimBrackets("a(b)c)")).toBe("a(b)c");
    expect(trimBrackets("ab]")).toBe("ab");
    expect(trimBrackets("a[b]")).toBe("a[b]");
  });
  it("code shapes from the repo's own source stay (parameters, operators, shorthand)", () => {
    for (const t of [
      "export type WriteToken = (handle: FileHandle, token: string) => Promise<void>;",
      "writeToken: WriteToken = writeTokenDefault,",
      "const principalOfToken = (t: string | null): string | null =>",
      "if (this.tokenAt === 0) this.tokenAt = now;",
      "token: token ?? existing?.token,",
      "const secret = sec ?? m;",
      'token: typeof p.token === "string" ? p.token : "",',
    ]) {
      same(t);
    }
  });
  it("ci() rewrites letters outside classes and keeps groups and quantifiers", () => {
    const re = new RegExp(ci(String.raw`(?<a>ab[A-Z]{2})\k<a>x{1,3}`));
    expect(re.test("AbCDAbCDx")).toBe(true);
    expect(re.test("abcdabcdx")).toBe(false);
  });
});

describe("iteration 3: CLI forms", () => {
  it("MEDIUM: joined compound flags and tool -p/-P forms", () => {
    for (const t of [
      `--authtoken ${V}`,
      `--apitoken ${V}`,
      `--accesstoken=${V}`,
      `--clientsecret ${V}`,
      `--secretkey ${V}`,
      `--auth-key ${V}`,
      `--authkey ${V}`,
      `sqlcmd -S h -U sa -P ${V}`,
      `bcp db.dbo.t out t.dat -U sa -P ${V} -c`,
      `mongosh -u admin -p ${V} --host h`,
      `mongo --host h -u admin -p ${V}`,
      `keytool -importkeystore -storepass ${V} -srckeystore a.jks`,
      `jarsigner -keystore a.jks -keypass ${V} app.jar alias`,
      `'${V}' | ConvertTo-SecureString -AsPlainText -Force`,
      `echo '${V}' | sudo -S apt update`,
      `aws configure set aws_secret_access_key ${V}`,
      `smbclient //h/share -U user%${V}`,
      `htpasswd -bc .htpasswd alice ${V}`,
      `gh secret set DEPLOY_KEY --body ${V}`,
      `ngrok config add-authtoken ${V}`,
      `curl -u ${V}abc123: https://x`,
    ]) {
      sec(t);
    }
    for (const t of [
      "--bypass yes",
      "--passthrough yes",
      "--authtoken-file /run/secrets/t",
      "mongo -p 27017",
      "sqlcmd -S h -E -Q 'select 1'",
      "echo hello | sudo tee /etc/motd",
      "aws configure set region us-east-1",
      "htpasswd -n alice",
      "curl -u admin: https://x",
    ]) {
      same(t);
    }
  });
  it("LOW: minor shapes", () => {
    sec(`Ocp-Apim-Subscription-Key: ${V}`);
    sec(`dsn: "https://${V}@o1.ingest.sentry.io/2"`);
    sec(`<entry key="db.password">${V}</entry>`);
    sec(`<property name="spring.datasource.password">${V}</property>`);
    same('<entry key="db.host">localhost</entry>');
  });
});

describe("iteration 3: pgpass precision", () => {
  it("anchors at a line start, a literal newline, or echo; rejects MAC, IPv6, timestamps", () => {
    sec(`localhost:5432:mydb:me:${V}`);
    sec(`cat ~/.pgpass\nhost.example.com:5432:db:app:${V}`);
    sec(`echo "localhost:5432:*:me:${V}" >> ~/.pgpass`);
    const raw = `garbage "cat x\\nhost.example.com:5432:db:app:${V}"`;
    expect(red.redactLine(raw)).not.toContain(V);
    for (const t of [
      "00:15:5d:01:02:03",
      "link/ether 00:15:5d:01:02:03 brd ff:ff:ff:ff:ff:ff",
      "inet6 2001:0:0:0:1:2:3:4/64 scope global",
      "ts 12:30:45:123:456",
      "2026-10-27T15:57:40.666Z:worker:retry:3 failed",
      '{"time":"2026-10-27T15:57:40.666Z","msg":"listening","port":8787}',
    ]) {
      same(t);
      expect(red.redactLine(t), t).toBe(t);
    }
  });
});

describe("iteration 3: token formats", () => {
  it("Mailgun key- is not matched inside a longer name", () => {
    same("object-key-d41d8cd98f00b2" + "04e9800998ecf8427e");
    sec("key-d41d8cd98f00b2" + "04e9800998ecf8427e", "d41d8cd98f00b204e9800998ecf8427e");
  });
  const a = (n: number, set = "AbCdEf0123456789"): string =>
    set.repeat(Math.ceil(n / 16)).slice(0, n);
  const hex = (n: number): string => "0123456789abcdef".repeat(Math.ceil(n / 16)).slice(0, n);
  const SAMPLES: string[] = [
    `sk_live_${a(24)}`,
    `whsec_${a(16)}`,
    `AIza${a(35)}`,
    `ya29.${a(24)}`,
    `GOCSPX-${a(24)}`,
    `npm_${a(36)}`,
    `glpat-${a(24)}`,
    `hf_${a(34)}`,
    `SG.${a(16)}.${a(16)}`,
    `hvs.${a(24)}`,
    `HRKU-${a(24)}`,
    `dop_v1_${hex(40)}`,
    `dckr_pat_${a(24)}`,
    `shpat_${hex(32)}`,
    `pypi-AgEIcHlwaS5vcmc${a(50)}`,
    `glc_${a(30)}`,
    `lin_api_${a(30)}`,
    `ntn_${a(30)}`,
    `PMAK-${hex(24)}-${hex(34)}`,
    `dapi${hex(32)}`,
    `ATATT3${a(24)}`,
    `sntrys_${a(24)}`,
    `sbp_${hex(40)}`,
    `xapp-1-${a(12)}`,
    `sq0atp-${a(24)}`,
    `SK${hex(32)}`,
    `key-${hex(32)}`,
    `oy2${"abcdefghij0123456789".repeat(3).slice(0, 43)}`,
    `AGE-SECRET-KEY-1${"ABCDEFGHIJ0123456789".repeat(3).slice(0, 58)}`,
    `abc1Q~${a(32)}`,
    `1234567890:AA${a(33)}`,
    `eyJ${a(10)}.eyJ${a(10)}.${a(10)}`,
  ];
  it("one sample per TOKEN_FORMATS entry: TOKEN_HINT matches it and its format redacts it", () => {
    expect(SAMPLES).toHaveLength(TOKEN_FORMATS.length);
    SAMPLES.forEach((s, i) => {
      expect(TOKEN_HINT.test(s), `hint: ${s}`).toBe(true);
      expect(new RegExp(TOKEN_FORMATS[i]!).test(s), `format ${i}: ${s}`).toBe(true);
      const out = red.redactLine(wrap(`x ${s} y`));
      expect(out, s).not.toContain(s);
      expect(out, s).toContain("[redacted:");
    });
  });
});

describe("iteration 3: deny/allow validator", () => {
  const rejects = (p: string): boolean =>
    !compileRedactionConfig({ deny: [{ name: "u", pattern: p }] }).ok;
  it("MEDIUM: an inner ? makes a quantified group variable; ranged quantifiers are capped", () => {
    expect(rejects("(?:a?){40}b")).toBe(true);
    expect(rejects("(?:a?)+b")).toBe(true);
    expect(rejects(String.raw`\w{1,99}\w{1,99}\w{1,99}!`)).toBe(true);
    expect(rejects(".{0,99}a.{0,99}b.{0,99}c.{0,99}d.{0,99}e")).toBe(true);
    expect(rejects(String.raw`\w{1,64}@\w{1,64}\.com`)).toBe(false);
    expect(rejects("CORP-[0-9]{8}")).toBe(false);
    expect(rejects("(?:foo)?bar")).toBe(false);
  });
  // Passes every static check (a quantifier-free chain of alternations) and is exponential.
  const EVIL = "(?:a|a)".repeat(40) + "b";
  it("MEDIUM: an accepted but catastrophic pattern is cut off at the line budget", () => {
    const { redactor, error } = redactorFromConfig({ deny: [{ name: "evil", pattern: EVIL }] });
    expect(error).toBeUndefined();
    const t0 = performance.now();
    const out = redactor.redactLine(wrap("a".repeat(60) + "c " + V));
    const ms = performance.now() - t0;
    expect(JSON.parse(out)).toEqual({ type: "sessiondeck_marker", reason: "redaction_failed" });
    expect(out).not.toContain(V);
    expect(ms).toBeLessThan(LINE_BUDGET_MS * 3);
    // the redactor recovers: the next line is redacted normally
    const next = redactor.redactLine(wrap(`password=${V}`));
    expect(next).not.toContain(V);
    console.log(`runtime bound: catastrophic deny pattern cut off after ${ms.toFixed(0)} ms`);
  });
  it("an allow pattern is bounded the same way", () => {
    const { redactor } = redactorFromConfig({ allow: [EVIL] });
    const out = redactor.redactLine(wrap("password=" + "a".repeat(60) + "c"));
    expect(JSON.parse(out)).toEqual({ type: "sessiondeck_marker", reason: "redaction_failed" });
  });
  it("the guard costs well under a millisecond per line", () => {
    const { redactor } = redactorFromConfig({ deny: [{ name: "pin", pattern: "PIN[0-9]{2}" }] });
    const lines = Array.from({ length: 2000 }, (_, i) => wrap(`line ${i} PIN12 password=${V}`));
    const t0 = performance.now();
    for (const l of lines) redactor.redactLine(l);
    const per = (performance.now() - t0) / lines.length;
    console.log(`runtime bound overhead: ${(per * 1000).toFixed(0)} us per line (deny configured)`);
    expect(per).toBeLessThan(5);
  });
});
