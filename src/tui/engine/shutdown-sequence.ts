export interface TuiShutdownSequenceOptions {
  dispose: () => void | Promise<void>
  flushTelemetry: () => void | Promise<void>
  cleanup: ReadonlyArray<() => void | Promise<void>>
  exit: (code: number) => void
  reportErrors?: (error: AggregateError) => void
}

/**
 * Dispose first so the app produces its final perf summary, then durably flush
 * telemetry before tearing down shared resources or terminating the process.
 */
export async function runTuiShutdownSequence(
  options: TuiShutdownSequenceOptions,
  code: number,
): Promise<void> {
  const errors: unknown[] = []
  const runStep = async (step: () => void | Promise<void>): Promise<void> => {
    try {
      await step()
    } catch (error) {
      errors.push(error)
    }
  }

  await runStep(options.dispose)
  await runStep(options.flushTelemetry)
  for (const cleanup of options.cleanup) {
    await runStep(cleanup)
  }
  if (errors.length > 0) {
    try {
      options.reportErrors?.(new AggregateError(errors, 'TUI shutdown completed with errors'))
    } catch {
      // Reporting must never prevent termination.
    }
  }
  options.exit(code)
}
