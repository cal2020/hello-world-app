import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query'

import { api, jsonBody } from './client'
import type {
  ComparisonResult,
  DemoResult,
  Equivalence,
  Finding,
  ImportDetail,
  ImportSummary,
  Meta,
  RunDetail,
  SavedComparison,
} from './types'

export const keys = {
  meta: ['meta'] as const,
  imports: ['imports'] as const,
  import: (id: string) => ['import', id] as const,
  run: (id: string) => ['run', id] as const,
  finding: (id: string) => ['finding', id] as const,
  comparisons: ['comparisons'] as const,
  compare: (base: string, cand: string, eq: Equivalence) => ['compare', base, cand, eq] as const,
}

export function useMeta() {
  return useQuery({ queryKey: keys.meta, queryFn: () => api<Meta>('/api/meta'), staleTime: 30_000 })
}

export function useImports() {
  return useQuery({
    queryKey: keys.imports,
    queryFn: async () => (await api<{ imports: ImportSummary[] }>('/api/imports')).imports,
  })
}

export function useImportDetail(id: string | null) {
  return useQuery({
    queryKey: keys.import(id ?? ''),
    queryFn: () => api<ImportDetail>(`/api/imports/${encodeURIComponent(id ?? '')}`),
    enabled: Boolean(id),
    retry: (count, error) => !(error instanceof Error && 'status' in error && error.status === 404) && count < 2,
  })
}

export function useRunDetail(id: string | null) {
  return useQuery({
    queryKey: keys.run(id ?? ''),
    queryFn: () => api<RunDetail>(`/api/runs/${encodeURIComponent(id ?? '')}`),
    enabled: Boolean(id),
    retry: (count, error) => !(error instanceof Error && 'status' in error && error.status === 404) && count < 2,
  })
}

export function useFindingDetail(id: string | null) {
  return useQuery({
    queryKey: keys.finding(id ?? ''),
    queryFn: () => api<Finding>(`/api/findings/${encodeURIComponent(id ?? '')}`),
    enabled: Boolean(id),
    retry: (count, error) => !(error instanceof Error && 'status' in error && error.status === 404) && count < 2,
  })
}

export function useComparisons() {
  return useQuery({
    queryKey: keys.comparisons,
    queryFn: async () => (await api<{ comparisons: SavedComparison[] }>('/api/comparisons')).comparisons,
  })
}

export function useComparePreview(base: string | null, cand: string | null, eq: Equivalence | null) {
  return useQuery({
    queryKey: keys.compare(base ?? '', cand ?? '', eq ?? 'unsure'),
    queryFn: () => {
      const params = new URLSearchParams({ baseline: base ?? '', candidate: cand ?? '', equivalence: eq ?? '' })
      return api<ComparisonResult>(`/api/compare?${params.toString()}`)
    },
    enabled: Boolean(base && cand && eq && base !== cand),
    placeholderData: keepPreviousData,
  })
}

/** Every mutation changes counts shown in several places; local refetches are cheap. */
function useInvalidateAll() {
  const client = useQueryClient()
  return () => client.invalidateQueries()
}

export function useDismissFinding() {
  const invalidate = useInvalidateAll()
  return useMutation({
    mutationFn: ({ id, dismissed, note }: { id: string; dismissed: boolean; note?: string | null }) =>
      api<Finding>(`/api/findings/${encodeURIComponent(id)}`, {
        method: 'PATCH',
        ...jsonBody({ dismissed, note: note ?? null }),
      }),
    onSuccess: invalidate,
  })
}

export function useDeleteImport() {
  const invalidate = useInvalidateAll()
  return useMutation({
    mutationFn: (id: string) =>
      api<{ runs: number; calls: number; findings: number; comparisons: number }>(
        `/api/imports/${encodeURIComponent(id)}`,
        { method: 'DELETE' },
      ),
    onSuccess: invalidate,
  })
}

export function useDeleteRun() {
  const invalidate = useInvalidateAll()
  return useMutation({
    mutationFn: (id: string) =>
      api<{ deleted: 'run' | 'import'; import_id: string; calls?: number; comparisons?: number }>(
        `/api/runs/${encodeURIComponent(id)}`,
        { method: 'DELETE' },
      ),
    onSuccess: invalidate,
  })
}

export function useLoadDemo() {
  const invalidate = useInvalidateAll()
  return useMutation({
    mutationFn: () => api<DemoResult>('/api/demo', { method: 'POST' }),
    onSuccess: invalidate,
  })
}

export function useRemoveDemo() {
  const invalidate = useInvalidateAll()
  return useMutation({
    mutationFn: () => api<{ imports: number }>('/api/demo', { method: 'DELETE' }),
    onSuccess: invalidate,
  })
}

export function useSaveComparison() {
  const invalidate = useInvalidateAll()
  return useMutation({
    mutationFn: (body: { baseline_run_id: string; candidate_run_id: string; equivalence: Equivalence; note: string | null }) =>
      api<SavedComparison>('/api/comparisons', { method: 'POST', ...jsonBody(body) }),
    onSuccess: invalidate,
  })
}

export function useDeleteComparison() {
  const invalidate = useInvalidateAll()
  return useMutation({
    mutationFn: (id: string) => api<unknown>(`/api/comparisons/${encodeURIComponent(id)}`, { method: 'DELETE' }),
    onSuccess: invalidate,
  })
}
