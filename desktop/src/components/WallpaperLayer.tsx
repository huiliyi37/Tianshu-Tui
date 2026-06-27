import { useEffect, useState, useCallback } from 'react'

// WallpaperLayer — renders a full-viewport background image behind the app.
// When a wallpaper is set, it activates glass mode (data-surface="glass" on
// :root) so all surface tokens become translucent with backdrop blur.
// When cleared, the app reverts to solid opaque surfaces.
//
// The wallpaper is stored as a data URL in localStorage (user picks a file
// via the settings panel). No network requests — fully local.

const STORAGE_KEY = 'rivet:wallpaper'
const FIT_KEY = 'rivet:wallpaper-fit'

export type WallpaperFit = 'cover' | 'contain' | 'center'

export function getWallpaper(): string | null {
  try {
    return localStorage.getItem(STORAGE_KEY)
  } catch {
    return null
  }
}

export function getWallpaperFit(): WallpaperFit {
  try {
    return (localStorage.getItem(FIT_KEY) as WallpaperFit) ?? 'cover'
  } catch {
    return 'cover'
  }
}

export function setWallpaper(dataUrl: string | null): void {
  try {
    if (dataUrl) localStorage.setItem(STORAGE_KEY, dataUrl)
    else localStorage.removeItem(STORAGE_KEY)
  } catch {
    // localStorage full (data URLs are large) — silently fail
  }
}

export function setWallpaperFit(fit: WallpaperFit): void {
  try {
    localStorage.setItem(FIT_KEY, fit)
  } catch {
    // ignore
  }
}

/** Whether glass mode is currently active (a wallpaper is set). */
export function isGlassActive(): boolean {
  return getWallpaper() !== null
}

/**
 * Full-viewport background layer. Renders behind everything (z-index: -1).
 * When active, sets data-surface="glass" on document root to enable
 * translucent surface tokens + backdrop blur across the app.
 */
export function WallpaperLayer() {
  const [wallpaper, setWallpaperState] = useState<string | null>(() => getWallpaper())
  const [fit, setFitState] = useState<WallpaperFit>(() => getWallpaperFit())

  // Listen for wallpaper changes from settings panel (cross-component sync)
  useEffect(() => {
    const handler = () => {
      setWallpaperState(getWallpaper())
      setFitState(getWallpaperFit())
    }
    window.addEventListener('rivet:wallpaper-change', handler)
    window.addEventListener('storage', handler)
    return () => {
      window.removeEventListener('rivet:wallpaper-change', handler)
      window.removeEventListener('storage', handler)
    }
  }, [])

  // Toggle glass mode on document root
  useEffect(() => {
    const root = document.documentElement
    if (wallpaper) root.setAttribute('data-surface', 'glass')
    else root.removeAttribute('data-surface')
  }, [wallpaper])

  const objectFit = fit === 'cover' ? 'cover' : fit === 'contain' ? 'contain' : 'none'

  if (!wallpaper) return null

  return (
    <div
      className="wallpaper-layer"
      style={{
        backgroundImage: `url("${wallpaper}")`,
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
  const wallpaper = getWallpaper()
  const fit = getWallpaperFit()

  const pick = useCallback((file: File) => {
    const reader = new FileReader()
    reader.onload = () => {
      const dataUrl = reader.result as string
      setWallpaper(dataUrl)
      window.dispatchEvent(new Event('rivet:wallpaper-change'))
    }
    reader.readAsDataURL(file)
  }, [])

  const clear = useCallback(() => {
    setWallpaper(null)
    window.dispatchEvent(new Event('rivet:wallpaper-change'))
  }, [])

  const changeFit = useCallback((f: WallpaperFit) => {
    setWallpaperFit(f)
    window.dispatchEvent(new Event('rivet:wallpaper-change'))
  }, [])

  return { wallpaper, fit, pick, clear, changeFit }
}
