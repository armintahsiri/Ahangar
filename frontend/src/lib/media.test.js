import { describe, it, expect } from 'vitest'
import { mediaRefOf, mediaSrc, dataUrlToBytes, uploadMedia, migrateStateMedia, exportInlineMedia, mediaHashesOf } from './media.js'
import { mergeStates } from './sync-merge.js'
import { hashKey } from './sync-merge.js'

const H1 = 'a'.repeat(64), H2 = 'b'.repeat(64)
const GIF_URL = 'data:image/gif;base64,R0lGODlhAQABAAAAADs='
const MP4_URL = 'data:video/mp4;base64,AAAAIGZ0eXBpc29t'

describe('mediaSrc / mediaRefOf', () => {
  it('reference → same-origin URL', () => {
    expect(mediaSrc({ mediaRef: { h: H1, e: 'gif' } })).toBe(`/api/media/${H1}.gif`)
    expect(mediaRefOf({ mediaRef: { h: H1, e: 'mp4' } })).toEqual({ h: H1, e: 'mp4' })
  })
  it('inline shapes pass through', () => {
    expect(mediaSrc({ gifData: GIF_URL })).toBe(GIF_URL)
    expect(mediaSrc({ gif: MP4_URL })).toBe(MP4_URL)
  })
  it('nothing → null, and malformed references are safe', () => {
    expect(mediaSrc({})).toBeNull()
    expect(mediaSrc({ mediaRef: { h: 'short', e: 'gif' } })).toBeNull()
    expect(mediaSrc({ mediaRef: { h: H1, e: 'exe' } })).toBeNull()
    // a malformed reference falls back to an inline copy if one is present
    expect(mediaSrc({ mediaRef: { h: 'zz' }, gifData: GIF_URL })).toBe(GIF_URL)
  })
})

describe('dataUrlToBytes / uploadMedia', () => {
  it('decodes bytes and kind', () => {
    const { bytes, contentType, ext } = dataUrlToBytes(GIF_URL)
    expect(ext).toBe('gif')
    expect(contentType).toBe('image/gif')
    expect(bytes[0]).toBe(0x47) // 'G'
  })
  it('upload posts raw bytes and returns the server answer', async () => {
    const seen = []
    const fetchFn = async (url, opts) => {
      seen.push({ url, opts })
      return { ok: true, json: async () => ({ h: H1, e: 'gif', size: 11 }) }
    }
    const r = await uploadMedia(GIF_URL, fetchFn)
    expect(r).toEqual({ h: H1, e: 'gif', size: 11 })
    expect(seen[0].url).toBe('/api/media')
    expect(seen[0].opts.headers['Content-Type']).toBe('image/gif')
    expect(seen[0].opts.body[0]).toBe(0x47)
  })
  it('server errors surface with their message and status', async () => {
    const fetchFn = async () => ({ ok: false, status: 413, json: async () => ({ error: 'quota reached' }) })
    await expect(uploadMedia(GIF_URL, fetchFn)).rejects.toMatchObject({ status: 413, message: 'quota reached' })
  })
})

describe('migrateStateMedia', () => {
  const base = () => ({
    rev: 3,
    routines: [{ id: 'r1', ex: [{ id: '0025', sets: 3, gifData: GIF_URL }, { id: '0043', sets: 2 }] }],
    customEx: [{ id: 'c1', n: 'Mine', gif: MP4_URL }]
  })

  it('converts both shapes, keeping everything else untouched', async () => {
    const uploads = [GIF_URL, MP4_URL]
    const { state, migrated, failed } = await migrateStateMedia(base(), async d => {
      expect(d).toBe(uploads.shift())
      return { h: H1, e: 'gif' }
    })
    expect(migrated).toBe(2)
    expect(failed).toBe(0)
    expect(state.routines[0].ex[0]).toEqual({ id: '0025', sets: 3, mediaRef: { h: H1, e: 'gif' } })
    expect(state.customEx[0].mediaRef).toEqual({ h: H1, e: 'gif' })
    expect(state.customEx[0].gif).toBeUndefined()
    expect(state.routines[0].ex[1]).toEqual({ id: '0043', sets: 2 }) // no media → untouched
    expect(state.rev).toBe(3) // rev belongs to the sync layer, not to this function
    expect(state).not.toBe(base()) // the input is never mutated
  })

  it('a failed upload leaves that item inline and the rest still migrate', async () => {
    const { state, migrated, failed } = await migrateStateMedia(base(), async d =>
      d === GIF_URL ? Promise.reject(new Error('offline')) : { h: H2, e: 'mp4' }
    )
    expect(migrated).toBe(1)
    expect(failed).toBe(1)
    expect(state.routines[0].ex[0].gifData).toBe(GIF_URL) // kept byte-for-byte
    expect(state.customEx[0].mediaRef).toEqual({ h: H2, e: 'mp4' })
  })

  it('is idempotent — a migrated state needs zero uploads the second time', async () => {
    let calls = 0
    const { state } = await migrateStateMedia(base(), async () => ({ h: H1, e: 'gif' }))
    const second = await migrateStateMedia(state, async () => { calls++; return { h: H1, e: 'gif' } })
    expect(calls).toBe(0)
    expect(second.migrated).toBe(0)
    expect(second.state).toEqual(state)
  })

  it('an item carrying both shapes collapses to the reference', async () => {
    const { state } = await migrateStateMedia(
      { routines: [], customEx: [{ id: 'c1', gifData: GIF_URL, mediaRef: { h: H1, e: 'gif' } }] },
      async () => { throw new Error('must not upload') }
    )
    expect(state.customEx[0]).toEqual({ id: 'c1', mediaRef: { h: H1, e: 'gif' } })
  })

  it('two devices migrating the same media converge — the merge sees one identical value', async () => {
    const before = base()
    const baseHashes = {}
    for (const k of Object.keys(before)) baseHashes[k] = hashKey(before[k])
    const uploadA = async () => ({ h: H1, e: 'gif' })
    const uploadB = async () => ({ h: H1, e: 'gif' }) // same bytes → same hash on the server
    const a = await migrateStateMedia(before, uploadA)
    const b = await migrateStateMedia(before, uploadB)
    const { conflicts, epochConflict, merged } = mergeStates({ baseHashes, local: a.state, server: b.state })
    expect(epochConflict).toBe(false)
    expect(conflicts).toEqual([])
    expect(merged.routines[0].ex[0].mediaRef).toEqual({ h: H1, e: 'gif' })
  })
})

describe('mediaHashesOf', () => {
  it('collects referenced hashes from routines and customs, skipping inline media', () => {
    const s = {
      routines: [
        { id: 'r1', ex: [{ id: '0025', mediaRef: { h: H1, e: 'gif' } }, { id: '0043', gifData: GIF_URL }] },
        { id: 'r2', ex: [] }
      ],
      customEx: [{ id: 'c1', mediaRef: { h: H2, e: 'mp4' } }]
    }
    expect([...mediaHashesOf(s)].sort()).toEqual([H1, H2].sort())
    expect(mediaHashesOf({}).size).toBe(0)
  })
})

describe('exportInlineMedia — self-contained backups', () => {
  const refState = {
    routines: [{ id: 'r1', ex: [{ id: '0025', mediaRef: { h: H1, e: 'gif' } }, { id: '0043', sets: 2 }] }],
    customEx: [{ id: 'c1', n: 'Mine', mediaRef: { h: H2, e: 'mp4' } }]
  }
  const bytes = n => new Uint8Array(n).map((_, i) => i % 251)
  it('inlines references so the backup is self-contained', async () => {
    const fetchFn = async url => {
      const h = url.includes(H1) ? bytes(40) : bytes(20)
      return { ok: true, arrayBuffer: async () => h.buffer }
    }
    const { state, failed } = await import('./media.js').then(m => m.exportInlineMedia(refState, fetchFn))
    expect(failed).toEqual([])
    expect(state.routines[0].ex[0].gifData).toMatch(/^data:image\/gif;base64,/)
    expect(state.routines[0].ex[0].mediaRef).toBeUndefined()
    expect(state.customEx[0].gif).toMatch(/^data:video\/mp4;base64,/)
    expect(state.routines[0].ex[1]).toEqual({ id: '0043', sets: 2 })
  })
  it('a failed fetch keeps the reference and reports the hash', async () => {
    const fetchFn = async url => url.includes(H1) ? { ok: true, arrayBuffer: async () => bytes(8).buffer } : { ok: false, status: 404 }
    const { state, failed } = await import('./media.js').then(m => m.exportInlineMedia(refState, fetchFn))
    expect(failed).toEqual([H2])
    expect(state.routines[0].ex[0].gifData).toMatch(/^data:image\/gif;base64,/)
    expect(state.customEx[0].mediaRef).toEqual({ h: H2, e: 'mp4' }) // untouched
  })
})

describe('state size — inline vs reference (3 × ~800 KB gifs)', () => {
  it('migration shrinks the synced state by orders of magnitude', async () => {
    const big = 'data:image/gif;base64,' + btoa('x'.repeat(800 * 1024))
    const st = { unit: 'kg', routines: [{ id: 'r1', ex: [{ id: '0025', gifData: big }, { id: '0043', gifData: big }, { id: '0085', gifData: big }] }], customEx: [] }
    const before = JSON.stringify(st).length
    const { state } = await migrateStateMedia(st, async () => ({ h: H1, e: 'gif' }))
    const after = JSON.stringify(state).length
    expect(after).toBeLessThan(before / 100)
  })
})
