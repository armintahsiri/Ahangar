import { useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { useStore } from '../store/useStore.js'
import { EXIDX } from '../lib/exercises.js'
import { lastBW, streakWeeks, setLabel, modeOf, effortOf, setsDone } from '../lib/history.js'
import { fmtNum, fmtDate, fmtDur, todayISO, isoOf, weekKey, ltrNum } from '../lib/format.js'
import { t, dateLocale } from '../lib/i18n.js'
import { bwSheet, goalSheet, calendarSheet, workoutDetailSheet, WorkoutRow, bwDeltaColor } from '../sheets.jsx'
import LineChart from '../components/LineChart.jsx'
import Heatmap from '../components/Heatmap.jsx'
import MuscleBalance from '../components/MuscleBalance.jsx'
import Icon from '../components/Icon.jsx'
import { e1rmSeries, best1RM } from '../lib/onerm.js'
import {
  hasEffort, displayScale, scaleName, toScale, avgRir, effortSummary, effortWeeks,
  effortHistogram, HARD_RIR
} from '../lib/effort.js'
import { Button, Segmented, SelectRow } from '../components/ui.jsx'

// "This month" has to mean the month the dates are shown in. Workout days are stored as
// ISO dates but rendered through the UI locale, which in Persian means Jalali months —
// an ISO-month substring match would call mid-آبان "last month" for a third of every
// month. The locale's own calendar (fa-IR → Persian) is the single source of truth.
const monthKeyOf = iso => new Date(iso + 'T12:00:00').toLocaleDateString(dateLocale(), { year: 'numeric', month: 'numeric' })

// The opener, in sentences rather than charts. It answers the three questions a plain
// reader actually brings to this page — was I active this week, did I set records, where
// does my weight stand — before any curve asks to be decoded. Every line is derived from
// data already on this page, and a line with nothing to say simply doesn't render, so the
// card stays short for the beginner and fills in as the history grows.
function SummaryCard({ S }) {
  const now = Date.now()
  const thisMonth = monthKeyOf(todayISO())
  const weekWs = S.workouts.filter(w => weekKey(w.d) === weekKey(todayISO()))
  const weekMs = weekWs.reduce((a, w) => a + Math.max(0, (w.end || w.start) - w.start), 0)
  const nPrs = S.workouts.reduce((a, w) =>
    a + (monthKeyOf(w.d) === thisMonth ? (w.prs || []).length : 0), 0)
  const lb = lastBW(S)
  const bw30 = S.bodyweight.filter(b => (b.t || new Date(b.d).getTime()) > now - 30 * 86400000)
  const bwDelta30 = bw30.length > 1 ? bw30[bw30.length - 1].w - bw30[0].w : null
  const goalLeft = S.targetW && lb ? S.targetW - lb.w : null

  return <div className="card">
    <h2>{t('How was your week?')}</h2>
    <div className="sumrow">
      <Icon name="dumbbell" />
      {weekWs.length
        ? <span>{t(weekWs.length === 1 ? '{0} workout' : '{0} workouts', weekWs.length)}{weekMs >= 300000 ? ' · ' + fmtDur(weekMs) : ''}</span>
        : <span className="muted">{t('No workouts logged this week yet.')}</span>}
    </div>
    {nPrs > 0 && <div className="sumrow"><Icon name="trophy" />
      <span>{t(nPrs === 1 ? '{0} new record this month' : '{0} new records this month', fmtNum(nPrs))}</span></div>}
    {bwDelta30 !== null && <div className="sumrow"><Icon name="scale" />
      <span>{t('Weight {0} in the last 30 days', ltrNum((bwDelta30 > 0 ? '+' : '') + fmtNum(bwDelta30)) + ' ' + S.unit)}</span></div>}
    {goalLeft !== null && <div className="sumrow"><Icon name="target" />
      {Math.abs(goalLeft) < 0.15
        ? <span>{t('Goal reached')}</span>
        : <span>{t('{0} left to reach your goal', fmtNum(Math.abs(goalLeft)) + ' ' + S.unit)}</span>}
    </div>}
  </div>
}

// Personal records, lifted from the workouts themselves: finishing a session stores the ids
// that beat every earlier top weight, so this is exactly what the PR badges on the history
// rows are counting — now named and dated. "How many records did I set" is the number a
// regular user cares about far more than any curve, and it was already on disk.
function PrCard({ S }) {
  const rows = []
  S.workouts.forEach(w => (w.prs || []).forEach(id => {
    const en = (w.entries || []).find(e => e.id === id)
    if (!en) return
    const mx = Math.max(0, ...en.sets.filter(s => s.done).map(s => s.w || 0), en.topW || 0)
    rows.push({ id, d: w.d, w: mx })
  }))
  if (!rows.length) return null
  rows.sort((a, b) => (a.d < b.d ? 1 : a.d > b.d ? -1 : 0))
  const thisMonth = monthKeyOf(todayISO())
  const month = rows.filter(r => monthKeyOf(r.d) === thisMonth)
  const show = month.length ? month : [rows[0]]

  return <div className="card">
    <h2>{t('Records')} <span className="dim" style={{ textTransform: 'none', letterSpacing: 0 }}>
      · {month.length ? t('{0} new this month', fmtNum(month.length)) : t('nothing new this month')}</span></h2>
    {!month.length && <div className="small dim" style={{ marginBottom: 2 }}>{t('No new records this month — your latest:')}</div>}
    {show.slice(0, 6).map((r, i) => <div key={i} className="row between small" style={{ padding: '6px 0', borderBottom: 'var(--hair) solid var(--sep)' }}>
      <span>{month.length > 0 && <Icon name="trophy" style={{ color: 'var(--yellow)', fontSize: 13, marginInlineEnd: 6 }} />}{EXIDX[r.id] ? EXIDX[r.id].n : t('Unknown exercise')}</span>
      <span className="muted">{fmtNum(r.w) + ' ' + S.unit} · {fmtDate(r.d, true)}</span>
    </div>)}
  </div>
}

// How hard the training was — the half of the picture a volume chart cannot show. The
// headline is now plain language ("this many reps were still left per set"), because RIR
// and RPE are coach vocabulary; the curves and the histogram that do speak coach live
// behind a fold the default reader never has to open. Everything is computed in RIR
// (lib/effort.js) and converted to whichever scale this profile reads. Every number
// carries how much of the training it speaks for: rating is optional and off by default,
// so a partly rated history is the normal case, and an average without its denominator
// would quietly speak for sets that were never rated.
function EffortCard({ S }) {
  const [win, setWin] = useState(90)
  const kind = displayScale(S)
  const hd = scaleName(kind)
  const isRir = kind === 'rir'
  const sum = effortSummary(S, win)
  const weeks = effortWeeks(S, win)
  const hist = effortHistogram(S, win)
  const maxBin = Math.max(1, ...hist.map(b => b.n))
  // The week's set count rides along in the tooltip, because the pair is the reading:
  // volume up with effort up is fatigue piling up, volume up with effort flat is adaptation.
  const pts = weeks.map(w => ({ t: w.t, y: toScale(kind, w.rir), note: t('{0} sets', w.sets) }))
  // Bins run hardest-first in both scales: RIR 0 and RPE 10 are the same set.
  const binLabel = b => isRir ? (b.tail ? b.rir + '+' : String(b.rir)) : (b.tail ? '≤ 6' : String(10 - b.rir))

  return <div className="card">
    <h2>{t('Effort')} <span className="dim" style={{ textTransform: 'none', letterSpacing: 0 }}>· {t('how hard the training felt')}</span></h2>
    <Segmented className="seg-range" value={win} onChange={setWin}
      options={[{ value: 30, label: t('30 days') }, { value: 90, label: t('90 days') }, { value: 365, label: t('1 year') }, { value: 0, label: t('All') }]} />
    {sum.rated === 0 ? <div className="muted small">{t('No rated sets in this period.')}</div> : <>
      <div className="row between" style={{ alignItems: 'flex-end', gap: 12 }}>
        <div>
          <div className="stat-v">{sum.avg == null ? '—' : fmtNum(toScale(kind, sum.avg))}</div>
          <div className="small dim">{isRir ? t('reps still left per set, on average') : t('average effort, out of 10')}</div>
        </div>
        <div style={{ textAlign: 'right' }}>
          <div className="stat-v" style={{ color: 'var(--yellow)' }}>{sum.hardPct == null ? '—' : Math.round(sum.hardPct * 100) + '%'}</div>
          <div className="small dim">{t('hard sets — close to failure')}</div>
        </div>
      </div>
      <div className="small dim" style={{ marginTop: 8 }}>{t('{0} of {1} finished sets rated', sum.rated, sum.done)}</div>
      {effortOf(S) === 'none' && <div className="small" style={{ color: 'var(--yellow)', marginTop: 4 }}>
        {t('Effort per set is switched off — turn it on in Settings to keep rating.')}
      </div>}
      <details className="fold">
        <summary>{t('Charts & details')}<Icon name="chevronDown" className="chev" /></summary>
        {pts.length > 1 && <>
          <h4 className="sec" style={{ marginTop: 12 }}>{t('Week by week')}</h4>
          <div className="chart"><LineChart points={pts} h={140} unit={hd} color="var(--yellow)" invert={isRir} /></div>
        </>}
        <h4 className="sec" style={{ marginTop: 12 }}>{t('Where the sets land')}</h4>
        {hist.map(b => <div key={b.rir} className="mrow">
          <span className="nm">{hd} {binLabel(b)}</span>
          <span className="bar"><i style={{ width: Math.round(b.n / maxBin * 100) + '%', background: b.rir <= HARD_RIR ? 'var(--yellow)' : 'var(--label-3)' }} /></span>
          <span className="v">{b.n ? b.n + ' · ' + Math.round(b.pct * 100) + '%' : '—'}</span>
        </div>)}
        <div className="small dim" style={{ marginTop: 8 }}>
          {t('Most working sets belong close to failure without living there — half at the floor and half at the top average out to a healthy-looking middle.')}
        </div>
      </details>
    </>}
  </div>
}

// Stats = the analytics hub: all charts, progress and history live here.
export default function Stats() {
  const nav = useNavigate()
  const S = useStore(s => s.S)
  const [range, setRange] = useState(90)
  const [exId, setExId] = useState(null)
  const [exMetric, setExMetric] = useState('top')
  const now = Date.now()
  const anyEffort = hasEffort(S)
  const kind = displayScale(S)
  const hd = scaleName(kind)

  const bwPts = S.bodyweight.filter(b => range === 0 || (b.t || new Date(b.d).getTime()) > now - range * 86400000)
    .map(b => ({ t: b.t || new Date(b.d).getTime(), y: b.w, d: b.d }))
  const bw30 = S.bodyweight.filter(b => (b.t || new Date(b.d).getTime()) > now - 30 * 86400000)
  const bwDelta30 = bw30.length > 1 ? bw30[bw30.length - 1].w - bw30[0].w : null
  const thisMonth = monthKeyOf(todayISO())
  const monthW = S.workouts.filter(w => monthKeyOf(w.d) === thisMonth).length
  // The weigh-in headline answers the chart before it is read: what changed in this range,
  // and how far the goal still is. A line chart shows a shape; this says what it means.
  const bwRangeDelta = bwPts.length > 1 ? bwPts[bwPts.length - 1].y - bwPts[0].y : null
  const lb = lastBW(S)
  const goalNote = S.targetW && lb
    ? (Math.abs(S.targetW - lb.w) < 0.15 ? t('Goal reached')
      : t('{0} left to reach your goal', fmtNum(Math.abs(S.targetW - lb.w)) + ' ' + S.unit))
    : null

  // "X training days" decodes the heatmap better than any axis label — it is the one
  // number the grid of squares is actually about.
  const days12m = new Set(S.workouts.filter(w => w.d >= isoOf(new Date(now - 365 * 86400000))).map(w => w.d)).size

  const exHist = [...new Set(S.workouts.flatMap(w => w.entries.map(e => e.id)))].filter(id => EXIDX[id]).sort((a, b) => EXIDX[a].n < EXIDX[b].n ? -1 : 1)
  const curEx = exId && exHist.includes(exId) ? exId : exHist[0] || null
  // How this exercise was logged most recently decides what the curve means: top weight,
  // longest hold or top speed. Sets logged in another mode lack the field and score 0, so a
  // switched exercise drops its old points instead of mixing seconds into a weight chart.
  const curMode = curEx ? (() => {
    for (let i = S.workouts.length - 1; i >= 0; i--) {
      const en = S.workouts[i].entries.find(e => e.id === curEx)
      if (en) return modeOf({ ...(en.target || {}), id: curEx })
    }
    return modeOf({ id: curEx })
  })() : 'reps'
  const curCardio = curMode === 'cardio'
  const curTimed = curMode === 'time'
  const metric = s => curCardio ? (s.speed || 0) : curTimed ? (s.sec || 0) : (s.w || 0)
  const exUnit = curCardio ? 'km/h' : curTimed ? 's' : S.unit
  let exPts = [], exList = [], exBest = 0
  if (curEx) {
    S.workouts.forEach(w => {
      const en = w.entries.find(e => e.id === curEx)
      if (en) { const mx = Math.max(0, ...en.sets.filter(s => s.done).map(metric), curCardio || curTimed ? 0 : (en.topW || 0)); if (mx > 0) { exPts.push({ t: w.start, y: mx, d: w.d, sets: en.sets.filter(s => s.done), target: en.target }); if (mx > exBest) exBest = mx } }
    })
    exList = exPts.slice(-5).reverse()
  }
  // Estimated 1RM (issue #18) — only reps-mode training produces one, so cardio and timed
  // work simply have no points and the toggle stays hidden.
  const e1Pts = curEx ? e1rmSeries(S, curEx) : []
  const e1Best = curEx ? best1RM(S, curEx) : null
  const showE1 = e1Pts.length > 0
  // Effort on this exercise, per session. It rides on the top-set curve as well as having a
  // curve of its own, because the two only mean something together: the same weight moved
  // with more left in the tank is progress a weight-only chart draws as a flat line.
  const exRir = exPts.map(p => avgRir(p.sets))
  const showEff = exRir.filter(v => v != null).length >= 3
  const effPts = exPts.map((p, i) => (exRir[i] == null ? null : { t: p.t, y: toScale(kind, exRir[i]), d: p.d })).filter(Boolean)
  const onE1 = showE1 && exMetric === 'e1rm'
  const onEff = showEff && exMetric === 'effort'
  const topPts = exPts.map((p, i) => ({
    t: p.t, y: p.y, d: p.d,
    // 0 RIR (nothing left) is a full dot, 4+ a faint one; unrated sessions keep the plain line.
    m: exRir[i] == null ? null : 1 - Math.min(4, Math.max(0, exRir[i])) / 4,
    note: exRir[i] == null ? undefined : hd + ' ' + fmtNum(toScale(kind, exRir[i]))
  }))
  const exOpts = [{ value: 'top', label: t('Top set') }]
  if (showE1) exOpts.push({ value: 'e1rm', label: t('Est. 1RM') })
  if (showEff) exOpts.push({ value: 'effort', label: t('Effort') })

  // The plain-language comparison: the best set then and now, and what changed between
  // them. The curve below shows a shape; this says what the shape means. The base session
  // is the latest one at least ~4 weeks back — "a month ago" — falling back to the very
  // first session, so a young history still gets an honest "since you started" reading.
  const lastP = exPts[exPts.length - 1] || null
  let baseP = null
  if (lastP && exPts.length > 1) {
    for (let i = exPts.length - 2; i >= 0; i--) {
      if (lastP.t - exPts[i].t >= 27 * 86400000) { baseP = exPts[i]; break }
    }
    if (!baseP) baseP = exPts[0]
  }
  // The top set itself, so the card can quote real logged numbers ("45×8") instead of a
  // bare maximum. An entry with a stored topW but no checked sets has no set to quote —
  // the per-workout maximum stands in for it.
  const topSetOf = p => p.sets.length ? p.sets.reduce((b, s) => (metric(s) > metric(b) ? s : b), p.sets[0]) : null
  const labelOf = p => {
    const ts = topSetOf(p)
    return ts ? setLabel(curEx, ts, p.target) : fmtNum(p.y) + ' ' + exUnit
  }
  const valOf = p => { const ts = topSetOf(p); return ts ? metric(ts) : p.y }
  // A workout without a recorded `start` (a hand-edited backup) would make the difference
  // NaN, and NaN slips both null and zero checks — guard the delta explicitly.
  const exDiff = lastP && baseP && Number.isFinite(lastP.t) && Number.isFinite(baseP.t)
    ? valOf(lastP) - valOf(baseP) : null

  // Recent list shows finished training only — an aborted session (nothing checked off)
  // would otherwise surface as a "0 min · 0 kg" row that reads like a bug.
  const recent = [...S.workouts].reverse().filter(w => setsDone(w) > 0).slice(0, 6)

  return <>
    <div className="hdr"><div><h1>{t('Stats')}</h1><div className="sub">{t('Progress & history')}</div></div>
      <button className="iconbtn" onClick={() => nav('/history')} aria-label={t('History')}><Icon name="history" /></button></div>

    <SummaryCard S={S} />

    <div className="tiles">
      <div className="tile"><div className="l"><Icon name="dumbbell" />{t('Workouts')}</div><div className="v">{S.workouts.length}</div></div>
      <div className="tile"><div className="l"><Icon name="calendar" />{t('This month')}</div><div className="v">{monthW}</div></div>
      <div className="tile"><div className="l"><Icon name="flame" />{t('Week streak')}</div><div className="v">{streakWeeks(S)}</div></div>
      <div className="tile"><div className="l"><Icon name="scale" />{t('Weight 30d')}</div><div className="v" style={{ fontSize: 22, color: bwDelta30 === null ? 'inherit' : bwDeltaColor(bwDelta30, (lastBW(S) || {}).w || 0) }}>{bwDelta30 === null ? '—' : ltrNum((bwDelta30 > 0 ? '+' : '') + fmtNum(bwDelta30)) + ' ' + S.unit}</div></div>
    </div>

    <PrCard S={S} />

    <div className="card">
      <h2>{t('{0} training days · last 12 months', fmtNum(days12m))}</h2>
      <Heatmap S={S} onDay={iso => { const ws = S.workouts.filter(w => w.d === iso); if (ws.length === 1) workoutDetailSheet(ws[0]); else if (ws.length) calendarSheet(iso) }} />
      <div className="small dim" style={{ marginTop: 8 }}>{t('Each square is one day — darker means a longer session.')}</div>
    </div>

    {S.workouts.length > 0 && <MuscleBalance workouts={S.workouts} body={S.body} />}

    {anyEffort && <EffortCard S={S} />}

    <div className="cols">
      <div className="card">
        <div className="row between" style={{ marginBottom: 8 }}>
          <h2 style={{ margin: 0 }}>{t('Body weight')}</h2>
          <div className="row" style={{ gap: 8 }}>
            <Button size="sm" icon="target" style={S.targetW ? { color: 'var(--yellow)' } : undefined} onClick={goalSheet}>{S.targetW ? fmtNum(S.targetW) : t('Goal')}</Button>
            <Button size="sm" icon="plus" onClick={() => bwSheet()}>{t('Log')}</Button>
          </div>
        </div>
        <Segmented className="seg-range" value={range} onChange={setRange}
          options={[{ value: 30, label: t('1 month') }, { value: 90, label: t('3 months') }, { value: 365, label: t('1 year') }, { value: 0, label: t('All') }]} />
        {bwRangeDelta !== null && <div className="small" style={{ marginBottom: 6 }}>
          {t('Change in this period')}:{' '}
          <b style={{ color: bwDeltaColor(bwRangeDelta, (lb || {}).w || 0) }}>{ltrNum((bwRangeDelta > 0 ? '+' : '') + fmtNum(bwRangeDelta)) + ' ' + S.unit}</b>
          {goalNote && <span className="dim"> · {goalNote}</span>}
        </div>}
        <div className="chart"><LineChart points={bwPts} h={160} unit={S.unit} goal={S.targetW} /></div>
      </div>

      <div className="card">
        <h2>{t('Exercise progress')}</h2>
        {exHist.length ? <>
          <div className="sect-b" style={{ marginBottom: 12 }}>
            <SelectRow title={t('Exercise')} sheetTitle={t('Exercise progress')} value={curEx} onChange={setExId}
              options={exHist.map(id => ({ value: id, label: EXIDX[id].n }))} />
          </div>
          {lastP ? <>
            <h4 className="sec" style={{ margin: '2px 0 4px' }}>{t('Top set — then vs now')}</h4>
            {baseP && <div className="row between" style={{ padding: '5px 0' }}>
              <span className="small dim">{fmtDate(baseP.d, true)}</span><span>{labelOf(baseP)}</span></div>}
            <div className="row between" style={{ padding: '5px 0' }}>
              <span className="small dim">{lastP.d === todayISO() ? t('Today') : fmtDate(lastP.d, true)}</span>
              <span style={{ fontWeight: 600 }}>{labelOf(lastP)}</span></div>
            {exDiff != null && exDiff !== 0 && <div className="small" style={{ marginTop: 2, color: exDiff > 0 ? 'var(--green)' : 'var(--red)' }}>
              {exDiff > 0 ? '↑' : '↓'} {fmtNum(Math.abs(exDiff)) + ' ' + exUnit}
              <span className="dim"> · {t('since {0}', fmtDate(baseP.d, true))}</span></div>}
            {exDiff === 0 && <div className="small dim" style={{ marginTop: 2 }}>{t('unchanged since {0}', fmtDate(baseP.d, true))}</div>}
          </>
            : <div className="muted small">{t('Finish your first workout to see progress curves here.')}</div>}
          <details className="fold">
            <summary>{t('Charts & details')}<Icon name="chevronDown" className="chev" /></summary>
            {exOpts.length > 1 && <Segmented className="seg-range" value={onEff ? 'effort' : onE1 ? 'e1rm' : 'top'} onChange={setExMetric} options={exOpts} />}
            <div className="chart">
              {onEff
                ? <LineChart points={effPts} h={150} unit={hd} color="var(--yellow)" invert={kind === 'rir'} />
                : <LineChart points={onE1 ? e1Pts.map(p => ({ t: p.t, y: p.y, d: p.d })) : topPts} h={150} unit={exUnit} color="var(--blue)" />}
            </div>
            <div style={{ marginTop: 8 }}>{exList.map((p, i) => <div key={i} className="row between small" style={{ padding: '6px 0', borderBottom: 'var(--hair) solid var(--sep)' }}>
              <span className="muted">{fmtDate(p.d, true)}</span><span>{p.sets.map(s => setLabel(curEx, s, p.target)).join('  ')}</span></div>)}</div>
            <div className="small dim" style={{ marginTop: 8 }}>
              {onEff ? t('Average effort per workout') : onE1 ? t('Estimated 1RM per workout') : curCardio ? t('Top speed per workout') : curTimed ? t('Longest hold per workout') : t('Best set weight per workout')}
              {onEff ? '' : <> · {t('Best:')}{' '}<b className="accent">{fmtNum(onE1 ? e1Best.est : exBest)} {onE1 ? S.unit : exUnit}</b></>}
            </div>
            {onE1 && <div className="small dim" style={{ marginTop: 4 }}>
              {t('Best estimate from {0} on {1} — an estimate, not a tested max.', fmtNum(e1Best.w) + ' ' + S.unit + ' × ' + e1Best.r, fmtDate(e1Best.d, true))}
            </div>}
            {!onEff && !onE1 && showEff && <div className="small dim" style={{ marginTop: 4 }}>
              {t('A fuller dot means less left in the tank — the same weight at a lower {0} is progress the line alone does not show.', hd)}
            </div>}
          </details>
        </> : <div className="muted small">{t('Finish your first workout to see progress curves here.')}</div>}
      </div>
    </div>

    {recent.length > 0 && <>
      <div className="row between" style={{ marginBottom: 10 }}>
        <h4 className="sec" style={{ margin: 0 }}>{t('Recent workouts')}</h4>
        <Button size="sm" variant="ghost" trailingIcon="chevronRight" onClick={() => nav('/history')}>{t('All')} {S.workouts.length}</Button>
      </div>
      <div className="list">{recent.map(w => <WorkoutRow key={w.id} w={w} onClick={() => workoutDetailSheet(w)} />)}</div>
    </>}
  </>
}
