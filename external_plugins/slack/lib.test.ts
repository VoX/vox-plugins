import { test, expect, describe } from 'bun:test'
import {
  safeSlice,
  formatSendResult,
  parseDuration,
  mdToMrkdwn,
  parseSlackMentions,
  chunk,
  isDmChannel,
  normalizeReactionName,
} from './lib'

describe('safeSlice', () => {
  test('passthrough when shorter than limit', () => {
    expect(safeSlice('hello', 10)).toBe('hello')
  })
  test('truncates plain ASCII', () => {
    expect(safeSlice('abcdef', 3)).toBe('abc')
  })
  test('preserves multi-codepoint emoji (no lone surrogate)', () => {
    const out = safeSlice('abc🦝def', 4)
    expect(out).toBe('abc🦝')
    expect(() => JSON.parse(JSON.stringify(out))).not.toThrow()
  })
  test('zero limit returns empty', () => {
    expect(safeSlice('abc', 0)).toBe('')
  })
})

describe('formatSendResult', () => {
  test('singular form for one ts', () => {
    expect(formatSendResult(['1234.5678'])).toBe('sent (ts: 1234.5678)')
  })
  test('plural form for multiple', () => {
    expect(formatSendResult(['1.1', '2.2', '3.3'])).toBe('sent 3 parts (ts: 1.1, 2.2, 3.3)')
  })
})

describe('parseDuration', () => {
  test('"45m" = 45 minutes', () => {
    expect(parseDuration('45m')).toBe(45 * 60_000)
  })
  test('"2h30m" = 150 minutes', () => {
    expect(parseDuration('2h30m')).toBe(150 * 60_000)
  })
  test('"1d" = 86400000 ms', () => {
    expect(parseDuration('1d')).toBe(86_400_000)
  })
  test('case insensitive', () => {
    expect(parseDuration('1H')).toBe(3_600_000)
  })
  test('rejects bare number', () => {
    expect(parseDuration('45')).toBe(null)
  })
  test('rejects garbage', () => {
    expect(parseDuration('forever')).toBe(null)
  })
  test('rejects partial-consume input', () => {
    expect(parseDuration('1htrailing')).toBe(null)
  })
  test('empty string is null', () => {
    expect(parseDuration('')).toBe(null)
  })
})

describe('mdToMrkdwn', () => {
  test('converts **bold** to *bold*', () => {
    expect(mdToMrkdwn('hello **world** today')).toBe('hello *world* today')
  })
  test('converts ~~strike~~ to ~strike~', () => {
    expect(mdToMrkdwn('~~gone~~')).toBe('~gone~')
  })
  test('converts [text](url) to <url|text>', () => {
    expect(mdToMrkdwn('see [the docs](https://example.com)')).toBe('see <https://example.com|the docs>')
  })
  test('leaves single asterisk italic alone (ambiguous)', () => {
    expect(mdToMrkdwn('this is *italic* yes')).toBe('this is *italic* yes')
  })
  test('handles multiple bold runs without merging', () => {
    expect(mdToMrkdwn('**a** and **b**')).toBe('*a* and *b*')
  })
  test('preserves backticks and code blocks', () => {
    expect(mdToMrkdwn('`x` and ```y```')).toBe('`x` and ```y```')
  })
  test('does not convert markdown inside fenced code blocks', () => {
    const input = 'see this code:\n```\nconst x = "**not bold**"\n```\nand normal **bold**'
    const out = mdToMrkdwn(input)
    expect(out).toContain('"**not bold**"')  // untouched
    expect(out).toContain('and normal *bold*')  // converted
  })
  test('does not convert markdown inside inline backticks', () => {
    expect(mdToMrkdwn('use `**foo**` for bold, but **bar** is bold'))
      .toBe('use `**foo**` for bold, but *bar* is bold')
  })
  test('does not convert link syntax inside code blocks', () => {
    expect(mdToMrkdwn('```\n[link](http://x)\n```'))
      .toBe('```\n[link](http://x)\n```')
  })
})

describe('parseSlackMentions', () => {
  test('parses user mention', () => {
    const m = parseSlackMentions('hi <@U123ABC>')
    expect(m).toEqual([{ type: 'user', raw: '<@U123ABC>', id: 'U123ABC' }])
  })
  test('parses channel mention with name', () => {
    const m = parseSlackMentions('see <#C123ABC|general>')
    expect(m).toEqual([{ type: 'channel', raw: '<#C123ABC|general>', id: 'C123ABC', name: 'general' }])
  })
  test('parses channel mention without name', () => {
    const m = parseSlackMentions('see <#C123ABC>')
    expect(m).toEqual([{ type: 'channel', raw: '<#C123ABC>', id: 'C123ABC' }])
  })
  test('parses user-group mention', () => {
    const m = parseSlackMentions('<!subteam^S123|@oncall>')
    expect(m).toEqual([{ type: 'usergroup', raw: '<!subteam^S123|@oncall>', id: 'S123', handle: '@oncall' }])
  })
  test('parses !here, !channel, !everyone', () => {
    const m = parseSlackMentions('<!here> <!channel> <!everyone>')
    expect(m.map(x => x.type === 'special' ? x.keyword : null)).toEqual(['here', 'channel', 'everyone'])
  })
  test('ignores non-mentions', () => {
    expect(parseSlackMentions('plain text')).toEqual([])
    expect(parseSlackMentions('<https://example.com>')).toEqual([])
  })
  test('handles multiple mentions in order', () => {
    const m = parseSlackMentions('<@U1> and <@U2>')
    expect(m.map(x => 'id' in x ? x.id : null)).toEqual(['U1', 'U2'])
  })
})

describe('chunk', () => {
  test('short text returns single chunk', () => {
    expect(chunk('hi', 100)).toEqual(['hi'])
  })
  test('cuts at paragraph boundary', () => {
    const out = chunk('line 1\nline 2\n\nline 3', 16)
    expect(out[0]).toBe('line 1\nline 2')
  })
  test('cuts at line boundary', () => {
    const out = chunk('hello\nworld how', 11)
    expect(out[0]).toBe('hello')
  })
  test('cuts at space boundary', () => {
    const out = chunk('the quick brown fox', 10)
    expect(out[0]).toBe('the quick')
  })
  test('hard-cuts when no whitespace', () => {
    expect(chunk('aaaaaaaa', 4)).toEqual(['aaaa', 'aaaa'])
  })
  test('strips leading whitespace from continuations', () => {
    const out = chunk('hello world', 5)
    expect(out[1]).toBe('world')
  })
})

describe('isDmChannel', () => {
  test('D-prefix is a DM', () => {
    expect(isDmChannel('D12345')).toBe(true)
  })
  test('C-prefix is not a DM', () => {
    expect(isDmChannel('C12345')).toBe(false)
  })
  test('G-prefix is not a DM (private channel)', () => {
    expect(isDmChannel('G12345')).toBe(false)
  })
  test('MPDM-prefix is not a DM (group DM)', () => {
    expect(isDmChannel('MPDM01234')).toBe(false)
  })
  test('empty string is not a DM', () => {
    expect(isDmChannel('')).toBe(false)
  })
})

describe('normalizeReactionName', () => {
  test('plain shortcode', () => {
    expect(normalizeReactionName('thumbsup')).toBe('thumbsup')
  })
  test('strips surrounding colons', () => {
    expect(normalizeReactionName(':white_check_mark:')).toBe('white_check_mark')
  })
  test('lowercases', () => {
    expect(normalizeReactionName('ThumbsUp')).toBe('thumbsup')
  })
  test('rejects unicode emoji', () => {
    expect(() => normalizeReactionName('👍')).toThrow(/shortcode/)
  })
  test('rejects empty', () => {
    expect(() => normalizeReactionName('')).toThrow(/empty/)
    expect(() => normalizeReactionName('::')).toThrow(/empty/)
  })
  test('accepts +1 / -1 / underscores / digits', () => {
    expect(normalizeReactionName('+1')).toBe('+1')
    expect(normalizeReactionName('-1')).toBe('-1')
    expect(normalizeReactionName('check_mark_button')).toBe('check_mark_button')
    expect(normalizeReactionName('100')).toBe('100')
  })
})
