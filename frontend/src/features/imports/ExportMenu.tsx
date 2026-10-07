import { Download, FileCode2, FileText } from 'lucide-react'

import { Button } from '../../components/ui/button'
import { DropdownContent, DropdownItem, DropdownLabel, DropdownMenu, DropdownTrigger } from '../../components/ui/dropdown'

export function ExportMenu({ onExport, label = 'Export report' }: { onExport: (format: 'html' | 'json') => void; label?: string }) {
  return (
    <DropdownMenu>
      <DropdownTrigger asChild>
        <Button size="sm" aria-label={label}>
          <Download /> <span className="hidden sm:inline">{label}</span>
        </Button>
      </DropdownTrigger>
      <DropdownContent>
        <DropdownLabel>Portable report</DropdownLabel>
        <DropdownItem onSelect={() => onExport('html')}>
          <FileText />
          <span className="flex flex-col">
            <span>HTML report</span>
            <span className="text-xs text-ink-3">Self-contained, readable, printable</span>
          </span>
        </DropdownItem>
        <DropdownItem onSelect={() => onExport('json')}>
          <FileCode2 />
          <span className="flex flex-col">
            <span>JSON report</span>
            <span className="text-xs text-ink-3">Versioned, machine-readable</span>
          </span>
        </DropdownItem>
      </DropdownContent>
    </DropdownMenu>
  )
}
