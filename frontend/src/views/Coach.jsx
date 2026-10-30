import { useEffect, useMemo, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { api } from '../lib/api.js'
import { useStore } from '../store/useStore.js'
import { useUI } from '../store/useUI.js'
import { DAYN } from '../lib/format.js'
import { EXIDX } from '../lib/exercises.js'
import { setLabel } from '../lib/history.js'
import { t } from '../lib/i18n.js'
import Icon from '../components/Icon.jsx'
import { Button } from '../components/ui.jsx'
import { exCount } from '../lib/format.js'

const DAYS = [1, 2, 3, 4, 5, 6, 0]
const emptyWeek = () => Object.fromEntries(DAYS.map(d => [String(d), 'rest']))

export default function Coach() {
  const nav = useNavigate()
  const user = useStore(s => s.user)
  const allRoutines = useStore(s => s.S.routines)
  const routines = allRoutines.filter(r => !r.coachManaged)
  const toast = useUI(s => s.toast)
  const [clients, setClients] = useState([])
  const [selected, setSelected] = useState('')
  const [sourceRoutine, setSourceRoutine] = useState('')
  const [day, setDay] = useState('1')
  const [detail, setDetail] = useState(null)
  const [invite, setInvite] = useState('')
  const [busy, setBusy] = useState(false)
  const selectedClient = useMemo(() => clients.find(c => c.id === selected) || null, [clients, selected])

  const reload = async (keep = selected) => {
    try {
      const { clients: rows } = await api('/api/coach/clients')
      setClients(rows)
      const nextId = keep && rows.some(c => c.id === keep) ? keep : (rows[0]?.id || '')
      setSelected(nextId)
      if (nextId) api('/api/coach/client?id=' + encodeURIComponent(nextId)).then(setDetail).catch(() => {})
    } catch (e) { toast(e.message || t('Could not load clients')) }
  }
  useEffect(() => { reload('') }, [])
  useEffect(() => {
    if (!selected) { setDetail(null); return }
    api('/api/coach/client?id=' + encodeURIComponent(selected)).then(setDetail).catch(e => toast(e.message))
  }, [selected])

  const makeInvite = async () => {
    try {
      const { invite: item } = await api('/api/coach/invites/new', { method: 'POST', body: '{}' })
      setInvite(item.code)
      navigator.clipboard?.writeText(item.code).catch(() => {})
      toast(t('Invite code copied'))
    } catch (e) { toast(e.message || t('Could not create invite')) }
  }

  const saveAssignment = async next => {
    if (!selectedClient) return
    setBusy(true)
    try {
      const { assignment } = await api('/api/coach/assignment', {
        method: 'PUT', body: JSON.stringify({ memberId: selectedClient.id, routines: next.routines, week: next.week })
      })
      setClients(rows => rows.map(c => c.id === selectedClient.id ? { ...c, assignment } : c))
      setDetail(d => d ? { ...d, assignment } : d)
      toast(t('Assigned program updated'))
    } catch (e) { toast(e.message || t('Could not update program')) }
    finally { setBusy(false) }
  }

  const assign = async () => {
    const source = routines.find(r => r.id === sourceRoutine)
    if (!source || !selectedClient) return
    const current = selectedClient.assignment || { routines: [], week: {} }
    const assignedId = 'coach-' + source.id
    const nextRoutines = [...(current.routines || []).filter(r => r.id !== assignedId), {
      id: assignedId, name: source.name, emoji: source.emoji, prog: source.prog, ex: source.ex.map(e => ({ ...e }))
    }]
    const nextWeek = { ...emptyWeek(), ...(current.week || {}), [day]: assignedId }
    await saveAssignment({ routines: nextRoutines, week: nextWeek })
  }

  const unassign = async dayKey => {
    if (!selectedClient?.assignment) return
    const current = selectedClient.assignment
    const nextWeek = { ...emptyWeek(), ...(current.week || {}), [dayKey]: 'rest' }
    const used = new Set(Object.values(nextWeek).filter(id => id && id !== 'rest'))
    await saveAssignment({ routines: (current.routines || []).filter(r => used.has(r.id)), week: nextWeek })
  }

  if (!user?.admin && user?.role !== 'coach') return null
  return <div className="narrow">
    <div className="hdr">
      <button className="iconbtn" onClick={() => nav('/home')} aria-label={t('Back')}><Icon name="chevronLeft" /></button>
      <div className="grow"><h1 style={{ margin: 0 }}>{t('Coach dashboard')}</h1><div className="sub">{t('{0} clients', clients.length)}</div></div>
      <button className="iconbtn" onClick={() => reload()} aria-label={t('Refresh')}>↻</button>
    </div>

    <div className="card">
      <h2 style={{ marginTop: 0 }}>{t('Invite a club member')}</h2>
      <div className="muted small">{t('Share this one-time code with a member. Their account will be linked to you.')}</div>
      <div style={{ height: 10 }} />
      <Button variant="primary" icon="plus" onClick={makeInvite}>{t('Create member invite')}</Button>
      {invite && <button className="input" style={{ marginTop: 10, textAlign: 'center', fontFamily: 'monospace', letterSpacing: '.12em' }} onClick={() => { navigator.clipboard?.writeText(invite).catch(() => {}); toast(t('Copied')) }}>{invite}</button>}
    </div>

    <h4 className="sec">{t('My clients')}</h4>
    {clients.length ? <div className="list">{clients.map(c => <div key={c.id} className={'item' + (selected === c.id ? ' selected' : '')} onClick={() => setSelected(c.id)}>
      <span className="lrow-i"><Icon name="person" /></span>
      <div className="grow"><div className="tt">{c.name}</div><div className="ss">{c.workouts} {t('workouts')} · {c.assignment?.routines?.length || 0} {t('assigned routines')}</div></div>
      {c.disabled && <span className="tag">{t('Disabled')}</span>}
    </div>)}</div> : <div className="empty">{t('No clients yet. Invite a member to get started.')}</div>}

    {selectedClient && <>
      <div className="row between" style={{ marginTop: 20 }}><h4 className="sec" style={{ margin: 0 }}>{t('Program for {0}', selectedClient.name)}</h4><Button size="sm" onClick={() => nav('/plan')}>{t('My templates')}</Button></div>
      <div className="card">
        <div className="muted small">{t('Create or edit a routine in My Plan, then assign a separate snapshot to this client. Later edits to your template do not change the client’s assigned plan.')}</div>
        <div style={{ height: 12 }} />
        {routines.length ? <>
          <select className="input" value={sourceRoutine} onChange={e => setSourceRoutine(e.target.value)}>
            <option value="">{t('Choose a routine template')}</option>
            {routines.map(r => <option value={r.id} key={r.id}>{r.name}</option>)}
          </select>
          <div style={{ height: 8 }} />
          <select className="input" value={day} onChange={e => setDay(e.target.value)}>
            {DAYS.map(d => <option value={String(d)} key={d}>{t(DAYN[d])}</option>)}
          </select>
          <div style={{ height: 10 }} />
          <Button variant="primary" icon="check" disabled={!sourceRoutine || busy} onClick={assign}>{t('Assign routine to this day')}</Button>
        </> : <div className="small muted">{t('Create a routine in My Plan before assigning one.')}</div>}
      </div>

      <h4 className="sec">{t('Assigned weekly plan')}</h4>
      <div className="list">{DAYS.map(d => {
        const id = selectedClient.assignment?.week?.[String(d)]
        const routine = selectedClient.assignment?.routines?.find(r => r.id === id)
        return <div className="item" key={d}>
          <div className="grow"><div className="tt">{t(DAYN[d])}</div><div className="ss">{routine ? `${routine.name} · ${exCount(routine.ex.length)}` : t('Rest')}</div></div>
          {routine && <button className="iconbtn" aria-label={t('Remove assignment')} onClick={() => unassign(String(d))}><Icon name="trash" /></button>}
        </div>
      })}</div>

      <h4 className="sec">{t('Member workout reports')}</h4>
      <div className="card">
        {!detail ? <div className="small muted">{t('Loading reports…')}</div> : detail.workouts?.length ? detail.workouts.slice(0, 8).map(w => {
          const done = w.entries?.reduce((n, e) => n + (e.sets || []).filter(s => s.done).length, 0) || 0
          const total = w.entries?.reduce((n, e) => n + (e.sets || []).length, 0) || 0
          return <details key={w.id} style={{ padding: '8px 0', borderBottom: '1px solid var(--sep)' }}>
            <summary className="row between" style={{ cursor: 'pointer', listStyle: 'none' }}>
              <div><div className="tt">{w.name}</div><div className="ss">{w.d} · {t('{0} of {1} sets', done, total)}</div></div>
              <span className="tag acc">{total && done === total ? t('Complete') : t('Partial')}</span>
            </summary>
            <div style={{ padding: '8px 0 0 10px' }}>{(w.entries || []).map((entry, i) => {
              const completed = (entry.sets || []).filter(s => s.done)
              const exercise = EXIDX[entry.id]
              return <div key={i} style={{ padding: '7px 0', borderTop: '1px solid var(--sep)' }}>
                <div className="row between"><span className="tt capitalize">{exercise?.n || entry.id}</span><span className="tag">{t('{0} of {1} sets', completed.length, entry.sets?.length || 0)}</span></div>
                <div className="ss" style={{ marginTop: 3 }}>{(entry.sets || []).map((s, n) => `${s.done ? '✓' : '–'} ${t('Set')} ${n + 1}: ${s.done ? setLabel(entry.id, s, entry.target) : t('Not completed')}`).join(' · ')}</div>
              </div>
            })}</div>
          </details>
        }) : <div className="small muted">{t('No workout reports yet.')}</div>}
      </div>
    </>}
  </div>
}
