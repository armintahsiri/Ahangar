// Persian exercise names, loaded lazily per language exactly like the locale packs.
// Pure data + matching logic: no store, no DOM. The pack file is
// locales/exnames.fa.js — { '<dataset id>': { n: 'نام فارسی', a: ['alias', …] } } —
// and is never fetched unless the language is fa (import.meta.glob registers, i18n fetches).

import { normalizeFa } from './fa-text.js'

let faPack = null
const packs = import.meta.glob('../locales/exnames.*.js')

// i18n.setLang awaits this before notifying, so a language switch renders with names loaded.
export async function loadExNames(lang) {
  if (lang !== 'fa') { faPack = null; return }
  try { faPack = (await packs['../locales/exnames.fa.js']()).default }
  catch { faPack = null }
}
export const faPackLoaded = () => !!faPack

const entryOf = ex => (ex && faPack && faPack[ex.id]) || null

// Persian display name when one covers this id and the language asks for it; custom
// exercises (ids never in the pack) and unknown ids always fall back to their own name.
export function exName(ex, lang) {
  if (!ex) return ''
  if (lang === 'fa') {
    const e = entryOf(ex)
    if (e?.n) return e.n
  }
  return ex.n || ''
}

// The smaller, dimmer English name under a Persian one (instructions stay English).
export function exEnglishName(ex, lang) {
  if (lang !== 'fa' || !ex) return ''
  const e = entryOf(ex)
  return e?.n && e.n !== ex.n ? ex.n : ''
}

function faTextOf(ex) {
  const e = entryOf(ex)
  return e ? [e.n, ...(e.a || [])].join(' ') : ''
}

// Name search: the query is normalized the same way as the haystack (Persian letters,
// digits, spacing), then every space-separated token must appear (AND) across the English
// name + Persian name + Persian aliases. Callers keep their existing tg/eq/desc checks —
// matchEx preserves those verbatim so English behaviour stays as it was.
export function nameMatches(ex, query) {
  const tokens = normalizeFa(query).split(' ').filter(Boolean)
  if (!tokens.length) return true
  const hay = normalizeFa([ex?.n || '', faTextOf(ex)].join(' '))
  return tokens.every(t => hay.includes(t))
}

// Full filter used by Library and ExercisePicker: name match (fa or en, tokenized) OR the
// old group/equipment/description substring, unchanged. An empty query matches everything.
export function matchEx(ex, query) {
  if (nameMatches(ex, query)) return true
  const raw = String(query || '').toLowerCase().trim()
  if (!raw) return true
  return (ex?.tg || '').toLowerCase().includes(raw)
    || (ex?.eq || '').toLowerCase().includes(raw)
    || (ex?.desc || '').toLowerCase().includes(raw)
}
