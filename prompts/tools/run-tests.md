## Run Tests Tool

Run project tests and return parsed results.

### Usage
- Use `run_tests` to verify changes after editing code
- Use `filter` to run a specific test file or test name
- Automatically detects package manager and test command from `package.json`
- Reports: exit code, failed tests, error details, duration

### Detection Logic
1. Reads `package.json` `scripts.test` to find the test runner
2. Maps to the appropriate command:
   - `vitest` → `npx vitest run`
   - `jest` → `npx jest`
   - `tsx --test` / `node:test` → uses script directly
   - Fallback → `npm test`

### Output
- Success: `Exit code: 0`, passed/failed/skipped counts, duration
- Failure: Includes `FAILURES:` section with test names and error details
- Output truncated at 8000 chars (head + tail preserved)

### Parameters
- `filter` (optional): Test file or name pattern
- `timeout` (optional): Timeout in ms (default: 120000)

### Examples
Good: `run_tests()` — run all tests
Good: `run_tests(filter="loop.test.ts")` — run specific test file
Good: `run_tests(timeout=300000)` — longer timeout for slow suites
