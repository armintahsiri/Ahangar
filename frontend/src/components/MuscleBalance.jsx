import { useState } from 'react'
import { weekKey, todayISO } from '../lib/format.js'
import { loadOfWorkouts, rankOf, MUSCLE_NAME } from '../lib/muscles.js'
import { isHardSet, rirOf } from '../lib/effort.js'
import { t } from '../lib/i18n.js'
import BodyMap, { BodyMapLegend } from './BodyMap.jsx'
import { Button, Segmented } from './ui.jsx'

// Which muscles a set of workouts actually hit — and, the point of the card, which ones
// it keeps missing. Shading is relative within the window (lib/muscles.js). Lives here so
// the coach dashboard can show the same card for a client (Stats shows it for yourself).
export default function MuscleBalance({ workouts, body }) {
  const [win, setWin] = useState(7)
  const [hard, setHard] = useState(false)
  const [sel, setSel] = useState(null)
  const now = Date.now()
  const inWin = workouts.filter(w =>
    win === 0 ? true
      : win === 7 ? weekKey(w.d) === weekKey(todayISO())
        : (w.start || new Date(w.d).getTime()) > now - win * 86400000)
  // Counting only sets within three reps of failure distinguishes intensity from volume.
  // Show the filter whenever effort ratings exist in the window, even when none qualify.
  const rated = inWin.some(w => (w.entries || []).some(e =>
    (e.sets || []).some(s => s.done && rirOf(s) != null)))
  const on = hard && rated
  const load = loadOfWorkouts(inWin, on ? isHardSet : null)
  const { worked, missed } = rankOf(load)
  const top = worked.slice(0, 4)
  const max = worked.length ? load[worked[0]] : 0
  const sets = m => Math.round((load[m] || 0) * 10) / 10

  return <div className="card">
    <div className="row between" style={{ marginBottom: 8 }}>
      <div>
        <h2 style={{ margin: 0 }}>{t('Muscle balance')}</h2>
        <div className="small muted" style={{ marginTop: 3 }}>{t('Intensity · how close to failure')}</div>
      </div>
      {rated && <Button size="sm" icon="flame" style={on ? { color: 'var(--yellow)' } : undefined}
        onClick={() => { setHard(h => !h); setSel(null) }}>{on ? t('Near failure') : t('All sets')}</Button>}
    </div>
    <Segmented className="seg-range" value={win} onChange={v => { setWin(v); setSel(null) }}
      options={[{ value: 7, label: t('Week') }, { value: 30, label: t('Month') }, { value: 90, label: t('Season') }, { value: 180, label: t('Half-year') }]} />
    {inWin.length ? <>
      <BodyMap className="tappable" load={load} body={body} selected={sel}
        onMuscle={m => setSel(s => (s === m ? null : m))} />
      <BodyMapLegend />
      {sel && <div className="mrow" style={{ borderTop: 'var(--hair) solid var(--sep)', marginTop: 4, paddingTop: 10 }}>
        <span className="nm"><b>{t(MUSCLE_NAME[sel])}</b></span>
        <span className="v">{sets(sel) ? t('{0} sets', sets(sel)) : on ? t('no hard sets') : t('not trained')}</span>
      </div>}
      {!sel && top.map(m => <div key={m} className="mrow">
        <span className="nm">{t(MUSCLE_NAME[m])}</span>
        <span className="bar"><i style={{ width: Math.round(load[m] / max * 100) + '%', background: on ? 'var(--yellow)' : undefined }} /></span>
        <span className="v">{t('{0} sets', sets(m))}</span>
      </div>)}
      {missed.length > 0 && <>
        <h4 className="sec" style={{ marginTop: 12 }}>{on ? t('No hard sets in this period') : t('Not trained in this period')}</h4>
        <div className="mchips">{missed.map(m => <span key={m} className="mchip miss">{t(MUSCLE_NAME[m])}</span>)}</div>
      </>}
      {!missed.length && worked.length > 0 &&
        <div className="muted small" style={{ marginTop: 10 }}>{on
          ? t('Every muscle group got at least one hard set in this period.')
          : t('Every muscle group got some work in this period.')}</div>}
    </> : <div className="muted small">{t('No workouts in this period yet.')}</div>}
  </div>
}
