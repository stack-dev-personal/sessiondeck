import type { ZodError, ZodIssue } from "zod";

/** "envelopes[3].kind" style path; "body" for the root. */
export function formatPath(path: (string | number)[]): string {
  if (path.length === 0) return "body";
  let out = "";
  for (const seg of path) {
    out += typeof seg === "number" ? `[${seg}]` : out === "" ? seg : `.${seg}`;
  }
  return out;
}

/** Messages are rebuilt from the issue code so a rejected value is never echoed back. */
function safeMessage(issue: ZodIssue): string {
  switch (issue.code) {
    case "invalid_type":
      return issue.received === "undefined"
        ? "Required"
        : `Expected ${issue.expected}, received ${issue.received}`;
    case "invalid_enum_value":
      return "Invalid enum value";
    case "invalid_literal":
      return "Invalid literal value";
    case "custom":
    case "invalid_string":
    case "too_small":
    case "too_big":
      return issue.message; // schema-authored text (e.g. "id must be a ULID"), never contains input
    default:
      return issue.code;
  }
}

/** First issue only: "<path>: <message>". */
export function reasonFromZod(err: ZodError): string {
  const issue = err.issues[0];
  if (issue === undefined) return "invalid";
  return `${formatPath(issue.path)}: ${safeMessage(issue)}`;
}
