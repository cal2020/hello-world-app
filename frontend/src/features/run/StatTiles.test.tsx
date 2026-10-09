import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'

import { TooltipProvider } from '../../components/ui/tooltip'
import { SpendTile } from './StatTiles'

function renderTile(spend: Parameters<typeof SpendTile>[0]['spend']) {
  return render(
    <TooltipProvider>
      <SpendTile spend={spend} />
    </TooltipProvider>,
  )
}

describe('SpendTile', () => {
  it('keeps unknown costs explicit', () => {
    renderTile({ by_currency: [{ currency: 'USD', amount: '0.01' }], known_calls: 3, unknown_calls: 1, total_calls: 4, complete: false, estimated_calls: 0, basis: 'reported' })
    expect(screen.getByText('$0.0100')).toBeInTheDocument()
    expect(screen.getByText(/1 call without a reported cost \(not counted as zero\)/)).toBeInTheDocument()
  })

  it('shows each currency on its own line', () => {
    renderTile({
      by_currency: [
        { currency: 'EUR', amount: '0.02' },
        { currency: 'USD', amount: '0.01' },
      ],
      known_calls: 2,
      unknown_calls: 0,
      total_calls: 2,
      complete: true,
      estimated_calls: 0,
      basis: 'reported',
    })
    expect(screen.getByText('€0.0200')).toBeInTheDocument()
    expect(screen.getByText('$0.0100')).toBeInTheDocument()
    expect(screen.getByText(/never converted or combined/)).toBeInTheDocument()
  })

  it('says Unknown, not $0, when nothing reports a cost', () => {
    renderTile({ by_currency: [], known_calls: 0, unknown_calls: 2, total_calls: 2, complete: false, estimated_calls: 0, basis: 'none' })
    expect(screen.getByText('Unknown')).toBeInTheDocument()
    expect(screen.queryByText(/\$0/)).not.toBeInTheDocument()
  })
})
