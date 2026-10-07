import type {
  ApprovalRequired,
  ChangeInspect,
  CheckRun,
  CommandInfo,
  EngineInfo,
  Job,
  Repo,
  RepoState,
  Task,
  WorkspaceDiff,
} from '../../shared/api';
import type { Claimed, Recorded, Workspace } from '../../shared/engine-types';

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly data: Record<string, unknown>,
  ) {
    super(message);
  }
  get approval(): ApprovalRequired | null {
    return this.status === 428 ? (this.data as unknown as ApprovalRequired) : null;
  }
}

async function request<T>(method: string, path: string, body?: unknown): Promise<T> {
  let r: Response;
  try {
    r = await fetch(path, {
      method,
      headers: method === 'GET' ? {} : { 'content-type': 'application/json', 'x-switchyard': '1' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  } catch {
    throw new ApiError(0, 'offline', 'Switchyard’s server is not reachable. Is `npm run dev` or `npm start` running?', {});
  }
  const text = await r.text();
  let data: Record<string, unknown> = {};
  try {
    data = text ? JSON.parse(text) : {};
  } catch {
    if (!r.ok) throw new ApiError(r.status, 'bad-response', 'The server answered with something unexpected. Check that the API server is running.', {});
  }
  if (!r.ok) throw new ApiError(r.status, String(data.error ?? 'error'), String(data.message ?? `Request failed (${r.status})`), data);
  return data as T;
}

export type RepoStateWithJobs = RepoState & { jobs: Job[] };

export const api = {
  engine: (refresh = false) => request<EngineInfo>('GET', `/api/engine${refresh ? '?refresh=1' : ''}`),
  repos: () => request<Repo[]>('GET', '/api/repos'),
  register: (path: string) => request<Repo>('POST', '/api/repos', { path }),
  unregister: (repo: string) => request('DELETE', `/api/repos/${repo}`),
  init: (repo: string) => request('POST', `/api/repos/${repo}/init`, {}),
  state: (repo: string) => request<RepoStateWithJobs>('GET', `/api/repos/${repo}/state`),
  change: (repo: string, change: string) => request<ChangeInspect>('GET', `/api/repos/${repo}/changes/${change}`),
  workspaceDiff: (repo: string, ws: string) => request<WorkspaceDiff>('GET', `/api/repos/${repo}/workspaces/${ws}/diff`),
  createTask: (repo: string, t: { title: string; owner: string; notes: string }) => request<Task>('POST', `/api/repos/${repo}/tasks`, t),
  updateTask: (repo: string, task: string, patch: Partial<Pick<Task, 'title' | 'owner' | 'notes'>>) =>
    request<Task>('PATCH', `/api/repos/${repo}/tasks/${task}`, patch),
  claim: (repo: string, ws: string, resources: string[]) => request<Claimed>('POST', `/api/repos/${repo}/workspaces/${ws}/claim`, { resources }),
  record: (repo: string, ws: string, summary: string) => request<Recorded>('POST', `/api/repos/${repo}/workspaces/${ws}/record`, { summary }),
  dispose: (repo: string, ws: string, confirm: string) => request('POST', `/api/repos/${repo}/workspaces/${ws}/dispose`, { confirm }),
  check: (repo: string, change: string, rerun = false) => request<Job>('POST', `/api/repos/${repo}/changes/${change}/check`, { rerun }),
  accept: (repo: string, change: string, expectedCurrent: string) =>
    request<Job>('POST', `/api/repos/${repo}/changes/${change}/accept`, { expectedCurrent }),
  retry: (repo: string, change: string) => request<Workspace>('POST', `/api/repos/${repo}/changes/${change}/retry`, {}),
  discard: (repo: string, change: string, confirm: string) => request('POST', `/api/repos/${repo}/changes/${change}/discard`, { confirm }),
  approve: (repo: string, keys: string[], changeId?: string) => request<CommandInfo[]>('POST', `/api/repos/${repo}/approvals`, { keys, changeId }),
  revoke: (repo: string, key: string) => request('DELETE', `/api/repos/${repo}/approvals/${key}`),
  checks: (repo: string) => request<CheckRun[]>('GET', `/api/repos/${repo}/checks`),
  dismiss: (repo: string, op: string) => request('POST', `/api/repos/${repo}/operations/${op}/dismiss`, {}),
  job: (id: string) => request<Job>('GET', `/api/jobs/${id}`),
  cancelJob: (id: string) => request<Job>('POST', `/api/jobs/${id}/cancel`, {}),
};
