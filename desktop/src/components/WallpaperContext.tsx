import { createContext, useContext, useState, useEffect, useCallback, useMemo } from 'react'
import {
  loadWallpaper,
  saveWallpaper,
  saveWallpaperFit,
  clearWallpaper,
  type WallpaperData,
} from '../lib/wallpaper-store'

export type WallpaperFit = 'cover' | 'contain' | 'center'

interface WallpaperContextValue {
  wallpaper: WallpaperData | null
  fit: WallpaperFit
  loading: boolean
  pick: (file: File) => Promise<void>
  clear: () => Promise<void>
  changeFit: (fit: WallpaperFit) => Promise<void>
}

const WallpaperContext = createContext<WallpaperContextValue | null>(null)

export function WallpaperProvider(props: { children: React.ReactNode }) {
  const [wallpaper, setWallpaper] = useState<WallpaperData | null>(null)
  const [fit, setFit] = useState<WallpaperFit>('cover')
  const [loading, setLoading] = useState(true)

  const refresh = useCallback(async () => {
    const data = await loadWallpaper()
    setWallpaper(data)
    if (data) setFit(data.fit)
  }, [])

  useEffect(() => {
    let mounted = true
    loadWallpaper().then((data) => {
      if (!mounted) return
      setWallpaper(data)
      if (data) setFit(data.fit)
      setLoading(false)
    })
    return () => {
      mounted = false
    }
  }, [])

  const pick = useCallback(
    async (file: File) => {
      await saveWallpaper(file, fit)
      await refresh()
    },
    [fit, refresh],
  )

  const clear = useCallback(async () => {
    await clearWallpaper()
    setWallpaper(null)
  }, [])

  const changeFit = useCallback(
    async (f: WallpaperFit) => {
      setFit(f)
      await saveWallpaperFit(f)
      await refresh()
    },
    [refresh],
  )

  const value = useMemo(
    () => ({ wallpaper, fit, loading, pick, clear, changeFit }),
    [wallpaper, fit, loading, pick, clear, changeFit],
  )

  return <WallpaperContext.Provider value={value}>{props.children}</WallpaperContext.Provider>
}

export function useWallpaper(): WallpaperContextValue {
  const ctx = useContext(WallpaperContext)
  if (!ctx) throw new Error('useWallpaper must be used within WallpaperProvider')
  return ctx
}
