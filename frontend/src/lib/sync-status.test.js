import { describe, it, expect } from 'vitest'
import { nextSync, describeSync } from './sync-status.js'

// mirrors lib/i18n.js t(): source string is the key, {0},{1}… are replaced with args
const t = (s, ...args) => args.reduce((v, a, i) => v.replaceAll('{' + i + '}', String(a)), s)

describe('sync status transitions', () => {
  it('starts idle from nothing', () => {
    expect(nextSync(undefined, { type: 'reset' })).toEqual({ status: 'idle', at: null })
  })

  it('edit and send go pending and keep the last success time', () => {
    const synced = { status: 'synced', at: 100 }
    expect(nextSync(synced, { type: 'edit' })).toEqual({ status: 'pending', at: 100 })
    expect(nextSync(synced, { type: 'send' })).toEqual({ status: 'pending', at: 100 })
  })

  it('success and pull mark synced with the event time', () => {
    expect(nextSync(null, { type: 'success', at: 5 })).toEqual({ status: 'synced', at: 5 })
    expect(nextSync(null, { type: 'pull', at: 7 })).toEqual({ status: 'synced', at: 7 })
  })

  it('failure marks failed with the event time', () => {
    expect(nextSync({ status: 'pending', at: 1 }, { type: 'failure', at: 9 })).toEqual({ status: 'failed', at: 9 })
  })

  it('reset clears back to idle', () => {
    expect(nextSync({ status: 'failed', at: 9 }, { type: 'reset' })).toEqual({ status: 'idle', at: null })
  })

  it('unknown events leave the status alone', () => {
    const cur = { status: 'failed', at: 3 }
    expect(nextSync(cur, { type: 'nope' })).toBe(cur)
  })
})

describe('describeSync', () => {
  it('storage errors outrank the sync status', () => {
    const d = describeSync({ status: 'synced', at: 1 }, true, t, null)
    expect(d.tone).toBe('error')
    expect(d.text).toMatch(/storage is full/)
  })

  it('failed sync says data is safe locally', () => {
    const d = describeSync({ status: 'failed', at: 1 }, false, t, null)
    expect(d.tone).toBe('error')
    expect(d.text).toMatch(/safe on this device/)
  })

  it('pending is pending', () => {
    expect(describeSync({ status: 'pending', at: null }, false, t, null).text).toMatch(/Waiting to sync/)
  })

  it('synced shows the last success time through the given formatter', () => {
    expect(describeSync({ status: 'synced', at: 42 }, false, t, () => '08:00').text).toBe('Synced · 08:00')
  })

  it('synced without a formatter or time stays short', () => {
    expect(describeSync({ status: 'synced', at: null }, false, t, null).text).toBe('Synced')
    expect(describeSync({ status: 'synced', at: 1 }, false, t, null).text).toBe('Synced')
  })

  it('idle reads as not synced yet', () => {
    expect(describeSync(null, false, t, null).text).toBe('Not synced yet')
  })
})
