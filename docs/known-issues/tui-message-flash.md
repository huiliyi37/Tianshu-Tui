# TUI: Assistant Message "Flashes" After Streaming Completes

**Status:** ✅ Fixed (2026-05-30) — Options A + B applied  
**Date:** 2026-05-17 (identified), 2026-05-30 (fixed)  
**Files involved:** `src/tui/stream.tsx`, `src/tui/app.tsx`

---

## Symptom

After the model finishes streaming a response, the text briefly disappears before re-appearing as a static log entry. In the terminal this looks like a "flash" or "flicker" — the full reply is visible, then vanishes for a split second, then comes back as a finalized message.

---

## Root Cause

In `src/tui/app.tsx` the `onTurnComplete` callback clears React state in this order:

1. `pushStatic(assistant_message)` — pushes the final message to the static log buffer (`<Static>`).
2. `setStreamingText('')` — empties the live `StreamOutput` text.
3. `setIsStreaming(false)` — tells `StreamOutput` to stop rendering.

Between steps 2 and 3, `StreamOutput` receives:
- `text = ''`
- `isStreaming = true`

Its current implementation is:

```tsx
export const StreamOutput = memo(function StreamOutput({ text, isStreaming }: StreamOutputProps) {
  if (!text && !isStreaming) return null
  return (
    <Box flexDirection="column" paddingX={1}>
      <Text wrap="wrap">{text}</Text>   {/* empty */}
      {isStreaming && <Text dimColor>▊</Text>}  {/* cursor still shown */}
    </Box>
  )
})
```

Because `text` is empty but `isStreaming` is still `true`, the component does **not** return `null`. It renders an empty text line plus the `▊` cursor. The user sees a single frame of blank space (or just the cursor) before the component finally unmounts when `isStreaming` flips to `false`.

If Ink's `<Static>` `AssistantMessage` renders one frame later than the `StreamOutput` blanking, the user perceives the content as "flashing".

---

## Fix Options

### Option A — Modify `src/tui/stream.tsx` (recommended, minimal) ✅ APPLIED

Change `StreamOutput` so it returns `null` when `text` is empty, regardless of `isStreaming`:

```tsx
export const StreamOutput = memo(function StreamOutput({ text, isStreaming }: StreamOutputProps) {
  if (!text) return null   // was: if (!text && !isStreaming) return null
  return (
    <Box flexDirection="column" paddingX={1}>
      <Text wrap="wrap">{text}</Text>
      {isStreaming && <Text dimColor>▊</Text>}
    </Box>
  )
})
```

This removes the blank-cursor frame entirely. The message stays visible until `isStreaming` is set to `false`, at which point `StreamOutput` disappears cleanly and the static `AssistantMessage` takes over.

### Option B — Reverse state-clear order in `src/tui/app.tsx` ✅ APPLIED

In `onTurnComplete`, set `isStreaming` to `false` **before** clearing `streamingText`:

```ts
setIsStreaming(false)   // 1. hide StreamOutput while text is still present
setStreamingText('')    // 2. then clear the text
```

With this order, `StreamOutput` sees `isStreaming = false` while `text` still has content, so its existing guard `if (!text && !isStreaming) return null` does not trigger — the component simply unmounts immediately with the full text still in props.

### Option C — Apply both

Both changes are safe and additive. Option A makes the component more robust; Option B makes the lifecycle ordering more explicit.

---

## Verification After Fix

1. Run `npx tsc --noEmit` to confirm no type errors.
2. Run `npx tsx --test src/**/__tests__/*.test.ts` to ensure no regressions.
3. Manual test: send any prompt, watch the streamed response. The text should remain continuously visible from the last streaming delta through to the static log entry, with no blank frame in between.

---

## Related

- `src/tui/stream.tsx` — `StreamOutput` component
- `src/tui/app.tsx` — `onTurnComplete`, `onTextDelta`, state management
- `src/tui/assistant-message.tsx` — `AssistantMessage` (static log renderer)
