import { GitBranchPlus } from 'lucide-react';
import { useState } from 'react';
import { api } from '../lib/api';
import { useWorkbench } from '../lib/workbench';
import { Dialog } from './ui/dialog';
import { Button, cx, Field, inputClass } from './ui/primitives';

const OWNER = /^[A-Za-z0-9][A-Za-z0-9 ._-]{0,39}$/;

export function NewTaskDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (o: boolean) => void }) {
  const { repoId, run, select, state } = useWorkbench();
  const [title, setTitle] = useState('');
  const [owner, setOwner] = useState(() => {
    try {
      return localStorage.getItem('switchyard.owner') ?? '';
    } catch {
      return '';
    }
  });
  const [notes, setNotes] = useState('');
  const [touched, setTouched] = useState(false);
  const [busy, setBusy] = useState(false);
  const titleError = touched && !title.trim() ? 'Give the task a short title.' : null;
  const ownerError = touched && !OWNER.test(owner.trim()) ? 'Start with a letter or digit; letters, digits, spaces, “.”, “_”, “-” (40 max).' : null;

  const submit = async () => {
    setTouched(true);
    if (!title.trim() || !OWNER.test(owner.trim())) return;
    setBusy(true);
    const t = await run('New task', () => api.createTask(repoId!, { title: title.trim(), owner: owner.trim(), notes: notes.trim() }), {
      success: () => 'Workspace opened. Its path is in the inspector.',
    });
    setBusy(false);
    if (t) {
      try {
        localStorage.setItem('switchyard.owner', owner.trim());
      } catch {
        /* not remembered */
      }
      setTitle('');
      setNotes('');
      setTouched(false);
      onOpenChange(false);
      select(t.id);
    }
  };

  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      icon={<GitBranchPlus className="size-4.5 text-[var(--brand)]" />}
      title="New task"
      description={
        <>
          Zit opens an isolated workspace from current (<span className="font-mono">{state?.current?.id.slice(0, 8)}</span>). The owner is recorded as the change’s author.
        </>
      }
      footer={
        <>
          <Button variant="ghost" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button variant="primary" loading={busy} onClick={() => void submit()}>
            Open workspace
          </Button>
        </>
      }
    >
      <form
        className="space-y-4"
        onSubmit={(e) => {
          e.preventDefault();
          void submit();
        }}
      >
        <Field id="task-title" label="Task" error={titleError} hint="Becomes the change’s intent in Zit.">
          <input id="task-title" autoFocus className={inputClass} value={title} maxLength={200} onChange={(e) => setTitle(e.target.value)} placeholder="Add rate limiting to the export endpoint" aria-invalid={!!titleError} />
        </Field>
        <Field id="task-owner" label="Owner" error={ownerError} hint="A person or agent, e.g. “maria” or “claude”.">
          <input id="task-owner" className={inputClass} value={owner} maxLength={40} onChange={(e) => setOwner(e.target.value)} placeholder="maria" aria-invalid={!!ownerError} autoComplete="off" />
        </Field>
        <Field id="task-notes-new" label="Notes (optional)" hint="Kept by Switchyard only.">
          <textarea id="task-notes-new" className={cx(inputClass, 'min-h-[72px] resize-y')} maxLength={4000} value={notes} onChange={(e) => setNotes(e.target.value)} />
        </Field>
        <button type="submit" className="hidden" />
      </form>
    </Dialog>
  );
}
