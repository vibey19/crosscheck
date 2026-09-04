import { getParser } from '@unified-latex/unified-latex-util-parse';
import { collapseWhitespace, literalFor, PARSER_VERSION } from './normalize.js';

export interface ParsedSection {
  /** Numbered path, e.g. `3.1 Ablation`. Unnumbered front matter uses its own title. */
  path: string;
  title: string;
  level: number;
  ordinal: number;
  /** Offsets into `ParsedDocument.text`, not into the LaTeX source. */
  charStart: number;
  charEnd: number;
}

export interface ParsedDocument {
  text: string;
  sections: ParsedSection[];
  parserVersion: string;
}

const SECTION_LEVELS: Record<string, number> = {
  section: 1,
  subsection: 2,
  subsubsection: 3,
};

/** Environments whose contents are never prose and would only add noise to claim extraction. */
const SKIP_ENVIRONMENTS = new Set([
  'tikzpicture', 'lstlisting', 'verbatim', 'algorithm', 'algorithmic',
  'thebibliography', 'filecontents', 'comment',
]);

/** Environments kept for their caption only — the body is a graphic. */
const CAPTION_ONLY_ENVIRONMENTS = new Set(['figure', 'figure*', 'subfigure', 'wrapfigure']);

/** Tabular-like environments, where `&` and `\\` carry the structure claim extraction needs. */
const TABULAR_ENVIRONMENTS = new Set(['tabular', 'tabularx', 'array', 'longtable', 'tabu']);

/** Macros dropped along with their arguments — bookkeeping, not prose. */
const DROP_WITH_ARGS = new Set([
  'label', 'cite', 'citep', 'citet', 'citealp', 'ref', 'eqref', 'autoref', 'cref', 'Cref',
  'usepackage', 'documentclass', 'bibliography', 'bibliographystyle', 'vspace', 'hspace',
  'includegraphics', 'newcommand', 'renewcommand', 'def', 'footnote', 'input', 'include',
]);

/** Macros whose argument text is kept but the macro itself contributes nothing. */
const TRANSPARENT = new Set([
  'textbf', 'textit', 'emph', 'text', 'texttt', 'textsc', 'textrm', 'mathrm', 'mathbf',
  'mathit', 'underline', 'title', 'mbox', 'hbox', 'texorpdfstring', 'ensuremath',
]);

interface Node {
  type?: string;
  content?: unknown;
  args?: Node[];
  env?: unknown;
}

function asNodes(value: unknown): Node[] {
  return Array.isArray(value) ? (value as Node[]) : [];
}

function envName(node: Node): string {
  const raw = node.env;
  if (typeof raw === 'string') return raw;
  return asNodes(raw)
    .map((n) => (typeof n.content === 'string' ? n.content : ''))
    .join('');
}

/** Renders a macro argument group to plain text — used for titles and captions. */
function argText(arg: Node | undefined): string {
  if (!arg) return '';
  const out: string[] = [];
  emit(asNodes(arg.content), out, { inTabular: false });
  return collapseWhitespace(out.join(''));
}

interface EmitOptions {
  inTabular: boolean;
}

/** Appends the plain-text rendering of `nodes` to `out`. */
function emit(nodes: Node[], out: string[], options: EmitOptions): void {
  for (const node of nodes) {
    switch (node.type) {
      case 'string': {
        const content = typeof node.content === 'string' ? node.content : '';
        // In tabular context an ampersand is a cell separator, not literal text.
        out.push(options.inTabular && content === '&' ? ' | ' : content);
        break;
      }
      case 'whitespace':
        out.push(' ');
        break;
      case 'parbreak':
        out.push('\n\n');
        break;
      case 'comment':
        break;
      case 'group':
        emit(asNodes(node.content), out, options);
        break;
      case 'inlinemath':
      case 'displaymath': {
        const inner: string[] = [];
        emit(asNodes(node.content), inner, options);
        // Math frequently carries the reported quantity, so keep its text rather than dropping it.
        const rendered = inner.join('').replace(/\s+/g, ' ').trim();
        if (rendered) out.push(node.type === 'displaymath' ? `\n${rendered}\n` : rendered);
        break;
      }
      case 'verbatim':
        break;
      case 'environment': {
        const name = envName(node);
        if (SKIP_ENVIRONMENTS.has(name)) break;
        if (CAPTION_ONLY_ENVIRONMENTS.has(name)) {
          const caption = findCaption(asNodes(node.content));
          if (caption) out.push(`\n${caption}\n`);
          break;
        }
        const tabular = options.inTabular || TABULAR_ENVIRONMENTS.has(name);
        out.push('\n');
        emit(asNodes(node.content), out, { inTabular: tabular });
        out.push('\n');
        break;
      }
      case 'macro': {
        const name = typeof node.content === 'string' ? node.content : '';
        // `\\` ends a table row; elsewhere it is just a line break.
        if (name === '\\' || name === 'newline' || name === 'cr') {
          out.push('\n');
          break;
        }
        if (DROP_WITH_ARGS.has(name)) break;
        const literal = literalFor(name);
        if (literal !== undefined) {
          out.push(literal);
          break;
        }
        if (TRANSPARENT.has(name) || !SECTION_LEVELS[name]) {
          for (const arg of node.args ?? []) emit(asNodes(arg.content), out, options);
        }
        break;
      }
      default:
        if (Array.isArray(node.content)) emit(node.content as Node[], out, options);
    }
  }
}

function findCaption(nodes: Node[]): string | undefined {
  for (const node of nodes) {
    if (node.type === 'macro' && node.content === 'caption') {
      return argText(node.args?.[node.args.length - 1]);
    }
    if (Array.isArray(node.content)) {
      const nested = findCaption(node.content as Node[]);
      if (nested) return nested;
    }
  }
  return undefined;
}

/** Flattens the document body so section macros at any nesting depth are seen in reading order. */
function flatten(nodes: Node[], into: Node[]): void {
  for (const node of nodes) {
    if (node.type === 'environment') {
      const name = envName(node);
      if (name === 'document') {
        flatten(asNodes(node.content), into);
        continue;
      }
    }
    into.push(node);
  }
}

class SectionBuilder {
  readonly sections: ParsedSection[] = [];
  private readonly counters = [0, 0, 0];
  private open: { path: string; title: string; level: number; charStart: number } | undefined;
  private ordinal = 0;

  constructor(private readonly cursor: () => number) {}

  start(title: string, level: number, numbered: boolean): void {
    this.close();
    let path = title;
    if (numbered) {
      this.counters[level - 1] = (this.counters[level - 1] ?? 0) + 1;
      for (let i = level; i < this.counters.length; i += 1) this.counters[i] = 0;
      path = `${this.counters.slice(0, level).join('.')} ${title}`;
    }
    this.open = { path, title, level, charStart: this.cursor() };
  }

  /** Front matter (abstract) — outside the numbering scheme. */
  startUnnumbered(title: string): void {
    this.start(title, 1, false);
  }

  close(): void {
    if (!this.open) return;
    const charEnd = this.cursor();
    if (charEnd > this.open.charStart) {
      this.sections.push({ ...this.open, ordinal: this.ordinal++, charEnd });
    }
    this.open = undefined;
  }
}

export function parseLatex(source: string): ParsedDocument {
  const ast = getParser().parse(source);

  const body: Node[] = [];
  flatten(asNodes((ast as unknown as Node).content), body);

  const chunks: string[] = [];
  // Length of the text emitted so far, which is where the next section will begin.
  const cursor = () => collapseWhitespace(chunks.join('')).length;
  const builder = new SectionBuilder(cursor);

  for (const node of body) {
    if (node.type === 'environment' && envName(node) === 'abstract') {
      builder.startUnnumbered('Abstract');
      const inner: string[] = [];
      emit(asNodes(node.content), inner, { inTabular: false });
      chunks.push(`\n\n${inner.join('')}\n\n`);
      continue;
    }

    if (node.type === 'macro') {
      const name = typeof node.content === 'string' ? node.content : '';
      const level = SECTION_LEVELS[name];
      if (level) {
        const args = node.args ?? [];
        // A starred heading carries a `*` argument and is unnumbered.
        const starred = args.some((a) => argText(a) === '*');
        const title = argText(args[args.length - 1]);
        chunks.push('\n\n');
        builder.start(title, level, !starred);
        chunks.push(`${title}\n\n`);
        continue;
      }
    }

    const inner: string[] = [];
    emit([node], inner, { inTabular: false });
    chunks.push(inner.join(''));
  }

  builder.close();

  return {
    text: collapseWhitespace(chunks.join('')),
    sections: builder.sections,
    parserVersion: PARSER_VERSION,
  };
}
