# @sessiondeck/probe

The laptop side: hooks, statusline, and the daemon that forwards the spool and transcripts.

## Transcript redaction (R4.7)

Every transcript line is redacted in the daemon before it is enqueued. Lines over the size limit
(500 KB) are never parsed or scanned; they become a marker. The line is parsed as JSON, every string
value and key is redacted, and the line is re-serialized only when something changed. A line that
does not parse is redacted as raw text. A redacted span becomes `[redacted:<rule>]`; a JSON value
under a credential key (`password`, `token`, `auth`, `passphrase`, `AccountKey`, ...) becomes
`[redacted:secret-key]`.

Built-in rules: `private-key`, `url-credentials`, `auth-header`, `bearer`, `curl-basic-auth`,
`cli-flag` (`--password X`, `--password "X Y"` to the matching quote, `mysql -pX`, `docker login -p X`,
`setx NAME X`, PowerShell `-Password X` and `ConvertTo-SecureString "X"`, `echo X | ... --password-stdin`,
`net use`, `/password:X`), `cookie` (`Cookie:`, `document.cookie =`, `curl -b`; a `name=value` pair is
required), `pgpass`, `anthropic-openai-key`, `github-token`, `aws-key`, `slack-token`, `service-key`
(some 35 vendor token formats, Slack, Discord and Teams webhooks, signed-URL `sig=`),
`env-assignment` (separators `=` `:` `=>` `:=` `?=` `||=`; `["KEY"] =`; XML element and
`key`/`value` attribute pairs; `define('K', 'v')`; `.netrc`; SQL `IDENTIFIED BY`), and in
`private-key` a base64-encoded PEM block (`client-key-data:`).

### probe.json `redaction` section

The section is read once, when the daemon starts. Restart the daemon to apply a change; the daemon
logs the active rule counts at start. `probe install` keeps the section when it rewrites probe.json.
A leading UTF-8 BOM is accepted.

```json
"redaction": {
  "enabled": true,
  "deny":  [{ "name": "corp-id", "pattern": "CORP-[0-9]{8}", "flags": "i" }],
  "allow": ["^ghp_EXAMPLE"],
  "disableRules": ["service-key"]
}
```

- `deny`: extra patterns, replaced by `[redacted:<name>]`. Run over 4096-character windows that
  overlap by 512, so a match up to 512 characters long is never split. Patterns with a nested
  quantifier (`(a+)+`, `(\w+){4}`, and also a group holding an inner `?` that is repeated, such as
  `(?:a?){40}`), a quantified group with alternation (`(a|aa)+`), more than one unbounded quantifier
  (`+`, `*`, `{n,}`, or a range up to 100 or more), more than two ranged quantifiers `{n,m}`, more
  than six optional items, or that match the empty string are rejected. These checks are a first
  line only. The protection is a runtime bound: when any `deny` or `allow` pattern is configured,
  each line is redacted under a `vm` timeout of 1 s (about 0.3 ms of overhead per line), and a line
  that exceeds it is replaced by the `redaction_failed` marker, so nothing unredacted ships and the
  tailer is stalled by at most the budget per such line. With no deny or allow pattern there is no
  guard and no overhead (the built-in rules are linear).
- `allow`: a detected secret is left alone when an allow pattern matches the secret span itself
  (not the key name before it). Patterns are unanchored: `"."` exempts everything. The daemon logs a
  warning with the number of allow patterns and their lengths, never their text (an allow entry may
  be a real token).
- `disableRules` and `"enabled": false`: the owner's choice. `enabled: false` is logged as a
  warning. The structural key walk is not a rule and stays on whenever redaction is enabled.
- A rejected section falls back to the built-in rules alone (enabled); the error names the entry and
  never echoes the pattern.

### Adding a built-in rule

A pattern that only matters for some words can carry a gate (`gh(hint, ...)` in `rules.ts`): a cheap
necessary condition the redactor tests before running it. Patterns must be linear: no lookahead over an unbounded run (put value-shape checks in the rule's
`check` function), no repeated group with an inner unbounded quantifier. Add the shape to the
corpora (`test/redaction/`) and to `SHAPES` in `redaction-timing.test.ts`, which times every rule
on 1 MB inputs (limit 1 s, best of 3). `gen-independent.mjs` and `gen-fresh.mjs` regenerate the
second and third secret corpora.

### Known gaps

Deliberate; each is a shape that cannot be told from prose or code without a false-positive cost.

- A secret that appears only in a comment or prose with no key it is attached to
  (`# tok=Hk29...`, "the password is Hk29..."): no key name to anchor on.
- `password = correct horse battery staple`: a bare multi-word value; only quoted values may contain spaces.
- A bare `Cookie: AbCd1234` with no `name=value` pair: a real Cookie header always has one, and
  requiring it keeps prose such as `Set-Cookie: SameSite=Lax is required` intact.
- `PASSWORD hunter2` (keyword, space, value, no separator) outside `.netrc`, SQL, CLI forms and `aws configure set`.
- A `.pgpass` line whose host contains `:` (IPv6) or whose fields are quoted.
- `bypass: x`-style names ending in `pass` are not treated as `pass` keys; `pass: relaunch`
  (one short plain word) is read as a test verdict, not a password.
- A base64 PEM that does not start at the `-----BEGIN` boundary (re-wrapped or prefixed) and
  chains of three or more nested rejected values (`a(b)tok=a(b)password=X`) are not recovered.
- Values spread over several JSON string fields (a key in one field, its value in the next) are
  only caught for the `name`/`value` pair shape.
- A `.pgpass` entry in the middle of a line (`pg: host:5432:db:user:pw`) is not matched; entries are
  anchored at a line start, after a newline, after `echo`/`printf`, or after a quote.
- Unkeyed secret-manager reads: the value is printed with no key next to it, so nothing marks it.
  `gcloud secrets versions access latest --secret=x`, `vault kv get -field=password secret/x`,
  `op read op://vault/item/field`, `kubectl get secret x -o jsonpath=... | base64 -d`,
  `az keyvault secret show --query value -o tsv`, `aws secretsmanager get-secret-value --query SecretString --output text`.
  The command line is not redacted and its output is a bare string.
- A name with a secret word and a setting-like suffix (`token_type`, `password_min_length`,
  `secret_name`, `max_tokens`) is left alone on purpose; so is an identifier value in code
  (`password: hashed,`, `token: token ?? x`).
- A value ending in an unbalanced `)`, `]` or `}` loses that closer to the surrounding code (the
  closer stays in the output).
- Deny and allow patterns are owner-trusted input; the runtime bound limits the damage of a bad one
  but the pattern still runs on the tailer's thread until the budget is spent.
