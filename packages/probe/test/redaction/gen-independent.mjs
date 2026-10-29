// Generates independent-secret-corpus.jsonl and .expected.json (the security reviewer's cases,
// ported). Run: node gen-independent.mjs. The outputs go to .generated/ (gitignored); the test reads them.
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
const here = join(dirname(fileURLToPath(import.meta.url)), ".generated");
mkdirSync(here, { recursive: true });
const A = "sk-ant-api03-" + "Qx7vR2mN9pL4kT" + "8wZ1yB5cD3fG6hJ0sA-xYzW_kQ12"; // synthetic
const GH = "ghp_Ab3dEf6hIj9kLm2n" + "Op5qRs8tUv1wXy4zAb7c";
const NPM_UUID = ["0a1b2c3d", "4e5f", "6789", "abcd", "ef0123456789"].join("-");
const HVS = "hvs." + "CAESIJx7vR2mN9pL4kT8wZ1yB5cD";
const AWS = "AKIAZ7XQ3M" + "NB5VTR2LKP";
const AWSSEC = "wJalrXUtnFEMI/K7MDENG/bPxRfiCYzEXAMPLEKY9";
const msg = (text) => ({
  type: "user",
  message: {
    role: "user",
    content: [{ type: "tool_result", tool_use_id: "toolu_01", content: text }],
  },
});
const asst = (text) => ({
  type: "assistant",
  message: { role: "assistant", content: [{ type: "text", text }] },
});
const C = []; // [label, lineObjOrRawString, [secrets]]
const add = (label, line, secrets) =>
  C.push([label, typeof line === "string" ? line : JSON.stringify(line), secrets]);
// 1 double-nested JSON: tool_result content is JSON string containing a .env file
add(
  "nested2 .env",
  msg(
    JSON.stringify({
      stdout:
        "DB_PASSWORD=Pq9x!vT3zz\nAPI_KEY=ab12cd34ef56gh78\nexport STRIPE_SECRET=whsec_9aZ8bY7cX6",
    }),
  ),
  ["Pq9x!vT3zz", "ab12cd34ef56gh78", "whsec_9aZ8bY7cX6"],
);
add(
  "nested3 .env",
  msg(
    JSON.stringify({
      x: JSON.stringify({ stdout: "SECRET_KEY=Zm9vYmFyYmF6MTIz\nexport db_password=Lw8Kq2Ns7Rt" }),
    }),
  ),
  ["Zm9vYmFyYmF6MTIz", "Lw8Kq2Ns7Rt"],
);
add(
  "unicode-escaped sk-ant raw",
  `{"type":"assistant","message":{"content":[{"type":"text","text":"key \\u0073k-ant-api03-Qx7vR2mN9pL4kT8wZ1yB5cD3fG6hJ0sA-xYzW_kQ12"}]}}`,
  [A],
);
add(
  "unicode-escaped key name raw",
  `{"type":"x","toolUseResult":{"\\u0070assword":"Lw8Kq2Ns7Rtz"}}`,
  ["Lw8Kq2Ns7Rtz"],
);
add(
  "split across line break PEM",
  msg(
    "-----BEGIN RSA " +
      "PRIVATE KEY-----\nMIIEowIBAAKCAQEAx7vR2mN9pL4kT8wZ1yB5cD3fG6hJ0sAbCdEf\nGhIjKlMnOpQrStUvWxYz0123456789abcdef\n-----END RSA PRIVATE KEY-----",
  ),
  ["MIIEowIBAAKCAQEAx7vR2mN9pL4kT8wZ1yB5cD3fG6hJ0sAbCdEf"],
);
add("password split by newline", msg("password=\nLw8Kq2Ns7Rt"), ["Lw8Kq2Ns7Rt"]);
add("lowercase export", msg("export db_password=Lw8Kq2Ns7Rt"), ["Lw8Kq2Ns7Rt"]);
add("lowercase export no digit", msg("export db_password=correcthorsebattery"), [
  "correcthorsebattery",
]);
add("lowercase export special", msg("export db_password=P@ss!w0rd#"), ["P@ss!w0rd#"]);
add("yaml password", msg("database:\n  user: app\n  password: Hunt3r2xyz\n"), ["Hunt3r2xyz"]);
add("yaml password special", msg("database:\n  password: P@ssw0rd!2024\n"), ["P@ssw0rd!2024"]);
add("yaml password short nodigit", msg("database:\n  password: changeme\n"), ["changeme"]);
add("yaml quoted", msg('  password: "Tr0ub4dor&3"'), ["Tr0ub4dor&3"]);
add("yaml api_key", msg("openai:\n  api_key: 4f9a8b7c6d5e4f3a2b1c"), ["4f9a8b7c6d5e4f3a2b1c"]);
add("yaml client_secret", msg("oauth:\n  client_secret: Gx7Kp2Lm9Qz4Rt"), ["Gx7Kp2Lm9Qz4Rt"]);
add("toml", msg('[database]\nhost = "db"\npassword = "s3cretT0ml!"\n'), ["s3cretT0ml!"]);
add("toml token", msg('[registry]\ntoken = "cio9Xk2LmQp7RtZ"\n'), ["cio9Xk2LmQp7RtZ"]);
add(
  "npmrc authToken",
  msg("//registry." + "npmjs.org/:_auth" + "Token=" + NPM_UUID + "\n"),
  [NPM_UUID],
);
add("npmrc _auth", msg("//npm.corp.example/:_" + "auth=dXNlcjpQ" + "YXNzdzByZDEyMw==\nalways-auth=true"), [
  "dXNlcjpQYXNzdzByZDEyMw==",
]);
add("npmrc _password", msg("//npm.corp.example/:_" + "password=UGFzc3cw" + "cmQxMjM=\n"), [
  "UGFzc3cwcmQxMjM=",
]);
add(
  "docker config auths",
  msg(
    JSON.stringify(
      { auths: { "https://index.docker.io/v1/": { auth: "dXNlcjpQ" + "YXNzdzByZDEyMw==" } } },
      null,
      2,
    ),
  ),
  ["dXNlcjpQYXNzdzByZDEyMw=="],
);
add(
  "docker config auths obj",
  {
    type: "x",
    toolUseResult: {
      file: { content: { auths: { "ghcr.io": { auth: "Z2g6Z2hwX0Fi" + "M2RFZjZoSWo5a0xt" } } } },
    },
  },
  ["Z2g6Z2hwX0FiM2RFZjZoSWo5a0xt"],
);
add(
  "gcp sa json",
  msg(
    JSON.stringify(
      {
        type: "service_account",
        project_id: "p",
        private_key_id: "1a2b3c4d5e6f7a8b9c0d1e2f3a4b5c6d7e8f9a0b",
        private_key:
          "-----BEGIN PR" +
          "IVATE KEY-----\nMIIEvQIBADANBgkqhkiG9w0BAQEFAASCBKcwggSjAgEAAoIBAQC7\n-----END PRIVATE KEY-----\n",
        client_email: "x@p.iam.gserviceaccount.com",
      },
      null,
      2,
    ),
  ),
  ["MIIEvQIBADANBgkqhkiG9w0BAQEFAASCBKcwggSjAgEAAoIBAQC7"],
);
add(
  "azure sa json client secret",
  msg(
    JSON.stringify({
      clientId: "00000000-0000-0000-0000-000000000000",
      clientSecret: "Qx8~Zp3.Lm7_Rt2-Kw9vNb4",
    }),
  ),
  ["Qx8~Zp3.Lm7_Rt2-Kw9vNb4"],
);
add(
  "sqlserver connstr",
  msg(
    "Server=tcp:db.example.net,1433;Database=app;User ID=sa;Password=P@ssw0rd!2024;Encrypt=True;",
  ),
  ["P@ssw0rd!2024"],
);
add("sqlserver connstr pwd", msg("Data Source=db;Initial Catalog=app;User Id=sa;Pwd=Xk9!mQ2#zL;"), [
  "Xk9!mQ2#zL",
]);
add(
  "azure storage connstr",
  msg(
    "Default" + "EndpointsProtocol=https;AccountName=acct;Account" + "Key=Eby8vdM02xNOcqFlqUwJPLlmEtlCDXJ1OUzFT50uSRZ6IFsuFq2UVErCz4I6tq/K1SZFPTOtr/KBHBeksoGMGw==;EndpointSuffix=core.windows.net",
  ),
  ["Eby8vdM02xNOcqFlqUwJPLlmEtlCDXJ1OUzFT50uSRZ6IFsuFq2UVErCz4I6tq/K1SZFPTOtr/KBHBeksoGMGw=="],
);
add(
  "azure servicebus",
  msg(
    "Endpoint=sb://ns.servicebus.windows.net/;SharedAccessKeyName=Root;SharedAccessKey=Zm9vYmFyYmF6cXV4MTIzNDU2Nzg5MA+/abc=",
  ),
  ["Zm9vYmFyYmF6cXV4MTIzNDU2Nzg5MA+/abc="],
);
add("mongo connstr", msg("mongodb+srv://admin:" + "Xk9mQ2zLp4@cluster0.abc.mongodb.net/db"), [
  "Xk9mQ2zLp4",
]);
add("redis url special", msg("REDIS_URL=redis://:Xk9mQ2zLp4@cache:6379/0"), ["Xk9mQ2zLp4"]);
add(
  "python kwarg",
  asst("conn = psycopg2.connect(host='db', user='app', password=\"Lw8Kq2Ns7Rt\")"),
  ["Lw8Kq2Ns7Rt"],
);
add("python kwarg single", asst("client = Client(api_key='4f9a8b7c6d5e4f3a2b1c')"), [
  "4f9a8b7c6d5e4f3a2b1c",
]);
add("python kwarg nodigit", asst("login(username='bob', password='correcthorse')"), [
  "correcthorse",
]);
add(
  "cli --password space",
  {
    type: "assistant",
    message: {
      content: [
        {
          type: "tool_use",
          name: "Bash",
          input: { command: "mysqladmin --user=root --password Xk9mQ2zLp4 status" },
        },
      ],
    },
  },
  ["Xk9mQ2zLp4"],
);
add(
  "cli -p mysql",
  {
    type: "assistant",
    message: {
      content: [
        { type: "tool_use", name: "Bash", input: { command: "mysql -u root -pXk9mQ2zLp4 app" } },
      ],
    },
  },
  ["Xk9mQ2zLp4"],
);
add(
  "cli --token=",
  {
    type: "assistant",
    message: {
      content: [
        {
          type: "tool_use",
          name: "Bash",
          input: { command: "vault login --token=" + HVS },
        },
      ],
    },
  },
  [HVS],
);
add(
  "cli --token space",
  {
    type: "assistant",
    message: {
      content: [
        {
          type: "tool_use",
          name: "Bash",
          input: {
            command: "gh auth login --with-token < x; cli deploy --token 9f8e7d6c5b4a39281706",
          },
        },
      ],
    },
  },
  ["9f8e7d6c5b4a39281706"],
);
add(
  "cli docker login -p",
  {
    type: "assistant",
    message: {
      content: [
        {
          type: "tool_use",
          name: "Bash",
          input: { command: "docker login -u bob -p Xk9mQ2zLp4 registry.example" },
        },
      ],
    },
  },
  ["Xk9mQ2zLp4"],
);
add(
  "cli --client-secret",
  {
    type: "assistant",
    message: {
      content: [
        {
          type: "tool_use",
          name: "Bash",
          input: { command: "az login --service-principal -u app -p Qx8~Zp3.Lm7_Rt2 --tenant t" },
        },
      ],
    },
  },
  ["Qx8~Zp3.Lm7_Rt2"],
);
add(
  "set-cookie",
  msg(
    "HTTP/1.1 200 OK\nSet-Cookie: session=s%3AJx7vR2mN9pL4kT8wZ1yB5cD3fG6h.Zp3Lm7; Path=/; HttpOnly",
  ),
  ["Jx7vR2mN9pL4kT8wZ1yB5cD3fG6h"],
);
add("cookie header", msg("> Cookie: sessionid=9f8e7d6c5b4a39281706abcdef; csrftoken=abc"), [
  "9f8e7d6c5b4a39281706abcdef",
]);
add(
  "curl -H cookie",
  {
    type: "assistant",
    message: {
      content: [
        {
          type: "tool_use",
          name: "Bash",
          input: { command: "curl -H 'Cookie: auth_session=9f8e7d6c5b4a39281706abcdef' https://x" },
        },
      ],
    },
  },
  ["9f8e7d6c5b4a39281706abcdef"],
);
add(
  "hook attachment command",
  {
    type: "attachment",
    attachment: {
      type: "hook_success",
      command: `node hook.js --key ${A}`,
      stderr: "",
      stdout: "",
    },
  },
  [A],
);
add(
  "hook attachment stderr",
  {
    type: "attachment",
    attachment: { type: "hook_error", stderr: `Error: invalid x-api-key ${A}` },
  },
  [A],
);
add("secret as object key", { type: "x", toolUseResult: { [A]: true, [GH]: 1 } }, [A, GH]);
add(
  "secret key of env obj",
  { type: "x", toolUseResult: { env: { "DB_PASSWORD=Lw8Kq2Ns7Rt": "" } } },
  ["Lw8Kq2Ns7Rt"],
);
add(
  "toolUseResult.stdout",
  {
    type: "user",
    toolUseResult: {
      stdout: `AWS_ACCESS_KEY_ID=${AWS}\nAWS_SECRET_ACCESS_KEY=${AWSSEC}`,
      stderr: "",
    },
  },
  [AWS, AWSSEC],
);
add(
  "aws credentials ini",
  msg(`[default]\naws_access_key_id = ${AWS}\naws_secret_access_key = ${AWSSEC}\n`),
  [AWS, AWSSEC],
);
add(
  "aws creds json",
  msg(
    JSON.stringify({
      Credentials: {
        AccessKeyId: "ASIAZ7XQ3M" + "NB5VTR2LKP",
        SecretAccessKey: AWSSEC,
        SessionToken: "IQoJb3JpZ2luX2VjEJr//////////wEaCXVzLWVhc3QtMSJHMEUCIQ",
      },
    }),
  ),
  ["ASIAZ7XQ3M" + "NB5VTR2LKP", AWSSEC, "IQoJb3JpZ2luX2VjEJr"],
);
add("anthropic env", msg(`ANTHROPIC_API_KEY=${A}`), [A]);
add("anthropic header", msg(`curl https://api.anthropic.com/v1/messages -H "x-api-key: ${A}"`), [
  A,
]);
add("openai proj key", msg("OPENAI=sk-proj-Ab3dEf6hIj9k" + "Lm2nOp5qRs8tUv1wXy4z"), [
  "sk-proj-Ab3dEf6hIj9k" + "Lm2nOp5qRs8tUv1wXy4z",
]);
add("generic secret json", msg('{"client_secret": "Gx7Kp2Lm9Qz4Rt"}'), ["Gx7Kp2Lm9Qz4Rt"]);
add("twilio auth token", msg("TWILIO_AUTH_TOKEN=9f8e7d6c5b4a39281706abcdef012345"), [
  "9f8e7d6c5b4a39281706abcdef012345",
]);
add("sendgrid", msg("SG.Ab3dEf6hIj9kLm2nOp5qRs.Tu8vWx1y" + "Za4bCd7eFg0hIj3kLm6nOp9qRs2tUv5wXy8"), [
  "SG.Ab3dEf6hIj9kLm2nOp5qRs.Tu8vWx1y" + "Za4bCd7eFg0hIj3kLm6nOp9qRs2tUv5wXy8",
]);
add(
  "discord webhook",
  msg("https://discord.com/api/webhooks/1234567890/Ab3dEf6hIj9kLm2nOp5qRs8tUv1wXy4zAb7cDe0fGh3"),
  ["Ab3dEf6hIj9kLm2nOp5qRs8tUv1wXy4zAb7cDe0fGh3"],
);
add(
  "slack webhook",
  msg("https://hooks.slack.com/s" + "ervices/T00000000/" + "B00000000/XXXXXXXXXXXXXXXXXXXXXXXX9"),
  ["XXXXXXXXXXXXXXXXXXXXXXXX9"],
);
add(
  "json-escaped slashes url creds nested",
  msg(JSON.stringify({ u: "postgres:\\/\\/app:Xk9mQ2zLp4@db\\/x" })),
  ["Xk9mQ2zLp4"],
);
add(
  "ssh openssh key",
  msg(
    "-----BEGIN OPENSS" +
      "H PRIVATE KEY-----\nb3BlbnNzaC1rZXktdjEAAAAABG5vbmUAAAAEbm9uZQAAAAAAAAABAAAAMwAAAAtzc2gtZW\n-----END OPENSSH PRIVATE KEY-----",
  ),
  ["b3BlbnNzaC1rZXktdjEAAAAABG5vbmUAAAAEbm9uZQAAAAAAAAABAAAAMwAAAAtzc2gtZW"],
);
add(
  "k8s secret yaml data",
  msg(
    "apiVersion: v1\nkind: Secret\ndata:\n  password: UGFzc3cwcmQxMjM=\n  api-token: Z2hwX0FiM2RFZjZoSWo5",
  ),
  ["UGFzc3cwcmQxMjM=", "Z2hwX0FiM2RFZjZoSWo5"],
);
add("powershell env", msg("$env:DB_PASSWORD = 'Lw8Kq2Ns7Rt'"), ["Lw8Kq2Ns7Rt"]);
add("setx windows", msg("setx GITHUB_TOKEN abcdef0123456789abcdef0123456789abcdef01"), [
  "abcdef0123456789abcdef0123456789abcdef01",
]);
add(
  "dotnet user-secrets",
  msg('dotnet user-secrets set "Stripe:SecretKey" "rk_live_Ab3dEf6h' + 'Ij9kLm2nOp5qRs8t"'),
  ["rk_live_Ab3dEf6h" + "Ij9kLm2nOp5qRs8t"],
);
add("long quoted >1024", msg(`API_KEY="${"Ab3dEf6hIj".repeat(110)}"`), [
  "Ab3dEf6hIj".repeat(110).slice(0, 60),
]);
add("bearer short no digit", msg("Authorization: Bearer abcdefghijklmnopqrstuv"), [
  "abcdefghijklmnopqrstuv",
]);
add(
  "db password in camelCase obj",
  { type: "x", toolUseResult: { config: { dbPassword: "Lw8Kq2Ns7Rt", smtpPass: "Qz8Lm2Np" } } },
  ["Lw8Kq2Ns7Rt", "Qz8Lm2Np"],
);
add("passphrase", msg("GPG_PASSPHRASE=Lw8Kq2Ns7Rtz"), ["Lw8Kq2Ns7Rtz"]);
add("lowercase passphrase", msg("passphrase: correct-horse-battery-9"), [
  "correct-horse-battery-9",
]);
add(
  "rawfallback truncated json",
  `{"type":"user","message":{"content":"export DB_PASSWORD=Lw8Kq2Ns7Rt and ${GH}`,
  ["Lw8Kq2Ns7Rt", GH],
);
add(
  "deep json",
  "[".repeat(100) +
    JSON.stringify({ password: "Lw8Kq2Ns7Rt", t: `DB_PASSWORD=Pq9xvT3zz1 ${A}` }) +
    "]".repeat(100),
  ["Lw8Kq2Ns7Rt", "Pq9xvT3zz1", A],
);

writeFileSync(join(here, "independent-secret-corpus.jsonl"), C.map((c) => c[1]).join("\n") + "\n");
writeFileSync(
  join(here, "independent-secret-corpus.expected.json"),
  JSON.stringify(
    C.map(([label, , secrets]) => ({ label, secrets })),
    null,
    1,
  ) + "\n",
);
console.log(`${C.length} cases`);
