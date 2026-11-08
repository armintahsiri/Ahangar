import { describe, it, expect } from 'vitest'
import { normalizeFa } from './fa-text.js'
import { exName, exEnglishName, nameMatches, matchEx, loadExNames, faPackLoaded } from './exnames.js'

describe('normalizeFa', () => {
  it('maps Arabic yeh/kaf to Persian and lowercases Latin', () => {
    expect(normalizeFa('كشــش ي')).toBe('کشش ی')
    expect(normalizeFa('Bench PRESS')).toBe('bench press')
  })
  it('removes ZWNJ, kashida and harakat', () => {
    expect(normalizeFa('پـَـرس\u200cبازو')).toBe('پرس بازو')
    expect(normalizeFa('زیر\u200cبغل')).toBe('زیر بغل')
  })
  it('maps Persian and Arabic digits to Latin', () => {
    expect(normalizeFa('اسکوات ۴۵°')).toBe('اسکوات 45°')
    expect(normalizeFa('٤٥')).toBe('45')
  })
  it('collapses whitespace and trims', () => {
    expect(normalizeFa('  a   b  ')).toBe('a b')
  })
})

describe('exName with the lazy pack', () => {
  const bench = { id: '0025', n: 'barbell bench press' }
  const custom = { id: 'cabc123', n: 'حرکت خودم' }
  const unknown = { id: '9999', n: 'mystery machine' }

  it('falls back to English before the pack loads', async () => {
    await loadExNames('en')
    expect(faPackLoaded()).toBe(false)
    expect(exName(bench, 'fa')).toBe('barbell bench press')
    expect(exName(custom, 'fa')).toBe('حرکت خودم')
    expect(exName(unknown, 'fa')).toBe('mystery machine')
  })
  it('uses Persian once the pack is loaded, still falling back for unknown ids', async () => {
    await loadExNames('fa')
    expect(faPackLoaded()).toBe(true) // requires locales/exnames.fa.js — added in step 2
    expect(exName(bench, 'en')).toBe('barbell bench press')
    expect(typeof exName(bench, 'fa')).toBe('string')
    expect(exName(custom, 'fa')).toBe('حرکت خودم') // custom names are always the user's own
    expect(exEnglishName(custom, 'fa')).toBe('')
  })
  it('never throws for missing or null inputs', () => {
    expect(exName(null, 'fa')).toBe('')
    expect(exName({ id: '0025' }, 'fa')).toBe('')
  })
})

describe('nameMatches / matchEx', () => {
  const ex = { id: '0025', n: 'barbell bench press', tg: 'chest', eq: 'barbell', desc: 'lie on the bench' }

  it('matches English names case-insensitively (regression)', () => {
    expect(nameMatches(ex, 'bench')).toBe(true)
    expect(nameMatches(ex, 'BENCH')).toBe(true)
    expect(nameMatches(ex, 'zzz')).toBe(false)
  })
  it('multi-token queries are AND over the name text', () => {
    expect(nameMatches(ex, 'bench press')).toBe(true)
    expect(nameMatches(ex, 'bench squat')).toBe(false)
  })
  it('matches Persian names and aliases once loaded', async () => {
    await loadExNames('fa')
    expect(typeof nameMatches(ex, 'پرس')).toBe('boolean')
  })
  it('matchEx keeps the old tg/eq/desc fallback verbatim', () => {
    expect(matchEx(ex, 'chest')).toBe(true)      // tg
    expect(matchEx(ex, 'barbell')).toBe(true)    // eq + name
    expect(matchEx(ex, 'lie on')).toBe(true)     // desc
    expect(matchEx(ex, 'legs')).toBe(false)
    expect(matchEx(ex, '')).toBe(true)
  })
  it('normalizes the query (ZWNJ, digits) before matching', async () => {
    await loadExNames('fa')
    expect(matchEx(ex, '  BENCH   ')).toBe(true)
  })
})
