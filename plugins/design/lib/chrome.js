import { existsSync } from 'node:fs'

/** @param {Record<string, string | undefined>} [env] */
export function findChromeBinary(env = process.env) {
  const override = env.CHROME_PATH ?? env.PUPPETEER_EXECUTABLE_PATH
  if (override && existsSync(override)) return override

  const platform = process.platform
  /** @type {string[]} */
  const candidates = []
  if (platform === 'darwin') {
    candidates.push(
      '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
      '/Applications/Chromium.app/Contents/MacOS/Chromium',
      '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
    )
  } else if (platform === 'win32') {
    const pf = env['ProgramFiles'] ?? 'C:\\Program Files'
    const pf86 = env['ProgramFiles(x86)'] ?? 'C:\\Program Files (x86)'
    candidates.push(
      `${pf}\\Google\\Chrome\\Application\\chrome.exe`,
      `${pf86}\\Google\\Chrome\\Application\\chrome.exe`,
      `${pf}\\Microsoft\\Edge\\Application\\msedge.exe`,
    )
  } else {
    candidates.push(
      '/usr/bin/google-chrome',
      '/usr/bin/google-chrome-stable',
      '/usr/bin/chromium',
      '/usr/bin/chromium-browser',
      '/snap/bin/chromium',
    )
  }

  for (const p of candidates) {
    if (existsSync(p)) return p
  }
  return null
}

export function chromeNotFoundMessage() {
  return [
    'Chrome/Chromium not found on this system.',
    'Install Google Chrome, or set CHROME_PATH to the browser executable.',
    'macOS: /Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    'Linux: google-chrome or chromium in PATH',
    'Windows: C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  ].join('\n')
}
