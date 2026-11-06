import { useLocation, useNavigate } from 'react-router-dom'
import { useStore } from '../store/useStore.js'
import { effectiveRoutine } from '../lib/history.js'
import { todayISO } from '../lib/format.js'
import { DEMO } from '../lib/demo.js'
import { MOBILE } from '../lib/mobile.js'
import { t } from '../lib/i18n.js'
import Icon from './Icon.jsx'

// Two navs stay mounted and the viewport picks one in CSS: #tabbar for phone
// and tablet, #sidebar from the desktop breakpoint up. No resize listeners —
// same CSS-driven approach as every other responsive decision in this app.
export default function TabBar({ onStart }) {
  const nav = useNavigate()
  const loc = useLocation()
  const S = useStore(s => s.S)
  const user = useStore(s => s.user)
  const clubName = useStore(s => s.clubName)
  const isGuest = useStore(s => s.isGuest())
  // matches the Shell gate: guest mode only counts in the backend-less builds
  if (!user && !((DEMO || MOBILE) && isGuest)) return null
  const cur = loc.pathname.split('/')[1] || 'home'
  const on = k => cur === k || (cur === 'history' && k === 'stats') || (cur === 'settings' && k === 'home')
  // the sidebar carries History and Settings as first-class items, so it highlights
  // the exact route instead of borrowing a neighbour's state like the tab bar does
  const onExact = k => cur === k

  const startWorkout = () => {
    if (!S.active) {
      const r = effectiveRoutine(S, todayISO())
      if (r && r.ex.length) { onStart(r.id); return }
    }
    nav('/workout')
  }
  const Tab = ({ k, icon, to, label }) => (
    <button className={on(k) ? 'on' : ''} onClick={() => nav(to)}>
      <Icon name={icon} /><span>{label}</span>
    </button>
  )
  const SideItem = ({ k, icon, to, label }) => (
    <button className={'sb-item' + (onExact(k) ? ' on' : '')} onClick={() => nav(to)}>
      <Icon name={icon} /><span>{label}</span>
    </button>
  )

  return (
    <>
      <nav id="tabbar">
        <Tab k="home" icon="house" to="/home" label={t('Home')} />
        <Tab k="plan" icon="calendar" to="/plan" label={t('Plan')} />
        <button className={'start' + (S.active ? ' rec' : '')} onClick={startWorkout}>
          <span className="cir"><Icon name={S.active ? 'play' : 'dumbbell'} /></span>
          <span>{S.active ? t('Resume') : t('Start')}</span>
        </button>
        <Tab k="stats" icon="chart" to="/stats" label={t('Stats')} />
        <Tab k="library" icon="list" to="/library" label={t('Exercises')} />
      </nav>
      <nav id="sidebar">
        <div className="sb-brand"><Icon name="dumbbell" /><span>{clubName || 'openGym'}</span></div>
        <button className="btn primary sb-start" onClick={startWorkout}>
          <Icon name={S.active ? 'play' : 'dumbbell'} />{S.active ? t('Resume') : t('Start')}
        </button>
        <SideItem k="home" icon="house" to="/home" label={t('Home')} />
        <SideItem k="plan" icon="calendar" to="/plan" label={t('Plan')} />
        <SideItem k="stats" icon="chart" to="/stats" label={t('Stats')} />
        <SideItem k="history" icon="history" to="/history" label={t('History')} />
        <SideItem k="library" icon="list" to="/library" label={t('Exercises')} />
        <div className="sb-div" />
        <SideItem k="settings" icon="gear" to="/settings" label={t('Settings')} />
        {(user?.admin || user?.role === 'coach') && <SideItem k="coach" icon="clipboard" to="/coach" label={t('Coach')} />}
        {user?.admin && <SideItem k="admin" icon="shield" to="/admin" label={t('Admin')} />}
        {user && <div className="sb-user"><Icon name="personCircle" /><span>{user.name}</span></div>}
      </nav>
    </>
  )
}
