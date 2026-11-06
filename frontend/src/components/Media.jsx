import { useRef, useState } from 'react'
import { imgSrc, gifSrc, isVideoMedia } from '../lib/exercises.js'
import { useStore } from '../store/useStore.js'
import { t } from '../lib/i18n.js'
import Icon from './Icon.jsx'

// Big autoplaying animation; tap toggles to the still frame. `compact` shrinks it (superset cards).
// Custom exercises have no media — the animation stays blank by design (issue #11).
// `minimizable` (workout view) adds a persistent minimize/expand control so the animation stops
// eating the screen; the chosen size is saved to settings and carries across exercises and
// future workouts (issue #12).
export default function Media({ ex, id, compact, minimizable }) {
  const [playing, setPlaying] = useState(true)
  const videoRef = useRef(null)
  const gifSize = useStore(s => s.S.gifSize)
  const update = useStore(s => s.update)
  if (!ex.gif) return null
  const video = isVideoMedia(ex)
  const canPause = !!ex.img || video
  const mini = minimizable && gifSize === 'mini'
  const toggleSize = e => { e.stopPropagation(); update(s => { s.gifSize = mini ? 'full' : 'mini' }) }
  const still = ex.img ? imgSrc(ex) : gifSrc(ex)
  const togglePlayback = () => {
    if (video) {
      if (playing) videoRef.current?.pause()
      else videoRef.current?.play().catch(() => {})
    }
    setPlaying(p => !p)
  }
  return (
    <div className={'exmedia' + (compact ? ' compact' : '') + (mini ? ' mini' : '')} id={id} onClick={canPause ? togglePlayback : undefined}>
      {video
        ? <video ref={videoRef} src={gifSrc(ex)} autoPlay loop muted playsInline aria-label={ex.n} />
        : <img decoding="async" src={playing ? gifSrc(ex) : still} alt={ex.n} />}
      {minimizable && (
        <button className="giftoggle" onClick={toggleSize}>
          <Icon name={mini ? 'expand' : 'minimize'} />{mini ? t('Expand') : t('Minimize')}
        </button>
      )}
      {!mini && canPause && (
        <span className="gifhint">
          <Icon name={playing ? 'pause' : 'play'} />{playing ? t('tap to pause') : t('tap to play')}
        </span>
      )}
    </div>
  )
}

export function Thumb({ ex }) {
  const src = ex.img ? imgSrc(ex) : ex.gif ? gifSrc(ex) : null
  if (!src) return <div className="thumb thumb-x"><Icon name="dumbbell" /></div>
  if (isVideoMedia(ex)) return <video className="thumb" src={src} preload="auto" muted playsInline aria-hidden="true" />
  return <img className="thumb" loading="lazy" decoding="async" src={src} alt="" />
}
