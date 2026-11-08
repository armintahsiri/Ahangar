// Backend helpers for session-based phone/password accounts.
export const IS_APPLE = /iPhone|iPad|iPod|Macintosh/.test(navigator.userAgent)
export const IS_ANDROID = /Android/.test(navigator.userAgent)

export async function api(path, opts) {
  const o = Object.assign({ headers: { 'Content-Type': 'application/json' } }, opts)
  // A state PUT fired by the tab-close flush has to survive unload: keepalive does that,
  // but only for small bodies (the browser caps keepalive at 64 KB) — bigger syncs stay
  // on the normal path and wait for the next debounce.
  if (o.method === 'PUT' && path === '/api/data' && typeof o.body === 'string' && o.body.length < 60 * 1024) o.keepalive = true
  const r = await fetch(path, o)
  const data = await r.json().catch(() => ({}))
  if (!r.ok) { const e = new Error(data.error || ('HTTP ' + r.status)); e.status = r.status; throw e }
  return data
}

export async function registerAccount({ name, phone, password, code }) {
  const { user } = await api('/api/register', { method: 'POST', body: JSON.stringify({ name, phone, password, code }) })
  return user
}
export async function signIn(phone, password) {
  const { user } = await api('/api/login', { method: 'POST', body: JSON.stringify({ phone, password }) })
  return user
}
