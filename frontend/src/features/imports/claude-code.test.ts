import { describe, expect, it } from 'vitest'

import { LineSplitter, UsageExtract, looksLikeTranscript } from './claude-code'

const SESSION = '5b0c2a6e-3f1d-4e8a-9c7b-1a2b3c4d5e6f'

function response(requestId: string, text: string, extra: Record<string, unknown> = {}) {
  return JSON.stringify({
    type: 'assistant',
    sessionId: SESSION,
    requestId,
    timestamp: '2026-10-07T12:00:05.100Z',
    isSidechain: false,
    version: '2.1.296',
    cwd: '/home/dev/secret-project',
    message: {
      id: `msg_${requestId}`,
      model: 'claude-opus-5-5',
      content: [{ type: 'text', text }],
      usage: { input_tokens: 3, output_tokens: 500, cache_read_input_tokens: 40000, service_tier: 'standard' },
    },
    ...extra,
  })
}

function extract(lines: string[]): UsageExtract {
  const out = new UsageExtract()
  for (const line of lines) out.addLine(line)
  return out
}

describe('looksLikeTranscript', () => {
  it('recognizes Claude Code entries and rejects AUDR', () => {
    expect(looksLikeTranscript(`{"type":"queue-operation","sessionId":"${SESSION}"}\n`)).toBe(true)
    expect(looksLikeTranscript('{"type":"summary","summary":"Refactor","leafUuid":"u1"}\n')).toBe(true)
    expect(looksLikeTranscript('{"spec_version":"1.0.0","record_id":"01K"}\n')).toBe(false)
    expect(looksLikeTranscript('[{"spec_version":"1.0.0"}]')).toBe(false)
    expect(looksLikeTranscript('{\n  "spec_version": "1.0.0"\n}')).toBe(false)
    expect(looksLikeTranscript('')).toBe(false)
  })

  it('falls back to the field names when the first line is longer than the window', () => {
    const cut = `{"type":"user","sessionId":"${SESSION}","message":{"content":"${'x'.repeat(100)}`
    expect(looksLikeTranscript(cut)).toBe(true)
  })
})

describe('UsageExtract', () => {
  it('keeps one entry per request, without message content', () => {
    const out = extract([
      JSON.stringify({ type: 'user', sessionId: SESSION, message: { content: 'SECRET-PROMPT "assistant"' } }),
      response('req_A', 'SECRET-THINKING'),
      response('req_A', 'SECRET-REPLY', { timestamp: '2026-10-07T12:00:05.400Z' }),
      response('req_B', 'SECRET-REPLY'),
    ])
    expect(out.requests).toBe(2)
    const lines = out.toText().trimEnd().split('\n').map((line) => JSON.parse(line) as Record<string, unknown>)
    expect(lines).toHaveLength(2)
    expect(lines[0]).toEqual({
      type: 'assistant',
      sessionId: SESSION,
      requestId: 'req_A',
      timestamp: '2026-10-07T12:00:05.400Z', // the last entry for the request wins
      isSidechain: false,
      version: '2.1.296',
      message: {
        id: 'msg_req_A',
        model: 'claude-opus-5-5',
        usage: { input_tokens: 3, output_tokens: 500, cache_read_input_tokens: 40000, service_tier: 'standard' },
      },
    })
    expect(out.toText()).not.toMatch(/SECRET|secret-project/)
  })

  it('keeps saved cost figures in file order relative to the requests', () => {
    const out = extract([
      response('req_A', 'a'),
      JSON.stringify({ type: 'cost-state', sessionId: SESSION, totalCostUSD: 0.0712, modelUsage: { x: 1 } }),
      response('req_B', 'b'),
      response('req_A', 'a again'),
    ])
    const types = out
      .toText()
      .trimEnd()
      .split('\n')
      .map((line) => (JSON.parse(line) as { type: string; requestId?: string }).requestId ?? 'cost-state')
    expect(types).toEqual(['req_A', 'cost-state', 'req_B'])
    expect(out.toText()).toContain('{"type":"cost-state","sessionId":"5b0c2a6e-3f1d-4e8a-9c7b-1a2b3c4d5e6f","totalCostUSD":0.0712}')
  })

  it('skips messages Claude Code wrote itself and entries without usage', () => {
    const synthetic = JSON.parse(response('req_X', 'API Error')) as { message: { model: string } }
    synthetic.message.model = '<synthetic>'
    const out = extract([
      JSON.stringify(synthetic),
      JSON.stringify({ type: 'assistant', sessionId: SESSION, requestId: 'req_Y', message: { model: 'm' } }),
      '{"type":"assistant","sessionId":"cut off',
    ])
    expect(out.requests).toBe(0)
    expect(out.toText()).toBe('')
  })

  it('names the import after the session title, preferring a title the user set', () => {
    const one = extract([
      response('req_A', 'a'),
      JSON.stringify({ type: 'ai-title', sessionId: SESSION, aiTitle: 'Refactor billing module' }),
    ])
    expect(one.displayName('file.jsonl')).toBe('Claude Code – Refactor billing module')
    one.addLine(JSON.stringify({ type: 'custom-title', sessionId: SESSION, customTitle: 'Billing refactor' }))
    expect(one.displayName('file.jsonl')).toBe('Claude Code – Billing refactor')

    const untitled = extract([response('req_A', 'a')])
    expect(untitled.displayName('file.jsonl')).toBe('file.jsonl')

    const two = extract([response('req_A', 'a'), response('req_B', 'b', { sessionId: 'other-session-0001' })])
    expect(two.displayName('file.jsonl')).toBe('Claude Code – 2 sessions')
  })
})

describe('LineSplitter', () => {
  it('joins lines split across chunks', () => {
    const lines: string[] = []
    const splitter = new LineSplitter((line) => lines.push(line))
    for (const chunk of ['{"a":', '1}\n{"b"', ':2}\n', '\n{"c":3}']) splitter.push(chunk)
    splitter.end()
    expect(lines).toEqual(['{"a":1}', '{"b":2}', '', '{"c":3}'])
  })
})
