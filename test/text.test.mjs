/**
 * Unit tests for the pure text helpers (docs/INTERFACE.md §2.5/§4).
 *
 * Run with: node --test test/
 */

import assert from 'node:assert/strict'
import test from 'node:test'

import {
  cleanMarkdownText,
  extractFirstTextParagraph,
  firstParagraph,
  toSingleLine,
  truncateCodepoints,
} from '../lib/text.js'

const FENCE = '```'
const TILDE_FENCE = '~~~'

test('cleanMarkdownText: removes fenced code blocks and keeps surrounding prose', () => {
  const input = ['Here is the fix:', `${FENCE}js`, 'const broken = true', FENCE, 'Apply it.'].join('\n')
  assert.equal(cleanMarkdownText(input), 'Here is the fix: Apply it.')
})

test('cleanMarkdownText: removes tilde fences and unterminated fences', () => {
  assert.equal(cleanMarkdownText(`${TILDE_FENCE}sh\nrm -rf /\n${TILDE_FENCE}\nsafe`), 'safe')
  assert.equal(cleanMarkdownText(`Before\n${FENCE}\nconst leaked = 1`), 'Before')
  assert.equal(cleanMarkdownText(`Before\n${FENCE}js\nconst leaked = 1`), 'Before')
})

test('cleanMarkdownText: inline code keeps its content but drops the backticks', () => {
  assert.equal(cleanMarkdownText('Use `npm test` now'), 'Use npm test now')
  assert.equal(cleanMarkdownText('Also ``--flag`` works'), 'Also --flag works')
})

test('cleanMarkdownText: strips heading, list, quote and rule markers', () => {
  const input = ['# Title', '', '## Sub heading', '', '- one', '* two', '1. three', '', '> quoted text', '', '---', '', 'tail'].join(
    '\n',
  )
  assert.equal(cleanMarkdownText(input), 'Title Sub heading one two three quoted text tail')
})

test('cleanMarkdownText: strips emphasis and strikethrough markers', () => {
  assert.equal(
    cleanMarkdownText('**bold** __under__ *ital* _em_ ~~gone~~ untouched'),
    'bold under ital em gone untouched',
  )
  // Identifiers containing underscores must survive (inline code is already unwrapped).
  assert.equal(cleanMarkdownText('call file_name and snake_case_word'), 'call file_name and snake_case_word')
})

test('cleanMarkdownText: links keep their label, images are dropped', () => {
  assert.equal(cleanMarkdownText('See [the docs](https://example.com/a_(b)) please'), 'See the docs please')
  assert.equal(cleanMarkdownText('![chart](chart.png) after'), 'after')
})

test('cleanMarkdownText: markdown tables collapse to cell text', () => {
  const table = ['| name | value |', '| --- | ---: |', '| a | 1 |', '| b | 2 |'].join('\n')
  assert.equal(cleanMarkdownText(table), 'name value a 1 b 2')
})

test('cleanMarkdownText: raw HTML and entities are cleaned up', () => {
  assert.equal(cleanMarkdownText('<b>Hello</b> &amp; <i>bye</i> &lt;3'), 'Hello & bye <3')
  assert.equal(cleanMarkdownText('a&nbsp;b &#39;quoted&#39;'), "a b 'quoted'")
})

test('cleanMarkdownText: collapses every whitespace run and trims', () => {
  assert.equal(cleanMarkdownText('  a\n\n\n b\t\tc  '), 'a b c')
  assert.equal(cleanMarkdownText('\n \t\n'), '')
})

test('cleanMarkdownText: empty and non-string input returns an empty string', () => {
  assert.equal(cleanMarkdownText(''), '')
  assert.equal(cleanMarkdownText(null), '')
  assert.equal(cleanMarkdownText(undefined), '')
  assert.equal(cleanMarkdownText(42), '')
  assert.equal(cleanMarkdownText({ text: 'x' }), '')
})

test('firstParagraph: returns the first non-empty cleaned paragraph', () => {
  assert.equal(firstParagraph('First **para**.\n\nSecond para.'), 'First para.')
  assert.equal(firstParagraph(`${FENCE}\ncode only\n${FENCE}\n\nReal paragraph.`), 'Real paragraph.')
  assert.equal(firstParagraph('line one\nline two\n\nlater'), 'line one line two')
  assert.equal(firstParagraph('- bullet a\n- bullet b\n\nnext'), 'bullet a bullet b')
  assert.equal(firstParagraph('Only line'), 'Only line')
})

test('firstParagraph: returns null when nothing survives cleaning', () => {
  assert.equal(firstParagraph(''), null)
  assert.equal(firstParagraph('   \n\n  '), null)
  assert.equal(firstParagraph(`${FENCE}\ncode only\n${FENCE}`), null)
  assert.equal(firstParagraph(null), null)
  assert.equal(firstParagraph(undefined), null)
})

test('extractFirstTextParagraph: joins text blocks and ignores non-text blocks', () => {
  const blocks = [
    { type: 'reasoning', text: 'private thoughts' },
    { type: 'tool-call', id: 'call-1', name: 'read', arguments: '{}' },
    { type: 'text', text: '**Done.** All checks pass.' },
    { type: 'text', text: 'Second paragraph.' },
  ]
  assert.equal(extractFirstTextParagraph(blocks), 'Done. All checks pass.')
})

test('extractFirstTextParagraph: skips empty text blocks, returns null when no text', () => {
  assert.equal(
    extractFirstTextParagraph([
      { type: 'text', text: '   ' },
      { type: 'text', text: 'first real block' },
    ]),
    'first real block',
  )
  assert.equal(extractFirstTextParagraph([{ type: 'tool-call', id: 'c', name: 'x', arguments: '{}' }]), null)
  assert.equal(extractFirstTextParagraph([{ type: 'text', text: 'multi\nline\n\nsecond' }]), 'multi line')
  assert.equal(extractFirstTextParagraph(null), null)
  assert.equal(extractFirstTextParagraph('not-an-array'), null)
})

test('truncateCodepoints: leaves short text untouched', () => {
  assert.equal(truncateCodepoints('abcd', 4), 'abcd')
  assert.equal(truncateCodepoints('ab', 10), 'ab')
  assert.equal(truncateCodepoints('', 5), '')
})

test('truncateCodepoints: ellipsis is inside the code-point budget', () => {
  const truncated = truncateCodepoints('abcdef', 4)
  assert.equal(truncated, 'abc…')
  assert.equal(Array.from(truncated).length, 4)
  assert.equal(truncateCodepoints('你好世界', 3), '你好…')
})

test('truncateCodepoints: counts code points, not UTF-16 units', () => {
  const emoji = '😀😀😀😀'
  const truncated = truncateCodepoints(emoji, 2)
  assert.equal(truncated, '😀…')
  assert.equal(Array.from(truncated).length, 2)
  assert.equal(Array.from(truncateCodepoints(emoji, 4)).length, 4)
})

test('truncateCodepoints: degenerate limits and inputs', () => {
  assert.equal(truncateCodepoints('abc', 0), '')
  assert.equal(truncateCodepoints('abc', 1), '…')
  assert.equal(truncateCodepoints('abc', -3), '')
  assert.equal(truncateCodepoints('abc', Number.NaN), '')
  assert.equal(truncateCodepoints('abc', undefined), '')
  assert.equal(truncateCodepoints(null, 3), '')
})

test('toSingleLine: collapses whitespace without touching markdown', () => {
  assert.equal(toSingleLine('  a\n b\t c '), 'a b c')
  assert.equal(toSingleLine('**not cleaned**'), '**not cleaned**')
  assert.equal(toSingleLine(null), '')
  assert.equal(toSingleLine(7), '')
})

test('cleanMarkdownText: inline code survives tag and emphasis stripping', () => {
  assert.equal(cleanMarkdownText('Returns `Vec<String>` now'), 'Returns Vec<String> now')
  assert.equal(cleanMarkdownText('Edit `__init__.py` and `*args`'), 'Edit __init__.py and *args')
  assert.equal(cleanMarkdownText('Use `a | b` here'), 'Use a | b here')
})

test('cleanMarkdownText: only tag-shaped markup is removed', () => {
  assert.equal(cleanMarkdownText('if a < b and c > d'), 'if a < b and c > d')
  assert.equal(cleanMarkdownText('see <https://example.com/x> or <br/> <span class="x">ok</span>'), 'see or ok')
})

test('firstParagraph: skips heading-only blocks when prose follows', () => {
  assert.equal(firstParagraph('## Summary\n\nAll checks pass.'), 'All checks pass.')
  assert.equal(firstParagraph('**总结**\n\n已修复登录问题。'), '已修复登录问题。')
  assert.equal(firstParagraph('## Summary\nAll checks pass.\n\nMore.'), 'All checks pass.')
  // A heading with nothing after it is still better than no body.
  assert.equal(firstParagraph('## Done'), 'Done')
})

test('firstParagraph: a colon lead-in is joined with the block it introduces', () => {
  assert.equal(firstParagraph('Here is what changed:\n\n- fixed login\n- added tests\n\nDone.'), 'Here is what changed: fixed login added tests')
  assert.equal(firstParagraph('改动如下：\n\n```js\ncode\n```\n\n修复了登录。'), '改动如下： 修复了登录。')
  assert.equal(firstParagraph('Only a lead-in:'), 'Only a lead-in:')
})
