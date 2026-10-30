// Backend helpers for session-based phone/password accounts.
export const IS_APPLE = /iPhone|iPad|iPod|Macintosh/.test(navigator.userAgent)
export const IS_ANDROID = /Android/.test(navigator.userAgent)

export async function api(path, opts) {
  const r = await fetch(path, Object.assign({ headers: { 'Content-Type': 'application/json' } }, opts))
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
export async function saveCredentials(phone, password) {
  const { user } = await api('/api/account/credentials', { method: 'POST', body: JSON.stringify({ phone, password }) })
  return user
}
