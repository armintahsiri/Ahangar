import { useStore, hasData } from '../store/useStore.js'
import { useUI } from '../store/useUI.js'
import { registerAccount, signIn, api } from '../lib/api.js'
import { t } from '../lib/i18n.js'
import { DEMO, REPO } from '../lib/demo.js'
import { useState, useEffect } from 'react'
import Icon from '../components/Icon.jsx'
import { Button } from '../components/ui.jsx'

function AccountSheet({ close, registering }) {
  const { setUser, pushState, pullState } = useStore()
  const [name, setName] = useState('')
  const [phone, setPhone] = useState('')
  const [password, setPassword] = useState('')
  const [confirmPassword, setConfirmPassword] = useState('')
  const [code, setCode] = useState('')
  const [inviteOnly, setInviteOnly] = useState(false)
  const [busy, setBusy] = useState(false)
  useEffect(() => { api('/api/config').then(c => setInviteOnly(!!c.invite_only)).catch(() => {}) }, [])
  const go = async () => {
    if (busy) return
    if (!phone.trim() || !password) { useUI.getState().toast(t('Enter your mobile number and password')); return }
    if (registering && !name.trim()) { useUI.getState().toast(t('Enter a name')); return }
    if (registering && password.length < 8) { useUI.getState().toast(t('Password must be at least 8 characters')); return }
    if (registering && password !== confirmPassword) { useUI.getState().toast(t('Passwords do not match')); return }
    if (registering && inviteOnly && !code.trim()) { useUI.getState().toast(t('An invite code is required')); return }
    setBusy(true)
    try {
      const u = registering
        ? await registerAccount({ name: name.trim(), phone, password, code: code.trim() })
        : await signIn(phone, password)
      setUser(u); close()
      if (registering && hasData(useStore.getState().S)) { await pushState(); useUI.getState().toast(t('Profile created — data from this device moved into it')) }
      else { await pullState(); useUI.getState().toast(t('Welcome, {0}', u.name)) }
    } catch (e) { useUI.getState().toast(e.message || (registering ? t('Registration failed') : t('Sign-in failed'))) }
    finally { setBusy(false) }
  }
  return <>
    <h3>{registering ? t('Create your profile') : t('Sign in')}</h3>
    {registering && <><input autoFocus className="input" placeholder={t('Your name')} maxLength={40} value={name} onChange={e => setName(e.target.value)} /><div style={{ height: 10 }} /></>}
    <input className="input" type="tel" inputMode="tel" autoComplete="tel" placeholder={t('Mobile number')} value={phone} onChange={e => setPhone(e.target.value)} />
    <div style={{ height: 10 }} />
    <input className="input" type="password" autoComplete={registering ? 'new-password' : 'current-password'} placeholder={t('Password')} maxLength={200} value={password} onChange={e => setPassword(e.target.value)} onKeyDown={e => { if (e.key === 'Enter') go() }} />
    {registering && <><div style={{ height: 10 }} /><input className="input" type="password" autoComplete="new-password" placeholder={t('Confirm password')} maxLength={200} value={confirmPassword} onChange={e => setConfirmPassword(e.target.value)} onKeyDown={e => { if (e.key === 'Enter') go() }} /><div className="dim small" style={{ marginTop: 6 }}>{t('Use at least 8 characters. Your password is stored securely as a one-way hash.')}</div>
      <div className="dim small" style={{ marginTop: 8, lineHeight: 1.5 }}>{t('Your gym owner (admin) can view your workout history, body-weight log and mobile number. If a coach is assigned to you, they see your logged workouts to guide your training. Nothing is shared beyond this server.')}</div></>}
    {registering && inviteOnly && <><div style={{ height: 10 }} /><input className="input" placeholder={t('Invite code')} maxLength={40} value={code} onChange={e => setCode(e.target.value.toUpperCase())} style={{ letterSpacing: '.14em', fontWeight: 600, textAlign: 'center' }} /><div className="dim small" style={{ marginTop: 6 }}>{t('This app is invite-only — enter the code you were given.')}</div></>}
    <div style={{ height: 12 }} /><Button variant="primary" onClick={go} disabled={busy}>{registering ? t('Create account') : t('Sign in')}</Button>
  </>
}

export default function Login() {
  const { setGuest } = useStore()
  const clubName = useStore(s => s.clubName)
  const head = <><div style={{ fontSize: 54, display: 'flex', justifyContent: 'center', color: 'var(--acc)' }}><Icon name="dumbbell" /></div><h1 style={{ fontSize: 34, fontWeight: 700, letterSpacing: '-.028em', margin: '10px 0 4px' }}>{clubName}</h1></>
  const wrap = { display: 'flex', flexDirection: 'column', justifyContent: 'center', minHeight: '78vh', textAlign: 'center' }
  if (DEMO) return <div className="narrow" style={wrap}>{head}<div className="muted" style={{ marginBottom: 30 }}>{t('Live demo — everything stays in this browser.')}</div><Button variant="primary" icon="sparkles" onClick={() => setGuest(true)}>{t('Start the demo')}</Button><div className="card small muted" style={{ textAlign: 'left', marginTop: 16 }}>{t('This demo runs entirely in your browser on example data — nothing is sent anywhere. Phone/password sign-in and sync across your devices come with the openGym server, which you get by self-hosting it.')}</div><div className="dim small" style={{ marginTop: 22, lineHeight: 1.6 }}><a href={REPO} target="_blank" rel="noopener">{t('Self-host it in a minute →')}</a></div></div>
  return <div className="narrow" style={wrap}>
    {head}<div className="muted" style={{ marginBottom: 34 }}>{t('Your workouts. Your weights. Your profile.')}</div>
    <Button variant="primary" icon="person" onClick={() => useUI.getState().openSheet(close => <AccountSheet close={close} registering={false} />)}>{t('Sign in')}</Button>
    <div style={{ height: 10 }} /><Button icon="sparkles" onClick={() => useUI.getState().openSheet(close => <AccountSheet close={close} registering />)}>{t('Create new profile')}</Button>
    <div className="dim small" style={{ marginTop: 26, lineHeight: 1.5 }}>{t('Sign in with your mobile number and password.')}<br />{t('Each profile keeps its own plan, workouts & body weight.')}</div>
  </div>
}
