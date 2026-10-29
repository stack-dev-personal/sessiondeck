// Built-in redaction rules (R4.7, A14). Rules are data: a name (used in the `[redacted:<name>]`
// marker), the patterns, and an optional cheap `hint` that must match before the patterns run.
//
// Regex safety: every built-in pattern is linear. No group with an inner unbounded quantifier is
// itself repeated; there is no lookahead that scans an unbounded run (value shape checks live in
// `Rule.check`, after the match); lazy runs are anchored on a literal terminator or end of string
// or bounded; the key-name prefix is bounded ({0,48}). Do not add a rule without a case in the
// corpora and the 1 MB timing test (redaction-timing.test.ts: add a SHAPES entry for the new rule).

export type Groups = Record<string, string | undefined>;

export interface Rule {
  name: string;
  /** Global regexes. Named groups: `pre` (kept), `q` (kept quote), `sec`/`sec2` (replaced). */
  patterns: RegExp[];
  /** If set, the patterns run on a string only when this matches it. */
  hint?: RegExp;
  /**
   * Shortens a bare secret span before `check` (trailing unbalanced brackets belong to the
   * surrounding code, not the value). The cut-off tail is kept in the output.
   */
  trim?: (secret: string) => string;
  /**
   * Post-match validation, run in the replace callback so the regexes themselves stay free of
   * unbounded lookaheads. Receives the secret span (the whole match when the pattern has no
   * `sec`/`sec2` group) and the named groups; false leaves the match alone.
   */
  check?: (secret: string, gr: Groups) => boolean;
}

/**
 * Rewrites a regex source so it matches without the `i` flag, every letter outside a class
 * becoming `[xX]`. Lets one pattern use case-sensitive classes (`[A-Z]` as a camelCase boundary)
 * next to case-insensitive keywords.
 */
export function ci(src: string): string {
  let out = "";
  let i = 0;
  while (i < src.length) {
    const c = src[i]!;
    if (c === "\\") {
      if (src[i + 1] === "k" && src[i + 2] === "<") {
        const e = src.indexOf(">", i);
        out += src.slice(i, e + 1);
        i = e + 1;
      } else {
        out += src.slice(i, i + 2);
        i += 2;
      }
      continue;
    }
    if (c === "[") {
      let j = i + 1;
      if (src[j] === "^") j++;
      while (j < src.length && src[j] !== "]") j += src[j] === "\\" ? 2 : 1;
      out += src.slice(i, j + 1);
      i = j + 1;
      continue;
    }
    const m = /^(?:\(\?(?:<[A-Za-z]\w*>|<[=!]|[:=!])|\{\d*,?\d*\})/.exec(src.slice(i, i + 40));
    if (m) {
      out += m[0];
      i += m[0].length;
      continue;
    }
    out += /[a-z]/i.test(c) ? `[${c.toLowerCase()}${c.toUpperCase()}]` : c;
    i++;
  }
  return out;
}

/** Values that name a place a secret would come from, or a placeholder, are not secrets. */
const PH = String.raw`(?!\$|<|${"`"}|\{|%|\[redacted|\*\*\*|\.\.\.|(?:process\.env|os\.environ|os\.getenv|getenv|ENV\[|import\.meta\.env|System\.getenv)|(?:[Yy]our|[Mm]y)[-_ ]|(?:include|omit|same-origin|[Ss]tring|[Nn]umber|[Bb]oolean|str|int|any|[Nn]ull|NULL|[Nn]one|[Nn]il|[Tt]rue|[Ff]alse|[Uu]ndefined|[Xx]{3,}|[Pp]laceholder|[Rr]edacted)(?![A-Za-z0-9_]))`;

/** Quoted value, any length up to the closing quote on the same line (no 1024 cap). */
const QUOTED = (min: number): string =>
  String.raw`(?<q>\\?["'])${PH}(?<sec>(?:(?!\k<q>)[^\n]){${min},})\k<q>`;
/** `post` (spaces and the next character) is read by `envCheck`; the lookahead is bounded by the spaces. */
const POST = String.raw`(?=(?<post>[ \t]*\S?))`;
/** A bare value ends at whitespace, a quote, or a separator (`;` ends an ADO/SQL connection-string field). */
const BARE = String.raw`${PH}(?<sec2>[^\s;&,"'${"`"}]{3,})${POST}`;

const KW = String.raw`(?:api[_-]?key|apikey|secret(?:[_-]?(?:access[_-]?)?key)?|passw(?:or)?d|pwd|passphrase|token|private[_-]?key|access[_-]?key|account[_-]?key|auth[_-]?token|auth[_-]?key|storepass|keypass|secret[_-]?string|dsn|key[_-]data|pass)`;
/** Words that may carry a suffix (`secret_key_base`); weaker words (`key`, `auth`) may not. */
const STRONG = String.raw`secret|passw(?:or)?d|passphrase|token|storepass|keypass|authtoken`;
/** Name suffix: snake (`_key_base`) or camelCase (`KeyBase`); the camel hump needs a case-sensitive class. */
const KS = String.raw`(?<ks>(?:[_-][A-Za-z0-9]{1,16}){1,3}|(?:[A-Z][a-z0-9]{1,15}){1,3})`;
/** Weak keys name things that are often not secrets: a bare value must also look like a credential. */
const KW_WEAK = String.raw`(?:credentials?|authorization|auth|bearer)`;
const WEAK_KEY = /^(?:credentials?|bearer|authorization|auth)$/i;
/** Start of a key name: not mid-identifier, but a literal backslash-n from escaped JSON text counts as a break. */
const KB = String.raw`(?:(?<![\w.-])|(?<=\\[nrt]))`;

/** Assignment separators: `=`, `:`, `=>` (PHP, Ruby), `:=` (Go), `?=` (make), `||=` (Ruby). */
const SEP = String.raw`(?:=>|:=|\?=|\|\|=|[:=])`;
/** After a key name: an optional closing quote and `]` (`os.environ["API_KEY"] =`, `$c['pass'] =`). */
const CLOSE = String.raw`(?:\\?["'])?\]?`;
/**
 * An optional type annotation between a key and `=`: `apiKey: string = "x"`, `password: Optional[str] = "x"`.
 * Bounded (40) and followed by a bounded run of blanks and a literal `=`; without it the `:` would
 * be taken as the separator and the placeholder check would reject `string` as the value.
 */
const ANN = String.raw`(?:[ \t]*:[ \t]*[\w.<>\[\]|, ?]{1,40}?[ \t]*(?==[ \t]*[^\s=]))?`;
/** A CLI value: quoted up to the matching quote (spaces and `&;|` included), else one bare word. */
const CLI_VALUE = String.raw`(?:${QUOTED(1)}|["']?(?!-)${PH}(?<sec2>[^\s"'${"`"};&|]{3,}))`;

const g = (src: string, flags = ""): RegExp => new RegExp(src, `g${flags}`);

/**
 * Per-pattern gate: a cheap necessary condition (a literal the pattern cannot match without). The
 * redactor skips a pattern whose gate does not match the text, so a line full of one keyword does
 * not pay for the patterns built on the others.
 */
export const PATTERN_HINTS = new WeakMap<RegExp, RegExp>();
const gh = (hint: RegExp, src: string, flags = ""): RegExp => {
  const re = g(src, flags);
  PATTERN_HINTS.set(re, hint);
  return re;
};

const PEM = String.raw`-----BEGIN (?:[A-Z0-9]+ )*PRIVATE KEY(?: BLOCK)?-----(?=[\sA-Za-z0-9+/=\\:,.-]{20})[\s\S]*?(?:-----END (?:[A-Z0-9]+ )*PRIVATE KEY(?: BLOCK)?-----|$)`;
/** A PEM block that was base64-encoded whole (`client-key-data:` in a kubeconfig): starts `-----BEGIN`. */
const PEM_B64 = String.raw`(?<![A-Za-z0-9+/])LS0tLS1CRUdJTi[A-Za-z0-9+/=_-]{40,}`;

// Same prefixes as the contract's SECRET_VALUE_PREFIXES (a test keeps them in step); the contract
// module is not a runtime dependency of the daemon bundle.
const GITHUB = String.raw`(?<![A-Za-z0-9])(?:gh[pousr]_[A-Za-z0-9]{16,}|github_pat_[A-Za-z0-9_]{16,})`;

/**
 * Vendor token formats: a fixed prefix and a long run. Each is its own regex so the engine can use
 * the literal prefix to skip ahead; none has a nested quantifier.
 */
const NB = String.raw`(?<![A-Za-z0-9])`;
export const TOKEN_FORMATS: string[] = [
  String.raw`${NB}(?:[sr]k|pk)_(?:live|test)_[A-Za-z0-9]{16,}`, // Stripe
  String.raw`${NB}whsec_[A-Za-z0-9]{12,}`, // Stripe webhook secret
  String.raw`(?<![A-Za-z0-9_-])AIza[0-9A-Za-z_-]{35}`, // Google API key
  String.raw`${NB}ya29\.[A-Za-z0-9_-]{20,}`, // Google OAuth access token
  String.raw`${NB}GOCSPX-[A-Za-z0-9_-]{20,}`, // Google OAuth client secret
  String.raw`${NB}npm_[A-Za-z0-9]{36}`,
  String.raw`${NB}gl(?:pat|ptt|rt|dt|ft|imt|agent|cbt|soat|oas)-[A-Za-z0-9_-]{20,}`, // GitLab
  String.raw`${NB}hf_[A-Za-z0-9]{30,}`, // Hugging Face
  String.raw`${NB}SG\.[A-Za-z0-9_-]{16,}\.[A-Za-z0-9_-]{16,}`, // SendGrid
  String.raw`${NB}hv[sbr]\.[A-Za-z0-9_-]{20,}`, // HashiCorp Vault
  String.raw`${NB}HRKU-[A-Za-z0-9_-]{20,}`, // Heroku
  String.raw`${NB}do[opr]_v1_[a-f0-9]{40,}`, // DigitalOcean
  String.raw`${NB}dckr_pat_[A-Za-z0-9_-]{20,}`, // Docker Hub
  String.raw`${NB}shp(?:at|ss|ca|pa)_[a-f0-9]{32}`, // Shopify
  String.raw`${NB}pypi-AgEIcHlwaS5vcmc[A-Za-z0-9_-]{50,}`, // PyPI
  String.raw`${NB}gl(?:c|sa)_[A-Za-z0-9_=+/-]{30,}`, // Grafana
  String.raw`${NB}lin_api_[A-Za-z0-9]{30,}`, // Linear
  String.raw`${NB}ntn_[A-Za-z0-9]{30,}`, // Notion
  String.raw`${NB}PMAK-[0-9a-f]{24}-[0-9a-f]{34}`, // Postman
  String.raw`${NB}dapi[0-9a-f]{32}`, // Databricks
  String.raw`${NB}ATATT3[A-Za-z0-9_=-]{20,}`, // Atlassian
  String.raw`${NB}sntrys_[A-Za-z0-9+/=_-]{20,}`, // Sentry
  String.raw`${NB}sbp_[0-9a-f]{40}`, // Supabase
  String.raw`${NB}xapp-\d-[A-Za-z0-9-]{10,}`, // Slack app-level
  String.raw`${NB}sq0(?:atp|csp)-[A-Za-z0-9_-]{22,}`, // Square
  String.raw`${NB}SK[0-9a-f]{32}(?![A-Za-z0-9])`, // Twilio API key
  String.raw`(?<![A-Za-z0-9_-])key-[0-9a-f]{32}(?![A-Za-z0-9])`, // Mailgun
  String.raw`${NB}oy2[a-z0-9]{43}`, // NuGet
  String.raw`${NB}AGE-SECRET-KEY-1[A-Z0-9]{58}`,
  String.raw`(?<![A-Za-z0-9_.~-])[A-Za-z0-9_.~-]{3}\dQ~[A-Za-z0-9_.~-]{30,}`, // Azure AD client secret
  String.raw`(?<![A-Za-z0-9])\d{8,10}:AA[A-Za-z0-9_-]{33}(?![A-Za-z0-9_-])`, // Telegram bot
  String.raw`(?<![A-Za-z0-9_-])eyJ[A-Za-z0-9_-]{8,}\.eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{4,}`, // JWT
];
/** Runs the service-key patterns only on lines holding one of these literals or shapes. */
export const TOKEN_HINT =
  /_(?:live|test)_|whsec_|AIza|ya29\.|GOCSPX-|npm_|gl[a-z]{1,5}[-_]|hf_|SG\.|hv[sbr]\.|HRKU-|do[opr]_v1_|dckr_pat_|shp(?:at|ss|ca|pa)_|pypi-|lin_api_|ntn_|PMAK-|dapi|ATATT3|sntrys_|sbp_|xapp-|sq0|SK[0-9a-f]|key-[0-9a-f]|oy2|AGE-SECRET|Q~|:AA|eyJ|webhook|hooks\.slack|IncomingWebhook|[?&](?:sig|signature|x-amz|x-goog)/i;

/** Words that start an expression in code: a bare value of one of these is code. */
const JS_WORDS = new Set(
  "typeof await new async function void delete this self cls super yield".split(" "),
);
const CODE_CALL = /^[A-Za-z_$][\w$.]*[([]/;
const DOTTED_IDENT = /^[a-z_]\w*(?:\.[a-z_]\w*)+$/;
const LOOSE_VALUE = /^[A-Za-z0-9+/_=~-]{6,}$/;

/**
 * Bare values of env-assignment: a quoted value is always a secret; a bare one must not read as
 * code (a call, an index, a dotted path, `await getToken(req)`), and under a weak key it must also
 * look like a credential. Runs after the match so no regex needs an unbounded lookahead.
 */
/** Name-suffix words that make a secret word name a setting, not a secret: `token_type`, `max_tokens`. */
const BENIGN_SUFFIX = new Set(
  (
    "type types count counts limit limits length len min max size expiry expires expire expiration " +
    "ttl lifetime timeout header headers url uri endpoint host port file files path dir name names " +
    "id ids policy policies hash hashed salt rounds cost field fields label labels regex pattern " +
    "required enabled disabled strategy prompt reset rotation age usage budget rate interval bytes " +
    "format mode kind version encoding algorithm alg validation validator check from source " +
    "provider manager env var variable cache charset prefix suffix at time date ts"
  ).split(" "),
);
function suffixIsSetting(ks: string): boolean {
  return ks
    .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
    .toLowerCase()
    .split(/[_-]/)
    .some((w) => BENIGN_SUFFIX.has(w));
}

/** Drops trailing closers the value does not open (`getToken(password=x)`): they belong to the code around it. */
export function trimBrackets(secret: string): string {
  // One pass for the totals, then cut trailing closers while they outnumber their openers: linear.
  const n = { "(": 0, ")": 0, "[": 0, "]": 0, "{": 0, "}": 0 } as Record<string, number>;
  for (const ch of secret) if (ch in n) n[ch] = (n[ch] ?? 0) + 1;
  let end = secret.length;
  while (end > 0) {
    const c = secret[end - 1]!;
    const open = c === ")" ? "(" : c === "]" ? "[" : c === "}" ? "{" : "";
    if (open === "" || (n[c] ?? 0) <= (n[open] ?? 0)) break;
    n[c] = (n[c] ?? 0) - 1;
    end -= 1;
  }
  return secret.slice(0, end);
}

function envCheck(secret: string, gr: Groups): boolean {
  const kw = gr["kw"];
  const ks = gr["ks"] ?? "";
  if (ks !== "") {
    if (suffixIsSetting(ks)) return false;
    if (gr["sec"] === undefined && /^\d+$/.test(secret)) return false;
  }
  // `pass` is a word of its own (`pass:`, `smtp_pass`, `smtpPass`), not the tail of `bypass`/`compass`.
  if (kw !== undefined && /^pass$/i.test(kw)) {
    const kp = gr["kp"] ?? "";
    if (kp !== "" && !/[_.-]$/.test(kp) && !(kw[0] === "P" && /[a-z0-9]$/.test(kp))) return false;
  }
  if (gr["sec"] !== undefined) {
    // `'password' => 'Password'` in a translation file names the field; it is not a value.
    return kw === undefined || secret.toLowerCase() !== kw.toLowerCase();
  }
  if (CODE_CALL.test(secret)) return false;
  // `(handle, token) =>`, `typeof x`: parameters and keywords, not values.
  if (/^\([\w$]*[:,)]?$/.test(secret) || JS_WORDS.has(secret)) return false;
  // `PASS: relaunch` in a log is a verdict; a bare `pass` value must not be one short plain word.
  if (kw !== undefined && /^pass$/i.test(kw) && /^[A-Za-z]{1,11}$/.test(secret)) return false;
  const post0 = gr["post"] ?? "";
  // `token: Token = createToken(u)`: a declaration, the bare word is a type.
  if (/^=(?!=)/.test(post0.trimStart())) return false;
  if (kw === undefined) return true; // UPPER_SNAKE names: any bare value
  if (DOTTED_IDENT.test(secret) && secret.length < 48) return false;
  if (/^pwd$/i.test(kw) && /^(?:[/~.]|[A-Za-z]:[\\/])/.test(secret)) return false; // $PWD, a directory
  const post = gr["post"] ?? "";
  if (/^[A-Za-z_]+$/.test(secret) && (gr["sp"] ?? "") !== "" && /^[ \t]+[\w(]/.test(post)) {
    return false; // `token = await getToken(req)`
  }
  // Object literal or typed parameter with an identifier value: `{ password: hashed, token: tokenFromHeader }`,
  // `token: Token = tokenDefault,`; a value that repeats the key (`token: token`) is a variable.
  const pre = gr["pre"] ?? "";
  if (
    /^[a-z_$][A-Za-z_$]*$/.test(secret) &&
    /:/.test(pre) &&
    !/:=\s*$/.test(pre) &&
    /^[,})]/.test(post.trimStart())
  ) {
    return false;
  }
  if (secret.toLowerCase() === kw.toLowerCase()) return false;
  // `const secret = sec ?? m`: an identifier followed by an operator, with spaces around the `=`.
  if (
    (gr["sp"] ?? "") !== "" &&
    /^[A-Za-z_$][\w$.]*$/.test(secret) &&
    !/\d/.test(secret) &&
    /^(?:\?\?|\|\||&&|\?|\+|\*|\/|<|>|-)/.test(post.trimStart())
  ) {
    return false;
  }
  if (WEAK_KEY.test(kw)) {
    return (
      LOOSE_VALUE.test(secret) &&
      (/\d/.test(secret) || secret.length >= 12) &&
      !/^[(.[]/.test(post.trimStart())
    );
  }
  return true;
}

/** Words that follow a flag in a sentence: `use --token with a PAT`, `--password option`. */
const PROSE_WORDS = new Set(
  (
    "a an and are as at be but by can do does file flag for from has have if in instead is it its " +
    "may must no not of on only option options or parameter param prompt should so than that the " +
    "then there this to value via was when where which will with without you your argument arg " +
    "here below above also set sets used uses using see needed required generic tls stdin ask " +
    "interactive auto random generated env"
  ).split(" "),
);

function cliCheck(secret: string, gr: Groups): boolean {
  const nm = gr["nm"];
  if (nm !== undefined && !/key|token|secret|pass|pwd|cred|auth/i.test(nm)) return false;
  if (gr["short"] !== undefined && /^\d+(?::\d+)*(?:\/\w+)?$/.test(secret)) return false; // -p"8080:80"
  if (gr["sec"] !== undefined) return true; // quoted: up to the matching quote, no prose check
  if (/^[(@]/.test(secret)) return false; // `-Password (Read-Host ...)`
  // A bare word after a space is prose only when it is a known prose word.
  if (gr["sep"] !== undefined && /^[ \t]+$/.test(gr["sep"])) {
    return !PROSE_WORDS.has(secret.toLowerCase());
  }
  return true;
}

/** A Cookie value: `name=value`, then `; name[=value]` repeated. The separators are disjoint from the names. */
const COOKIE_PAIRS = String.raw`[\w.%~+-]{1,64}=[^\s;"'\\]{3,}(?:;[ \t]*[\w.%~+-]{1,64}(?:=[^\s;"'\\]*)?)*`;
const COOKIE_ATTRS = new Set([
  "samesite",
  "path",
  "domain",
  "expires",
  "max-age",
  "secure",
  "httponly",
  "partitioned",
  "priority",
]);
function cookieCheck(s: string): boolean {
  const m = /^([\w.%~+-]+)=(.{0,8})/.exec(s);
  if (!m) return false;
  const name = m[1]!.toLowerCase();
  if (COOKIE_ATTRS.has(name)) return false; // `Set-Cookie: SameSite=Lax is required`
  return !(name === "name" && /^value/i.test(m[2]!)); // `Cookie: name=value pairs`
}

function pemCheck(s: string): boolean {
  if (s.startsWith("-----")) return true;
  const head = Buffer.from(s.slice(0, 96).replace(/-/g, "+").replace(/_/g, "/"), "base64");
  return head.toString("latin1").includes("PRIVATE KEY");
}

const BEARER_SCHEMES = String.raw`(?:Bearer|Basic|Digest|Token|Negotiate|ApiKey)`;
/** Key-name part for the kw patterns: a bounded lazy prefix, then the secret word. */
const KEYWORD = String.raw`(?<kp>[\w.-]{0,48}?)(?<kw>${KW})(?![A-Za-z0-9])`;

export const BUILTIN_RULES: Rule[] = [
  {
    name: "private-key",
    hint: /PRIVATE KEY|LS0tLS1CRUdJTi/,
    patterns: [g(PEM), g(PEM_B64)],
    check: pemCheck,
  },
  {
    name: "url-credentials",
    hint: /:(?:\\{0,4}\/){2}/,
    patterns: [
      g(
        String.raw`(?<pre>\b[a-zA-Z][a-zA-Z0-9+.-]{1,24}:(?:\\{0,4}\/){2}[^\s:/@"'<>\\]{0,128}:)(?![$<{%])(?<sec>[^\s@/"'<>\\]{1,256})(?=@)`,
      ),
    ],
  },
  {
    name: "auth-header",
    hint: /authorization|api-key|auth-token|access-token|security-token|subscription-key|functions-key|vault-token|private-token|gitlab-token|auth-key/i,
    patterns: [
      g(
        String.raw`(?<pre>(?:Proxy-)?Authorization(?:\\?["'])?\s*[:=]\s*(?:\\?["'])?(?:${BEARER_SCHEMES}\s+)?)${PH}(?!${BEARER_SCHEMES}\s)(?<sec>[^\s"',]{6,})`,
        "i",
      ),
      g(
        String.raw`(?<pre>(?:X-Api-Key|Api-Key|X-Auth-Token|X-Auth-Key|X-Access-Token|X-Amz-Security-Token|Ocp-Apim-Subscription-Key|X-Functions-Key|X-Vault-Token|X-Gitlab-Token|Private-Token)(?:\\?["'])?\s*[:=]\s*(?:\\?["'])?)${PH}(?<sec>[^\s"',]{6,})`,
        "i",
      ),
    ],
  },
  {
    name: "bearer",
    hint: /bearer/i,
    patterns: [g(String.raw`(?<pre>\b[Bb]earer\s+)(?<sec>[A-Za-z0-9._~+/=-]{12,})`)],
    check: (s) => /[0-9.]/.test(s),
  },
  {
    name: "curl-basic-auth",
    hint: /curl/,
    patterns: [
      g(
        String.raw`(?<pre>\bcurl\s(?:[^\n|;&]{0,200}?\s)?(?:-u|--user)[ =]["']?[^\s:"']{0,64}:)${PH}(?<sec>[^\s"']{1,256})`,
      ),
      // `curl -u KEY:` : the API key is the user name, the password is empty
      g(
        String.raw`(?<pre>\bcurl\s(?:[^\n|;&]{0,200}?\s)?(?:-u|--user)[ =]["']?)${PH}(?<sec>[^\s:"']{12,128})(?<nopw>)(?=:(?:["']|\s|$))`,
      ),
    ],
    check: (s, gr) => gr["nopw"] === undefined || (/\d/.test(s) && /[A-Za-z]/.test(s)),
  },
  {
    name: "cli-flag",
    hint: /-[a-z]|--|setx|\/p|net[ \t]+use|ConvertTo-SecureString|aws[ \t]+configure|ngrok/i,
    patterns: [
      // --password X, --token=X, --client-secret "X Y"
      g(
        String.raw`(?<pre>(?<![\w-])--(?:[a-z0-9]+[-_]){0,2}(?:password|passwd|pwd|passphrase|pass|token|secret|api[-_]?key|access[-_]?key|private[-_]?key|auth[-_]?key|secret[-_]?key|storepass|keypass)(?<sep>=|[ \t]+))${CLI_VALUE}`,
        "i",
      ),
      // Joined compound flags: --authtoken, --apitoken, --clientsecret, --secretkey, --authkey
      // (not `pass`/`pwd`, which would hit --bypass and --compass)
      g(
        String.raw`(?<pre>(?<![\w-])--(?:[a-z0-9]+[-_]){0,2}[a-z0-9]{1,16}?(?:token|secret|apikey|accesskey|privatekey|authkey|secretkey|password|passphrase)(?<sep>=|[ \t]+))${CLI_VALUE}`,
        "i",
      ),
      // keytool/jarsigner: -storepass X, -keypass X, -srcstorepass X, -deststorepass X
      g(String.raw`(?<pre>(?<![\w-])-(?:src|dest)?(?:store|key)pass(?<sep>=|[ \t]+))${CLI_VALUE}`),
      // sqlcmd/bcp -P X; mongo/mongosh/mongodump/... -p X (a port is `--port`, `-p 27017` is skipped by cliCheck)
      g(String.raw`(?<pre>\b(?:sqlcmd|bcp)\b[^\n|;&]{0,120}?[ \t]-P(?:[ \t]+|(?=\S)))${CLI_VALUE}`),
      g(
        String.raw`(?<pre>\bmongo(?:sh|dump|restore|export|import|stat|top|files)?\b[^\n|;&]{0,120}?[ \t]-p(?<short>)(?:[ \t]+|(?=\S)))${CLI_VALUE}`,
      ),
      // smbclient -U user%SECRET
      g(
        String.raw`(?<pre>\b(?:smbclient|rpcclient|smbmap)\b[^\n|;&]{0,120}?[ \t]-U[ \t]*["']?[^\s%"']{1,64}%)${CLI_VALUE}`,
      ),
      // htpasswd -b[c] file user SECRET
      g(
        String.raw`(?<pre>\bhtpasswd[ \t]+(?:-[a-zA-Z]{1,8}[ \t]+){0,3}-[a-zA-Z]{0,7}b[a-zA-Z]{0,7}[ \t]+(?:-[a-zA-Z]{1,8}[ \t]+){0,3}\S{1,200}[ \t]+\S{1,64}[ \t]+)${CLI_VALUE}`,
      ),
      // gh secret set NAME --body SECRET
      g(
        String.raw`(?<pre>\bgh[ \t]+secret[ \t]+set\b[^\n|;&]{0,120}?[ \t](?:--body|-b)(?:=|[ \t]+))${CLI_VALUE}`,
      ),
      // ngrok authtoken X, ngrok config add-authtoken X
      g(String.raw`(?<pre>\bngrok[ \t]+(?:config[ \t]+)?(?:add-)?authtoken[ \t]+)${CLI_VALUE}`),
      // aws configure set aws_secret_access_key X / aws_session_token X
      g(
        String.raw`(?<pre>\baws[ \t]+configure[ \t]+set[ \t]+(?:[\w.-]{1,64}\.)?(?:aws_)?(?:secret_access_key|session_token)[ \t]+)${CLI_VALUE}`,
        "i",
      ),
      // 'SECRET' | ConvertTo-SecureString
      g(
        String.raw`(?<pre>(?<![^\s(;="]))${QUOTED(1)}(?=[ \t]*\|[ \t]*ConvertTo-SecureString\b)`,
        "i",
      ),
      // PowerShell: -Password X, -ApiKey:X, -Token "X"
      g(
        String.raw`(?<pre>(?<![\w-])-(?:Password|Passwd|Pwd|Passphrase|Token|ApiKey|Api-Key|Secret|ClientSecret|AccessToken|AuthToken|SecretKey|AccessKey|PrivateKey)(?<sep>[:=]|[ \t]+))${CLI_VALUE}`,
        "i",
      ),
      // ConvertTo-SecureString "X" -AsPlainText -Force, ... -String 'X' ..., ... -AsPlainText -String X
      g(
        String.raw`(?<pre>\bConvertTo-SecureString[ \t]+(?:-(?:AsPlainText|Force)[ \t]+){0,2}(?:-String[ \t]+)?)${CLI_VALUE}`,
        "i",
      ),
      g(
        String.raw`(?<pre>\bConvertTo-SecureString\b[^\n|;&]{0,100}?[ \t]-String[ \t]+)${CLI_VALUE}`,
        "i",
      ),
      // mysql -u root -pSECRET / -p'SECRET Y' (attached; `-p dbname` is a prompt); 7z/rar -pSECRET
      g(
        String.raw`(?<pre>\b(?:mysql(?:dump|admin|check|import|show|pump)?|mariadb(?:-dump)?|7za?|rar)\b[^\n|;&]{0,120}?[ \t]-p)${CLI_VALUE}`,
      ),
      // -p'SECRET' or -p"SECRET Y" on its own (the quote makes it a value, not a port or a name)
      g(String.raw`(?<pre>(?<![\w-])-p(?<short>))${QUOTED(1)}`),
      // docker/podman/helm login -p SECRET, az login -p, sshpass -p, psexec -p
      g(
        String.raw`(?<pre>\b(?:(?:docker|podman|nerdctl|helm)[ \t]+(?:registry[ \t]+)?login|az[ \t]+login|sshpass|psexec[0-9]*(?:\.exe)?)\b[^\n|;&]{0,120}?[ \t]-p(?:[ \t]+|(?=\S)))${CLI_VALUE}`,
        "i",
      ),
      // redis-cli -a SECRET; zip/unzip -P SECRET
      g(String.raw`(?<pre>\bredis-cli\b[^\n|;&]{0,120}?[ \t]-a[ \t]+)${CLI_VALUE}`),
      g(String.raw`(?<pre>\b(?:un)?zip\b[^\n|;&]{0,120}?[ \t]-P[ \t]+)${CLI_VALUE}`),
      // openssl enc -pass pass:SECRET, -passin pass:SECRET
      g(String.raw`(?<pre>(?<![\w-])-pass(?:in|out)?[ \t]+pass:)${CLI_VALUE}`),
      // echo SECRET | docker login --password-stdin (also gh auth login --with-token, helm, az)
      g(
        String.raw`(?<pre>\b(?:echo[ \t]+(?:-n[ \t]+)?|printf[ \t]+(?:%s|'[^'\n]{0,20}'|"[^"\n]{0,20}")[ \t]+))${CLI_VALUE}(?=[ \t]*\|[^\n|]{0,120}?(?:--(?:password-stdin|token-stdin|with-token|stdin\b)|\bsudo[ \t]+(?:-[A-Za-z]+[ \t]+){0,2}-S\b|ConvertTo-SecureString\b))`,
      ),
      // net use Z: \\srv\share SECRET /user:name
      g(
        String.raw`(?<pre>\bnet[ \t]+use[ \t]+(?:[A-Za-z]:[ \t]+)?\\{2,8}\S{1,200}[ \t]+)${PH}(?!\/)(?<sec2>[^\s"'${"`"};&|]{3,})`,
        "i",
      ),
      // Windows: /password:SECRET, /pwd=SECRET
      g(String.raw`(?<pre>(?<=^|[\s"'])\/(?:password|passwd|pwd|pass)[:=])${CLI_VALUE}`, "i"),
      // Windows: setx NAME VALUE
      g(
        String.raw`(?<pre>\bsetx[ \t]+(?:/[Mm][ \t]+)?(?<nm>[A-Za-z_]\w{0,63})[ \t]+)${CLI_VALUE}`,
        "i",
      ),
    ],
    check: cliCheck,
  },
  {
    name: "cookie",
    hint: /cookie|curl/i,
    patterns: [
      g(
        String.raw`(?<pre>\b(?:Set-)?Cookie(?:\\?["'])?[ \t]*:[ \t]*(?:\\?["'])?)(?<sec>${COOKIE_PAIRS})`,
        "i",
      ),
      // document.cookie = "sid=..."
      g(String.raw`(?<pre>\bcookies?(?:\\?["'])?[ \t]*=[ \t]*\\?["'])(?<sec>${COOKIE_PAIRS})`, "i"),
      // curl -b "sid=..." / --cookie sid=...
      g(
        String.raw`(?<pre>\bcurl\b[^\n|;&]{0,200}?[ \t](?:-b|--cookie)(?:[ \t]+|=)\\?["']?)(?<sec>${COOKIE_PAIRS})`,
      ),
    ],
    check: cookieCheck,
  },
  {
    // ~/.pgpass: host:port:database:user:password
    name: "pgpass",
    // Anchored at a line start, after a literal \n, or after echo/printf: a MAC, an IPv6 address or a
    // timestamp inside a line is not a pgpass entry (and `check` rejects a hex/colon-only match).
    hint: /:(?:\d{1,5}|\*):/,
    patterns: [
      g(
        String.raw`(?<pre>(?<=^|\n|\\n|["']|\b(?:echo|printf)[ \t]{1,8}(?:-[a-z]{1,3}[ \t]{1,8})?["']?)[\w.*-]{1,128}:(?:\d{1,5}|\*):[\w.*-]{1,64}:[\w.*-]{1,64}:)(?<sec>[^\s"']{3,})`,
      ),
    ],
    check: (s, gr) => {
      const pre = gr["pre"] ?? "";
      return !/^[0-9a-f:/.]+$/i.test(pre + s) && !/^\d{4}-\d\d-\d\d/.test(pre);
    },
  },
  {
    name: "anthropic-openai-key",
    hint: /sk-/,
    patterns: [g(String.raw`(?<![A-Za-z0-9])sk-[A-Za-z0-9_-]{20,}`)],
    check: (s) => /[0-9A-Z]/.test(s),
  },
  {
    name: "github-token",
    hint: /gh[pousr]_|github_pat_/,
    patterns: [g(GITHUB)],
  },
  {
    name: "aws-key",
    hint: /AKIA|ASIA/,
    patterns: [g(String.raw`(?<![A-Za-z0-9])(?:AKIA|ASIA)[A-Z0-9]{16}(?![A-Za-z0-9])`)],
  },
  {
    name: "slack-token",
    hint: /xox[abeprs]-/,
    patterns: [g(String.raw`(?<![A-Za-z0-9])xox[abeprs]-[A-Za-z0-9-]{10,}`)],
  },
  {
    name: "service-key",
    hint: TOKEN_HINT,
    patterns: [
      ...TOKEN_FORMATS.map((p) => g(p)),
      // Slack, Discord and Teams/Outlook webhook URLs: the trailing path segment is the credential.
      g(
        String.raw`(?<pre>hooks\.slack\.com\/services\/[A-Z0-9]+\/[A-Z0-9]+\/)(?<sec>[A-Za-z0-9]{8,})`,
      ),
      g(
        String.raw`(?<pre>discord(?:app)?\.com\/api\/(?:v\d+\/)?webhooks\/\d+\/)(?<sec>[A-Za-z0-9_-]{20,})`,
      ),
      g(String.raw`(?<pre>IncomingWebhook\/)(?<sec>[A-Za-z0-9-]{16,}(?:\/[A-Za-z0-9-]{8,})?)`),
      // Signed URLs: Azure SAS `sig=`, S3/GCS signatures.
      g(
        String.raw`(?<pre>[?&](?:sig|signature|x-amz-signature|x-amz-security-token|x-goog-signature)=)(?<sec>[A-Za-z0-9%+/_-]{16,}={0,3})`,
        "i",
      ),
    ],
  },
  {
    name: "env-assignment",
    hint: /key|token|secret|pass|pwd|credential|dsn|cred|auth|identified/i,
    patterns: [
      // UPPER_SNAKE names ending in a secret word: KEY, PASS, PWD, CRED, DSN, AUTH.
      gh(
        /_(?:KEY|PASS|PWD|CRED|CREDS|DSN|AUTH)/,
        String.raw`(?<pre>${KB}[A-Z][A-Z0-9_]{0,48}_(?:KEY|PASS|PWD|CRED|CREDS|DSN|AUTH)(?![A-Za-z0-9])${CLOSE}${ANN}\s*${SEP}\s*)(?:${QUOTED(3)}|${BARE})`,
      ),
      // Any case: names containing a secret word (api_key, password, SECRET, accessToken, ...).
      // Quoted values always; bare values unless they read as code (see envCheck).
      g(
        String.raw`(?<pre>${KB}${KEYWORD}${CLOSE}${ANN}(?<sp>\s*)${SEP}\s*)(?:${QUOTED(4)}|${BARE})`,
        "i",
      ),
      // The same with a suffix on the name: secret_key_base, secretKeyBase, password_file (envCheck
      // drops suffixes that name a setting, not a secret: max_tokens, token_type, password_min_length).
      // Case-sensitive classes mark the camelCase boundary, so the keywords are expanded by `ci`.
      gh(
        /secret|passw|passphrase|token|storepass|keypass/i,
        ci(
          String.raw`(?<pre>${KB}(?<kp>[\w.-]{0,48}?)(?<kw>${STRONG})${KS}(?![A-Za-z0-9])${CLOSE}${ANN}(?<sp>\s*)${SEP}\s*)(?:${QUOTED(4)}|${BARE})`,
        ),
      ),
      // Weak keys (credentials, auth, authorization, bearer): the value stays on the line.
      gh(
        /credential|authorization|auth|bearer/i,
        String.raw`(?<pre>${KB}[\w.-]{0,48}?(?<kw>${KW_WEAK})(?![A-Za-z0-9])${CLOSE}(?<sp>[ \t]*)${SEP}[ \t]*)(?:${QUOTED(4)}|${BARE})`,
        "i",
      ),
      // UPPER_SNAKE names with a secret word anywhere (SECRET_KEY_BASE, DB_PASSWORD_X): any bare value.
      gh(
        /TOKEN|SECRET|PASSWORD|PASSWD|PASSPHRASE|STOREPASS|KEYPASS/,
        String.raw`(?<pre>${KB}(?:[A-Z][A-Z0-9_]{0,48})?(?:TOKEN|SECRET|PASSWORD|PASSWD|PASSPHRASE|STOREPASS|KEYPASS)(?<ks>[A-Z0-9_]{0,32})(?![A-Za-z0-9])${CLOSE}${ANN}\s*${SEP}\s*)(?:${QUOTED(3)}|${BARE})`,
      ),
      // Key and value as separate arguments: define('DB_PASSWORD', 'x'), config.set("db", "password", "x")
      gh(
        /["'][ \t]*,/,
        String.raw`(?<pre>${KB}${KEYWORD}(?:\\?["'])[ \t]*,\s*)${QUOTED(4)}(?![ \t]*[:=])`,
        "i",
      ),
      // XML element: <password>x</password>
      g(
        String.raw`(?<pre><(?<kp>[\w:.-]{0,48}?)(?<kw>${KW})(?![A-Za-z])(?:[ \t][^<>]{0,200})?>\s*)${PH}(?<sec2>[^<\s][^<]{2,})(?=<\/)`,
        "i",
      ),
      // XML key/name attribute: <entry key="db.password">x</entry>, <property name="x.password">x</property>
      g(
        String.raw`(?<pre><(?:entry|property|param|parameter|setting|add|item|env|variable)\b[^<>]{0,100}?\b(?:key|name)=["'](?<kp>[\w.:-]{0,64}?)(?<kw>${KW})(?![A-Za-z0-9])["'][^<>]{0,100}?>\s*)${PH}(?<sec2>[^<\s][^<]{2,})(?=<\/)`,
        "i",
      ),
      // Cloud CLI output: Azure `storage account keys list` ("keyName":"key1",...,"value":"x"), Key Vault
      // `secret show` ("id":".../secrets/name/ver",...,"value":"x")
      g(
        String.raw`(?<pre>\bkeyName(?:\\?["'])?[ \t]*[:=][ \t]*\\?["']?\w{1,64}[^\n]{0,200}?\bvalue(?:\\?["'])?[ \t]*[:=][ \t]*)(?:${QUOTED(8)}|${BARE})`,
        "i",
      ),
      g(
        String.raw`(?<pre>\/secrets\/[\w.-]{1,127}(?:\/\w{1,64})?\\?["'][^\n]{0,300}?\bvalue(?:\\?["'])?[ \t]*[:=][ \t]*)(?:${QUOTED(4)}|${BARE})`,
        "i",
      ),
      // A name/value pair: <add key="ApiKey" value="x"/>, {"name": "DB_PASSWORD", "value": "x"}, k8s env
      g(
        String.raw`(?<pre>\b(?:key|name)(?:\\?["'])?[ \t]*[:=][ \t]*(?<kq>\\?["']?)[\w.:-]{0,64}?(?<kw>${KW})(?![A-Za-z])[\w.:-]{0,32}?\k<kq>[\s,]{1,24}(?:\\?["'])?value(?:\\?["'])?[ \t]*[:=][ \t]*)(?:${QUOTED(1)}|${BARE})`,
        "i",
      ),
      // .netrc: machine h login u password X
      g(
        String.raw`(?<pre>\b(?:machine\s+\S{1,128}\s+(?:login\s+\S{1,128}\s+)?|(?:default\s+)?login\s+\S{1,128}\s+)password\s+)${PH}(?<sec2>[^\s"']{3,})`,
        "i",
      ),
      // SQL: IDENTIFIED BY 'x', WITH PASSWORD 'x'
      g(
        String.raw`(?<pre>\b(?:IDENTIFIED[ \t]+(?:WITH[ \t]+\w{1,32}[ \t]+)?BY|PASSWORD)[ \t]+)${QUOTED(3)}`,
        "i",
      ),
    ],
    check: envCheck,
    trim: trimBrackets,
  },
];

/**
 * Does a JSON object key name a credential? camelCase and kebab are folded to snake_case; the
 * secret word must end the name, so `max_tokens` and `task_key` do not match.
 */
export function isSecretKeyName(key: string): boolean {
  if (key.length < 3 || key.length > 64) return false;
  const k = key
    .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
    .replace(/-/g, "_")
    .toLowerCase();
  return SECRET_KEY_END.test(k);
}
const SECRET_KEY_END =
  /(?:^|_)(?:api_?key|apikey|secret(?:_access)?(?:_key)?(?:_base)?|secret_?string|passw(?:or)?d|pwd|pass|token|credentials?|passphrase|private_?key|access_?key|account_?key|auth_?token|auth_?key|storepass|keypass|authorization|auth|bearer|dsn|key_data|(?:signing|encryption|master|license|session|service|app|bot|webhook)_key)$/;

/** Cheap gate for the structural key walk: any word `isSecretKeyName` could accept. */
export const STRUCT_HINT = /key|secret|pass|pwd|token|credential|auth|bearer|dsn/i;

export const BUILTIN_RULE_NAMES: readonly string[] = BUILTIN_RULES.map((r) => r.name);
export { PH as PLACEHOLDER_LOOKAHEAD };
