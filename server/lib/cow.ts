// Does the file system under ZIT_HOME support the copy-on-write clones Zit
// builds workspaces from? Zit probes the same way (src/workspace.rs
// `copy_on_write`): clone one small file with FICLONE on Linux, clonefile on
// macOS. Node's COPYFILE_FICLONE_FORCE makes exactly those calls and fails
// rather than falling back to a copy.

import { constants } from 'node:fs';
import { copyFile, mkdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

export async function probeCopyOnWrite(zitHome: string, env: NodeJS.ProcessEnv = process.env): Promise<{ supported: boolean; detail: string }> {
  if (env.ZIT_MATERIALISE === 'checkout') {
    return { supported: false, detail: 'ZIT_MATERIALISE=checkout is set: Zit makes every workspace a plain checkout.' };
  }
  const dir = join(zitHome, `.switchyard-cow-probe-${process.pid}-${Date.now()}`);
  try {
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, 'a'), 'switchyard');
    await copyFile(join(dir, 'a'), join(dir, 'b'), constants.COPYFILE_FICLONE_FORCE);
    return { supported: true, detail: `Copy-on-write clones work in ${zitHome}: workspaces share unchanged files on disk.` };
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code ?? 'error';
    return {
      supported: false,
      detail: `No copy-on-write clones in ${zitHome} (${code}). Zit falls back to a plain checkout per workspace: correct, but each one uses full disk space. APFS, or btrfs/XFS with reflink, enable sharing.`,
    };
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}
