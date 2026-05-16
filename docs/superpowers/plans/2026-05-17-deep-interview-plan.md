# Deep Interview 实施计划

## Task 1: Types + Phase Tracker
- `src/tui/phase-tracker.ts`: Add `'interview'` to Phase union
- New type `InterviewState` for clarity/intent/round data

## Task 2: StatusBar Interview UI
- `src/tui/status-bar.tsx`: Accept optional `interview` prop, render interview status line when active

## Task 3: app.tsx Integration
- Parse `<!-- interview:{...} -->` markers from agent text output
- Maintain `interviewState` ref, pass to StatusBar
- Clear interview state on turn complete

## Task 4: Slash Command + Prompt
- `src/tui/slash-commands.ts`: `/interview <topic>` command
- `src/prompt/static.ts`: Interview prompt segment appended when interview active

## Task 5: Tests
- Status bar interview rendering
- Clarity score parsing
- Interview marker regex
