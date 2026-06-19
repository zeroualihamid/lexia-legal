export interface ParsedSrc {
  id?: string
  title?: string
  path?: string
  type?: string
}

export type StreamSegment =
  | { kind: 'text'; text: string }
  | { kind: 'src'; src: ParsedSrc }

const OPEN = '<SRC>'
const CLOSE = '</SRC>'

function parseSrcBody(body: string): ParsedSrc | null {
  const src: ParsedSrc = {}
  for (const line of body.split('\n')) {
    const match = line.match(/^\s*([a-zA-Z_]+)\s*:\s*(.+)\s*$/)
    if (!match) continue
    const key = match[1].toLowerCase()
    const value = match[2].trim()
    if (key === 'id') src.id = value
    else if (key === 'title') src.title = value
    else if (key === 'path') src.path = value
    else if (key === 'type') src.type = value
  }
  if (!src.id && !src.path) return null
  return src
}

/** Hide a partial `<SRC…` tail while the model is still streaming the tag. */
export function stripIncompleteSrcTail(raw: string): string {
  const lower = raw.toLowerCase()
  const openIdx = lower.lastIndexOf('<src')
  if (openIdx === -1) {
    const lt = raw.lastIndexOf('<')
    if (lt === -1 || lt < raw.length - 5) return raw
    const tail = raw.slice(lt).toLowerCase()
    if ('<src>'.startsWith(tail) || '<src'.startsWith(tail)) {
      return raw.slice(0, lt)
    }
    return raw
  }
  const closeIdx = lower.indexOf('</src>', openIdx)
  if (closeIdx === -1) return raw.slice(0, openIdx)
  return raw
}

/** Split assistant text into prose + completed `<SRC>` blocks. */
export function parseMessageWithSrc(raw: string): StreamSegment[] {
  const segments: StreamSegment[] = []
  const safe = stripIncompleteSrcTail(raw)
  let cursor = 0

  while (cursor < safe.length) {
    const openIdx = safe.indexOf(OPEN, cursor)
    if (openIdx === -1) {
      const tail = safe.slice(cursor)
      if (tail) segments.push({ kind: 'text', text: tail })
      break
    }

    if (openIdx > cursor) {
      segments.push({ kind: 'text', text: safe.slice(cursor, openIdx) })
    }

    const bodyStart = openIdx + OPEN.length
    const closeIdx = safe.indexOf(CLOSE, bodyStart)
    if (closeIdx === -1) break

    const body = safe.slice(bodyStart, closeIdx).trim()
    if (body) {
      const parsed = parseSrcBody(body)
      if (parsed) segments.push({ kind: 'src', src: parsed })
    }
    cursor = closeIdx + CLOSE.length
  }

  return segments
}
