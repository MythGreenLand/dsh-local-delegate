/**
 * Paragraph-aware text chunking for local models with small context windows.
 * Splits on blank lines, then on sentence terminators, then on whitespace.
 */

/** Find the best cut index at or before `max`. */
function cutIndex(text, max) {
  const floor = Math.floor(max * 0.55)
  const window = text.slice(0, max)
  const patterns = [/[。！？!?]\s*/g, /[.;；:：]\s+/g, /\n/g, /\s+/g]
  for (const pattern of patterns) {
    let last = -1
    for (const match of window.matchAll(pattern)) last = match.index + match[0].length
    if (last > floor) return last
  }
  return max
}

/**
 * Split `text` into chunks no longer than `maxChars`, preferring paragraph and
 * sentence boundaries so translations stay coherent.
 * @param {string} text source text.
 * @param {number} maxChars target chunk size in characters.
 * @returns {string[]} non-empty chunks in source order.
 */
export function splitText(text, maxChars) {
  const clean = String(text ?? '').replace(/\r\n/g, '\n').replace(/\r/g, '\n')
  const limit = Math.max(200, Math.floor(Number(maxChars) || 4000))
  if (clean.length <= limit) return clean.trim().length > 0 ? [clean] : []

  const parts = []
  let buffer = ''
  const flush = () => {
    if (buffer.trim().length > 0) parts.push(buffer)
    buffer = ''
  }

  for (const paragraph of clean.split(/\n{2,}/)) {
    const candidate = buffer ? buffer + '\n\n' + paragraph : paragraph
    if (candidate.length <= limit) {
      buffer = candidate
      continue
    }
    flush()
    let rest = paragraph
    while (rest.length > limit) {
      const cut = cutIndex(rest, limit)
      parts.push(rest.slice(0, cut))
      rest = rest.slice(cut)
    }
    buffer = rest
  }
  flush()
  return parts
}

/** Join per-chunk results back into one document. */
export function joinChunks(chunks) {
  return chunks.filter((chunk) => typeof chunk === 'string' && chunk.trim().length > 0).join('\n\n')
}

/** Rough token estimate used only for reporting, never for limits. */
export function estimateTokens(text) {
  return Math.ceil(String(text ?? '').length / 3.2)
}
