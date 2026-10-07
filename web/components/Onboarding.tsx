import { useQueryClient } from '@tanstack/react-query';
import { FolderGit2, GitBranchPlus, Lock, PackageCheck, PlayCircle, Plus, ShieldCheck, Split, Wrench } from 'lucide-react';
import { useState } from 'react';
import { api } from '../lib/api';
import { useWorkbench } from '../lib/workbench';
import { Logo } from './Logo';
import { Dialog } from './ui/dialog';
import { Button, Callout, CopyButton, cx, Field, inputClass } from './ui/primitives';

export function RegisterRepoDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (o: boolean) => void }) {
  const { setRepoId } = useWorkbench();
  const qc = useQueryClient();
  const [path, setPath] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const submit = async () => {
    setBusy(true);
    setError(null);
    try {
      const repo = await api.register(path);
      await qc.invalidateQueries({ queryKey: ['repos'] });
      setRepoId(repo.id);
      setPath('');
      onOpenChange(false);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not register that repository.');
    } finally {
      setBusy(false);
    }
  };
  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      icon={<FolderGit2 className="size-4.5 text-[var(--brand)]" />}
      title="Register a repository"
      description="Switchyard only reads and acts on repositories you register here. Registering changes nothing on disk."
      footer={
        <>
          <Button variant="ghost" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button variant="primary" loading={busy} disabled={!path.trim()} onClick={() => void submit()}>
            Register
          </Button>
        </>
      }
    >
      <form
        onSubmit={(e) => {
          e.preventDefault();
          void submit();
        }}
      >
        <Field id="repo-path" label="Absolute path" error={error} hint="The repository’s working tree, e.g. /home/you/code/shop. Use a disposable clone while you try things out.">
          <input
            id="repo-path"
            autoFocus
            className={cx(inputClass, 'font-mono text-[13px]')}
            value={path}
            onChange={(e) => setPath(e.target.value)}
            placeholder="/home/you/code/project"
            aria-invalid={!!error}
            aria-describedby={error ? 'repo-path-error' : 'repo-path-hint'}
            spellCheck={false}
            autoComplete="off"
          />
        </Field>
      </form>
    </Dialog>
  );
}

const STEPS = [
  { icon: GitBranchPlus, title: 'Open a workspace per task', body: 'Zit gives each task a disposable copy of the repository. Work there with any editor or agent.' },
  { icon: Lock, title: 'Claim and watch overlaps', body: 'Claim files or functions before editing; see where tasks touch the same code.' },
  { icon: ShieldCheck, title: 'Review with evidence', body: 'Diffs, the author’s reason, and check results from approved commands only.' },
  { icon: PackageCheck, title: 'Accept one at a time', body: 'Zit composes, re-checks and lands each change atomically. Rejections keep the change.' },
];

export function Welcome({ onRegister }: { onRegister: () => void }) {
  return (
    <div className="mx-auto max-w-5xl px-4 py-10 sm:py-16">
      <div className="text-center">
        <div className="mb-6 inline-flex">
          <Logo size={56} />
        </div>
        <h1 className="text-3xl font-semibold tracking-tight text-balance sm:text-5xl">
          Many sessions. <span className="brand-text">One mainline.</span>
        </h1>
        <p className="mx-auto mt-4 max-w-2xl text-[15px] leading-relaxed text-pretty text-dim sm:text-base">
          Switchyard supervises parallel coding sessions in one repository — who owns what, where work overlaps, which checks passed — and lands each change through the{' '}
          <a className="text-ink underline decoration-line-strong underline-offset-4 hover:decoration-[var(--brand)]" href="https://getzit.org/" target="_blank" rel="noreferrer">
            Zit
          </a>{' '}
          engine.
        </p>
      </div>
      <div className="mt-10 grid gap-4 md:grid-cols-2">
        <div className="rounded-2xl border border-line bg-panel p-5">
          <div className="mb-3 flex items-center gap-2">
            <FolderGit2 className="size-5 text-[var(--brand)]" />
            <h2 className="font-semibold">Use your repository</h2>
          </div>
          <p className="mb-4 text-sm text-dim">Register a local git repository. You will be asked before Zit starts tracking it, and before any command runs.</p>
          <Button variant="primary" icon={<Plus className="size-4" />} onClick={onRegister}>
            Register a repository
          </Button>
        </div>
        <div className="rounded-2xl border border-line bg-panel p-5">
          <div className="mb-3 flex items-center gap-2">
            <PlayCircle className="size-5 text-emerald-500" />
            <h2 className="font-semibold">Try the scripted demo</h2>
          </div>
          <p className="mb-3 text-sm text-dim">Creates a disposable repository with four synthetic tasks, an overlap and a failing check. No credentials needed.</p>
          <div className="flex items-center gap-2 rounded-lg bg-panel-2 px-3 py-2 font-mono text-[13px] ring-1 ring-line">
            <span className="text-faint">$</span> npm run demo
            <span className="ml-auto">
              <CopyButton text="npm run demo" />
            </span>
          </div>
          <p className="mt-2 text-xs text-faint">
            Then pick <span className="font-mono">acme-shop</span> from the repository menu. <span className="font-mono">npm run demo:reset</span> removes it.
          </p>
        </div>
      </div>
      <ol className="mt-10 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        {STEPS.map((s, i) => (
          <li key={s.title} className="rounded-2xl border border-line bg-panel/60 p-4">
            <div className="mb-3 flex items-center gap-2">
              <span className="flex size-7 items-center justify-center rounded-lg bg-panel-2 text-xs font-semibold text-dim ring-1 ring-line">{i + 1}</span>
              <s.icon className="size-4 text-dim" aria-hidden />
            </div>
            <h3 className="text-sm font-semibold">{s.title}</h3>
            <p className="mt-1 text-[13px] leading-relaxed text-dim">{s.body}</p>
          </li>
        ))}
      </ol>
    </div>
  );
}

export function EngineMissing({ problem }: { problem: string }) {
  return (
    <div className="mx-auto max-w-xl px-4 py-20">
      <div className="rounded-2xl border border-line bg-panel p-6">
        <div className="mb-3 flex items-center gap-2">
          <Wrench className="size-5 text-amber-500" />
          <h1 className="text-lg font-semibold">Zit is needed</h1>
        </div>
        <p className="text-sm leading-relaxed text-dim">{problem}</p>
        <div className="mt-4 flex items-center gap-2 rounded-lg bg-panel-2 px-3 py-2 font-mono text-[13px] ring-1 ring-line">
          <span className="text-faint">$</span> npm run setup:zit
          <span className="ml-auto">
            <CopyButton text="npm run setup:zit" />
          </span>
        </div>
        <p className="mt-3 text-xs text-faint">Builds Zit 0.1.1 from crates.io into .tools/ (needs Rust 1.88+). Restart Switchyard afterwards.</p>
      </div>
    </div>
  );
}

export function NotInitialised() {
  const { state, repoId, run } = useWorkbench();
  const [busy, setBusy] = useState(false);
  return (
    <div className="mx-auto max-w-xl py-12">
      <div className="rounded-2xl border border-line bg-panel p-6">
        <div className="mb-3 flex items-center gap-2">
          <Split className="size-5 text-[var(--brand)]" />
          <h2 className="text-lg font-semibold">Zit is not tracking {state?.repo.name} yet</h2>
        </div>
        <p className="text-sm leading-relaxed text-dim">
          Initialising creates the ref <code className="font-mono text-ink">refs/zit/current</code> at your current <code className="font-mono text-ink">HEAD</code>. Your branches, history and remotes stay plain git; nothing else is written.
        </p>
        <Callout tone="info">
          <span className="font-mono text-[12px] break-all">{state?.repo.path}</span>
        </Callout>
        <div className="mt-4">
          <Button
            variant="primary"
            loading={busy}
            onClick={async () => {
              setBusy(true);
              await run('Initialise Zit', () => api.init(repoId!), { success: () => 'Zit now tracks this repository.' });
              setBusy(false);
            }}
          >
            Initialise Zit
          </Button>
        </div>
      </div>
    </div>
  );
}
