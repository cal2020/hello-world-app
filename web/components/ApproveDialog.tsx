import { ShieldCheck, Terminal } from 'lucide-react';
import { useState } from 'react';
import type { CommandInfo } from '../../shared/api';
import { api } from '../lib/api';
import { Dialog } from './ui/dialog';
import { Button, Callout } from './ui/primitives';

const KIND_LABEL: Record<CommandInfo['kind'], string> = {
  check: 'Check',
  prepare: 'Install step',
  derive: 'Generated file',
};

export function CommandList({ commands }: { commands: CommandInfo[] }) {
  return (
    <ul className="space-y-2.5">
      {commands.map((c) => (
        <li key={c.key} className="overflow-hidden rounded-xl border border-line bg-panel-2">
          <div className="flex flex-wrap items-center gap-2 border-b border-line px-3 py-2 text-xs">
            <Terminal className="size-3.5 text-dim" aria-hidden />
            <span className="font-medium">{KIND_LABEL[c.kind]}</span>
            <span className="font-mono text-dim">{c.name}</span>
            <span className="ml-auto text-faint">declared by {c.source === 'current' ? 'current’s' : 'the change’s'} zit.toml</span>
          </div>
          <pre className="scroll-thin overflow-x-auto px-3 py-2.5 font-mono text-[12.5px] leading-relaxed whitespace-pre-wrap break-all text-ink">{c.run}</pre>
        </li>
      ))}
    </ul>
  );
}

export function ApproveDialog({
  repoId,
  commands,
  changeId,
  label,
  onClose,
  onApproved,
}: {
  repoId: string;
  commands: CommandInfo[];
  changeId?: string;
  label: string;
  onClose: () => void;
  onApproved: () => Promise<void>;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  return (
    <Dialog
      open
      wide
      onOpenChange={(o) => !o && onClose()}
      icon={<ShieldCheck className="size-4.5 text-[var(--brand)]" />}
      title={`Approve commands before “${label}”`}
      description="Zit runs these exact shell commands from the repository’s zit.toml with sh -c, in an isolated workspace on this machine. Switchyard never builds commands from task text. Approval is remembered for this repository until a command’s text changes."
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button
            variant="primary"
            loading={busy}
            icon={<ShieldCheck className="size-4" />}
            onClick={async () => {
              setBusy(true);
              setError(null);
              try {
                await api.approve(
                  repoId,
                  commands.map((c) => c.key),
                  changeId,
                );
                await onApproved();
              } catch (e) {
                setError(e instanceof Error ? e.message : 'Could not save the approval.');
              } finally {
                setBusy(false);
              }
            }}
          >
            Approve {commands.length === 1 ? 'command' : `${commands.length} commands`} and continue
          </Button>
        </>
      }
    >
      <div className="space-y-3">
        <CommandList commands={commands} />
        {error && <Callout tone="danger">{error}</Callout>}
      </div>
    </Dialog>
  );
}
