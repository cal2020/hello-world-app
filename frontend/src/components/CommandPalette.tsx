import { Command } from 'cmdk'
import { FileJson, GitCompareArrows, Monitor, Moon, Search, Sparkles, Sun, Upload } from 'lucide-react'
import type { ReactNode } from 'react'

import type { FindingSummary, ImportSummary } from '../api/types'
import { categoryMeta } from '../lib/categories'
import { formatSpend } from '../lib/format'
import type { ThemeChoice } from '../lib/theme'

function Item({ value, onSelect, children, keywords }: { value: string; onSelect: () => void; children: ReactNode; keywords?: string[] }) {
  return (
    <Command.Item
      value={value}
      keywords={keywords}
      onSelect={onSelect}
      className="flex cursor-default items-center gap-3 rounded-lg px-3 py-2 text-[13px] text-ink outline-none select-none data-[selected=true]:bg-hover [&_svg]:size-4 [&_svg]:shrink-0 [&_svg]:text-ink-3"
    >
      {children}
    </Command.Item>
  )
}

const groupClass =
  'px-1.5 pb-1 [&_[cmdk-group-heading]]:px-3 [&_[cmdk-group-heading]]:pt-2.5 [&_[cmdk-group-heading]]:pb-1 [&_[cmdk-group-heading]]:text-[11px] [&_[cmdk-group-heading]]:font-semibold [&_[cmdk-group-heading]]:tracking-[0.08em] [&_[cmdk-group-heading]]:text-ink-3 [&_[cmdk-group-heading]]:uppercase'

export function CommandPalette({
  open,
  onOpenChange,
  imports,
  findings,
  onSelectRun,
  onSelectImport,
  onSelectFinding,
  onImport,
  onLoadDemo,
  onCompare,
  onTheme,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  imports: ImportSummary[]
  findings: FindingSummary[]
  onSelectRun: (id: string) => void
  onSelectImport: (id: string) => void
  onSelectFinding: (id: string) => void
  onImport: () => void
  onLoadDemo: () => void
  onCompare: () => void
  onTheme: (choice: ThemeChoice) => void
}) {
  const run = (fn: () => void) => () => {
    onOpenChange(false)
    fn()
  }
  return (
    <Command.Dialog
      open={open}
      onOpenChange={onOpenChange}
      label="Command palette"
      overlayClassName="fixed inset-0 z-40 bg-black/45 backdrop-blur-[2px] animate-fade-in"
      contentClassName="fixed top-[12vh] left-1/2 z-50 w-[calc(100vw-24px)] max-w-xl -translate-x-1/2 animate-pop-in overflow-hidden rounded-2xl border border-line bg-surface shadow-pop"
    >
      <div className="flex items-center gap-2.5 border-b border-line px-4">
        <Search className="size-4 shrink-0 text-ink-3" />
        <Command.Input
          placeholder="Search runs, findings and actions…"
          className="h-12 w-full bg-transparent text-[15px] text-ink outline-none placeholder:text-ink-3"
        />
      </div>
      <Command.List className="max-h-[min(60vh,440px)] overflow-y-auto py-1.5 scrollbar-thin">
        <Command.Empty className="px-4 py-8 text-center text-[13px] text-ink-3">No matches.</Command.Empty>
        <Command.Group heading="Actions" className={groupClass}>
          <Item value="Import an AUDR file or Claude Code transcripts" onSelect={run(onImport)}>
            <Upload /> Import an AUDR file or Claude Code transcripts…
          </Item>
          <Item value="Load the synthetic demo runs" onSelect={run(onLoadDemo)}>
            <Sparkles /> Load the synthetic demo runs
          </Item>
          <Item value="Compare two runs" onSelect={run(onCompare)}>
            <GitCompareArrows /> Compare two runs
          </Item>
          <Item value="Theme: light" onSelect={run(() => onTheme('light'))}>
            <Sun /> Theme: light
          </Item>
          <Item value="Theme: dark" onSelect={run(() => onTheme('dark'))}>
            <Moon /> Theme: dark
          </Item>
          <Item value="Theme: system" onSelect={run(() => onTheme('system'))}>
            <Monitor /> Theme: follow the system
          </Item>
        </Command.Group>
        {findings.length > 0 && (
          <Command.Group heading="Findings in view" className={groupClass}>
            {findings.slice(0, 50).map((finding) => {
              const meta = categoryMeta(finding.category)
              return (
                <Item key={finding.id} value={`${finding.id} ${finding.category_label} ${finding.title}`} onSelect={run(() => onSelectFinding(finding.id))}>
                  <meta.icon />
                  <span className="min-w-0 flex-1 truncate">{finding.title}</span>
                  <span className="shrink-0 text-xs text-ink-3">{finding.category_label}</span>
                </Item>
              )
            })}
          </Command.Group>
        )}
        {imports.map((imp) => (
          <Command.Group key={imp.id} heading={imp.filename} className={groupClass}>
            <Item value={`${imp.id} import ${imp.filename}`} onSelect={run(() => onSelectImport(imp.id))}>
              <FileJson /> <span className="truncate">Import overview · {imp.filename}</span>
            </Item>
            {imp.runs.map((r) => (
              <Item key={r.id} value={`${r.id} ${r.display_name} ${r.run_id}`} keywords={[imp.filename]} onSelect={run(() => onSelectRun(r.id))}>
                <span aria-hidden className="size-1.5 shrink-0 rounded-full bg-model" />
                <span className="min-w-0 flex-1 truncate">{r.display_name}</span>
                <span className="shrink-0 text-xs text-ink-3 tabular">{formatSpend(r.spend)}</span>
              </Item>
            ))}
          </Command.Group>
        ))}
      </Command.List>
    </Command.Dialog>
  )
}
