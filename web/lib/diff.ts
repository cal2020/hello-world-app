// Minimal unified-diff parser for display. Input is git's own output; nothing
// is executed or rendered as HTML.

export interface DiffLine {
  kind: 'add' | 'del' | 'ctx' | 'meta';
  text: string;
  oldNo: number | null;
  newNo: number | null;
}

export interface DiffHunk {
  header: string;
  lines: DiffLine[];
}

export interface DiffFile {
  oldPath: string | null;
  newPath: string | null;
  status: 'added' | 'deleted' | 'modified' | 'renamed' | 'binary';
  hunks: DiffHunk[];
  additions: number;
  deletions: number;
}

const HUNK = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@(.*)$/;

const stripPrefix = (p: string) => (p === '/dev/null' ? null : p.replace(/^[ab]\//, ''));

export function parseDiff(text: string): DiffFile[] {
  const files: DiffFile[] = [];
  let file: DiffFile | null = null;
  let hunk: DiffHunk | null = null;
  let oldNo = 0;
  let newNo = 0;
  for (const line of text.split('\n')) {
    if (line.startsWith('diff --git ')) {
      const m = /^diff --git a\/(.+) b\/(.+)$/.exec(line);
      file = { oldPath: m?.[1] ?? null, newPath: m?.[2] ?? null, status: 'modified', hunks: [], additions: 0, deletions: 0 };
      files.push(file);
      hunk = null;
      continue;
    }
    if (!file) continue;
    if (!hunk) {
      if (line.startsWith('new file mode')) file.status = 'added';
      else if (line.startsWith('deleted file mode')) file.status = 'deleted';
      else if (line.startsWith('rename from ')) file.status = 'renamed';
      else if (line.startsWith('Binary files')) file.status = 'binary';
      else if (line.startsWith('--- ')) file.oldPath = stripPrefix(line.slice(4));
      else if (line.startsWith('+++ ')) file.newPath = stripPrefix(line.slice(4));
    }
    const h = HUNK.exec(line);
    if (h) {
      oldNo = parseInt(h[1]!, 10);
      newNo = parseInt(h[2]!, 10);
      hunk = { header: line, lines: [] };
      file.hunks.push(hunk);
      continue;
    }
    if (!hunk) continue;
    if (line.startsWith('+')) {
      hunk.lines.push({ kind: 'add', text: line.slice(1), oldNo: null, newNo: newNo++ });
      file.additions++;
    } else if (line.startsWith('-')) {
      hunk.lines.push({ kind: 'del', text: line.slice(1), oldNo: oldNo++, newNo: null });
      file.deletions++;
    } else if (line.startsWith(' ')) {
      hunk.lines.push({ kind: 'ctx', text: line.slice(1), oldNo: oldNo++, newNo: newNo++ });
    } else if (line.startsWith('\\')) {
      hunk.lines.push({ kind: 'meta', text: line, oldNo: null, newNo: null });
    }
  }
  return files;
}

export const displayPath = (f: DiffFile) => f.newPath ?? f.oldPath ?? '(unknown)';
