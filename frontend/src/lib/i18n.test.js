import { describe, expect, it } from 'vitest'
import persian from '../locales/fa.js'
import { dateLocale, directionFor, getLang, setLang, t } from './i18n.js'

const placeholders = value => [...value.matchAll(/\{\d+\}/g)].map(match => match[0]).sort()

describe('Persian locale', () => {
  it('keeps every translation placeholder in sync with its English source key', () => {
    expect(Object.keys(persian).length).toBeGreaterThan(0)
    for (const [key, value] of Object.entries(persian)) {
      expect(placeholders(value), key).toEqual(placeholders(key))
    }
  })

  it('only ships English and Persian', async () => {
    await setLang('fa')
    expect(getLang()).toBe('fa')
    expect(Object.keys((await import('./i18n.js')).LANGS).sort()).toEqual(['en', 'fa'])
  })

  it('loads as fa-IR with right-to-left direction', async () => {
    await setLang('fa')

    expect(getLang()).toBe('fa')
    // dates use the Persian calendar but keep Latin digits (see DATE_LOCALES in i18n.js)
    expect(dateLocale()).toBe('fa-IR-u-nu-latn')
    expect(directionFor(getLang())).toBe('rtl')
    expect(t('Settings')).toBe('تنظیمات')
  })
})
