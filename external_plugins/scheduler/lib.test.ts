import { test, expect, describe } from 'bun:test'
import { truncate, optString } from './lib'

describe('truncate', () => {
  test('returns input unchanged when shorter than limit', () => {
    expect(truncate('hello', 10)).toBe('hello')
  })

  test('returns input unchanged when exactly at limit', () => {
    expect(truncate('hello', 5)).toBe('hello')
  })

  test('truncates with ellipsis when over limit', () => {
    expect(truncate('hello world', 8)).toBe('hello w…')
  })

  test('output length equals max when truncating', () => {
    expect(truncate('a'.repeat(100), 10).length).toBe(10)
  })

  test('empty string passthrough', () => {
    expect(truncate('', 10)).toBe('')
  })

  test('ellipsis at minimum width', () => {
    // max=2 → slice(0, 1) + '…' = 2 chars total
    expect(truncate('abcdef', 2)).toBe('a…')
  })
})

describe('optString', () => {
  test('returns trimmed string for valid input', () => {
    expect(optString({ k: 'hello' }, 'k')).toBe('hello')
  })

  test('trims surrounding whitespace', () => {
    expect(optString({ k: '  hello  ' }, 'k')).toBe('hello')
  })

  test('returns undefined for whitespace-only string', () => {
    expect(optString({ k: '   ' }, 'k')).toBeUndefined()
  })

  test('returns undefined for empty string', () => {
    expect(optString({ k: '' }, 'k')).toBeUndefined()
  })

  test('returns undefined for missing key', () => {
    expect(optString({}, 'k')).toBeUndefined()
  })

  test('returns undefined for explicit undefined', () => {
    expect(optString({ k: undefined }, 'k')).toBeUndefined()
  })

  test('returns undefined for null', () => {
    expect(optString({ k: null }, 'k')).toBeUndefined()
  })

  test('returns undefined for number', () => {
    expect(optString({ k: 42 }, 'k')).toBeUndefined()
  })

  test('returns undefined for boolean', () => {
    expect(optString({ k: true }, 'k')).toBeUndefined()
    expect(optString({ k: false }, 'k')).toBeUndefined()
  })

  test('returns undefined for array', () => {
    expect(optString({ k: ['hello'] }, 'k')).toBeUndefined()
  })

  test('returns undefined for object', () => {
    expect(optString({ k: { foo: 'bar' } }, 'k')).toBeUndefined()
  })
})
