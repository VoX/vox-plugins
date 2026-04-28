import { test, expect, describe } from 'bun:test'
import { safeSlice, formatSendResult, assertEmbedUrl, chunk } from './lib'

describe('safeSlice', () => {
  test('returns input unchanged when shorter than limit', () => {
    expect(safeSlice('hello', 10)).toBe('hello')
  })

  test('returns input unchanged when exactly at limit', () => {
    expect(safeSlice('hello', 5)).toBe('hello')
  })

  test('truncates plain ASCII at codepoint limit', () => {
    expect(safeSlice('abcdef', 3)).toBe('abc')
  })

  test('preserves multi-codepoint emoji (no lone surrogate)', () => {
    // 🦝 is U+1F99D — two UTF-16 code units. Slice at 4 in code units would
    // strand a lone surrogate; safeSlice slices at 4 codepoints instead.
    const out = safeSlice('abc🦝def', 4)
    expect(out).toBe('abc🦝')
    // No lone surrogate: every char in [0xd800,0xdfff] must be paired.
    for (let i = 0; i < out.length; i++) {
      const code = out.charCodeAt(i)
      if (code >= 0xd800 && code <= 0xdbff) {
        const next = out.charCodeAt(i + 1)
        expect(next >= 0xdc00 && next <= 0xdfff).toBe(true)
        i++
      } else {
        expect(code >= 0xdc00 && code <= 0xdfff).toBe(false)
      }
    }
  })

  test('handles trailing-emoji-with-200-cap regression (the ulant case)', () => {
    // Build a 209-codepoint string with a non-BMP emoji that would land mid-pair
    // under raw `.slice(0, 200)` (UTF-16 code units). safeSlice picks the
    // codepoint after the emoji, keeping it intact.
    const str = 'm '.repeat(99) + '🦝 trailing'
    const out = safeSlice(str, 200)
    // 200 codepoints: 198 ('m ' × 99) + 🦝 + ' '
    expect(out).toBe('m '.repeat(99) + '🦝 ')
    expect(Array.from(out).length).toBe(200)
    // Round-trip JSON: a lone surrogate would corrupt the parse.
    expect(() => JSON.parse(JSON.stringify(out))).not.toThrow()
  })

  test('empty string is passthrough', () => {
    expect(safeSlice('', 10)).toBe('')
  })

  test('zero limit returns empty string', () => {
    expect(safeSlice('abc', 0)).toBe('')
  })

  test('JSON round-trip survives many adjacent emoji', () => {
    const out = safeSlice('🦝🫡🐧🦊🦝🫡🐧🦊', 5)
    expect(out).toBe('🦝🫡🐧🦊🦝')
    expect(() => JSON.parse(JSON.stringify(out))).not.toThrow()
  })
})

describe('formatSendResult', () => {
  test('single id uses singular phrasing', () => {
    expect(formatSendResult(['123'])).toBe('sent (id: 123)')
  })

  test('multiple ids include count and join', () => {
    expect(formatSendResult(['1', '2', '3'])).toBe('sent 3 parts (ids: 1, 2, 3)')
  })
})

describe('assertEmbedUrl', () => {
  test('accepts http URLs', () => {
    expect(() => assertEmbedUrl('url', 'http://example.com')).not.toThrow()
  })

  test('accepts https URLs', () => {
    expect(() => assertEmbedUrl('url', 'https://example.com/path?x=1')).not.toThrow()
  })

  test('accepts case-insensitive scheme', () => {
    expect(() => assertEmbedUrl('url', 'HTTPS://example.com')).not.toThrow()
  })

  test('rejects javascript: scheme', () => {
    expect(() => assertEmbedUrl('url', 'javascript:alert(1)')).toThrow(/must be an http\(s\) URL/)
  })

  test('rejects data: scheme', () => {
    expect(() => assertEmbedUrl('url', 'data:text/html,<script>alert(1)</script>')).toThrow(/must be an http\(s\) URL/)
  })

  test('rejects file: scheme', () => {
    expect(() => assertEmbedUrl('url', 'file:///etc/passwd')).toThrow(/must be an http\(s\) URL/)
  })

  test('rejects schemeless URL', () => {
    expect(() => assertEmbedUrl('url', 'example.com')).toThrow(/must be an http\(s\) URL/)
  })

  test('rejects empty string', () => {
    expect(() => assertEmbedUrl('url', '')).toThrow(/must be an http\(s\) URL/)
  })

  test('error message JSON-quotes the bad value', () => {
    try {
      assertEmbedUrl('url', 'javascript:alert(1)')
      throw new Error('expected throw')
    } catch (e: any) {
      expect(e.message).toContain('"javascript:alert(1)"')
    }
  })

  test('error message includes the field name', () => {
    expect(() => assertEmbedUrl('thumbnail_url', 'bad'))
      .toThrow(/^thumbnail_url /)
  })
})

describe('chunk', () => {
  test('short text returns single chunk', () => {
    expect(chunk('hello world', 100)).toEqual(['hello world'])
  })

  test('cuts at paragraph boundary when available', () => {
    const text = 'line 1\nline 2\n\nline 3 is in para two'
    const out = chunk(text, 16)
    expect(out[0]).toBe('line 1\nline 2')
    expect(out[1]).toBe('line 3 is in')
    // Only assert essentials — third chunk content depends on cut algo
    expect(out.length).toBeGreaterThan(1)
  })

  test('cuts at line boundary when no paragraph break', () => {
    const out = chunk('hello\nworld how are you', 11)
    expect(out[0]).toBe('hello')
    expect(out[1]).toBe('world how')
    expect(out[2]).toBe('are you')
  })

  test('cuts at space boundary when no line break', () => {
    const out = chunk('the quick brown fox', 10)
    expect(out[0]).toBe('the quick')
    expect(out[1]).toBe('brown fox')
  })

  test('hard-cuts at limit when no whitespace exists', () => {
    const out = chunk('aaaaaaaaaa', 4)
    expect(out).toEqual(['aaaa', 'aaaa', 'aa'])
  })

  test('strips leading whitespace from continuation chunks', () => {
    const out = chunk('hello world', 5)
    expect(out[1]).toBe('world')
    expect(out[1].startsWith(' ')).toBe(false)
  })
})
