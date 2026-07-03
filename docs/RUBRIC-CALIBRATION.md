# Rubric FP Calibration — Siltpoke Self-Codebase

**Date:** 2026-05-20
**Files scanned:** 223
**Total triggers:** 1823
**Errors:** 0

## Per-rule trigger counts

| Rule | Count | FP suspicion |
|---|---|---|
| magic-number | 1607 | 🔴 likely tune |
| god-function | 105 | 🔴 likely tune |
| deep-nesting | 73 | 🔴 likely tune |
| narrating-comment | 20 | 🟡 review |
| long-param-list | 7 | 🟢 |
| boolean-param | 5 | 🟢 |
| commented-out-code | 4 | 🟢 |
| god-file | 2 | 🟢 |

## Sample triggers (first 5 per rule)

### god-file

- src/web/screens/Critic.tsx:1 — File is 2070 lines (threshold: 800). Likely doing too many things; consider splitting by responsibility.
- src/cli/report.ts:1 — File is 3099 lines (threshold: 800). Likely doing too many things; consider splitting by responsibility.

### god-function

- src/memory/migrate-v3.ts:139 — Function 'migrateV2toV3' exceeds threshold: LOC=60 (threshold 50). Consider splitting into smaller, single-purpose functions.
- src/memory/summarizer.ts:59 — Function 'assembleSummarizerPrompt' exceeds threshold: LOC=54 (threshold 50). Consider splitting into smaller, single-purpose functions.
- src/memory/consolidate.ts:95 — Function 'countBrainCallsSince' exceeds threshold: cognitive complexity=18 (threshold 15). Consider splitting into smaller, single-purpose functions.
- src/memory/consolidate.ts:157 — Function 'loadRecentCritiques' exceeds threshold: cognitive complexity=27 (threshold 15). Consider splitting into smaller, single-purpose functions.
- src/memory/consolidate.ts:203 — Function 'loadRecentDismissals' exceeds threshold: cognitive complexity=18 (threshold 15). Consider splitting into smaller, single-purpose functions.

### deep-nesting

- src/memory/consolidate.ts:110 — Nesting depth 4 exceeds threshold (3) at 'if_statement'. Deep nesting harms readability and testability.
- src/memory/consolidate.ts:177 — Nesting depth 4 exceeds threshold (3) at 'if_statement'. Deep nesting harms readability and testability.
- src/memory/consolidate.ts:178 — Nesting depth 4 exceeds threshold (3) at 'try_statement'. Deep nesting harms readability and testability.
- src/memory/consolidate.ts:181 — Nesting depth 5 exceeds threshold (3) at 'if_statement'. Deep nesting harms readability and testability.
- src/memory/consolidate.ts:224 — Nesting depth 4 exceeds threshold (3) at 'if_statement'. Deep nesting harms readability and testability.

### long-param-list

- src/cli/chat.ts:166 — Function 'runSingleTurn' has 7 params (threshold 4). Too many params increase call-site complexity and reduce testability.
- src/cli/chat.ts:202 — Function 'runSearch' has 6 params (threshold 4). Too many params increase call-site complexity and reduce testability.
- src/cli/chat.ts:236 — Function 'runRepl' has 6 params (threshold 4). Too many params increase call-site complexity and reduce testability.
- src/state/pose.ts:54 — Function 'resolveArt' has 5 params (threshold 4). Too many params increase call-site complexity and reduce testability.
- src/critic/writeSnapshot.ts:32 — Function 'writeCriticSnapshot' has 5 params (threshold 4). Too many params increase call-site complexity and reduce testability.

### narrating-comment

- src/web/shells/Dashboard.tsx:217 — Narrating comment repeats what the next line already says. Comments should explain "why", not "what".
- src/web/screens/Home.data.ts:339 — Narrating comment repeats what the next line already says. Comments should explain "why", not "what".
- src/web/screens/Home.data.ts:349 — Narrating comment repeats what the next line already says. Comments should explain "why", not "what".
- src/web/screens/Home.data.ts:351 — Narrating comment repeats what the next line already says. Comments should explain "why", not "what".
- src/web/creature/parts.ts:95 — Narrating comment repeats what the next line already says. Comments should explain "why", not "what".

### magic-number

- src/memory/project.ts:41 — Magic number 16 found. Unnamed literals obscure intent and make refactoring brittle.
- src/memory/project.ts:113 — Magic number 3 found. Unnamed literals obscure intent and make refactoring brittle.
- src/memory/project.ts:178 — Magic number 4 found. Unnamed literals obscure intent and make refactoring brittle.
- src/memory/project.ts:179 — Magic number 2 found. Unnamed literals obscure intent and make refactoring brittle.
- src/memory/summarizer.ts:19 — Magic number 200 found. Unnamed literals obscure intent and make refactoring brittle.

### boolean-param

- src/cli/report.ts:835 — Boolean literal passed as positional argument to 'panelWrap'. Boolean flags obscure call-site intent.
- src/cli/report.ts:844 — Boolean literal passed as positional argument to 'panelWrap'. Boolean flags obscure call-site intent.
- src/cli/report.ts:853 — Boolean literal passed as positional argument to 'panelWrap'. Boolean flags obscure call-site intent.
- src/critic/rubric/tier2/narrating-comment.ts:104 — Boolean literal passed as positional argument to 'tokenize'. Boolean flags obscure call-site intent.
- src/critic/rubric/tier2/narrating-comment.ts:109 — Boolean literal passed as positional argument to 'tokenize'. Boolean flags obscure call-site intent.

### commented-out-code

- src/web/screens/Critic.tsx:513 — 2 consecutive comments appear to contain commented-out code. Dead code in comments creates noise and confusion.
- src/state/vitalsWriter.ts:124 — 2 consecutive comments appear to contain commented-out code. Dead code in comments creates noise and confusion.
- src/router/bash-parse.ts:145 — 2 consecutive comments appear to contain commented-out code. Dead code in comments creates noise and confusion.
- src/router/context.ts:147 — 2 consecutive comments appear to contain commented-out code. Dead code in comments creates noise and confusion.
