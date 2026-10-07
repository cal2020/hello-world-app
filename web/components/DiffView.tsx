import { ChevronRight, FileMinus2, FilePlus2, FileText } from 'lucide-react';
import { useMemo, useState } from 'react';
import { displayPath, parseDiff, type DiffFile } from '../lib/diff';
import { cx } from './ui/primitives';

function FileDiff({ file, defaultOpen }: { file: DiffFile; defaultOpen: boolean }) {
  const [open, setOpen] = useState(defaultOpen);
  const Icon = file.status === 'added' ? FilePlus2 : file.status === 'deleted' ? FileMinus2 : FileText;
  return (
    <div className="overflow-hidden rounded-xl border border-line bg-panel">
      <button onClick={() => setOpen(!open)} aria-expanded={open} className="flex w-full items-center gap-2 bg-panel-2/60 px-3 py-2 text-left hover:bg-panel-2">
        <ChevronRight className={cx('size-4 shrink-0 text-faint transition-transform', open && 'rotate-90')} aria-hidden />
        <Icon className="size-4 shrink-0 text-dim" aria-hidden />
        <span className="min-w-0 flex-1 truncate font-mono text-[12.5px]">{displayPath(file)}</span>
        <span className="shrink-0 font-mono text-[11.5px] text-emerald-600 dark:text-emerald-400">+{file.additions}</span>
        <span className="shrink-0 font-mono text-[11.5px] text-rose-600 dark:text-rose-400">−{file.deletions}</span>
      </button>
      {open && (
        <div className="scroll-thin overflow-x-auto">
          {file.status === 'binary' && <div className="px-3 py-2 text-xs text-dim">Binary file — not shown.</div>}
          <table className="w-full border-collapse font-mono text-[12px] leading-[1.6]">
            <tbody>
              {file.hunks.map((h, hi) => [
                <tr key={`h${hi}`} className="bg-[color-mix(in_oklab,var(--brand)_7%,transparent)] text-dim">
                  <td colSpan={3} className="px-3 py-1 text-[11px]">
                    {h.header}
                  </td>
                </tr>,
                ...h.lines.map((l, li) => (
                  <tr
                    key={`${hi}-${li}`}
                    className={cx(l.kind === 'add' && 'bg-emerald-500/10', l.kind === 'del' && 'bg-rose-500/10', l.kind === 'meta' && 'text-faint italic')}
                  >
                    <td className="w-10 border-r border-line px-2 text-right text-faint tabular-nums select-none">{l.oldNo ?? ''}</td>
                    <td className="w-10 border-r border-line px-2 text-right text-faint tabular-nums select-none">{l.newNo ?? ''}</td>
                    <td className="px-3 whitespace-pre">
                      <span aria-hidden className={cx('mr-2 inline-block w-2 select-none', l.kind === 'add' ? 'text-emerald-600 dark:text-emerald-400' : l.kind === 'del' ? 'text-rose-600 dark:text-rose-400' : 'text-transparent')}>
                        {l.kind === 'add' ? '+' : l.kind === 'del' ? '−' : ' '}
                      </span>
                      <span className="sr-only">{l.kind === 'add' ? 'added: ' : l.kind === 'del' ? 'removed: ' : ''}</span>
                      {l.text}
                    </td>
                  </tr>
                )),
              ])}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

export function DiffView({ diff, truncated }: { diff: string; truncated: boolean }) {
  const files = useMemo(() => parseDiff(diff), [diff]);
  if (files.length === 0) return <p className="py-6 text-center text-sm text-dim">No textual changes.</p>;
  const adds = files.reduce((n, f) => n + f.additions, 0);
  const dels = files.reduce((n, f) => n + f.deletions, 0);
  return (
    <div className="space-y-2">
      <p className="text-xs text-dim">
        {files.length} {files.length === 1 ? 'file' : 'files'} · <span className="text-emerald-600 dark:text-emerald-400">+{adds}</span>{' '}
        <span className="text-rose-600 dark:text-rose-400">−{dels}</span>
        {truncated && <span className="text-amber-600 dark:text-amber-300"> · diff truncated at 200 KB</span>}
      </p>
      {files.map((f, i) => (
        <FileDiff key={`${displayPath(f)}-${i}`} file={f} defaultOpen={i < 6} />
      ))}
    </div>
  );
}
