import type { WallpaperFit } from '../components/WallpaperLayer'

const DB_NAME = 'tianshu-wallpaper'
const DB_VERSION = 1
const STORE_NAME = 'wallpaper'
const BLOB_KEY = 'blob'
const FIT_KEY = 'fit'

const MAX_DIMENSION = 1920
const JPEG_QUALITY = 0.85

function openDB(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION)
    req.onerror = () => reject(req.error)
    req.onsuccess = () => resolve(req.result)
    req.onupgradeneeded = () => {
      const db = req.result
      if (!db.objectStoreNames.contains(STORE_NAME)) {
        db.createObjectStore(STORE_NAME)
      }
    }
  })
}

function getItem<T>(db: IDBDatabase, key: string): Promise<T | undefined> {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, 'readonly')
    const store = tx.objectStore(STORE_NAME)
    const req = store.get(key)
    req.onerror = () => reject(req.error)
    req.onsuccess = () => resolve(req.result as T | undefined)
  })
}

function setItem<T>(db: IDBDatabase, key: string, value: T): Promise<void> {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, 'readwrite')
    const store = tx.objectStore(STORE_NAME)
    const req = store.put(value, key)
    req.onerror = () => reject(req.error)
    req.onsuccess = () => resolve()
  })
}

function removeItem(db: IDBDatabase, key: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, 'readwrite')
    const store = tx.objectStore(STORE_NAME)
    const req = store.delete(key)
    req.onerror = () => reject(req.error)
    req.onsuccess = () => resolve()
  })
}

/** Compress and resize an image before storing. Returns a Blob. */
export async function compressWallpaper(file: File): Promise<Blob> {
  const bitmap = await createImageBitmap(file)
  try {
    let { width, height } = bitmap
    if (width > MAX_DIMENSION || height > MAX_DIMENSION) {
      const ratio = Math.min(MAX_DIMENSION / width, MAX_DIMENSION / height)
      width = Math.round(width * ratio)
      height = Math.round(height * ratio)
    }

    const canvas = document.createElement('canvas')
    canvas.width = width
    canvas.height = height
    const ctx = canvas.getContext('2d')
    if (!ctx) throw new Error('Failed to get canvas context')
    ctx.drawImage(bitmap, 0, 0, width, height)

    // Prefer WebP for smaller size, fall back to JPEG.
    if (canvas.toBlob) {
      const blob = await new Promise<Blob | null>((resolve) => {
        const supportWebP = document
          .createElement('canvas')
          .toDataURL('image/webp')
          .startsWith('data:image/webp')
        canvas.toBlob(resolve, supportWebP ? 'image/webp' : 'image/jpeg', JPEG_QUALITY)
      })
      if (blob) return blob
    }

    // Fallback: data URL -> Blob (synchronous path).
    const dataUrl = canvas.toDataURL('image/jpeg', JPEG_QUALITY)
    const res = await fetch(dataUrl)
    return res.blob()
  } finally {
    bitmap.close()
  }
}

export interface WallpaperData {
  url: string
  fit: WallpaperFit
}

let cached: WallpaperData | null | undefined
let currentObjectUrl: string | null = null

function revokeCurrent() {
  if (currentObjectUrl) {
    URL.revokeObjectURL(currentObjectUrl)
    currentObjectUrl = null
  }
}

/** Load wallpaper blob from IndexedDB and create an object URL. */
export async function loadWallpaper(): Promise<WallpaperData | null> {
  if (cached !== undefined) return cached
  try {
    const db = await openDB()
    const blob = await getItem<Blob>(db, BLOB_KEY)
    const fit = (await getItem<WallpaperFit>(db, FIT_KEY)) ?? 'cover'
    if (!blob) {
      cached = null
      return null
    }
    revokeCurrent()
    currentObjectUrl = URL.createObjectURL(blob)
    cached = { url: currentObjectUrl, fit }
    return cached
  } catch {
    cached = null
    return null
  }
}

/** Store a compressed wallpaper image and update the cache. */
export async function saveWallpaper(file: File, fit: WallpaperFit = 'cover'): Promise<void> {
  const blob = await compressWallpaper(file)
  const db = await openDB()
  await Promise.all([setItem(db, BLOB_KEY, blob), setItem(db, FIT_KEY, fit)])
  revokeCurrent()
  currentObjectUrl = URL.createObjectURL(blob)
  cached = { url: currentObjectUrl, fit }
}

/** Update fit mode without re-compressing the image. */
export async function saveWallpaperFit(fit: WallpaperFit): Promise<void> {
  const db = await openDB()
  await setItem(db, FIT_KEY, fit)
  cached = cached ? { ...cached, fit } : null
}

/** Remove wallpaper and clear cache. */
export async function clearWallpaper(): Promise<void> {
  try {
    const db = await openDB()
    await Promise.all([removeItem(db, BLOB_KEY), removeItem(db, FIT_KEY)])
  } finally {
    cached = null
    revokeCurrent()
  }
}
