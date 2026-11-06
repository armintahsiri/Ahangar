import { useEffect, useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { useStore } from '../store/useStore.js'
import { useUI } from '../store/useUI.js'
import { api } from '../lib/api.js'
import { t } from '../lib/i18n.js'
import { fmtDate, fmtNum, fmtVol, fmtDur } from '../lib/format.js'
import { workoutVolume, setsDone } from '../lib/history.js'
import { confirmSheet } from '../sheets.jsx'
import Icon from '../components/Icon.jsx'
import { Button } from '../components/ui.jsx'

// Admin-only operator dashboard (admin flag; guarded again server-side).
// Strings go through the standard t() packs like the rest of the UI.

const rel = ts => {
  if (!ts) return t('never')
  const s = Math.max(0, (Date.now() - ts) / 1000)
  if (s < 60) return t('just now')
  if (s < 3600) return t('{0}m ago', Math.floor(s / 60))
  if (s < 86400) return t('{0}h ago', Math.floor(s / 3600))
  return t('{0}d ago', Math.floor(s / 86400))
}
const dur = ms => { const m = Math.max(0, Math.floor(ms / 60000)); return m < 60 ? t('{0} min', m) : t('{0}h {1}m', Math.floor(m / 60), m % 60) }
const displayPhone = phone => {
  if (!phone) return '—'
  const local = phone.startsWith('+98') ? `0${phone.slice(3)}` : phone
  return local
}

// Admin sets a member's password. The password is typed (or generated) by the admin on
// purpose — it is a credential they will hand to the member in person, so the field is
// plain text rather than masked, and no old password can be shown (they're hashed).
function ResetPasswordSheet({ id, name, close }) {
  const toast = useUI(s => s.toast)
  const passwordInput = useRef(null)
  const [pw, setPw] = useState('')
  const [pw2, setPw2] = useState('')
  const [busy, setBusy] = useState(false)
  const generate = () => {
    // digits 2-9 + letters without I/O — 32 symbols, no 0/O/1, readable aloud over the phone
    const abc = '23456789ABCDEFGHJKLMNPQRSTUVWXYZ'
    const bytes = crypto.getRandomValues(new Uint8Array(10))
    const p = Array.from(bytes, b => abc[b % 32]).join('')
    setPw(p); setPw2(p)
  }
  const go = () => {
    if (busy) return
    if (pw.length < 8) { toast(t('Password must be at least 8 characters')); return }
    if (pw !== pw2) { toast(t('Passwords do not match')); return }
    setBusy(true)
    api('/api/admin/user/password', { method: 'POST', body: JSON.stringify({ id, password: pw }) })
      .then(() => { setPw(''); setPw2(''); toast(t('Password updated')); close() })
      .catch(e => toast(e.message))
      .finally(() => setBusy(false))
  }
  const copyPassword = async () => {
    if (!pw) return
    try {
      if (navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(pw)
        toast(t('Password copied'))
        return
      }
    } catch { /* HTTP/LAN origins may block the Clipboard API; try the browser copy command. */ }

    const input = passwordInput.current
    try {
      input?.focus()
      input?.select()
      input?.setSelectionRange(0, input.value.length)
      if (document.execCommand?.('copy')) {
        toast(t('Password copied'))
        return
      }
    } catch { /* Leave the password selected so the admin can copy it manually. */ }
    toast(t('Copy unavailable — password selected'))
  }
  return <>
    <h3>{t('New password for {0}', name)}</h3>
    <div className="muted small" style={{ marginBottom: 12, lineHeight: 1.5 }}>{t('They will be signed out everywhere and must sign in with the new password.')}</div>
    <input ref={passwordInput} className="input" type="text" autoComplete="off" autoCorrect="off" autoCapitalize="none" spellCheck={false} maxLength={200} placeholder={t('Password')} value={pw} onChange={e => setPw(e.target.value)} />
    <div style={{ height: 10 }} />
    <input className="input" type="text" autoComplete="off" autoCorrect="off" autoCapitalize="none" spellCheck={false} maxLength={200} placeholder={t('Confirm password')} value={pw2} onChange={e => setPw2(e.target.value)} onKeyDown={e => { if (e.key === 'Enter') go() }} />
    <div className="row" style={{ gap: 8, marginBottom: 12 }}>
      <Button size="sm" icon="reset" onClick={generate}>{t('Generate password')}</Button>
      <Button size="sm" icon="copy" onClick={copyPassword} disabled={!pw}>{t('Copy password')}</Button>
    </div>
    <Button variant="primary" onClick={go} disabled={busy}>{t('Reset password')}</Button>
  </>
}

function UserDetail({ id, users, meId, onChanged, close }) {
  const [d, setD] = useState(null)
  const toast = useUI(s => s.toast)
  const openSheet = useUI(s => s.openSheet)
  const load = () => api('/api/admin/user?id=' + encodeURIComponent(id)).then(setD).catch(e => toast(e.message))
  useEffect(() => { load() }, [id])
  if (!d) return <div className="muted small">{t('Loading…')}</div>
  const u = d.user
  const setDisabled = disabled => {
    api('/api/admin/user/disable', { method: 'POST', body: JSON.stringify({ id: u.id, disabled }) })
      .then(() => { toast(disabled ? t('User disabled') : t('User enabled')); onChanged(); close() })
      .catch(e => toast(e.message))
  }
  const setAdmin = flag => {
    api('/api/admin/user/admin', { method: 'POST', body: JSON.stringify({ id: u.id, admin: flag }) })
      .then(() => { toast(flag ? t('{0} is now an admin', u.name) : t('Admin access removed')); onChanged(); close() })
      .catch(e => toast(e.message))
  }
  const setCoach = (coachId, pickerClose) => {
    api('/api/admin/user/coach', { method: 'POST', body: JSON.stringify({ id: u.id, coachId }) })
      .then(r => { toast(r.coach ? t('Assigned to {0}', r.coach.name) : t('Coach removed')); pickerClose?.(); load(); onChanged() })
      .catch(e => toast(e.message))
  }
  const pickCoach = () => {
    const coaches = (users || []).filter(x => x.role === 'coach' && !x.disabled && x.id !== u.id)
    openSheet(pclose => <div style={{ padding: 16 }}>
      <h3 style={{ marginTop: 0 }}>{t('Assign coach to {0}', u.name)}</h3>
      {coaches.length ? <div className="list">{coaches.map(c => <button key={c.id} className="lrow tap" onClick={() => setCoach(c.id, pclose)}>
        <span className="lrow-m"><span className="lrow-t">{c.name}</span></span>
        {u.coach?.id === c.id && <Icon name="check" className="lrow-k" />}
      </button>)}</div>
        : <div className="empty small">{t('No coaches yet — promote a member to coach first.')}</div>}
    </div>)
  }
  return <>
    <h3 className="capitalize">{u.name}</h3>
    <div className="row" style={{ gap: 6, flexWrap: 'wrap', margin: '8px 0 12px' }}>
      {u.admin && <span className="tag acc">{t('admin')}</span>}
      {!u.admin && <span className="tag" style={{ color: u.role === 'coach' ? 'var(--blue)' : undefined }}>{u.role === 'coach' ? t('coach') : t('member')}</span>}
      {u.disabled && <span className="tag" style={{ color: 'var(--red)' }}>{t('disabled')}</span>}
      {u.invitedBy && <span className="tag">{t('invite {0}', u.invitedBy)}</span>}
      <span className="tag">{t('joined {0}', u.created ? fmtDate(u.created.slice(0, 10)) : '—')}</span>
    </div>
    <div className="row between" style={{ padding: '8px 2px', borderBottom: '1px solid var(--sep)' }}>
      <span className="small muted">{t('Mobile number')}</span>
      <b className="small" dir="ltr" style={{ fontVariantNumeric: 'tabular-nums' }}>{displayPhone(u.phone)}</b>
    </div>
    <div className="tiles" style={{ textAlign: 'start' }}>
      <div className="tile"><div className="l">{t('Workouts')}</div><div className="v" style={{ fontSize: '1.1rem' }}>{d.workouts.length}</div></div>
      <div className="tile"><div className="l">{t('Weigh-ins')}</div><div className="v" style={{ fontSize: '1.1rem' }}>{d.bodyweight.length}</div></div>
      <div className="tile"><div className="l">{t('Routines')}</div><div className="v" style={{ fontSize: '1.1rem' }}>{d.routines.length}</div></div>
      <div className="tile"><div className="l">{t('Last sync')}</div><div className="v" style={{ fontSize: '.95rem' }}>{rel(d.lastSync)}</div></div>
    </div>
    {!u.admin && u.role !== 'coach' && <div className="row between" style={{ margin: '10px 0 4px', padding: '9px 2px', borderBottom: '1px solid var(--sep)' }}>
      <div className="small" style={{ fontWeight: 600 }}>{t('Coach')}</div>
      <div className="row" style={{ gap: 8 }}>
        <span className="small muted">{u.coach ? u.coach.name : t('none')}</span>
        {u.coach && <button className="iconbtn" style={{ width: 32, height: 30, borderRadius: 8, fontSize: 15, color: 'var(--red)' }}
          onClick={() => confirmSheet({ title: t('Remove coach?'), message: t('{0} will no longer be under {1}, and their assigned program is deleted.', u.name, u.coach.name), confirmText: t('Remove'), danger: true, onConfirm: () => setCoach(null) })}
          aria-label={t('remove coach')}><Icon name="trash" /></button>}
        <button className="btn sm" onClick={pickCoach}>{u.coach ? t('Change') : t('Assign')}</button>
      </div>
    </div>}
    {!u.admin && <button className="btn" style={{ margin: '8px 0 4px' }} onClick={() => {
      const role = u.role === 'coach' ? 'member' : 'coach'
      api('/api/admin/user/role', { method: 'POST', body: JSON.stringify({ id: u.id, role }) })
        .then(() => { toast(role === 'coach' ? t('Coach access enabled') : t('Coach access removed')); onChanged(); close() })
        .catch(e => toast(e.message))
    }}>{u.role === 'coach' ? t('Remove coach access') : t('Make coach')}</button>}
    {/* password reset is member-only, like disable — an admin account is off-limits (server refuses too) */}
    {!u.admin && !u.envAdmin && <button className="btn" style={{ margin: '8px 0 4px' }}
      onClick={() => openSheet(pclose => <ResetPasswordSheet id={u.id} name={u.name} close={pclose} />)}>{t('Reset password')}</button>}
    {u.id !== meId && !u.envAdmin && <button className="btn" style={{ margin: '8px 0 4px' }} onClick={() => u.admin
      ? confirmSheet({ title: t('Remove admin from {0}?', u.name), message: t('They immediately lose access to this dashboard.'), confirmText: t('Remove admin'), danger: true, onConfirm: () => setAdmin(false) })
      : confirmSheet({ title: t('Make {0} an admin?', u.name), message: t("Admins can see every member's data, disable accounts, promote coaches and assign members to coaches."), confirmText: t('Make admin'), onConfirm: () => setAdmin(true) })
    }>{u.admin ? t('Remove admin') : t('Make admin')}</button>}
    {!u.admin && <button className={'btn ' + (u.disabled ? 'primary' : 'danger')} style={{ margin: '12px 0 4px' }}
      onClick={() => u.disabled ? setDisabled(false)
        : confirmSheet({ title: t('Disable {0}?', u.name), message: t('They are signed out everywhere and can no longer sync or log in until re-enabled.'), confirmText: t('Disable'), danger: true, onConfirm: () => setDisabled(true) })}>
      {u.disabled ? t('Enable account') : t('Disable account')}</button>}
    <h4 className="sec">{t('Workout history')}</h4>
    {d.workouts.length ? <div className="list" style={{ gap: 0 }}>
      {d.workouts.slice(0, 60).map(w => <div key={w.id} className="row between" style={{ padding: '9px 2px', borderBottom: '1px solid var(--sep)' }}>
        <div><div className="small" style={{ fontWeight: 600 }}>{w.name}</div>
          <div className="dim" style={{ fontSize: '.72rem' }}>{fmtDate(w.d, true)} · {fmtDur((w.end || w.start) - w.start)} · {t('{0} sets', setsDone(w))}{w.prs?.length ? ' · ' + t('{0} PR', w.prs.length) : ''}</div></div>
        <span className="small muted">{fmtVol(w.vol ?? workoutVolume(w), d.unit)}</span>
      </div>)}
    </div> : <div className="empty small">{t('No workouts logged.')}</div>}
  </>
}

function InvitesCard({ invites, reload }) {
  const toast = useUI(s => s.toast)
  const gen = () => api('/api/admin/invites/new', { method: 'POST', body: '{}' })
    .then(({ invite }) => { navigator.clipboard?.writeText(invite.code).catch(() => {}); toast(t('Code {0} created & copied', invite.code)); reload() })
    .catch(e => toast(e.message))
  const revoke = code => api('/api/admin/invites/revoke', { method: 'POST', body: JSON.stringify({ code }) })
    .then(() => { toast(t('Code revoked')); reload() }).catch(e => toast(e.message))
  const open = (invites || []).filter(i => !i.usedBy)
  const used = (invites || []).filter(i => i.usedBy)
  return <div className="card">
    <div className="row between"><h2 style={{ margin: 0 }}>{t('Invite codes')}</h2>
      <Button variant="primary" size="sm" onClick={gen} icon="plus">{t('Generate')}</Button></div>
    <div className="small muted" style={{ margin: '6px 0 10px' }}>{t('{0} unused · {1} redeemed', open.length, used.length)}</div>
    {open.map(i => <div key={i.code} className="row between" style={{ padding: '7px 2px', borderBottom: '1px solid var(--sep)' }}>
      <span style={{ fontFamily: 'ui-monospace,SFMono-Regular,Menlo,monospace', fontWeight: 500, letterSpacing: '.06em' }}
        onClick={() => { navigator.clipboard?.writeText(i.code).catch(() => {}); toast(t('Copied {0}', i.code)) }}>{i.code}</span>
      <button className="iconbtn" style={{ width: 32, height: 30, borderRadius: 8, fontSize: 15, color: 'var(--red)' }} onClick={() => revoke(i.code)} aria-label={t('revoke')}><Icon name="trash" /></button>
    </div>)}
    {used.map(i => <div key={i.code} className="row between dim" style={{ padding: '7px 2px', fontSize: '.8rem' }}>
      <span style={{ fontFamily: 'monospace' }}>{i.code}</span><span>→ {i.usedByName || t('used')}</span>
    </div>)}
    {!open.length && !used.length && <div className="dim small">{t('No codes yet — generate one to invite someone.')}</div>}
  </div>
}

export default function Admin() {
  const nav = useNavigate()
  const user = useStore(s => s.user)
  const toast = useUI(s => s.toast)
  const openSheet = useUI(s => s.openSheet)
  const [users, setUsers] = useState(null)
  const [invites, setInvites] = useState(null)
  const [inviteOnly, setInviteOnly] = useState(false)

  const loadUsers = () => api('/api/admin/users').then(d => { setUsers(d.users); setInviteOnly(d.invite_only) }).catch(e => toast(e.message || t('Failed to load')))
  const loadInvites = () => api('/api/admin/invites').then(d => setInvites(d.invites)).catch(() => {})
  // poll every 15s so the "training now" section stays live without a manual refresh
  useEffect(() => { if (!user?.admin) return; loadUsers(); loadInvites(); const iv = setInterval(loadUsers, 15000); return () => clearInterval(iv) }, [])
  if (!user?.admin) return null

  const openUser = id => openSheet(close => <UserDetail id={id} users={users} meId={user.id} onChanged={loadUsers} close={close} />)
  const liveUsers = (users || []).filter(u => u.live)
  const activeCount = (users || []).filter(u => u.lastSync && Date.now() - u.lastSync < 7 * 86400000).length
  const disabledCount = (users || []).filter(u => u.disabled).length

  return <div className="narrow">
    <div className="hdr">
      <button className="iconbtn" onClick={() => nav('/settings')} aria-label={t('Back')}><Icon name="chevronLeft" /></button>
      <div style={{ flex: 1, marginInlineStart: 8 }}><h1 style={{ margin: 0 }}>{t('Admin')}</h1>
        <div className="sub">{users ? t('{0} users · {1} active this week', users.length, activeCount) : t('Loading…')}</div></div>
      <button className="iconbtn" onClick={() => { loadUsers(); loadInvites() }} aria-label={t('Refresh')}>↻</button>
    </div>

    <div className="tiles" style={{ marginBottom: 12 }}>
      <div className="tile"><div className="l">{t('Users')}</div><div className="v">{users ? users.length : '—'}</div></div>
      <div className="tile"><div className="l">{t('Training now')}</div><div className="v" style={{ color: liveUsers.length ? 'var(--acc)' : undefined }}>{users ? liveUsers.length : '—'}</div></div>
      <div className="tile"><div className="l">{t('Active 7d')}</div><div className="v">{users ? activeCount : '—'}</div></div>
      <div className="tile"><div className="l">{t('Disabled')}</div><div className="v">{users ? disabledCount : '—'}</div></div>
    </div>

    {liveUsers.length > 0 && <div className="card" style={{ borderColor: 'var(--acc)' }}>
      <h2 className="row" style={{ margin: '0 0 8px', gap: 6 }}><Icon name="dot" style={{ fontSize: 10, color: 'var(--green)' }} />{t('Training now')}</h2>
      {liveUsers.map(u => <div key={u.id} className="row between" style={{ padding: '8px 2px', borderBottom: '1px solid var(--sep)' }} onClick={() => openUser(u.id)}>
        <div><div className="small" style={{ fontWeight: 600 }}>{u.name}</div>
          <div className="dim" style={{ fontSize: '.72rem' }}>{u.live.name} · {t('ex {0}/{1}', u.live.exIdx, u.live.exTotal)} · {t('{0}/{1} sets', u.live.setsDone, u.live.setsTotal)}</div></div>
        <span className="tag acc">{dur(Date.now() - u.live.startedAt)}</span>
      </div>)}
    </div>}

    <InvitesCard invites={invites} reload={loadInvites} />

    <h4 className="sec">{t('Users')}</h4>
    <div className="list">
      {(users || []).map(u => <div key={u.id} className="item" onClick={() => openUser(u.id)} style={u.disabled ? { opacity: .55 } : null}>
        <div className="grow"><div className="tt">{u.live && <Icon name="dot" style={{ fontSize: 9, color: 'var(--green)', display: 'inline-block', marginInlineStart: 5 }} />}{u.name} {u.admin && <span className="tag acc" style={{ marginInlineStart: 4 }}>{t('admin')}</span>}{!u.admin && u.role === 'coach' && <span className="tag" style={{ marginInlineStart: 4, color: 'var(--blue)' }}>{t('coach')}</span>}{!u.admin && u.role !== 'coach' && !u.coach && !u.disabled && <span className="tag" style={{ marginInlineStart: 4, color: 'var(--yellow)' }}>{t('no coach')}</span>}{u.disabled && <span className="tag" style={{ marginInlineStart: 4, color: 'var(--red)' }}>{t('off')}</span>}</div>
          <div className="ss" style={{ color: 'var(--label)' }}>
            <div>{t('Mobile number')}: <b dir="ltr" style={{ unicodeBidi: 'isolate', fontVariantNumeric: 'tabular-nums' }}>{displayPhone(u.phone)}</b></div>
            <div>{u.live ? t('training now · {0}', u.live.name) : [t('{0} workouts', u.workouts), u.lastWorkout ? t('last {0}', fmtDate(u.lastWorkout)) : null, u.coach ? t('coach: {0}', u.coach.name) : null, t('synced {0}', rel(u.lastSync))].filter(Boolean).join(' · ')}</div>
          </div></div>
        {u.hasPush && <Icon name="bell" title={t('push enabled')} style={{ fontSize: 15, color: 'var(--label-3)' }} />}<Icon name="chevronRight" className="chev" />
      </div>)}
      {users && !users.length && <div className="empty">{t('No users yet.')}</div>}
    </div>
  </div>
}
