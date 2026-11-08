// Pure personal-media helpers — no store, DOM or hard network imports (fetch is injectable),
// so vitest can exercise every branch. The two storage shapes an item can carry:
//
//   mediaRef: { h: <sha256 hex>, e: 'gif' | 'mp4' }   ← file lives on the server (MEDIA_MIGRATE)
//   gifData / gif: 'data:image/gif;base64,…'          ← inline base64, the pre-phase-4 shape
//
// The two never coexist on one item — migration replaces the inline shape with the reference.

// Validated accessor: a malformed reference (hand-edited backup, partial sync) reads as
// "no reference" instead of building a broken URL.
export function mediaRefOf(item) {
  const r = item?.mediaRef
  return r && /^[a-f0-9]{64}$/.test(r.h || '') && (r.e === 'gif' || r.e === 'mp4')
    ? { h: r.h, e: r.e }
    : null
}

// The one place that decides an item's <img>/<video> src: a same-origin URL for server
// media, the data-URL for inline media, null when the item has none. exercises.js gifSrc
// passes absolute-path URLs through untouched, so every Media caller can use this.
export function mediaSrc(item) {
  const ref = mediaRefOf(item)
  if (ref) return `/api/media/${ref.h}.${ref.e}`
  const d = item?.gifData || item?.gif
  return typeof d === 'string' && /^data:(image\/gif|video\/mp4);base64,/.test(d) ? d : null
}

const MIME_BY_EXT = { gif: 'image/gif', mp4: 'video/mp4' }

export function dataUrlToBytes(dataUrl) {
  const m = /^data:(image\/gif|video\/mp4);base64,(.+)$/.exec(String(dataUrl || ''))
  if (!m) throw new Error('not a gif/mp4 data-URL')
  const bin = atob(m[2])
  const bytes = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i)
  return { bytes, contentType: m[1], ext: m[1] === 'image/gif' ? 'gif' : 'mp4' }
}

// POST the raw bytes; the server sniffs magic bytes and answers { h, e, size } — or throws
// with the server's message (quota 413, wrong type 415, offline TypeError).
export async function uploadMedia(dataUrl, fetchFn = fetch) {
  const { bytes, contentType } = dataUrlToBytes(dataUrl)
  const res = await fetchFn('/api/media', { method: 'POST', headers: { 'Content-Type': contentType }, body: bytes })
  const data = await res.json().catch(() => ({}))
  if (!res.ok) { const e = new Error(data.error || `HTTP ${res.status}`); e.status = res.status; throw e }
  if (!/^[a-f0-9]{64}$/.test(data.h || '') || !MIME_BY_EXT[data.e]) throw new Error('bad upload response')
  return { h: data.h, e: data.e, size: data.size }
}

// Move every inline data-URL media in a state to the server, one item at a time, in order.
// A failed upload (offline, quota, …) leaves that item exactly as it was and continues —
// data is never dropped before its replacement is confirmed. Idempotent: a fully migrated
// state runs zero uploads. Returns a new object; the input is untouched.
export async function migrateStateMedia(state, uploadFn) {
  const next = JSON.parse(JSON.stringify(state))
  let migrated = 0, failed = 0
  const handle = async item => {
    if (!item || item.mediaRef) {           // already a reference — defensive: drop a stray
      if (item && item.mediaRef) { delete item.gifData; delete item.gif }  // …inline copy
      return
    }
    const d = item.gifData || item.gif
    if (typeof d !== 'string' || !/^data:(image\/gif|video\/mp4);base64,/.test(d)) return
    try {
      const r = await uploadFn(d)
      if (!r?.h || (r.e !== 'gif' && r.e !== 'mp4')) throw new Error('bad upload response')
      item.mediaRef = { h: r.h, e: r.e }
      delete item.gifData
      delete item.gif
      migrated++
    } catch { failed++ }
  }
  for (const r of next.routines || []) for (const e of r.ex || []) await handle(e)
  for (const c of next.customEx || []) await handle(c)
  return { state: next, migrated, failed }
}
