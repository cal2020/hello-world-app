/**
 * Checks every source link in src/content/sources.ts (URL and DOI) from a
 * machine with normal internet access.
 *
 *   npm run check:links            human-readable report
 *   npm run check:links -- --json  machine-readable report
 *
 * Exit code 1 when a link is definitely broken (404/410, DNS failure). Many
 * publishers answer automated requests with 401/403/429 or a bot challenge:
 * those are listed as "check manually" and do not fail the run.
 */
import { SOURCES } from '../src/content/sources';

type Outcome = 'ok' | 'redirect' | 'manual' | 'broken';

interface Result {
  id: string;
  url: string;
  status: number | null;
  outcome: Outcome;
  finalUrl?: string;
  error?: string;
  pending: boolean;
}

const USER_AGENT = 'Mozilla/5.0 (compatible; HumanCellAtlasLinkCheck/1.0; +https://github.com/)';
const TIMEOUT_MS = 20_000;
const CONCURRENCY = 6;

async function check(url: string): Promise<Pick<Result, 'status' | 'outcome' | 'finalUrl' | 'error'>> {
  const attempt = async (method: 'HEAD' | 'GET') => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
    try {
      return await fetch(url, { method, redirect: 'follow', signal: controller.signal, headers: { 'user-agent': USER_AGENT, accept: 'text/html,*/*' } });
    } finally {
      clearTimeout(timer);
    }
  };
  try {
    let response = await attempt('HEAD');
    if (response.status === 405 || response.status === 403 || response.status >= 500) response = await attempt('GET');
    const status = response.status;
    const finalUrl = response.url && response.url !== url ? response.url : undefined;
    if (status >= 200 && status < 300) return { status, outcome: finalUrl ? 'redirect' : 'ok', finalUrl };
    if (status === 404 || status === 410) return { status, outcome: 'broken', finalUrl };
    return { status, outcome: 'manual', finalUrl };
  } catch (error) {
    const message = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
    const dns = /ENOTFOUND|EAI_AGAIN/.test(String((error as { cause?: unknown })?.cause ?? message));
    return { status: null, outcome: dns ? 'broken' : 'manual', error: message };
  }
}

async function main(): Promise<void> {
  const json = process.argv.includes('--json');
  const targets: { id: string; url: string; pending: boolean }[] = [];
  for (const source of SOURCES) {
    const pending = source.status === 'pending';
    targets.push({ id: source.id, url: source.url, pending });
    if (source.doi && !source.url.includes(source.doi)) targets.push({ id: `${source.id} (doi)`, url: `https://doi.org/${source.doi}`, pending });
  }
  const results: Result[] = [];
  let next = 0;
  await Promise.all(
    Array.from({ length: CONCURRENCY }, async () => {
      while (next < targets.length) {
        const target = targets[next++];
        results.push({ ...target, ...(await check(target.url)) });
      }
    }),
  );
  results.sort((a, b) => a.id.localeCompare(b.id));
  if (json) {
    console.log(JSON.stringify(results, null, 2));
  } else {
    const label: Record<Outcome, string> = { ok: 'OK      ', redirect: 'REDIRECT', manual: 'MANUAL  ', broken: 'BROKEN  ' };
    for (const r of results) {
      console.log(`${label[r.outcome]} ${String(r.status ?? '---').padStart(3)}  ${r.id}${r.pending ? ' [pending verification]' : ''}\n         ${r.url}${r.finalUrl ? `\n      →  ${r.finalUrl}` : ''}${r.error ? `\n         ${r.error}` : ''}`);
    }
    const count = (o: Outcome) => results.filter((r) => r.outcome === o).length;
    console.log(`\n${results.length} links: ${count('ok')} ok, ${count('redirect')} redirected, ${count('manual')} to check manually, ${count('broken')} broken.`);
    console.log('Sources marked [pending verification] also need their supporting statement confirmed by a person (see docs/VERIFICATION.md).');
  }
  process.exitCode = results.some((r) => r.outcome === 'broken') ? 1 : 0;
}

void main();
