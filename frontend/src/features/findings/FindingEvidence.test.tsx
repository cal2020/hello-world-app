import { render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'

import type { SignatureEvidence } from '../../api/types'
import { FindingEvidence } from './FindingEvidence'

const evidence: SignatureEvidence = {
  kind: 'usage_signature_match',
  scope: 'run',
  signature: [
    { field: 'resource.name', value: 'claude-sonnet-4-5' },
    { field: 'usage.llm.input_tokens', value: 1800 },
    { field: 'usage.llm.reasoning_tokens', value: null },
  ],
  reference_record_id: 'rec-0001-reference',
  reference_call_id: 'call_ref',
  members: [
    { record_id: 'rec-0001-reference', run_id: 'run-1', role: 'reference', call_id: 'call_ref' },
    { record_id: 'rec-0002-candidate', run_id: 'run-1', role: 'candidate', call_id: 'call_two' },
  ],
  run_ids: ['run-1'],
  not_compared: ['Prompt and response content: AUDR records do not contain it.'],
  statement: 'Equal usage counters are consistent with repeated work, but they cannot show what each call processed.',
  proof: false,
}

describe('FindingEvidence', () => {
  it('shows the shared signature with absent counters as not reported', () => {
    render(<FindingEvidence evidence={evidence} status="derived" onSelectCall={vi.fn()} />)
    const table = screen.getByRole('table')
    expect(within(table).getByText('claude-sonnet-4-5')).toBeInTheDocument()
    expect(within(table).getByText('1,800')).toBeInTheDocument()
    expect(within(table).getByText('not reported')).toBeInTheDocument()
  })

  it('states that matching counters are not proof', () => {
    render(<FindingEvidence evidence={evidence} status="derived" onSelectCall={vi.fn()} />)
    expect(screen.getByText('Matching counters are not proof')).toBeInTheDocument()
    expect(screen.getByText(/Not compared: Prompt and response content/)).toBeInTheDocument()
    expect(document.body.textContent).not.toMatch(/identical prompts?|same prompts?/i)
  })

  it('opens the reference and candidate calls', async () => {
    const onSelect = vi.fn()
    render(<FindingEvidence evidence={evidence} status="derived" onSelectCall={onSelect} />)
    await userEvent.click(screen.getByRole('button', { name: /Reference/ }))
    expect(onSelect).toHaveBeenCalledWith('call_ref')
  })

  it('withholds evidence that could not be re-derived', () => {
    render(<FindingEvidence evidence={{ kind: 'unavailable' }} status="unavailable" onSelectCall={vi.fn()} />)
    expect(screen.getByText('Evidence unavailable')).toBeInTheDocument()
  })
})
