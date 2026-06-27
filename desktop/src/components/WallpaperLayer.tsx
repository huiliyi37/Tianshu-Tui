import { useEffect, useState, useCallback } from 'react'
import {
  loadWallpaper,
  saveWallpaper,
  saveWallpaperFit,
  clearWallpaper,
  type WallpaperData,
} from '../lib/wallpaper-store'

// WallpaperLayer — renders a full-viewport background image behind the app.
// When a wallpaper is set, it activates glass mode (data-surface="glass" on
// :root) so all surface tokens become translucent with backdrop blur.
// When cleared, the app reverts to solid opaque surfaces.
//
// Images are compressed and stored in IndexedDB (not localStorage) to avoid
// the 5MB quota and avoid blocking the main thread with large base64 strings.

export type WallpaperFit = 'cover' | 'contain' | 'center'

const WALLPAPER_CHANGE_EVENT = 'rivet:wallpaper-change'

/** Whether glass mode is currently active (a wallpaper is set). */
export async function isGlassActive(): Promise<boolean> {
  const data = await loadWallpaper()
  return data !== null
}

/**
 * Full-viewport background layer. Renders behind everything (z-index: -1).
 * When active, sets data-surface="glass" on document root to enable
 * translucent surface tokens + backdrop blur across the app.
 */
export function WallpaperLayer() {
  const [wallpaper, setWallpaperState] = useState<WallpaperData | null>(null)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    let mounted = true
    loadWallpaper().then((data) => {
      if (!mounted) return
      setWallpaperState(data)
      setLoading(false)
    })
    return () => {
      mounted = false
    }
  }, [])

  // Listen for wallpaper changes from settings panel (cross-component sync)
  useEffect(() => {
    const handler = () => {
      setLoading(true)
      loadWallpaper().then((data) => {
        setWallpaperState(data)
        setLoading(false)
      })
    }
    window.addEventListener(WALLPAPER_CHANGE_EVENT, handler)
    return () => window.removeEventListener(WALLPAPER_CHANGE_EVENT, handler)
  }, [])

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

/** Hook for settings panel — pick/clear wallpaper and change fit mode. */
export function useWallpaperControl() {
  const [wallpaper, setWallpaper] = useState<WallpaperData | null>(null)
  const [fit, setFit] = useState<WallpaperFit>('cover')

  useEffect(() => {
    loadWallpaper().then((data) => {
      if (data) {
        setWallpaper(data)
        setFit(data.fit)
      }
    })
  }, [])

  const refresh = useCallback(() => {
    loadWallpaper().then((data) => {
      setWallpaper(data)
      if (data) setFit(data.fit)
    })
  }, [])

  const pick = useCallback(
    async (file: File) => {
      await saveWallpaper(file, fit)
      window.dispatchEvent(new Event(WALLPAPER_CHANGE_EVENT))
      refresh()
    },
    [fit, refresh],
  )

  const clear = useCallback(async () => {
    await clearWallpaper()
    setWallpaper(null)
    window.dispatchEvent(new Event(WALLPAPER_CHANGE_EVENT))
  }, [])

  const changeFit = useCallback(
    async (f: WallpaperFit) => {
      setFit(f)
      await saveWallpaperFit(f)
      window.dispatchEvent(new Event(WALLPAPER_CHANGE_EVENT))
      refresh()
    },
    [refresh],
  )

  return { wallpaper, fit, pick, clear, changeFit }
}
