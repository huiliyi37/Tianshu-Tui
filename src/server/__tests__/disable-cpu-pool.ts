/**
 * Side-effect import: disable the cpu-pool worker for this test process.
 * MUST be imported before any module that (transitively) imports
 * workers/cpu-pool.ts — the env flag is read at module load.
 *
 * Why: the pool's unref()'d worker conflicts with node:test's event-loop
 * drain detection (see workers/__tests__/cpu-pool.test.ts header) — a test
 * that triggers a worker spawn leaves the runner hanging after all tests
 * pass. Callers fall back to their inline paths, which is exactly what the
 * tests should exercise deterministically anyway.
 */
process.env.RIVET_CPU_POOL = '0'
