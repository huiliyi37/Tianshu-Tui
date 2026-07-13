export type SearchSessionContent<T> = (query: string, signal: AbortSignal) => Promise<T[]>

export type SearchScheduler = {
  setTimeout: (callback: () => void, delayMs: number) => unknown
  clearTimeout: (handle: unknown) => void
}

type ProjectSidebarSearchOptions<T> = {
  search: SearchSessionContent<T>
  onResults: (results: T[]) => void
  delayMs?: number
  scheduler?: SearchScheduler
}

export type ProjectSidebarSearch = {
  update: (query: string) => void
  dispose: () => void
}

export function createProjectSidebarSearch<T>(
  options: ProjectSidebarSearchOptions<T>,
): ProjectSidebarSearch {
  const delayMs = options.delayMs ?? 250
  const scheduler = options.scheduler ?? {
    setTimeout: (callback, delay) => setTimeout(callback, delay),
    clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
  }
  let requestId = 0
  let timer: unknown
  let timerPending = false
  let activeController: AbortController | undefined

  const cancelCurrent = () => {
    if (timerPending) {
      scheduler.clearTimeout(timer)
      timer = undefined
      timerPending = false
    }
    activeController?.abort()
    activeController = undefined
  }

  const update = (query: string) => {
    requestId++
    const ownRequestId = requestId
    cancelCurrent()
    const normalized = query.trim()
    if (normalized.length < 2) {
      options.onResults([])
      return
    }

    activeController = new AbortController()
    const controller = activeController
    timerPending = true
    timer = scheduler.setTimeout(() => {
      timer = undefined
      timerPending = false
      options.search(normalized, controller.signal)
        .then((results) => {
          if (requestId === ownRequestId) options.onResults(results)
        })
        .catch(() => {
          if (requestId === ownRequestId && !controller.signal.aborted) options.onResults([])
        })
    }, delayMs)
  }

  const dispose = () => {
    requestId++
    cancelCurrent()
  }

  return { update, dispose }
}
