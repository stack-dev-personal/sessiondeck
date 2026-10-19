import { renderProvisionalTable, renderStateDiagram, renderTransitionTable } from "./diagram";
import { TRANSITIONS } from "./transitions";

/** Names of the generated regions in docs/CONTRACT.md, in `<!-- BEGIN:name -->` markers. */
export const DOC_BLOCK_NAMES = ["state-diagram", "transition-table", "provisional"] as const;
export type DocBlockName = (typeof DOC_BLOCK_NAMES)[number];

/** The generated content for each region, from the one transition table. */
export function renderDocBlocks(): Record<DocBlockName, string> {
  return {
    "state-diagram": renderStateDiagram(TRANSITIONS),
    "transition-table": renderTransitionTable(TRANSITIONS),
    provisional: renderProvisionalTable(),
  };
}

function normalize(text: string): string {
  return text.replace(/\r\n/g, "\n");
}

function markers(name: DocBlockName): { begin: string; end: string } {
  return { begin: `<!-- BEGIN:${name} -->`, end: `<!-- END:${name} -->` };
}

/** Content between the markers (LF-normalized, no surrounding blank lines), or null if absent. */
export function extractBlock(doc: string, name: DocBlockName): string | null {
  const text = normalize(doc);
  const { begin, end } = markers(name);
  const from = text.indexOf(begin);
  const to = text.indexOf(end);
  if (from === -1 || to === -1 || to < from) return null;
  return text.slice(from + begin.length, to).replace(/^\n+|\n+$/g, "");
}

/** Doc with the region between the markers replaced. Throws when the markers are missing. */
export function replaceBlock(doc: string, name: DocBlockName, content: string): string {
  const text = normalize(doc);
  const { begin, end } = markers(name);
  const from = text.indexOf(begin);
  const to = text.indexOf(end);
  if (from === -1 || to === -1 || to < from) {
    throw new Error(`docs/CONTRACT.md is missing the ${begin} ... ${end} markers`);
  }
  return `${text.slice(0, from + begin.length)}\n${content}\n${text.slice(to)}`;
}
