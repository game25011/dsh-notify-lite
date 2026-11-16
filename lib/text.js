/**
 * dsh-notify-toast — pure text helpers for the Host half.
 *
 * These helpers turn model/tool output into the short, single-line bodies a
 * Windows toast can show. They are deliberately side-effect free and exported
 * for `node --test` (see test/text.test.mjs).
 *
 * Character accounting follows docs/INTERFACE.md: lengths are Unicode
 * code points (`Array.from(text).length`), never UTF-16 code units.
 */

/** Common named/numeric HTML entities produced by models that escape markup. */
const NAMED_ENTITIES = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' ',
}

/** Decode the small HTML entity subset that shows up in assistant text. */
function decodeEntities(text) {
  return text
    .replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z]+);/g, (match, body) => {
      if (body[0] === '#') {
        const hex = body[1] === 'x' || body[1] === 'X'
        const code = Number.parseInt(hex ? body.slice(2) : body.slice(1), hex ? 16 : 10)
        if (Number.isFinite(code) && code >= 0 && code <= 0x10ffff) {
          try {
            return String.fromCodePoint(code)
          } catch {
            return match
          }
        }
        return match
      }
      return NAMED_ENTITIES[body.toLowerCase()] ?? match
    })
}

/**
 * Private-use delimiters for inline-code placeholders. Inline code payloads
 * are parked behind them so tag/emphasis stripping cannot eat `Vec<String>`
 * or `__init__`; models never emit these code points.
 */
const CODE_OPEN = ''
const CODE_CLOSE = ''
const CODE_PLACEHOLDER = /(\d+)/g

/**
 * Remove Markdown/markup decoration and collapse whitespace into one line.
 *
 * - fenced code blocks are removed (both ``` and ~~~, closed or unterminated);
 * - inline code keeps its content verbatim but loses the backticks;
 * - headings, block quotes, list bullets, tables and horizontal rules lose
 *   their markers; links keep the label, images are dropped;
 * - emphasis/strikethrough markers are removed; raw HTML tags are dropped and
 *   common entities decoded;
 * - the result has every whitespace run collapsed to one space (no newlines).
 *
 * @param {unknown} text raw text.
 * @returns {string} cleaned, single-line text ('', never null/undefined, for
 *   non-string or empty input).
 */
export function cleanMarkdownText(text) {
  if (typeof text !== 'string' || text.length === 0) return ''

  let out = text.replace(/\r\n?/g, '\n')

  // Fenced code blocks first: their content must never become notification text.
  out = out.replace(/```[^\n]*\n[\s\S]*?```/g, ' ')
  out = out.replace(/~~~[^\n]*\n[\s\S]*?~~~/g, ' ')
  // Unterminated fence: drop everything that follows it.
  out = out.replace(/```[\s\S]*$/g, ' ')
  out = out.replace(/~~~[\s\S]*$/g, ' ')

  out = out.replace(/<!--[\s\S]*?-->/g, ' ')
  // Images are noise for a toast; links keep their label. One level of
  // parentheses is allowed inside the URL target (e.g. Wikipedia links).
  out = out.replace(/!\[[^\]\n]*\]\((?:[^()\n]|\([^()\n]*\))*\)/g, ' ')
  out = out.replace(/\[([^\]\n]+)\]\((?:[^()\n]|\([^()\n]*\))*\)/g, '$1')
  // Inline code: keep the payload verbatim, drop the backticks.
  const codeSpans = []
  out = out.replace(/[]/g, '')
  out = out.replace(/`{1,2}([^`\n]+)`{1,2}/g, (match, code) => {
    codeSpans.push(code)
    return CODE_OPEN + String(codeSpans.length - 1) + CODE_CLOSE
  })
  out = out.replace(/`/g, '')

  // Line-leading Markdown markers.
  out = out.replace(/^[ \t]{0,3}#{1,6}[ \t]+/gm, '')
  out = out.replace(/[ \t]+#{1,6}[ \t]*$/gm, '')
  out = out.replace(/^[ \t]{0,3}>[ \t]?/gm, '')
  out = out.replace(/^[ \t]{0,3}(?:(?:\*[ \t]*){3,}|(?:-[ \t]*){3,}|(?:_[ \t]*){3,})$/gm, '')
  out = out.replace(/^[ \t]{0,3}(?:[-*+]|\d{1,9}[.)])[ \t]+/gm, '')

  // Tables: separator rows disappear, remaining cell pipes become spaces.
  out = out.replace(/^[ \t]*\|?[ \t]*:?-{2,}:?[ \t]*(?:\|[ \t]*:?-{2,}:?[ \t]*)+\|?[ \t]*$/gm, ' ')
  out = out.replace(/\|/g, ' ')

  // Autolinks and markup tags. Only tag-shaped runs are removed, so prose
  // such as "a < b > c" survives.
  out = out.replace(/<(?:https?|mailto):[^>\s]*>/gi, ' ')
  out = out.replace(/<\/?[A-Za-z][\w:-]*(?:\s[^<>]*)?\/?>/g, ' ')

  // Emphasis markers: paired forms first, then stray single markers that are
  // adjacent to whitespace so identifiers such as `file_name` survive intact.
  out = out.replace(/\*\*([^*\n]+)\*\*/g, '$1')
  out = out.replace(/__([^_\n]+)__/g, '$1')
  out = out.replace(/~~([^~\n]+)~~/g, '$1')
  out = out.replace(/\*\*+/g, '')
  out = out.replace(/~~/g, '')
  out = out.replace(/(^|[\s(])\*(?=\S)/g, '$1')
  out = out.replace(/(\S)\*(?=[\s).,!?:;]|$)/g, '$1')
  out = out.replace(/(^|[\s(])_(?=\S)/g, '$1')
  out = out.replace(/(\S)_(?=[\s).,!?:;]|$)/g, '$1')

  out = decodeEntities(out)
  if (codeSpans.length > 0) {
    out = out.replace(CODE_PLACEHOLDER, (match, index) => codeSpans[Number(index)] ?? '')
  }
  return out.replace(/\s+/g, ' ').trim()
}

/** A raw block that is only a heading: `## Title` or a lone `**Title**` line. */
function isHeadingLine(line) {
  const trimmed = line.trim()
  return /^#{1,6}[ \t]+\S/.test(trimmed) || /^(\*\*|__)[^*_\n]+\1[:：]?$/.test(trimmed)
}

/** A lead-in such as "Here is what changed:" that only introduces the next block. */
function endsWithColon(text) {
  return /[:：]$/.test(text)
}

/**
 * Split one raw paragraph into an optional leading heading and the remaining
 * body, so "## Summary\nAll checks pass" yields "All checks pass".
 */
function splitLeadingHeading(block) {
  const lines = block.split('\n')
  let index = 0
  while (index < lines.length && (lines[index].trim() === '' || isHeadingLine(lines[index]))) index += 1
  if (index === 0) return { heading: '', body: block }
  return { heading: lines.slice(0, index).join('\n'), body: lines.slice(index).join('\n') }
}

/**
 * Return the first non-empty paragraph of a Markdown-ish text, cleaned.
 *
 * Paragraph boundaries are the blank lines of the *raw* text, so fenced code
 * or decorative headers that clean to nothing fall through to the next block.
 * Heading-only blocks ("## Summary", "**Done**") are skipped when real prose
 * follows, and a short lead-in ending with a colon is joined with the block it
 * introduces, so a toast reads "Changed: fixed X" instead of "Changed:".
 *
 * @param {unknown} text raw text.
 * @returns {string|null} cleaned first paragraph, or null when nothing survives.
 */
export function firstParagraph(text) {
  if (typeof text !== 'string' || text.trim() === '') return null
  const normalized = text.replace(/\r\n?/g, '\n')
  const blocks = normalized.split(/\n[ \t]*\n/)
  let headingFallback = null
  for (let index = 0; index < blocks.length; index += 1) {
    const { heading, body } = splitLeadingHeading(blocks[index])
    const cleaned = cleanMarkdownText(body)
    if (!cleaned) {
      if (headingFallback === null && heading) headingFallback = cleanMarkdownText(heading) || null
      continue
    }
    if (!endsWithColon(cleaned)) return cleaned
    for (let next = index + 1; next < blocks.length; next += 1) {
      const following = cleanMarkdownText(splitLeadingHeading(blocks[next]).body)
      if (following) return cleaned + ' ' + following
    }
    return cleaned
  }
  if (headingFallback) return headingFallback
  const cleaned = cleanMarkdownText(normalized)
  return cleaned || null
}

/**
 * Extract the first text paragraph from assistant-message content blocks.
 *
 * @param {unknown} contentBlocks `event.data.message.content`-shaped array.
 * @returns {string|null} cleaned first paragraph, or null when the message has
 *   no non-empty `text` block.
 */
export function extractFirstTextParagraph(contentBlocks) {
  if (!Array.isArray(contentBlocks)) return null
  const parts = []
  for (const block of contentBlocks) {
    if (!block || block.type !== 'text' || typeof block.text !== 'string') continue
    if (block.text.trim()) parts.push(block.text)
  }
  if (parts.length === 0) return null
  return firstParagraph(parts.join('\n\n'))
}

/**
 * Collapse every whitespace run (including newlines) into one space and trim.
 *
 * @param {unknown} text raw text.
 * @returns {string} single-line text; '' for non-string input.
 */
export function toSingleLine(text) {
  if (typeof text !== 'string' || text.length === 0) return ''
  return text.replace(/\s+/g, ' ').trim()
}

/**
 * Truncate to at most `n` Unicode code points, marking the cut with '…'.
 *
 * The ellipsis is counted in the budget: the result never has more than `n`
 * code points. A limit of 0 returns ''; a limit of 1 returns '…'.
 *
 * @param {unknown} text raw text.
 * @param {number} n maximum code points in the result.
 * @returns {string} possibly truncated text.
 */
export function truncateCodepoints(text, n) {
  if (typeof text !== 'string' || text.length === 0) return ''
  const limit = typeof n === 'number' && Number.isFinite(n) ? Math.max(0, Math.floor(n)) : 0
  const points = Array.from(text)
  if (points.length <= limit) return text
  if (limit <= 0) return ''
  return points.slice(0, limit - 1).join('') + '…'
}
