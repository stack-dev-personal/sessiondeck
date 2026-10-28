// Time zone scrub for transcript text (R0.7, security gate round 3). A zone name next to row
// timestamps and other details narrows down where a person is, so zone names and abbreviations
// become <TZ>. Shared by the scrub and the leak check so they cannot drift apart. Pure functions.
//
//   - IANA names: a known area (Africa, America, Antarctica, Asia, Atlantic, Australia, Europe,
//     Indian, Pacific, Etc) followed by one or two /City segments. Ordinary code paths do not start
//     with these capitalised words.
//   - US and EU abbreviations (EST EDT CST CDT MST MDT PST PDT ET PT CET CEST BST) when they follow
//     a time of day, or stand alone in parentheses
//   - UTC or GMT with an offset (UTC-5, GMT+5:30); UTC by itself is left alone (row timestamps)
//   - English long names (Eastern Time, Pacific Standard Time)

const AREAS = "Africa|America|Antarctica|Asia|Atlantic|Australia|Europe|Indian|Pacific|Etc";
const SEG = String.raw`[A-Za-z][A-Za-z0-9_+-]*`;
const ABBR = "EST|EDT|CST|CDT|MST|MDT|PST|PDT|CET|CEST|BST|ET|PT";
const TIME = String.raw`\d{1,2}(?::\d{2}){0,2}(?:\s?[AaPp]\.?[Mm]\.?)?`;

const IANA = String.raw`\b(?:${AREAS})\/${SEG}(?:\/${SEG})?`;
const AFTER_TIME = String.raw`(?<![A-Za-z0-9_.-])(${TIME}\s*\(?)(?:${ABBR})(?![A-Za-z0-9])`;
const PAREN = String.raw`\((?:${ABBR})\)`;
const OFFSET = String.raw`(?<![A-Za-z0-9])(?:UTC|GMT)\s?[+\u2212-]\d{1,2}(?::?\d{2})?(?![A-Za-z0-9])`;
const LONG = String.raw`\b(?:Eastern|Central|Mountain|Pacific)(?: (?:Standard|Daylight))? Time\b`;

export const ZONE_PLACEHOLDER = "<TZ>";

/** Replaces zone names and abbreviations with <TZ>. @param {string} s */
export function scrubZones(s) {
  return s
    .replace(new RegExp(IANA, "g"), ZONE_PLACEHOLDER)
    .replace(new RegExp(LONG, "g"), ZONE_PLACEHOLDER)
    .replace(new RegExp(OFFSET, "g"), ZONE_PLACEHOLDER)
    .replace(new RegExp(PAREN, "g"), `(${ZONE_PLACEHOLDER})`)
    .replace(new RegExp(AFTER_TIME, "g"), `$1${ZONE_PLACEHOLDER}`);
}

const FINDERS = [IANA, LONG, OFFSET, PAREN, AFTER_TIME].map((src) => new RegExp(src));

/** Whether text still holds a zone name or abbreviation. @param {string} s */
export const hasZone = (s) => FINDERS.some((re) => re.test(s));
