// Text-block cuts for the transcript scrub and its leak check (R0.7, security gate round 2).
// Shared by both so they cannot drift apart. Pure functions, no I/O, on text whose paths are already
// placeholders.
//
// Claude Code repeats private material as message text: "Contents of <file>: ..." for a loaded
// file, "<Event> hook success: ..." and "SessionStart hook additional context: ..." for hooks, and
// "Result of calling the X tool: ..." after a "Called the X tool with the following input: {...}"
// that named a private path. Each block is cut down to its label plus "<BLOB n>".
import { isOutsideProject, PRIVATE_COMMAND, stripCutHome } from "./transcript-scrub-private.mjs";

/** Where "Contents of <path>" names the file; the path ends at the first space or colon. */
const CONTENTS_OF = /Contents of ([^\s:]+)(:*)/;
/** A hook label: "SessionStart hook additional context:", "PostToolUse:Read hook success:". */
const HOOK_LABEL = /\b[A-Z][A-Za-z]*(?::[^\s:]+)? hook [a-z-]+(?: [a-z-]+){0,3}:/;
const CONTENTS_LABEL = "Contents of ";
const CALLED = /Called the \w+ tool with the following input: /;
const RESULT = /Result of calling the \w+ tool:/;
// A value may run to the end of the text (cut at 120 characters), so the closing quote is optional.
const PATH_VALUE = /"(?:file_path|path|notebook_path)"\s*:\s*"([^"]*)("?)/g;
const COMMAND_VALUE = /"command"\s*:\s*"([^"]*)("?)/g;
const OWN_ROOT = "<HOME>/projects/<PROJECT_A>/";
const TRUNCATED = /<TRUNCATED \d+>$/;
export const BLOB_AFTER_LABEL = ": <BLOB ";

/** @param {string} p */
const outsidePath = (p) => p.startsWith("~") || p.startsWith("$HOME") || isOutsideProject(p);

/**
 * Whether the text of a "Called the X tool with the following input: {...}" block names a path
 * outside the project or a shell command that touches one.
 * @param {string} text scrubbed text, possibly cut
 */
export function calledOutside(text) {
  const at = text.search(CALLED);
  if (at === -1) return false;
  const rest = text.slice(at);
  for (const m of rest.matchAll(PATH_VALUE)) {
    const v = m[1] ?? "";
    // a cut-off start of this project's own root is not an outside path
    if (outsidePath(v) && (m[2] === '"' || !OWN_ROOT.startsWith(v))) return true;
  }
  for (const m of rest.matchAll(COMMAND_VALUE)) {
    const v = m[1] ?? "";
    if (PRIVATE_COMMAND.test(m[2] === '"' ? v : stripCutHome(v))) return true;
  }
  return false;
}

/**
 * First "Contents of <path>" whose path lies outside the project.
 * @param {string} s @returns {RegExpExecArray | null}
 */
function outsideContents(s) {
  const all = new RegExp(CONTENTS_OF.source, "g");
  for (let m = all.exec(s); m !== null; m = all.exec(s)) if (outsidePath(m[1] ?? "")) return m;
  return null;
}

/** Whether a block starts with the "Called the X tool" label. @param {string} text */
export const isCalled = (text) => CALLED.test(text);

/** Whether a block holds a "Result of calling the X tool:" label. @param {string} text */
export const isResult = (text) => RESULT.test(text);

/**
 * Cuts `s` after its first `end` characters (the label) down to "<label>: <BLOB n>".
 * @param {string} s @param {number} end index where the label ends @param {number} originalLength
 */
const cutAt = (s, end, originalLength) =>
  `${s.slice(0, end).replace(/:+$/, "")}: <BLOB ${Math.max(0, originalLength - end)}>`;

/**
 * Cuts the "Result of calling the X tool:" block of `s` down to its label.
 * @param {string} s @param {number} [originalLength] length of the text before it was cut short
 * @param {number} [from] where to start looking
 */
export function cutResult(s, originalLength = s.length, from = 0) {
  const m = RESULT.exec(s.slice(from));
  return m ? cutAt(s, from + m.index + m[0].length, originalLength) : s;
}

/**
 * Cuts private blocks of one string down to their labels: a "Contents of" block of a file outside
 * the project, the body of a hook label, and a "Result of calling" block that follows a private
 * "Called the X tool" in the same string. Each step cuts after its first match.
 * @param {string} s text whose paths are already placeholders
 */
export function cutPrivateText(s) {
  let out = s;
  const contents = outsideContents(out);
  if (contents) {
    out = cutAt(
      out,
      contents.index + CONTENTS_LABEL.length + (contents[1] ?? "").length,
      out.length,
    );
  }
  const hook = HOOK_LABEL.exec(out);
  if (hook) out = cutAt(out, hook.index + hook[0].length, out.length);
  const called = CALLED.exec(out);
  if (called && calledOutside(out.slice(called.index))) {
    out = cutResult(out, out.length, called.index);
  }
  return out;
}

/** Whether the text after a label is nothing but the cut marker (or a cut-off piece of it). @param {string} rest */
export function isCutRemainder(rest) {
  const x = rest.replace(TRUNCATED, "");
  return /^:? ?<BLOB \d+>$/.test(x) || /^:? ?<BLOB \d*$/.test(x) || BLOB_AFTER_LABEL.startsWith(x);
}

/**
 * Leak-check finding for one string: a private block that was not cut down to its label.
 * @param {string} text scrubbed (and possibly truncated) text
 * @returns {string | null} category, or null when acceptable
 */
export function privateTextFinding(text) {
  const s = text.replace(TRUNCATED, "");
  const contents = outsideContents(s);
  if (contents) {
    const rest = (contents[2] ?? "") + s.slice(contents.index + contents[0].length);
    if (!isCutRemainder(rest)) return "transcript-private-text-not-cut";
  }
  const hook = HOOK_LABEL.exec(s);
  if (hook && !isCutRemainder(s.slice(hook.index + hook[0].length))) {
    return "transcript-hook-text-not-cut";
  }
  const called = CALLED.exec(s);
  if (called && calledOutside(s.slice(called.index))) {
    const res = RESULT.exec(s.slice(called.index));
    if (res) {
      const rest = s.slice(called.index + res.index + res[0].length);
      if (!isCutRemainder(rest)) return "transcript-private-text-not-cut";
    }
  }
  return null;
}
