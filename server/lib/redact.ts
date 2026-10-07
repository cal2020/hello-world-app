// Bounded, redacted check output. Check commands are the user's own, but their
// output can echo tokens from the environment or config files; nothing shown in
// the browser or kept in history should carry them.

export const OUTPUT_MAX_CHARS = 4000;
export const OUTPUT_MAX_LINES = 160;

const ANSI = /\u001b\[[0-9;?]*[ -/]*[@-~]|\u001b\][^\u0007]*(?:\u0007|\u001b\\)/g;

const PATTERNS: Array<[RegExp, string]> = [
  [/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z ]*PRIVATE KEY-----|$)/g, '[redacted private key]'],
  [/\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{20,}\b/g, '[redacted token]'],
  [/\bgithub_pat_[A-Za-z0-9_]{20,}\b/g, '[redacted token]'],
  [/\bsk-[A-Za-z0-9_-]{20,}/g, '[redacted key]'],
  [/\bAKIA[0-9A-Z]{16}\b/g, '[redacted key]'],
  [/\bxox[abprs]-[A-Za-z0-9-]{10,}/g, '[redacted token]'],
  [/\bnpm_[A-Za-z0-9]{30,}\b/g, '[redacted token]'],
  [/\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]{12,}/gi, '$1 [redacted]'],
  [/([a-z][a-z0-9+.-]*:\/\/)[^\s:@/]+:[^\s@/]+@/gi, '$1[redacted]@'],
  [
    /\b((?:password|passwd|pwd|secret|token|api[_-]?key|access[_-]?key|client[_-]?secret|private[_-]?key)["']?\s*[:=]\s*)(["']?)[^\s"',;]{4,}\2/gi,
    '$1$2[redacted]$2',
  ],
];

const SECRET_ENV_NAME = /(SECRET|TOKEN|PASSWORD|PASSWD|API_?KEY|ACCESS_?KEY|PRIVATE_?KEY|CREDENTIAL)/i;

/** Values of secret-looking variables in this process's environment. */
export function secretEnvValues(env: NodeJS.ProcessEnv = process.env): string[] {
  return Object.entries(env)
    .filter(([name, value]) => SECRET_ENV_NAME.test(name) && typeof value === 'string' && value.length >= 8)
    .map(([, value]) => value as string)
    .sort((a, b) => b.length - a.length);
}

export interface Bounded {
  text: string;
  /** Characters or lines were dropped from the start. */
  truncated: boolean;
  /** At least one value was masked. */
  redacted: boolean;
}

export function redact(raw: string, extraSecrets: string[] = secretEnvValues()): Bounded {
  let text = raw.replace(ANSI, '').replace(/\r\n?/g, '\n');
  const before = text;
  for (const secret of extraSecrets) {
    if (secret) text = text.split(secret).join('[redacted env value]');
  }
  for (const [pattern, replacement] of PATTERNS) text = text.replace(pattern, replacement);
  const redacted = text !== before;

  let truncated = false;
  let lines = text.split('\n');
  if (lines.length > OUTPUT_MAX_LINES) {
    lines = lines.slice(-OUTPUT_MAX_LINES);
    truncated = true;
  }
  text = lines.join('\n');
  if (text.length > OUTPUT_MAX_CHARS) {
    text = text.slice(-OUTPUT_MAX_CHARS);
    truncated = true;
  }
  return { text, truncated, redacted };
}
