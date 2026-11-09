import { describe, it, expect, afterEach } from 'vitest'
import { setDigits, getDigits, dateLocale, setLang } from './i18n.js'
import { fmtNum, fmtDate, ltrNum } from './format.js'

afterEach(() => setDigits('latn'))

describe('Persian digits option', () => {
  it('defaults to Latin — regression on the pre-phase-6 behaviour', () => {
    expect(getDigits()).toBe('latn')
    expect(fmtNum(1234.5)).toBe('1,234.5')
    expect(dateLocale()).toBe('en-GB')
  })
  it('fa mode converts glyphs centrally (grouping and decimal separators included)', async () => {
    await setLang('fa')
    setDigits('fa')
    expect(fmtNum(1234.5)).toBe('۱٬۲۳۴٫۵')
    expect(fmtNum(0)).toBe('۰')
    expect(fmtNum(-1.5)).toBe('-۱٫۵') // the sign stays; ltrNum callers isolate it
  })
  it('fmtDate keeps the Persian calendar and only re-glyphs the digits', async () => {
    await setLang('fa')
    const latin = fmtDate('2026-11-09')      // fa-IR-u-nu-latn → Persian calendar, Latin digits
    expect(latin).toMatch(/[0-9]/)
    setDigits('fa')
    const fa = fmtDate('2026-11-09')
    expect(fa).not.toMatch(/[0-9]/)          // same date, Persian glyphs
    expect(fa.replace(/[۰-۹]/g, 'X')).toBe(latin.replace(/[0-9]/g, 'X'))
  })
  it('dateLocale never changes with digits (calendar pinned, glyphs converted centrally)', async () => {
    await setLang('fa')
    setDigits('fa')
    expect(dateLocale()).toBe('fa-IR-u-nu-latn')
  })
  it('English ignores the preference entirely', async () => {
    await setLang('en')
    setDigits('fa')
    expect(fmtNum(1234.5)).toBe('1,234.5')
  })
  it('ltrNum still wraps whatever string it gets', () => {
    expect(ltrNum('1.5')).toBe('\u20661.5\u2069')
    expect(ltrNum('۱٫۵')).toBe('\u2066۱٫۵\u2069')
  })
})
