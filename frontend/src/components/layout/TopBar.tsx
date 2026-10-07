import { GitCompareArrows, Menu, Monitor, Moon, ScanSearch, Search, Sun, Upload } from 'lucide-react'

import type { ThemeChoice } from '../../lib/theme'
import { Button } from '../ui/button'
import {
  DropdownContent,
  DropdownLabel,
  DropdownMenu,
  DropdownRadioGroup,
  DropdownRadioItem,
  DropdownTrigger,
} from '../ui/dropdown'
import { Kbd } from '../ui/kbd'
import { Segmented } from '../ui/segmented'
import { LogoMark } from './Logo'

export function TopBar({
  view,
  onViewChange,
  onOpenPalette,
  onOpenImport,
  onOpenSidebar,
  theme,
  onThemeChange,
}: {
  view: 'inspect' | 'compare'
  onViewChange: (view: 'inspect' | 'compare') => void
  onOpenPalette: () => void
  onOpenImport: () => void
  onOpenSidebar: () => void
  theme: ThemeChoice
  onThemeChange: (choice: ThemeChoice) => void
}) {
  const isMac = typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform)
  const ThemeIcon = theme === 'dark' ? Moon : theme === 'light' ? Sun : Monitor
  return (
    <header className="sticky top-0 z-30 border-b border-line bg-page/80 backdrop-blur-xl supports-[backdrop-filter]:bg-page/70">
      <div className="flex h-14 items-center gap-2 px-3 sm:gap-3 sm:px-4">
        <Button variant="ghost" size="icon" className="lg:hidden" aria-label="Open imports and runs" onClick={onOpenSidebar}>
          <Menu />
        </Button>
        <a href="/" className="flex items-center gap-2.5 rounded-lg pr-1" aria-label="AI Cost Inspector home">
          <LogoMark />
          <span className="hidden text-[15px] font-semibold tracking-[-0.015em] sm:inline">AI Cost Inspector</span>
        </a>
        <div className="mx-1 hidden h-5 w-px bg-line md:block" />
        <Segmented
          label="View"
          value={view}
          onChange={onViewChange}
          items={[
            { value: 'inspect', text: 'Inspect', label: <span className="hidden sm:inline">Inspect</span>, icon: <ScanSearch /> },
            { value: 'compare', text: 'Compare', label: <span className="hidden sm:inline">Compare</span>, icon: <GitCompareArrows /> },
          ]}
        />
        <div className="flex-1" />
        <button
          type="button"
          onClick={onOpenPalette}
          className="hidden h-9 w-64 items-center gap-2 rounded-xl border border-line bg-surface px-3 text-[13px] text-ink-3 transition-colors hover:border-line-strong hover:text-ink-2 md:flex"
        >
          <Search className="size-4" />
          <span className="flex-1 truncate text-left">Search runs and findings</span>
          <Kbd>{isMac ? '⌘' : 'Ctrl'}</Kbd>
          <Kbd>K</Kbd>
        </button>
        <Button variant="ghost" size="icon" className="md:hidden" aria-label="Search runs, findings and actions" onClick={onOpenPalette}>
          <Search />
        </Button>
        <DropdownMenu>
          <DropdownTrigger asChild>
            <Button variant="ghost" size="icon" aria-label={`Color theme: ${theme}`}>
              <ThemeIcon />
            </Button>
          </DropdownTrigger>
          <DropdownContent>
            <DropdownLabel>Theme</DropdownLabel>
            <DropdownRadioGroup value={theme} onValueChange={(value) => onThemeChange(value as ThemeChoice)}>
              <DropdownRadioItem value="system">
                <Monitor /> System
              </DropdownRadioItem>
              <DropdownRadioItem value="light">
                <Sun /> Light
              </DropdownRadioItem>
              <DropdownRadioItem value="dark">
                <Moon /> Dark
              </DropdownRadioItem>
            </DropdownRadioGroup>
          </DropdownContent>
        </DropdownMenu>
        <Button variant="primary" onClick={onOpenImport} aria-label="Import an AUDR file">
          <Upload />
          <span className="hidden sm:inline">Import</span>
        </Button>
      </div>
    </header>
  )
}
