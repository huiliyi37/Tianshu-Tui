/** sidecar 与桌面同一口径：data:image/(png|jpeg|webp|gif);base64,… */
const ACCEPTED = /^data:image\/(png|jpeg|webp|gif);base64,.+$/i
const MAX_IMAGES = 4
const MAX_BYTES = 1.5 * 1024 * 1024

export function normalizeImageDataUrl(raw: string): string | null {
  let url = raw.trim()
  if (url.startsWith('data:image/jpg;')) url = url.replace('data:image/jpg;', 'data:image/jpeg;')
  return ACCEPTED.test(url) ? url : null
}

export function decodedImageBytes(dataUrl: string): number {
  const comma = dataUrl.indexOf(',')
  if (comma < 0) return 0
  const b64 = dataUrl.slice(comma + 1)
  return Math.floor((b64.length * 3) / 4)
}

export function canAddImage(current: number): boolean {
  return current < MAX_IMAGES
}

export function imageTooLarge(dataUrl: string): boolean {
  return decodedImageBytes(dataUrl) > MAX_BYTES
}
