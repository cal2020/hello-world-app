const ENTITIES = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }

export function esc(value) {
  return String(value ?? '').replace(/[&<>"']/g, (ch) => ENTITIES[ch])
}

// Escape text and wrap each cited phrase in <mark>. Phrases that do not occur verbatim are ignored.
export function highlight(text, phrases = []) {
  const ranges = []
  for (const phrase of phrases) {
    const start = text.indexOf(phrase)
    if (start >= 0) ranges.push([start, start + phrase.length])
  }
  ranges.sort((a, b) => a[0] - b[0])
  let out = ''
  let pos = 0
  for (const [start, end] of ranges) {
    if (start < pos) continue
    out += esc(text.slice(pos, start)) + `<mark>${esc(text.slice(start, end))}</mark>`
    pos = end
  }
  return out + esc(text.slice(pos))
}
