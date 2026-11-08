// Pure sync-status logic for the store's non-persistent `sync` field.
// Dependency-free on purpose: vitest can exercise it without DOM, storage or store imports.
// The status answers one question — "is what I see here what the server has?" — which a
// silently failed PUT (gym_dirty was the only trace before) never let the user ask.

// events: 'edit'    a change was made and a debounced push is scheduled
//         'send'    the PUT to /api/data is in flight
//         'success' the server accepted the state
//         'failure' the PUT failed — data is safe locally, the server copy is stale
//         'pull'    the server state was adopted (sign-in / boot)
//         'reset'   signed out or no profile — nothing to sync
export function nextSync(cur, evt) {
  const prev = cur || { status: 'idle', at: null }
  switch (evt.type) {
    case 'edit':
    case 'send':    return { status: 'pending', at: prev.at }
    case 'success':
    case 'pull':    return { status: 'synced', at: evt.at }
    case 'failure': return { status: 'failed', at: evt.at }
    case 'reset':   return { status: 'idle', at: null }
    default:        return prev
  }
}

// One line of UI text for the current status. The component supplies t() and its own time
// formatter so this stays pure. `storageError` outranks sync — if the device cannot even
// write locally, that is the thing to say.
export function describeSync(sync, storageError, t, fmtWhen) {
  if (storageError) return { tone: 'error', icon: 'xmark', text: t('Device storage is full — changes may not persist. Export a backup and free up space.') }
  switch (sync?.status) {
    case 'failed':  return { tone: 'error', icon: 'xmark', text: t('Sync failed — your data is safe on this device and will sync later.') }
    case 'pending': return { tone: 'pending', icon: 'clock', text: t('Waiting to sync…') }
    case 'synced':  return { tone: 'ok', icon: 'check', text: sync.at && fmtWhen ? t('Synced · {0}', fmtWhen(sync.at)) : t('Synced') }
    default:        return { tone: 'ok', icon: 'reset', text: t('Not synced yet') }
  }
}
