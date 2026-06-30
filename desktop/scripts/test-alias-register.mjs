import { register } from 'node:module'

/** Register the @/ → desktop/src/ alias loader for desktop tests. */
register(new URL('./test-alias-loader.mjs', import.meta.url))
