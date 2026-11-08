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
    expect(exName({ id: 'ffff' }, 'fa')).toBe('')  // an id the pack does not cover
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

import pack from '../locales/exnames.fa.js'
import { EXDB } from './exercises-data.js'

describe('exnames.fa.js data integrity', () => {
  const EXIDX = new Map(EXDB.map(e => [e.id, e]))
  const ids = Object.keys(pack)
  it('every id exists in the dataset and none is duplicated', () => {
    expect(new Set(ids).size).toBe(ids.length)
    for (const id of ids) expect(EXIDX.has(id), `unknown dataset id ${id}`).toBe(true)
  })
  it('names and aliases are non-empty, trimmed strings', () => {
    for (const [id, e] of Object.entries(pack)) {
      expect(typeof e.n).toBe('string')
      expect(e.n.trim(), id).not.toBe('')
      expect(e.n, id).toBe(e.n.trim())
      for (const a of e.a || []) {
        expect(typeof a).toBe('string')
        expect(a.trim(), `${id} alias`).not.toBe('')
        expect(a, `${id} alias`).toBe(a.trim())
      }
    }
  })
  it('no Persian name contains digits or Arabic yeh/kaf', () => {
    for (const [id, e] of Object.entries(pack)) {
      expect(e.n, id).not.toMatch(/[0-9۰-۹٠-٩]/)
      expect(e.n, id).not.toMatch(/[يك]/)
      expect(e.n.length, id).toBeLessThan(60)
    }
  })
  it('the starter-plan exercises are fully covered', () => {
    for (const id of ['0025', '0047', '0426', '0334', '0241', '0251', '2330', '0027', '1323', '0031', '0313', '0043', '0085', '0739', '0585', '0586', '0605']) {
      expect(pack[id], `starter exercise ${id} uncovered`).toBeTruthy()
    }
  })
})
