// Generates secret-corpus.txt, secret-corpus.expected.json and benign-corpus.txt (R4.7).
// Deterministic (seeded). Every secret is synthetic: its body starts with FAKE or EXAMPLE, so none
// is a working credential and none passes a vendor checksum. Re-run: node gen-corpus.mjs
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = join(dirname(fileURLToPath(import.meta.url)), ".generated");
mkdirSync(here, { recursive: true });
let seed = 0x5eed1234;
function rnd() {
  seed = (seed + 0x6d2b79f5) | 0;
  let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
}
const pick = (xs) => xs[Math.floor(rnd() * xs.length)];
const ALNUM = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
const UP = "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";
const B64 = ALNUM + "+/";
const chars = (set, n) =>
  Array.from({ length: n }, () => set[Math.floor(rnd() * set.length)]).join("");

// Prefixed credentials: recognizable anywhere.
const PREFIXED = [
  () => ({ v: `ghp_FAKE${chars(ALNUM, 28)}`, env: "GITHUB_TOKEN" }),
  () => ({ v: `gho_FAKE${chars(ALNUM, 28)}`, env: "GH_TOKEN" }),
  () => ({ v: `ghu_FAKE${chars(ALNUM, 28)}`, env: "GH_USER_TOKEN" }),
  () => ({ v: `ghs_FAKE${chars(ALNUM, 28)}`, env: "GITHUB_APP_TOKEN" }),
  () => ({ v: `ghr_FAKE${chars(ALNUM, 28)}`, env: "GH_REFRESH_TOKEN" }),
  () => ({ v: `github_pat_FAKE${chars(ALNUM + "_", 40)}`, env: "GITHUB_PAT" }),
  () => ({ v: `sk-ant-api03-FAKE${chars(ALNUM + "_-", 60)}`, env: "ANTHROPIC_API_KEY" }),
  () => ({ v: `sk-proj-FAKE${chars(ALNUM + "_-", 44)}`, env: "OPENAI_API_KEY" }),
  () => ({ v: `sk-FAKE${chars(ALNUM, 40)}`, env: "LLM_API_KEY" }),
  () => ({ v: `AKIAFAKE${chars(UP, 12)}`, env: "AWS_ACCESS_KEY_ID" }),
  () => ({ v: `ASIAFAKE${chars(UP, 12)}`, env: "AWS_SESSION_ID_KEY" }),
  () => ({ v: `xoxb-FAKE-${chars("0123456789", 11)}-${chars(ALNUM, 24)}`, env: "SLACK_BOT_TOKEN" }),
  () => ({
    v: `xoxp-FAKE-${chars("0123456789", 11)}-${chars(ALNUM, 24)}`,
    env: "SLACK_USER_TOKEN",
  }),
  () => ({ v: `sk_live_FAKE${chars(ALNUM, 24)}`, env: "STRIPE_SECRET_KEY" }),
  () => ({ v: `AIzaFAKE${chars(ALNUM + "_-", 31)}`, env: "GOOGLE_API_KEY" }),
  () => ({ v: `npm_FAKE${chars(ALNUM, 32)}`, env: "NPM_TOKEN" }),
  () => ({ v: `glpat-FAKE${chars(ALNUM, 20)}`, env: "GITLAB_TOKEN" }),
  () => ({
    v: `eyJFAKE${chars(ALNUM, 14)}.eyJFAKE${chars(ALNUM, 20)}.FAKE${chars(ALNUM + "_-", 30)}`,
    env: "SESSION_JWT_TOKEN",
  }),
];
// Opaque secrets: only recognizable by the name they are assigned to.
const OPAQUE = [
  () => ({ v: `FAKEpass${chars(ALNUM, 6)}9`, env: "DB_PASSWORD", name: "password" }),
  () => ({ v: `hunter2-FAKE-${chars(ALNUM, 8)}`, env: "ADMIN_PASSWORD", name: "password" }),
  () => ({ v: `FAKE${chars(ALNUM, 30)}7`, env: "SESSION_SECRET", name: "secret" }),
  () => ({
    v: `FAKE/${chars(B64, 34)}`,
    env: "AWS_SECRET_ACCESS_KEY",
    name: "aws_secret_access_key",
  }),
  () => ({ v: `FAKE${chars(ALNUM, 22)}3`, env: "SIGNING_KEY", name: "api_key" }),
  () => ({ v: `FAKE${chars(ALNUM, 20)}`, env: "REDIS_PASS", name: "client_secret" }),
  () => ({ v: `Pa55-FAKE-${chars(ALNUM, 8)}`, env: "SMTP_PASSWORD", name: "passwd" }),
  () => ({ v: `FAKE${chars(ALNUM, 32)}`, env: "WEBHOOK_TOKEN", name: "access_token" }),
];
const pw = () => `FAKEpw${chars(ALNUM, 10)}`;

function pem(kind) {
  const body = [0, 1, 2].map(() => `MIIEFAKE${chars(B64, 56)}`);
  return {
    body,
    text: (nl) => `-----BEGIN ${kind}-----${nl}${body.join(nl)}${nl}-----END ${kind}-----`,
  };
}

// Text templates: (token) -> { text, secrets }.
const prefixedTemplates = [
  (t) => [`${t.env}=${t.v}`, [t.v]],
  (t) => [`export ${t.env}="${t.v}"`, [t.v]],
  (t) => [`set ${t.env}=${t.v}`, [t.v]],
  (t) => [`$env:${t.env} = "${t.v}"`, [t.v]],
  (t) => [`docker run --rm -e ${t.env}=${t.v} -e DEBUG=1 example/img:latest`, [t.v]],
  (t) => [`curl -sS -H "Authorization: Bearer ${t.v}" https://api.example.test/v1/me`, [t.v]],
  (t) => [`curl -sS -H 'X-Api-Key: ${t.v}' https://api.example.test/v1/items`, [t.v]],
  (t) => [`Authorization: Bearer ${t.v}`, [t.v]],
  (t) => [`{"api_key": "${t.v}", "region": "us-east-1"}`, [t.v]],
  (t) => [`  token: ${t.v}`, [t.v]],
  (t) => [`client = Client(api_key="${t.v}", timeout=30)`, [t.v]],
  (t) => [`echo ${t.v} | gh auth login --with-token`, [t.v]],
  (t) => [`git clone https://x-access-token:${t.v}@github.com/example/repo.git`, [t.v]],
  (t) => [`//registry.npmjs.org/:_authToken=${t.v}`, [t.v]],
  (t) => [`GET /v1/items?limit=10&access_token=${t.v} HTTP/1.1`, [t.v]],
  (t) => [`the key is ${t.v} (rotate it)`, [t.v]],
];
const opaqueTemplates = [
  (t) => [`${t.env}=${t.v}`, [t.v]],
  (t) => [`export ${t.env}='${t.v}'`, [t.v]],
  (t) => [`set ${t.env}=${t.v}`, [t.v]],
  (t) => [`$env:${t.env} = "${t.v}"`, [t.v]],
  (t) => [`  ${t.name}: "${t.v}"`, [t.v]],
  (t) => [`{"${t.name}": "${t.v}", "debug": false}`, [t.v]],
  (t) => [`${t.name} = '${t.v}'`, [t.v]],
  (t) => [`config.${t.name}="${t.v}";`, [t.v]],
];
const urlTemplates = () => {
  const p = pw();
  const q = pw();
  return [
    [`DATABASE_URL=postgres://app:${p}@db.example.test:5432/app`, [p]],
    [`mongodb+srv://svc:${p}@cluster0.example.test/db?retryWrites=true`, [p]],
    [`redis://:${p}@cache.example.test:6379/0`, [p]],
    [`psql "postgresql://admin:${p}@10.0.0.5/prod?sslmode=require"`, [p]],
    [`url: amqp://guest:${p}@mq.example.test:5672/vhost`, [p]],
    [`curl -u admin:${p} https://x.example.test/admin`, [p]],
    [`curl --user "ci:${q}" https://x.example.test/api`, [q]],
    [`https://user:${p}@git.example.test/team/repo.git`, [p]],
  ];
};

const out = []; // { line, secrets, json }
const add = (line, secrets, json = false) => out.push({ line, secrets, json });

// 1) 112 plain-text lines.
for (let i = 0; i < 72; i++) {
  const t = PREFIXED[i % PREFIXED.length]();
  const [text, s] = prefixedTemplates[Math.floor(i / 2) % prefixedTemplates.length](t);
  add(text, s);
}
for (let i = 0; i < 24; i++) {
  const t = OPAQUE[i % OPAQUE.length]();
  const [text, s] = opaqueTemplates[(i + Math.floor(i / 8)) % opaqueTemplates.length](t);
  add(text, s);
}
for (let i = 0; i < 12; i++) {
  const [text, s] = urlTemplates()[i % 8];
  add(text, s);
}
for (const kind of ["RSA PRIVATE KEY", "PRIVATE KEY", "OPENSSH PRIVATE KEY", "EC PRIVATE KEY"]) {
  const k = pem(kind);
  add(k.text(" "), k.body);
}

// 2) 88 JSON transcript-style lines (escapes, tool_result, hook attachment, structured keys).
const toolResult = (content) =>
  JSON.stringify({
    type: "user",
    message: {
      role: "user",
      content: [{ type: "tool_result", tool_use_id: "toolu_FAKE01", content }],
    },
  });
const toolUse = (input) =>
  JSON.stringify({
    type: "assistant",
    message: {
      role: "assistant",
      content: [{ type: "tool_use", id: "toolu_FAKE02", name: "Bash", input }],
    },
  });
const attachment = (a) => JSON.stringify({ type: "attachment", attachment: a });
for (let i = 0; i < 88; i++) {
  const t = PREFIXED[(i * 5) % PREFIXED.length]();
  const o = OPAQUE[i % OPAQUE.length]();
  const p = pw();
  switch (i % 11) {
    case 0:
      add(
        toolResult(`APP_NAME=demo\n${t.env}=${t.v}\nDEBUG=1\n${o.env}=${o.v}\n`),
        [t.v, o.v],
        true,
      );
      break;
    case 1:
      add(
        toolResult(
          `[default]\naws_access_key_id = AKIAFAKE${chars(UP, 12)}\naws_secret_access_key = ${o.v}\n`,
        ),
        [], // filled below
        true,
      );
      {
        const last = out.at(-1);
        const m = /AKIAFAKE[A-Z0-9]{12}/.exec(last.line);
        last.secrets = [m[0], o.v];
      }
      break;
    case 2:
      add(
        toolUse({
          command: `curl -H "Authorization: Bearer ${t.v}" https://api.example.test/x`,
          description: "call",
        }),
        [t.v],
        true,
      );
      break;
    case 3:
      add(
        attachment({
          type: "hook_non_blocking_error",
          hookName: "PreToolUse:Bash",
          command: `node hook.mjs --token ${t.v}`,
          stderr: `auth failed for ${t.env}=${t.v}\nretrying`,
        }),
        [t.v],
        true,
      );
      break;
    case 4:
      add(
        toolResult(
          JSON.stringify(
            { mcpServers: { demo: { command: "node", env: { [t.env]: t.v } } } },
            null,
            2,
          ),
        ),
        [t.v],
        true,
      );
      break;
    case 5: {
      const k = pem(pick(["RSA PRIVATE KEY", "OPENSSH PRIVATE KEY", "PRIVATE KEY"]));
      add(toolResult(`${k.text("\n")}\n`), k.body, true);
      break;
    }
    case 6:
      add(
        toolUse({
          file_path: "C:\\Users\\dev\\proj\\.env",
          content: `${o.env}="${o.v}"\r\nPORT=3000\r\n`,
        }),
        [o.v],
        true,
      );
      break;
    case 7:
      add(
        toolUse({
          command: "deploy",
          env: { [o.name === "password" ? "password" : "api_key"]: o.v },
        }),
        [o.v],
        true,
      );
      break;
    case 8:
      add(
        JSON.stringify({
          type: "assistant",
          message: {
            role: "assistant",
            content: [
              {
                type: "text",
                text: `Found the key \`${t.v}\` in config; also "password": "${p}" there.`,
              },
            ],
          },
        }),
        [t.v, p],
        true,
      );
      break;
    case 9:
      add(
        toolResult(
          `https://dev:${p}@github.com\n${"x".repeat(i % 7)}unicode \u00e9\u4e2d ${t.env}=${t.v}`,
        ),
        [p, t.v],
        true,
      );
      break;
    default:
      add(
        attachment({
          type: "hook_success",
          command: `set ${o.env}=${o.v} && run`,
          stdout: `ok ${t.v}`,
        }),
        [o.v, t.v],
        true,
      );
  }
}
if (out.length !== 200) throw new Error(`secret corpus has ${out.length} lines`);
writeFileSync(join(here, "secret-corpus.txt"), out.map((o) => o.line).join("\n") + "\n");
writeFileSync(
  join(here, "secret-corpus.expected.json"),
  JSON.stringify(
    out.map((o) => ({ secrets: o.secrets, json: o.json })),
    null,
    1,
  ) + "\n",
);

// ---- benign corpus ----
const ben = [];
const hex = (n) => chars("0123456789abcdef", n);
const uuid = () => `${hex(8)}-${hex(4)}-4${hex(3)}-a${hex(3)}-${hex(12)}`;
const words = [
  "alpha",
  "beta",
  "gamma",
  "delta",
  "omega",
  "sigma",
  "kappa",
  "theta",
  "lambda",
  "zeta",
];
const w = () => pick(words);
const benignTemplates = [
  () => `const task_key = makeKey(row.${w()}_id);`,
  () => `import { ${w()} } from 'sk-learn-${w()}';`,
  () => `pip install sk-learn==1.${Math.floor(rnd() * 9)}.0`,
  () => `<a class="skip-link" href="#${w()}">Skip to content</a>`,
  () => `.skip-nav-${w()} { position: absolute; left: -999px; }`,
  () => `The AKIA prefix identifies an AWS access key id; see the ${w()} guide for details.`,
  () => `// AKIA-like words in prose are not secrets, ask the ${w()} team`,
  () => `<img src="data:image/png;base64,${chars(B64, 140)}==" alt="${w()}">`,
  () => `sha256: ${hex(64)}`,
  () => `commit ${hex(40)} Author: dev <dev@example.test>`,
  () => `id = "${uuid()}"`,
  () => `git checkout ${hex(7)} && git log --oneline -${Math.floor(rnd() * 20) + 1}`,
  () => `echo "$API_KEY" | wc -c  # ${w()}`,
  () => `const key = process.env.API_KEY;`,
  () => `const t = process.env.${w().toUpperCase()}_TOKEN ?? '';`,
  () => `API_KEY=`,
  () => `${w().toUpperCase()}_TOKEN=`,
  () => `API_KEY=<your-key>`,
  () => `${w().toUpperCase()}_SECRET=\${${w().toUpperCase()}_SECRET}`,
  () => `GITHUB_TOKEN=$GITHUB_TOKEN`,
  () => `token = os.environ["${w().toUpperCase()}_TOKEN"]`,
  () => `password: string;`,
  () => `password = input("Password: ")`,
  () => `token = next_token()  # ${w()}`,
  () => `max_tokens: ${Math.floor(rnd() * 8000) + 100},`,
  () =>
    `{"input_tokens": ${Math.floor(rnd() * 9000)}, "output_tokens": ${Math.floor(rnd() * 900)}}`,
  () => `"token_type": "bearer"`,
  () => `Bearer authentication is described in RFC 6750 (${w()})`,
  () => `use the Authorization header with the Bearer scheme`,
  () => `git remote add origin git@github.com:example/${w()}.git`,
  () => `see https://github.com/example/${w()}/blob/main/README.md#L${Math.floor(rnd() * 90)}`,
  () => `fetch('http://localhost:${3000 + Math.floor(rnd() * 100)}/api/${w()}')`,
  () => `DATABASE_URL=postgres://localhost:5432/${w()}`,
  () => `url = "postgres://user:\${DB_PASS}@db.example.test/${w()}"`,
  () => `redis://localhost:6379/${Math.floor(rnd() * 9)}`,
  () => `ssh://git@git.example.test:2222/${w()}.git`,
  () => `grep -rn "BEGIN PRIVATE KEY" ./${w()}`,
  () => `// keys must be unique within the ${w()} list`,
  () => `const ${w()}Key = items.map((i) => i.key);`,
  () => `for (const [key, value] of Object.entries(${w()})) { console.log(key); }`,
  () => `export function ${w()}Handler(req: Request): Response { return new Response('ok'); }`,
  () => `SELECT id, name FROM ${w()}s WHERE created_at > now() - interval '1 day';`,
  () => `npm run build -- --mode ${w()}`,
  () => `PORT=${3000 + Math.floor(rnd() * 999)}`,
  () => `NODE_ENV=production`,
  () => `LOG_LEVEL=debug`,
  () => `if (!token) throw new Error("missing token");`,
  () => `type Props = { apiKey: string; secret?: boolean };`,
  () => `secret: boolean`,
  () => `const passwordField = document.querySelector('#${w()}');`,
  () => `<input type="password" name="${w()}" autocomplete="current-password">`,
  () => `# ${w()} section: keys, tokens and secrets are loaded from the vault at runtime`,
  () => `tokenizer = AutoTokenizer.from_pretrained("bert-base-uncased")  # ${w()}`,
  () => `"description": "Returns a page token for the next ${w()} request"`,
  () => `x-request-id: ${uuid()}`,
  () => `build ${Math.floor(rnd() * 9999)} passed in ${(rnd() * 90).toFixed(1)}s`,
  () => `    at ${w()} (/src/${w()}/index.ts:${Math.floor(rnd() * 400)}:${Math.floor(rnd() * 40)})`,
  () =>
    `{"type":"user","message":{"role":"user","content":"please rename ${w()}_key to ${w()}_id"}}`,
  () =>
    `{"type":"assistant","message":{"role":"assistant","content":[{"type":"text","text":"I will skip the ${w()} step."}]}}`,
  () => `integrity sha512-${chars(B64, 86)}==`,
  () => `"resolved": "https://registry.npmjs.org/${w()}/-/${w()}-1.${Math.floor(rnd() * 9)}.0.tgz"`,
  () => `Authorization header is required, see docs for ${w()}`,
  () => `const sk = sk_${w()};`,
];
for (let i = 0; i < 200; i++) ben.push(benignTemplates[i % benignTemplates.length]());
writeFileSync(join(here, "benign-corpus.txt"), ben.join("\n") + "\n");
console.log(`secret: ${out.length}, benign: ${ben.length}`);
