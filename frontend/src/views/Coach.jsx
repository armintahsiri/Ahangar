import { useEffect, useMemo, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { api } from '../lib/api.js'
import { useStore } from '../store/useStore.js'
import { useUI } from '../store/useUI.js'
import { DAYN } from '../lib/format.js'
import { EXIDX } from '../lib/exercises.js'
import { setLabel } from '../lib/history.js'
import { loadOfRoutine, rankOf, MUSCLE_NAME } from '../lib/muscles.js'
import { t, getLang } from '../lib/i18n.js'
import Icon from '../components/Icon.jsx'
import BodyMap from '../components/BodyMap.jsx'
import MuscleBalance from '../components/MuscleBalance.jsx'
import { Button } from '../components/ui.jsx'
import { exCount } from '../lib/format.js'
import { exName } from '../lib/exnames.js'

const DAYS = [6, 0, 1, 2, 3, 4, 5]
const emptyWeek = () => Object.fromEntries(DAYS.map(d => [String(d), 'rest']))

export default function Coach() {
  const nav = useNavigate()
  const user = useStore(s => s.user)
  const toast = useUI(s => s.toast)
  const [clients, setClients] = useState([])
  const [selected, setSelected] = useState('')
  const [detail, setDetail] = useState(null)
  const [busy, setBusy] = useState(false)
  const [mapDay, setMapDay] = useState('')
  const [showWholeProgram, setShowWholeProgram] = useState(false)
  const selectedClient = useMemo(() => clients.find(c => c.id === selected) || null, [clients, selected])
  const wholeProgramExercises = selectedClient ? DAYS.flatMap(d => {
    const id = selectedClient.assignment?.week?.[String(d)]
    return selectedClient.assignment?.routines?.find(r => r.id === id)?.ex || []
  }) : []
  const wholeProgramLoad = loadOfRoutine({ ex: wholeProgramExercises })
  const { worked: wholeProgramWorked } = rankOf(wholeProgramLoad)
  useEffect(() => {
    const firstTrainingDay = selectedClient && DAYS.find(d => {
      const id = selectedClient.assignment?.week?.[String(d)]
      return selectedClient.assignment?.routines?.some(r => r.id === id)
    })
    setMapDay(firstTrainingDay == null ? '' : String(firstTrainingDay))
  }, [selected])

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

  const setDayRoutine = async (dayKey, value) => {
    if (!selectedClient) return
    const current = selectedClient.assignment || { routines: [], week: {} }
    const nextWeek = { ...emptyWeek(), ...(current.week || {}), [dayKey]: value || 'rest' }
    // Keep the client's private routine library even when a routine is removed from
    // the weekly schedule. Each assignment record is scoped to this member on the API.
    await saveAssignment({ routines: [...(current.routines || [])], week: nextWeek })
  }

  if (!user?.admin && user?.role !== 'coach') return null
  return <div className="narrow">
    <div className="hdr">
      <button className="iconbtn" onClick={() => nav('/home')} aria-label={t('Back')}><Icon name="chevronLeft" /></button>
      <div className="grow"><h1 style={{ margin: 0 }}>{t('Coach dashboard')}</h1><div className="sub">{t('{0} clients', clients.length)}</div></div>
      <button className="iconbtn" onClick={() => reload()} aria-label={t('Refresh')}>↻</button>
    </div>

    <div className="card">
      <div className="muted small">{t('Members are assigned to you by the gym owner. You write a separate program for each of them from your own templates.')}</div>
      <div className="dim small" style={{ marginTop: 8, lineHeight: 1.5 }}>{t('You can see each client\'s logged workouts — sets, weights, effort and the body-weight reading taken at the session — plus the plan you assigned them. You cannot see their weigh-in log, settings or mobile number.')}</div>
    </div>

    <h4 className="sec">{t('My clients')}</h4>
    {clients.length ? <div className="list">{clients.map(c => <div key={c.id} className={'item coach-client' + (selected === c.id ? ' selected' : '')} onClick={() => { setSelected(c.id); setShowWholeProgram(false) }}>
      <span className="lrow-i"><Icon name="person" /></span>
      <div className="grow"><div className="tt">{c.name}</div><div className="ss">{c.workouts} {t('workouts')} · {c.assignment?.routines?.length || 0} {t('assigned routines')}</div></div>
      {selected === c.id && <span className="tag acc">{t('Selected')}</span>}
      {c.disabled && <span className="tag">{t('Disabled')}</span>}
    </div>)}</div> : <div className="empty">{t('No clients yet — the gym owner assigns members to you.')}</div>}

    {selectedClient && <>
      <div className="card" style={{ marginTop: 20, border: '1px solid var(--sep)' }}>
        <div className="row between" style={{ gap: 12 }}>
          <div className="row" style={{ gap: 10, minWidth: 0 }}>
            <span className="lrow-i" style={{ background: 'var(--surface-2)', color: 'var(--label-2)' }}><Icon name="person" /></span>
            <div className="coach-overall-toggle">
              <span style={{ minWidth: 0 }}>
                <span className="small muted">{t('Currently viewing')}</span>
                <span className="coach-overall-name">{selectedClient.name}</span>
              </span>
            </div>
          </div>
          <Button size="sm" onClick={() => nav('/plan')}>{t('My routine library')}</Button>
        </div>
        <div className="small muted" style={{ marginTop: 10 }}>{t('Each routine copied here belongs only to this person. Changes for another person stay separate.')}</div>
      </div>
      <h4 className="sec">{t('Assigned weekly plan')}</h4>
      <div className="list">{DAYS.map(d => {
        const id = selectedClient.assignment?.week?.[String(d)]
        const routine = selectedClient.assignment?.routines?.find(r => r.id === id)
        const dayKey = String(d)
        return <div key={d}>
          <div className={'item coach-day-row' + (mapDay === dayKey ? ' active' : '')}>
          <button className="grow coach-day-toggle" disabled={!routine} aria-pressed={mapDay === dayKey && !showWholeProgram} onClick={() => { setMapDay(dayKey); setShowWholeProgram(false) }}>
            <span><span className="tt">{t(DAYN[d])}</span><span className="ss">{routine ? `${routine.name} · ${exCount(routine.ex.length)}` : t('Rest')}</span></span>
            {routine && mapDay === dayKey && <Icon name="check" style={{ color: 'var(--acc)' }} />}
          </button>
          <div style={{ position: 'relative', width: 'auto', maxWidth: '52%' }}>
            <select className="input" style={{ width: '100%', appearance: 'none', paddingLeft: 38, direction: 'rtl', textAlign: 'center' }} value={id && id !== 'rest' ? id : ''} disabled={busy} aria-label={t(DAYN[d])}
              onChange={e => { setMapDay(String(d)); setShowWholeProgram(false); setDayRoutine(String(d), e.target.value) }}>
              <option value="">{t('Rest')}</option>
              {(selectedClient.assignment?.routines || []).map(r => <option value={r.id} key={r.id}>{r.name}</option>)}
            </select>
            <Icon name="chevronDown" style={{ position: 'absolute', left: 13, top: '50%', transform: 'translateY(-50%)', pointerEvents: 'none', color: 'var(--label-2)' }} />
          </div>
          </div>
        </div>
      })}</div>
      <div className="row" style={{ marginTop: 10, gap: 8 }}>
        <Button size="sm" onClick={() => nav('/plan')}>{t('Edit my routine library')}</Button>
        <span className="small muted">{t('Changes save automatically.')}</span>
      </div>

      {wholeProgramWorked.length > 0 && (() => {
        const routineId = mapDay ? selectedClient.assignment?.week?.[mapDay] : null
        const mapRoutine = selectedClient.assignment?.routines?.find(r => r.id === routineId)
        const dayLoad = mapRoutine ? loadOfRoutine(mapRoutine) : {}
        const { worked: dayWorked } = rankOf(dayLoad)
        const load = showWholeProgram ? wholeProgramLoad : dayLoad
        const worked = showWholeProgram ? wholeProgramWorked : dayWorked
        return <div className="card" style={{ marginTop: 14 }}>
          <div className="row between" style={{ gap: 10 }}>
            <h2 style={{ margin: 0 }}>{showWholeProgram ? t('Whole weekly plan') : t('Muscles worked on {0}', t(DAYN[Number(mapDay)]))}</h2>
            <Button size="sm" onClick={() => setShowWholeProgram(v => !v)}>{showWholeProgram ? t('Show selected day') : t('Show whole program')}</Button>
          </div>
          {worked.length > 0 ? <>
            <BodyMap load={load} body={detail?.body || 'male'} />
            <div className="mchips" style={{ marginTop: 8 }}>{worked.map(m => <span key={m} className="mchip acc">{t(MUSCLE_NAME[m])}</span>)}</div>
          </> : <div className="small muted" style={{ marginTop: 12 }}>{t('No exercises in this weekly plan yet.')}</div>}
        </div>
      })()}

      <h4 className="sec">{t('Member workout reports')}</h4>
      {detail?.workouts?.length > 0 && <MuscleBalance workouts={detail.workouts} body={detail.body} />}
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
                <div className="row between"><span className="tt capitalize">{exercise ? exName(exercise, getLang()) : entry.id}</span><span className="tag">{t('{0} of {1} sets', completed.length, entry.sets?.length || 0)}</span></div>
                <div className="ss" style={{ marginTop: 3 }}>{(entry.sets || []).map((s, n) => `${s.done ? '✓' : '–'} ${t('Set')} ${n + 1}: ${s.done ? setLabel(entry.id, s, entry.target) : t('Not completed')}`).join(' · ')}</div>
              </div>
            })}</div>
          </details>
        }) : <div className="small muted">{t('No workout reports yet.')}</div>}
      </div>
    </>}
  </div>
}
