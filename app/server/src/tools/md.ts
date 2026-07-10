/**
 * Markdown AST utilities for the audit importer.
 *
 * Parses the source audit with unified()+remark-parse+remark-gfm and exposes
 * helpers that slice the RAW source by node offsets (so markdown is preserved)
 * plus a delete-aware plain-text extractor for parsing.
 */
import { unified } from "unified";
import remarkParse from "remark-parse";
import remarkGfm from "remark-gfm";
import type { Root, Heading, Table, TableRow } from "mdast";

/** Minimal structural shape every mdast/unist node satisfies. */
interface Positioned {
  type: string;
  value?: string;
  children?: unknown[];
  position?: { start: { offset?: number }; end: { offset?: number } };
}

export interface Cell {
  /** RAW markdown of the cell (GFM pipe-escapes decoded). */
  raw: string;
  /** delete-aware plain text (strikethrough content removed). */
  text: string;
}

export interface Section {
  /** e.g. "C36" or "C56 (cont.)". */
  idPart: string;
  /** numeric id, NaN when the heading is not a task. */
  num: number;
  cont: boolean;
  /** heading title after the first separator. */
  title: string;
  /** full heading text. */
  headingText: string;
  bodyRaw: string;
}

export function parse(raw: string): Root {
  return unified().use(remarkParse).use(remarkGfm).parse(raw) as Root;
}

function startOffset(node: Positioned): number {
  const o = node.position?.start.offset;
  if (o === undefined) throw new Error(`node ${node.type} has no start offset`);
  return o;
}

function endOffset(node: Positioned): number {
  const o = node.position?.end.offset;
  if (o === undefined) throw new Error(`node ${node.type} has no end offset`);
  return o;
}

/** delete-aware text: concatenates text + inlineCode; skips ~~strikethrough~~. */
export function nodeText(node: unknown): string {
  if (!node || typeof node !== "object") return "";
  const n = node as { type?: string; value?: string; children?: unknown[] };
  switch (n.type) {
    case "text":
    case "inlineCode":
      return n.value ?? "";
    case "delete":
      return ""; // superseded (struck) content is dropped entirely
    case "break":
      return " ";
    case "image":
      return "";
    default:
      if (Array.isArray(n.children)) return n.children.map(nodeText).join("");
      return "";
  }
}

export function decodePipeEscapes(s: string): string {
  return s.replace(/\\\|/g, "|");
}

/** RAW markdown slice for a node, with GFM `\|` pipe-escapes decoded. */
export function cellFrom(raw: string, node: Positioned): Cell {
  let slice = raw.slice(startOffset(node), endOffset(node)).trim();
  // remark-gfm includes the bounding delimiter pipe on edge cells; strip one.
  if (slice.startsWith("|")) slice = slice.slice(1);
  if (slice.endsWith("|")) slice = slice.slice(0, -1);
  return { raw: decodePipeEscapes(slice.trim()), text: nodeText(node).trim() };
}

/** All GFM tables in document order. */
export function tables(root: Root): Table[] {
  return root.children.filter((c): c is Table => c.type === "table");
}

export function tableRows(raw: string, table: Table): Cell[][] {
  return (table.children as TableRow[]).map((row) =>
    row.children.map((cell) => cellFrom(raw, cell as unknown as Positioned)),
  );
}

/** Depth-2 headings in order. */
function h2(root: Root): Heading[] {
  return root.children.filter((c): c is Heading => c.type === "heading" && c.depth === 2);
}

export interface SplitHeading {
  idPart: string;
  title: string;
}

/** Split a heading on the FIRST separator (em dash, en dash, or spaced hyphen). */
export function splitHeading(headingText: string): SplitHeading {
  const m = /—|–| - /.exec(headingText);
  if (!m || m.index === undefined) return { idPart: headingText.trim(), title: "" };
  return {
    idPart: headingText.slice(0, m.index).trim(),
    title: headingText.slice(m.index + m[0].length).trim(),
  };
}

/** Strip a trailing thematic break (---) plus surrounding whitespace. */
export function stripTrailingRule(s: string): string {
  return s.replace(/\n*-{3,}\s*$/g, "").trim();
}

/** Locate a depth-2 heading whose text starts with `prefix` (case-insensitive). */
export function findHeading(root: Root, prefix: string): Heading | undefined {
  return h2(root).find((h) => nodeText(h).trim().toLowerCase().startsWith(prefix.toLowerCase()));
}

/** Raw body of a heading's section (from heading end to next h2 start), rule-stripped. */
export function sectionBody(raw: string, root: Root, heading: Heading): string {
  const headings = h2(root);
  const idx = headings.indexOf(heading);
  const next = headings[idx + 1];
  const from = endOffset(heading);
  const to = next ? startOffset(next) : raw.length;
  return stripTrailingRule(raw.slice(from, to));
}

/** Raw slice between two headings' start offsets (rule-stripped). */
export function between(raw: string, from: Heading, to: Heading | undefined): string {
  const start = startOffset(from);
  const end = to ? startOffset(to) : raw.length;
  return stripTrailingRule(raw.slice(start, end));
}

export function headingStart(node: Heading): number {
  return startOffset(node);
}

export function nodeEnd(node: Positioned): number {
  return endOffset(node);
}

/** All task detail sections (## C.. headings); caller normalizes ids. */
export function taskSections(raw: string, root: Root): Section[] {
  const out: Section[] = [];
  for (const h of h2(root)) {
    const headingText = nodeText(h).trim();
    if (!/^C\d+/.test(headingText)) continue;
    const { idPart, title } = splitHeading(headingText);
    const numMatch = /^C0*(\d+)/.exec(idPart);
    out.push({
      idPart,
      num: numMatch ? Number(numMatch[1]) : NaN,
      cont: /\(cont\.?\)/i.test(idPart),
      title,
      headingText,
      bodyRaw: sectionBody(raw, root, h),
    });
  }
  return out;
}
