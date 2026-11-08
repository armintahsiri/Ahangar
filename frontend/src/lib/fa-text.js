// Persian text normalization for search — pure string work, no store/DOM/i18n imports.

// Arabic yeh/kaf → Persian, strip zero-width non-joiner, kashida/tatweel and harakat,
// map Persian/Arabic digits to Latin, lowercase Latin, collapse whitespace. Used on both
// sides of a comparison (query and haystack), so none of this needs to be reversible.
export function normalizeFa(s) {
  return String(s || '')
    .replace(/ي/g, 'ی').replace(/ك/g, 'ک').replace(/ى/g, 'ی')
    .replace(/[\u200c\u200f\u200e]/g, ' ')        // ZWNJ / RLM / LRM → space
    .replace(/[\u064b-\u065f\u0670\u0640]/g, '')  // harakat, dagger alif, tatweel
    .replace(/[۰-۹]/g, d => String('۰۱۲۳۴۵۶۷۸۹'.indexOf(d)))
    .replace(/[٠-٩]/g, d => String('٠١٢٣٤٥٦٧٨٩'.indexOf(d)))
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim()
}

// Latin digits only, for anything that must never render in Persian script (inputs,
// phone numbers, codes). Same rounding as fmtNum without the locale switch.
export const latinNum = n => (Math.round(n * 10) / 10).toLocaleString('en-US')
