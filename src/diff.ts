// A small, pure, dependency-free line diff used to preview edit_file / write_file
// changes before they are approved. Not a full Myers diff — it trims the common
// prefix and suffix (cheap, O(n)) and runs an LCS diff on the middle, falling back
// to a block replace when the middle is too large to diff quadratically. Good
// enough for a readable confirmation preview, and it never hangs on big files.

export type DiffTag = " " | "+" | "-";

export interface DiffLine {
  tag: DiffTag;
  text: string;
}

// Cap on the LCS matrix size (rows * cols). Above this we fall back to a coarse
// block replace so the preview stays instant even on pathological inputs.
const LCS_CELL_CAP = 1_000_000;

function splitLines(text: string): string[] {
  // An empty string means "no lines" (e.g. a brand-new file), not [""].
  return text === "" ? [] : text.split("\n");
}

/** Diff two blocks of lines via LCS backtracking. Assumes both are small. */
function lcsDiff(a: string[], b: string[]): DiffLine[] {
  const n = a.length;
  const m = b.length;
  // dp[i][j] = LCS length of a[i:] and b[j:]
  const dp: number[][] = Array.from({ length: n + 1 }, () => new Array(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
    }
  }
  const out: DiffLine[] = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      out.push({ tag: " ", text: a[i] });
      i++;
      j++;
    } else if (dp[i + 1][j] >= dp[i][j + 1]) {
      out.push({ tag: "-", text: a[i] });
      i++;
    } else {
      out.push({ tag: "+", text: b[j] });
      j++;
    }
  }
  while (i < n) out.push({ tag: "-", text: a[i++] });
  while (j < m) out.push({ tag: "+", text: b[j++] });
  return out;
}

/** Coarse fallback: everything removed, then everything added. */
function blockReplace(a: string[], b: string[]): DiffLine[] {
  return [
    ...a.map((text): DiffLine => ({ tag: "-", text })),
    ...b.map((text): DiffLine => ({ tag: "+", text })),
  ];
}

export interface DiffOptions {
  /** Fold unchanged runs longer than 2*context around each change. */
  context?: number;
}

export function diffLines(oldText: string, newText: string, _opts?: DiffOptions): DiffLine[] {
  const a = splitLines(oldText);
  const b = splitLines(newText);

  const out: DiffLine[] = [];

  // Trim common prefix.
  let start = 0;
  while (start < a.length && start < b.length && a[start] === b[start]) {
    out.push({ tag: " ", text: a[start] });
    start++;
  }

  // Trim common suffix.
  let endA = a.length;
  let endB = b.length;
  while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) {
    endA--;
    endB--;
  }

  const midA = a.slice(start, endA);
  const midB = b.slice(start, endB);

  const middle =
    midA.length * midB.length > LCS_CELL_CAP ? blockReplace(midA, midB) : lcsDiff(midA, midB);
  out.push(...middle);

  // Append the trimmed common suffix as context.
  for (let k = endA; k < a.length; k++) out.push({ tag: " ", text: a[k] });

  return out;
}

export function diffStat(oldText: string, newText: string): { added: number; removed: number } {
  let added = 0;
  let removed = 0;
  for (const line of diffLines(oldText, newText)) {
    if (line.tag === "+") added++;
    else if (line.tag === "-") removed++;
  }
  return { added, removed };
}

/** Render a diff as text with +/-/space prefixes, folding long unchanged runs. */
export function formatDiff(oldText: string, newText: string, opts: DiffOptions = {}): string {
  const context = opts.context ?? 3;
  const lines = diffLines(oldText, newText);
  const rendered: string[] = [];

  let i = 0;
  while (i < lines.length) {
    if (lines[i].tag !== " ") {
      rendered.push(`${lines[i].tag}${lines[i].text}`);
      i++;
      continue;
    }
    // Collect a run of unchanged lines.
    let j = i;
    while (j < lines.length && lines[j].tag === " ") j++;
    const run = lines.slice(i, j);
    const atStart = i === 0;
    const atEnd = j === lines.length;

    if (run.length <= context * 2) {
      for (const l of run) rendered.push(` ${l.text}`);
    } else {
      // Keep `context` lines adjacent to changes, fold the middle.
      const head = atStart ? [] : run.slice(0, context);
      const tail = atEnd ? [] : run.slice(run.length - context);
      for (const l of head) rendered.push(` ${l.text}`);
      const folded = run.length - head.length - tail.length;
      if (folded > 0) rendered.push(`  … (${folded} unchanged lines)`);
      for (const l of tail) rendered.push(` ${l.text}`);
    }
    i = j;
  }

  return rendered.join("\n");
}
