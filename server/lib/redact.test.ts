import { describe, expect, it } from 'vitest';
import { OUTPUT_MAX_CHARS, OUTPUT_MAX_LINES, redact, secretEnvValues } from './redact';

describe('redact', () => {
  it('masks common credential shapes', () => {
    const raw = [
      'token ghp_abcdefghijklmnopqrstuvwxyz0123456789',
      'key sk-ant-api03-abcdefghijklmnopqrstuvwxyz',
      'aws AKIAABCDEFGHIJKLMNOP',
      'Authorization: Bearer abcdefghijklmnopqrstuvwxyz.123',
      'url https://user:hunter2@example.com/repo.git',
      'PASSWORD=supersecret123',
      'api_key: "abcd1234efgh"',
      '-----BEGIN RSA PRIVATE KEY-----\nMIIEow\n-----END RSA PRIVATE KEY-----',
    ].join('\n');
    const r = redact(raw, []);
    expect(r.redacted).toBe(true);
    for (const leak of ['ghp_abc', 'sk-ant-api03', 'AKIAABCD', 'abcdefghijklmnopqrstuvwxyz.123', 'hunter2', 'supersecret123', 'abcd1234efgh', 'MIIEow']) {
      expect(r.text).not.toContain(leak);
    }
    expect(r.text).toContain('https://[redacted]@example.com');
  });

  it('masks values of secret-looking environment variables', () => {
    const secrets = secretEnvValues({ MY_API_TOKEN: 'tok-1234567890', PATH: '/usr/bin', SHORT_SECRET: 'abc' });
    expect(secrets).toEqual(['tok-1234567890']);
    expect(redact('using tok-1234567890 now', secrets).text).toBe('using [redacted env value] now');
  });

  it('strips terminal escapes and keeps a bounded tail', () => {
    expect(redact('\u001b[31mred\u001b[0m', []).text).toBe('red');
    const long = Array.from({ length: 1000 }, (_, i) => `line ${i}`).join('\n');
    const r = redact(long, []);
    expect(r.truncated).toBe(true);
    expect(r.text.split('\n').length).toBeLessThanOrEqual(OUTPUT_MAX_LINES);
    expect(r.text.length).toBeLessThanOrEqual(OUTPUT_MAX_CHARS);
    expect(r.text.endsWith('line 999')).toBe(true);
    expect(redact('ok', []).redacted).toBe(false);
  });
});
