/**
 * Machine-only tag embedded in every pointer placeholder produced by the tool-arg
 * post-processors. Kept in a tiny dependency-free module so arg processors can
 * include it without creating a circular import with pointer-guard.ts.
 *
 * The model is extremely unlikely to emit this exact token when improvising an
 * imitation, but it will be present when the model literally regurgitates a
 * pointer from its compressed history. pointer-guard.ts includes this tag in its
 * detection phrases.
 */
export const POINTER_INTERNAL_TAG = '#RIVET-POINTER-DISPLAY-ONLY#'
