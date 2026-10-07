import { PanelRightClose, ServerCrash } from 'lucide-react'
import { useCallback, useEffect, useMemo, useState, type ReactNode } from 'react'
import { Toaster, toast } from 'sonner'

import { ActionsContext, type AppActions } from './app-actions'
import { downloadFile, errorMessage } from './api/client'
import {
  useComparisons,
  useDeleteImport,
  useDeleteRun,
  useImportDetail,
  useImports,
  useLoadDemo,
  useMeta,
  useRunDetail,
} from './api/hooks'
import type { ImportSummary, RunSummary } from './api/types'
import { CommandPalette } from './components/CommandPalette'
import { Sidebar } from './components/layout/Sidebar'
import { TopBar } from './components/layout/TopBar'
import { Button } from './components/ui/button'
import { Callout } from './components/ui/callout'
import { ConfirmDialog, Sheet } from './components/ui/dialog'
import { Skeleton } from './components/ui/skeleton'
import { TooltipProvider } from './components/ui/tooltip'
import { CallInspector } from './features/calls/CallInspector'
import { CompareView } from './features/compare/CompareView'
import { FindingInspectorLoader } from './features/findings/FindingInspector'
import { Glossary } from './features/glossary/Glossary'
import { ImportDialog } from './features/imports/ImportDialog'
import { ImportOverview } from './features/imports/ImportOverview'
import { RunView } from './features/run/RunView'
import { Welcome } from './features/welcome/Welcome'
import { formatBytes, plural } from './lib/format'
import { useMediaQuery } from './lib/media'
import { useTheme } from './lib/theme'
import { useUrlState } from './lib/url-state'

type PendingDelete = { kind: 'import'; summary: ImportSummary } | { kind: 'run'; run: RunSummary } | null

function InspectorFrame({ title, onClose, children }: { title: string; onClose?: () => void; children: ReactNode }) {
  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex h-12 shrink-0 items-center justify-between px-5">
        <p className="text-[11px] font-semibold tracking-[0.08em] text-ink-3 uppercase">{title}</p>
        {onClose && (
          <Button variant="ghost" size="icon-sm" aria-label="Close inspector" onClick={onClose}>
            <PanelRightClose />
          </Button>
        )}
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto scrollbar-thin">{children}</div>
    </div>
  )
}

function CenterSkeleton() {
  return (
    <div className="mx-auto max-w-[1180px] space-y-5 px-4 py-6 sm:px-6" aria-busy="true" aria-label="Loading">
      <Skeleton className="h-8 w-72" />
      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        {[0, 1, 2, 3].map((i) => (
          <Skeleton key={i} className="h-[132px] rounded-2xl" />
        ))}
      </div>
      <Skeleton className="h-[320px] rounded-2xl" />
    </div>
  )
}

export function App() {
  const [url, navigate] = useUrlState()
  const theme = useTheme()
  const meta = useMeta()
  const imports = useImports()
  const comparisons = useComparisons()
  const loadDemo = useLoadDemo()
  const deleteImport = useDeleteImport()
  const deleteRun = useDeleteRun()
  const [importOpen, setImportOpenState] = useState(false)
  const [importSeq, setImportSeq] = useState(0)
  const setImportOpen = useCallback((open: boolean) => {
    if (open) setImportSeq((n) => n + 1)
    setImportOpenState(open)
  }, [])
  const [paletteOpen, setPaletteOpen] = useState(false)
  const [sidebarOpen, setSidebarOpen] = useState(false)
  const [pendingDelete, setPendingDelete] = useState<PendingDelete>(null)
  const wide = useMediaQuery('(min-width: 1280px)')
  const desktop = useMediaQuery('(min-width: 1024px)')

  const inspecting = url.view === 'inspect'
  const runQuery = useRunDetail(inspecting ? url.run : null)
  const importQuery = useImportDetail(inspecting && !url.run ? url.import : null)

  const findingsInView = useMemo(
    () => (url.run ? runQuery.data?.findings : importQuery.data?.findings) ?? [],
    [url.run, runQuery.data, importQuery.data],
  )
  const selectedFinding = url.finding ? (findingsInView.find((f) => f.id === url.finding) ?? null) : null
  const selectedCall = url.call ? (runQuery.data?.calls.find((c) => c.id === url.call) ?? null) : null
  const selectedImportId =
    url.import ?? runQuery.data?.run.import_id ?? imports.data?.find((i) => i.runs.some((r) => r.id === url.run))?.id ?? null

  // With data but no selection, open the newest import's first run.
  useEffect(() => {
    if (!inspecting || url.run || url.import || !imports.data) return
    const newest = imports.data[imports.data.length - 1]
    const first = newest?.runs[0]
    if (first) navigate({ run: first.id }, { replace: true })
  }, [imports.data, inspecting, url.run, url.import, navigate])

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k') {
        event.preventDefault()
        setPaletteOpen((open) => !open)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  const selectRun = useCallback(
    (id: string) => {
      navigate({ view: 'inspect', run: id, import: null, finding: null, call: null })
      setSidebarOpen(false)
    },
    [navigate],
  )
  const selectImport = useCallback(
    (id: string) => {
      navigate({ view: 'inspect', import: id, run: null, finding: null, call: null })
      setSidebarOpen(false)
    },
    [navigate],
  )
  const selectFinding = useCallback((id: string) => navigate({ finding: id, call: null }), [navigate])
  const selectCall = useCallback(
    (id: string, runPk?: string) => {
      if (runPk && runPk !== url.run) navigate({ view: 'inspect', run: runPk, import: null, call: id })
      else navigate({ call: id })
    },
    [navigate, url.run],
  )
  const clearSelection = useCallback(() => navigate({ finding: null, call: null }), [navigate])

  const doLoadDemo = useCallback(() => {
    loadDemo.mutate(undefined, {
      onSuccess: (result) => {
        toast.success(result.created.length ? 'Demo runs loaded' : 'Demo runs were already loaded', {
          description: 'Synthetic, documented data, labelled as such everywhere.',
        })
        const base = result.suggested_comparison.baseline_run_id
        if (base) navigate({ view: 'inspect', run: base, import: null, finding: null, call: null })
      },
      onError: (error) => toast.error(errorMessage(error)),
    })
  }, [loadDemo, navigate])

  const download = useCallback(async (path: string, fallback: string) => {
    const id = toast.loading('Preparing the report…')
    try {
      const { filename, size } = await downloadFile(path, fallback)
      toast.success(`Exported ${filename}`, { id, description: `${formatBytes(size)} · saved by your browser` })
    } catch (error) {
      toast.error(errorMessage(error), { id })
    }
  }, [])

  const actions: AppActions = useMemo(
    () => ({
      openImport: () => setImportOpen(true),
      loadDemo: doLoadDemo,
      exportImport: (importId, format) =>
        void download(`/api/imports/${encodeURIComponent(importId)}/report?format=${format}`, `cost-report.${format}`),
      exportComparison: (comparisonId, format) =>
        void download(`/api/comparisons/${encodeURIComponent(comparisonId)}/report?format=${format}`, `comparison-report.${format}`),
      requestDeleteImport: (summary) => setPendingDelete({ kind: 'import', summary }),
      requestDeleteRun: (run) => setPendingDelete({ kind: 'run', run }),
      compareFrom: (runId) => navigate({ view: 'compare', base: runId, cand: null, eq: null }),
    }),
    [doLoadDemo, download, navigate, setImportOpen],
  )

  const deleteImpact = useMemo(() => {
    if (!pendingDelete) return null
    const runIds = new Set(
      pendingDelete.kind === 'import' ? pendingDelete.summary.runs.map((r) => r.id) : [pendingDelete.run.id],
    )
    const affected = (comparisons.data ?? []).filter(
      (c) => runIds.has(c.result.baseline.id) || runIds.has(c.result.candidate.id),
    ).length
    return { runIds, comparisons: affected }
  }, [pendingDelete, comparisons.data])

  const confirmDelete = () => {
    if (!pendingDelete) return
    const leave = () => navigate({ run: null, import: null, finding: null, call: null }, { replace: true })
    if (pendingDelete.kind === 'import') {
      const { summary } = pendingDelete
      deleteImport.mutate(summary.id, {
        onSuccess: () => {
          toast.success(`Deleted ${summary.filename}`)
          if (selectedImportId === summary.id) leave()
          setPendingDelete(null)
        },
        onError: (error) => toast.error(errorMessage(error)),
      })
    } else {
      const { run } = pendingDelete
      deleteRun.mutate(run.id, {
        onSuccess: (result) => {
          toast.success(
            result.deleted === 'import' ? 'Run deleted, with its now-empty import' : 'Run deleted; the import was re-analyzed',
          )
          if (url.run === run.id) leave()
          setPendingDelete(null)
        },
        onError: (error) => toast.error(errorMessage(error)),
      })
    }
  }

  const hasImports = (imports.data?.length ?? 0) > 0
  let center: ReactNode
  if (url.view === 'compare') {
    center = <CompareView url={url} onChange={(patch) => navigate(patch, { replace: true })} />
  } else if (imports.isPending) {
    center = <CenterSkeleton />
  } else if (imports.isError) {
    center = (
      <div className="mx-auto max-w-xl px-6 py-16">
        <Callout
          tone="error"
          title="The local analysis service isn’t responding"
          action={
            <Button size="sm" onClick={() => void imports.refetch()}>
              <ServerCrash /> Retry
            </Button>
          }
        >
          {errorMessage(imports.error)}
        </Callout>
      </div>
    )
  } else if (!hasImports) {
    center = <Welcome meta={meta.data} onLoadDemo={doLoadDemo} onImport={() => setImportOpen(true)} demoLoading={loadDemo.isPending} />
  } else if (url.run) {
    center = (
      <RunView
        runId={url.run}
        meta={meta.data}
        selectedFinding={selectedFinding}
        selectedCallId={url.call}
        onSelectFinding={selectFinding}
        onSelectCall={(id) => selectCall(id)}
        onOpenImport={selectImport}
        onClearSelection={() => navigate({ run: null, import: null, finding: null, call: null })}
      />
    )
  } else if (url.import) {
    center = (
      <ImportOverview
        importId={url.import}
        meta={meta.data}
        selectedFinding={selectedFinding}
        onSelectFinding={selectFinding}
        onSelectRun={selectRun}
        onClearSelection={() => navigate({ run: null, import: null, finding: null, call: null })}
      />
    )
  } else {
    center = <CenterSkeleton />
  }

  const showInspector = inspecting && hasImports
  const hasSelection = Boolean(url.finding || url.call)
  // A finding loads by id, so it can be inspected even when it sits outside the open run.
  const loadingSelection = Boolean(url.call) && (runQuery.isPending || importQuery.isFetching) && !selectedCall
  let inspectorTitle = 'Guide'
  let inspectorBody: ReactNode = <Glossary meta={meta.data} />
  if (selectedCall) {
    inspectorTitle = 'Call details'
    inspectorBody = (
      <CallInspector
        key={selectedCall.id}
        call={selectedCall}
        runStartMs={runQuery.data?.timeline.start_ms ?? null}
        findings={findingsInView}
        onSelectFinding={selectFinding}
        onBack={url.finding ? () => navigate({ call: null }) : undefined}
      />
    )
  } else if (url.finding) {
    inspectorTitle = 'Evidence'
    inspectorBody = (
      <FindingInspectorLoader key={url.finding} findingId={url.finding} onSelectCall={selectCall} onSelectFinding={selectFinding} />
    )
  } else if (loadingSelection) {
    inspectorBody = (
      <div className="space-y-3 px-5">
        <Skeleton className="h-6 w-40" />
        <Skeleton className="h-40" />
      </div>
    )
  } else if (url.call) {
    inspectorBody = (
      <div className="px-5">
        <Callout tone="warn" title="Not in this view">
          The selected call isn’t part of what’s open now. It may have been deleted or re-analyzed.
        </Callout>
      </div>
    )
  }

  const sidebar = (
    <Sidebar
      imports={imports.data}
      loading={imports.isPending}
      error={imports.isError ? errorMessage(imports.error) : null}
      onRetry={() => void imports.refetch()}
      selectedImport={selectedImportId}
      selectedRun={inspecting ? url.run : null}
      onSelectImport={selectImport}
      onSelectRun={selectRun}
      onImport={() => setImportOpen(true)}
      onLoadDemo={doLoadDemo}
      demoLoading={loadDemo.isPending}
      demoLoaded={Boolean(meta.data?.demo.loaded || imports.data?.some((i) => i.source === 'demo'))}
      footer={meta.data ? `${meta.data.analyzer.name} ${meta.data.analyzer.version} · AUDR ${meta.data.audr_spec_version}` : undefined}
    />
  )

  return (
    <ActionsContext.Provider value={actions}>
      <TooltipProvider delayDuration={250}>
        <a
          href="#main"
          className="sr-only z-50 rounded-lg bg-accent px-3 py-2 text-on-accent focus:not-sr-only focus:fixed focus:top-2 focus:left-2"
        >
          Skip to main content
        </a>
        <div className="flex h-dvh flex-col">
          <TopBar
            view={url.view}
            onViewChange={(view) => navigate({ view })}
            onOpenPalette={() => setPaletteOpen(true)}
            onOpenImport={() => setImportOpen(true)}
            onOpenSidebar={() => setSidebarOpen(true)}
            theme={theme.choice}
            onThemeChange={theme.setChoice}
          />
          <div className="flex min-h-0 flex-1">
            <aside aria-label="Imports" className="hidden w-[288px] shrink-0 border-r border-line bg-surface/60 lg:block">
              {sidebar}
            </aside>
            <main id="main" tabIndex={-1} className="@container relative min-w-0 flex-1 overflow-y-auto scrollbar-thin focus:outline-none">
              {center}
            </main>
            {showInspector && wide && (
              <aside aria-label="Inspector" className="w-[400px] shrink-0 border-l border-line bg-surface">
                <InspectorFrame title={inspectorTitle} onClose={hasSelection ? clearSelection : undefined}>
                  {inspectorBody}
                </InspectorFrame>
              </aside>
            )}
          </div>
        </div>

        <Sheet side="left" open={sidebarOpen && !desktop} onOpenChange={setSidebarOpen} title="Imports and runs">
          {sidebar}
        </Sheet>
        <Sheet side="right" open={showInspector && !wide && hasSelection} onOpenChange={(open) => !open && clearSelection()} title={inspectorTitle}>
          <InspectorFrame title={inspectorTitle} onClose={clearSelection}>
            {inspectorBody}
          </InspectorFrame>
        </Sheet>

        <ImportDialog
          key={importSeq}
          open={importOpen}
          onOpenChange={setImportOpen}
          meta={meta.data}
          onImported={(detail) => {
            setImportOpen(false)
            toast.success(`Imported ${detail.filename}`, {
              description: `${plural(detail.accepted_count, 'record')} · ${plural(detail.runs.length, 'run')} · ${plural(detail.open_findings, 'open candidate')}`,
            })
            const first = detail.runs[0]
            if (first && detail.runs.length === 1) selectRun(first.id)
            else selectImport(detail.id)
          }}
          onOpenExisting={(id) => {
            setImportOpen(false)
            selectImport(id)
          }}
        />

        <CommandPalette
          open={paletteOpen}
          onOpenChange={setPaletteOpen}
          imports={[...(imports.data ?? [])].reverse()}
          findings={inspecting ? findingsInView : []}
          onSelectRun={selectRun}
          onSelectImport={selectImport}
          onSelectFinding={selectFinding}
          onImport={() => setImportOpen(true)}
          onLoadDemo={doLoadDemo}
          onCompare={() => navigate({ view: 'compare' })}
          onTheme={theme.setChoice}
        />

        <ConfirmDialog
          open={pendingDelete != null}
          onOpenChange={(open) => !open && setPendingDelete(null)}
          busy={deleteImport.isPending || deleteRun.isPending}
          confirmLabel={pendingDelete?.kind === 'run' ? 'Delete run' : 'Delete import'}
          onConfirm={confirmDelete}
          title={
            pendingDelete?.kind === 'import'
              ? `Delete “${pendingDelete.summary.filename}”?`
              : pendingDelete?.kind === 'run'
                ? `Delete the run “${pendingDelete.run.display_name}”?`
                : ''
          }
          description={
            pendingDelete?.kind === 'import'
              ? `This permanently removes ${plural(pendingDelete.summary.runs.length, 'run')}, ${plural(pendingDelete.summary.accepted_count, 'stored call')} and every finding and dismissal note from this machine. Your original file is not touched.`
              : pendingDelete?.kind === 'run'
                ? `This removes the run’s ${plural(pendingDelete.run.calls, 'call')}. The import’s other runs are re-analyzed, because some findings span runs; dismissals of unchanged findings are kept. If this is the import’s only run, the import is deleted too.`
                : ''
          }
        >
          {deleteImpact && deleteImpact.comparisons > 0 && (
            <Callout tone="warn">
              {plural(deleteImpact.comparisons, 'saved comparison')} using {pendingDelete?.kind === 'run' ? 'this run' : 'these runs'}{' '}
              will be deleted as well.
            </Callout>
          )}
        </ConfirmDialog>

        <Toaster
          theme={theme.resolved}
          position="bottom-right"
          closeButton
          toastOptions={{ classNames: { toast: 'font-sans !rounded-xl !border-line !shadow-pop', description: '!text-ink-2' } }}
        />
      </TooltipProvider>
    </ActionsContext.Provider>
  )
}
