import { useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { useStore } from '../store/useStore.js'
import { effectiveRoutine, effectiveRoutineId, streakWeeks, lastBW, setsDoneActive } from '../lib/history.js'
import { fmtNum, fmtDate, todayISO, isoOf, DAYS } from '../lib/format.js'
import { t, dateLocale } from '../lib/i18n.js'
import { bwSheet, goalSheet, dayOverrideSheet, calendarSheet, startFlow, loadStarterPlan, bwDeltaColor } from '../sheets.jsx'
import LineChart from '../components/LineChart.jsx'
import Icon from '../components/Icon.jsx'
import { Button } from '../components/ui.jsx'
import { glyphOf } from '../lib/glyphs.js'
import BodyMap from '../components/BodyMap.jsx'
import { loadOfRoutine, rankOf, MUSCLE_NAME } from '../lib/muscles.js'

// Home = what to do now + a quick glance. Deep charts & history live in Stats.
export default function Home() {
  const nav = useNavigate()
  const S = useStore(s => s.S)
  const clubName = useStore(s => s.clubName)
  const user = useStore(s => s.user)
  const [weekOffset, setWeekOffset] = useState(0)
  const [selectedISO, setSelectedISO] = useState(() => todayISO())

  const today = new Date()
  const routine = effectiveRoutine(S, selectedISO)
  const dayOvr = S.dayPlan[selectedISO] !== undefined
  const selectedDate = new Date(selectedISO + 'T12:00:00')
  const selectedLabel = selectedISO === todayISO()
    ? t('Today')
    : selectedDate.toLocaleDateString(dateLocale(), { weekday: 'long', day: 'numeric', month: 'long' })
  const sessionLoad = routine ? loadOfRoutine(routine) : null
  const { worked: sessionMuscles = [] } = sessionLoad ? rankOf(sessionLoad) : {}
  const bw = lastBW(S)
  const prevBW = S.bodyweight.length > 1 ? S.bodyweight[S.bodyweight.length - 2] : null
  const delta = bw && prevBW ? bw.w - prevBW.w : null

  const weekStart = new Date(today)
  const daysSinceWeekStart = S.lang === 'fa' ? (today.getDay() + 1) % 7 : (today.getDay() + 6) % 7
  weekStart.setDate(today.getDate() - daysSinceWeekStart + weekOffset * 7)
  const doneDays = new Set(S.workouts.map(w => w.d))
  const strip = []
  for (let i = 0; i < 7; i++) {
    const d = new Date(weekStart); d.setDate(weekStart.getDate() + i)
    const iso = isoOf(d)
    const eff = effectiveRoutineId(S, iso), ovr = S.dayPlan[iso] !== undefined, done = doneDays.has(iso)
    const dot = done ? ' done' : ovr && eff ? ' ovr' : eff ? ' plan' : ''
    strip.push(<button type="button" key={i} aria-pressed={selectedISO === iso}
      className={'wday' + (iso === todayISO() ? ' today' : '') + (selectedISO === iso ? ' selected' : '')}
      onClick={() => setSelectedISO(iso)}>
      <div className="lbl">{t(DAYS[d.getDay()])}</div><div className="num">{d.getDate()}</div><div className={'dot' + dot} /></button>)
  }
  const weekEnd = new Date(weekStart); weekEnd.setDate(weekStart.getDate() + 6)
  const wkLabel = weekOffset === 0 ? t('This week') : `${weekStart.getDate()} ${weekStart.toLocaleDateString(dateLocale(), { month: 'short' })} – ${weekEnd.getDate()} ${weekEnd.toLocaleDateString(dateLocale(), { month: 'short' })}`

  const currentWeekStart = new Date(today)
  currentWeekStart.setDate(today.getDate() - (S.lang === 'fa' ? (today.getDay() + 1) % 7 : (today.getDay() + 6) % 7))
  const currentWeekStartISO = isoOf(currentWeekStart)
  const todayISOValue = todayISO()
  const wThisWeek = S.workouts.filter(w => w.d >= currentWeekStartISO && w.d <= todayISOValue).length
  const plannedPerWeek = Object.keys(S.week).filter(k => S.week[k]).length
  const weekSummary = plannedPerWeek
    ? t('This week: {0} of {1} planned workouts', wThisWeek, plannedPerWeek)
    : t('This week: {0} workouts', wThisWeek)
  const bwPoints = S.bodyweight.slice(-30).map(b => ({ t: b.t || new Date(b.d).getTime(), y: b.w, d: b.d }))

  // The selected day drives both the session summary and its muscle map.
  const shiftWeek = amount => {
    const next = new Date(selectedISO + 'T12:00:00')
    next.setDate(next.getDate() + amount * 7)
    setSelectedISO(isoOf(next))
    setWeekOffset(w => w + amount)
  }
  const onSelectedDay = () => {
    if (S.active) nav('/workout')
    else if (routine) startFlow(routine.id)
    else if (!S.coachProgram) dayOverrideSheet(selectedISO)
  }

  return <div className="narrow">
    <div className="hdr">
      <div><h1>{user ? t('Hi {0}', user.name) : clubName}</h1><div className="sub">{today.toLocaleDateString(dateLocale(), { weekday: 'long', day: 'numeric', month: 'long' })}</div></div>
      <button className="iconbtn" onClick={() => nav('/settings')} aria-label={t('Settings')}><Icon name="gear" /></button>
    </div>

    <div className="card">
      <div className="row between" style={{ marginBottom: 8 }}>
        <button className="iconbtn" style={{ width: 30, height: 30, fontSize: 15 }} onClick={() => shiftWeek(-1)} aria-label="Previous week"><Icon name="chevronLeft" /></button>
        <div className="small muted" style={{ fontWeight: 500 }}>{wkLabel}</div>
        <button className="iconbtn" style={{ width: 30, height: 30, fontSize: 15 }} onClick={() => shiftWeek(1)} aria-label="Next week"><Icon name="chevronRight" /></button>
      </div>
      <div className="week">{strip}</div>
      <div className="today-row" onClick={onSelectedDay}>
        <div className="row" style={{ gap: 9, minWidth: 0 }}>
          <span className="lrow-i" style={{ background: S.active ? 'var(--orange)' : routine ? 'var(--acc)' : 'var(--surface-3)' }}>
            <Icon name={S.active ? 'timer' : routine ? glyphOf(routine.emoji) : 'moon'} />
          </span>
          <div style={{ minWidth: 0 }}>
            <div className="lbl2">{selectedLabel}</div>
            <div className="ttl">{S.active ? t('{0} — in progress', S.active.name) : routine ? routine.name : t('Rest day')}{dayOvr && routine ? ' · ' + t('rescheduled') : ''}</div>
          </div>
        </div>
        {!S.coachProgram && routine && !S.active && <button className="iconbtn" aria-label={t('Edit day')} onClick={e => { e.stopPropagation(); dayOverrideSheet(selectedISO) }}><Icon name="pencil" /></button>}
        {S.active ? <span className="tag" style={{ color: 'var(--orange)', background: 'color-mix(in srgb,var(--orange) 16%,transparent)' }}>{t('Resume')}</span>
          : routine ? <span className="tag acc">{t('Start')}</span>
          : !S.coachProgram ? <Icon name="plus" className="chev" /> : null}
      </div>
    </div>

    {routine && sessionLoad && <div className="card">
      <h2>{t('What this session hits')}</h2>
      <BodyMap load={sessionLoad} body={S.body} />
      {sessionMuscles.length > 0 && <div className="mchips" style={{ marginTop: 8 }}>
        {sessionMuscles.slice(0, 4).map(m => <span key={m} className="mchip acc" style={{ background: 'var(--acc-soft)', color: 'var(--acc)' }}>{t(MUSCLE_NAME[m])}</span>)}
      </div>}
    </div>}

    {!S.routines.length && !S.active && (
      <div className="card">
        <div className="row" style={{ gap: 10, marginBottom: 6 }}>
          <span className="lrow-i"><Icon name="sparkles" /></span>
          <div className="big" style={{ fontSize: 22 }}>{t('Welcome!')}</div>
        </div>
        <div className="muted small" style={{ marginBottom: 12 }}>{t('Set up your weekly routine to get going — or load a ready-made Push / Pull / Legs plan.')}</div>
        <Button variant="primary" icon="sparkles" onClick={loadStarterPlan}>{t('Load starter plan (PPL)')}</Button>
        <div style={{ height: 8 }} /><Button onClick={() => nav('/plan')}>{t('Build my own plan')}</Button>
      </div>
    )}

    {/* weight and streak sit side by side from the tablet breakpoint up (.cols is a plain block on phones) */}
    <div className="cols">
      <div className="card">
        <div className="row between" style={{ marginBottom: 6 }}>
          <h2 style={{ margin: 0 }}>{t('Body weight')}</h2>
          <div className="row" style={{ gap: 8 }}>
            <Button size="sm" icon="target" style={S.targetW ? { color: 'var(--yellow)' } : undefined} onClick={goalSheet}>{S.targetW ? fmtNum(S.targetW) : t('Goal')}</Button>
            <Button size="sm" icon="plus" onClick={() => bwSheet()}>{t('Log')}</Button>
          </div>
        </div>
        {bw ? <>
          <div className="row" style={{ gap: 8, alignItems: 'baseline' }}>
            <div className="big">{fmtNum(bw.w)} <span className="muted" style={{ fontSize: '1rem' }}>{S.unit}</span></div>
            {/* only when it actually moved — an unchanged weight used to read as "− 0" */}
            {!!delta && (
              <span className="small row" style={{ gap: 2, fontWeight: 500, color: bwDeltaColor(delta, bw.w) }}>
                <Icon name={delta > 0 ? 'arrowUp' : 'arrowDown'} style={{ fontSize: 12 }} />
                {fmtNum(Math.abs(delta))}
              </span>
            )}
            <span className="dim small" style={{ marginLeft: 'auto' }}>{fmtDate(bw.d, true)}</span>
          </div>
          {S.targetW && (
            <div className="small row" style={{ color: 'var(--yellow)', marginTop: 4, gap: 5 }}>
              <Icon name="target" style={{ fontSize: 13 }} />
              <span>{t('Goal')} {fmtNum(S.targetW)} {S.unit} · {Math.abs(S.targetW - bw.w) < 0.05 ? t('reached!') : t(S.targetW > bw.w ? '{0} to gain' : '{0} to lose', fmtNum(Math.abs(S.targetW - bw.w)) + ' ' + S.unit)}</span>
            </div>
          )}
          <div className="chart" style={{ marginTop: 8 }}><LineChart points={bwPoints} h={130} unit={S.unit} goal={S.targetW} /></div>
        </> : <div className="muted small">{t("No entries yet — log your weight to start the curve. It's also asked before every workout.")}</div>}
      </div>

      <div className="card tappable" style={{ cursor: 'pointer' }} onClick={() => calendarSheet()}>
        <div className="row between">
          <div>
            <div className="row" style={{ gap: 7, fontSize: 22, fontWeight: 600, letterSpacing: '-.021em' }}>
              <Icon name="flame" style={{ color: 'var(--orange)' }} />
              {t('{0} week streak', streakWeeks(S))}
            </div>
            <div className="muted small" style={{ marginTop: 4, lineHeight: 1.6 }}>
              <div>{weekSummary}</div>
              <div>{t('Total workouts recorded: {0}', S.workouts.length)}</div>
            </div>
          </div>
          <Icon name="calendar" className="chev" style={{ fontSize: 20 }} />
        </div>
      </div>
    </div>
  </div>
}
