import { useEffect } from 'react'
import { useWallpaper } from './WallpaperContext'
import { useGlassMode } from '../lib/glass'

// WallpaperLayer — renders a full-viewport background behind the app.
// Glass mode activates when either a custom wallpaper is set OR the user has
// toggled on glass mode in settings. In the latter case we fall back to a
// subtle generated gradient so the translucent surfaces have something to blur.

export type { WallpaperFit } from './WallpaperContext'
export { useWallpaper } from './WallpaperContext'

/** Whether glass mode is currently active (a wallpaper is set). */
export async function isGlassActive(): Promise<boolean> {
  // Synchronous check is no longer possible with IndexedDB; consumers should
  // rely on the useWallpaper hook. This async helper is kept for compatibility.
  return false
}

/**
 * Full-viewport background layer. Renders behind everything (z-index: -1).
 * When active, sets data-surface="glass" on document root to enable
 * translucent surface tokens + backdrop blur across the app.
 */
export function WallpaperLayer() {
  const { wallpaper, loading } = useWallpaper()
  const [glassMode] = useGlassMode()

  const active = Boolean(wallpaper) || glassMode

  // Toggle glass mode on document root
  useEffect(() => {
    const root = document.documentElement
    if (active) root.setAttribute('data-surface', 'glass')
    else root.removeAttribute('data-surface')
  }, [active])

  const objectFit =
    wallpaper?.fit === 'contain' ? 'contain' : wallpaper?.fit === 'center' ? 'none' : 'cover'

  if (loading) return null

  if (wallpaper) {
    return (
      <div
        className="wallpaper-layer"
        style={{
          backgroundImage: `url("${wallpaper.url}")`,
          backgroundSize: objectFit,
          backgroundPosition: 'center',
          backgroundRepeat: 'no-repeat',
        }}
        aria-hidden
      />
    )
  }

  if (glassMode) {
    return <div className="wallpaper-layer wallpaper-gradient" aria-hidden />
  }

  return null
}
