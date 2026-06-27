import { useEffect } from 'react'
import { useWallpaper } from './WallpaperContext'

// WallpaperLayer — renders a full-viewport background image behind the app.
// When a wallpaper is set, it activates glass mode (data-surface="glass" on
// :root) so all surface tokens become translucent with backdrop blur.
// When cleared, the app reverts to solid opaque surfaces.
//
// State is managed by WallpaperProvider (WallpaperContext.tsx) so that
// SettingsSurface and this layer always stay in sync without custom events.

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

  // Toggle glass mode on document root
  useEffect(() => {
    const root = document.documentElement
    if (wallpaper) root.setAttribute('data-surface', 'glass')
    else root.removeAttribute('data-surface')
  }, [wallpaper])

  const objectFit =
    wallpaper?.fit === 'contain' ? 'contain' : wallpaper?.fit === 'center' ? 'none' : 'cover'

  if (loading || !wallpaper) return null

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
