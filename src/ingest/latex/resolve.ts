/**
 * Turns a bundle of `.tex` files into one LaTeX string.
 *
 * arXiv submissions are frequently split across many files with `\input`/`\include`, and the
 * section structure only makes sense once they are stitched back together in order.
 */

const MAX_INCLUDE_DEPTH = 12;

/** Strips comments so a commented-out `\input` is not followed. */
function stripComments(tex: string): string {
  // A backslash-escaped percent is a literal, not a comment.
  return tex.replace(/(^|[^\\])%.*$/gm, '$1');
}

/** Resolves `\input{foo}` against the tarball's file list, trying the usual extension variants. */
function lookup(files: Map<string, string>, target: string): string | undefined {
  const cleaned = target.trim().replace(/^\.\//, '');
  const candidates = [cleaned, `${cleaned}.tex`, `${cleaned}.TEX`];
  for (const candidate of candidates) {
    const direct = files.get(candidate);
    if (direct !== undefined) return direct;
    // Tarballs often nest everything under a directory prefix.
    for (const [name, content] of files) {
      if (name === candidate || name.endsWith(`/${candidate}`)) return content;
    }
  }
  return undefined;
}

export function expandIncludes(tex: string, files: Map<string, string>, depth = 0): string {
  if (depth >= MAX_INCLUDE_DEPTH) return tex;
  return stripComments(tex).replace(
    /\\(?:input|include)\s*\{([^}]*)\}/g,
    (match, target: string) => {
      const content = lookup(files, target);
      return content === undefined ? '' : `\n${expandIncludes(content, files, depth + 1)}\n`;
    },
  );
}

/**
 * Picks the root file. A submission may contain many `.tex` files — style fragments, per-section
 * pieces, leftover drafts — but only one has a document body.
 */
export function findMainTex(files: Map<string, string>): { name: string; content: string } {
  const texFiles = [...files].filter(([name]) => /\.tex$/i.test(name));
  if (texFiles.length === 0) throw new Error('E-print bundle contains no .tex file');

  const scored = texFiles
    .map(([name, content]) => {
      let score = 0;
      if (/\\begin\s*\{document\}/.test(content)) score += 100;
      if (/\\documentclass/.test(content)) score += 50;
      // Prefer a root file over a fragment it includes.
      if (/\\(?:input|include)\s*\{/.test(content)) score += 10;
      if (/^(?:.*\/)?(main|ms|paper|arxiv|root)\.tex$/i.test(name)) score += 5;
      // Shallower paths are likelier to be the root.
      score -= (name.match(/\//g)?.length ?? 0);
      return { name, content, score };
    })
    .sort((a, b) => b.score - a.score);

  const best = scored[0]!;
  if (best.score < 100) {
    throw new Error('No .tex file contains \\begin{document}; cannot identify the main file');
  }
  return { name: best.name, content: best.content };
}
