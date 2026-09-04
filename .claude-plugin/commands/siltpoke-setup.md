---
description: Create your Siltpoke pet and finish the install (statusline; daemon stays opt-in).
---

Finish the Siltpoke install by having a real conversation with the user —
NOT a rigid set of pick-one cards. Do NOT run any terminal wizard: a slash
command has no interactive TTY (stdin is closed/piped), so a prompt-based
script would just hang. And do NOT reach for pick-one option cards (the
4-option question-card widget) for the rich fields below — those cards gut
the wizard's range (no random-name roll, only 2-3 of the 5 species / 8
languages, personality flattened to a single label). You are the wizard now:
ask in prose, in the user's language, and let them answer freely. Just
resolve every answer down to the concrete values the kernel needs.

## 0. First: express or custom?

Before anything else, offer ONE fork, in the user's language:

- **Express (秒装)** — a default pet in one step, no questions. Pick this and you
  skip §1–§4 entirely: species = **slime**, personality = **species default**
  (so NO dials — see §5), language = **whatever language this conversation is in**
  (infer it; read it back in one line; fall back to `en` only if truly unknown),
  and the name = **one auto-rolled random name**. Roll it now with the §2 command
  (`random-name slime`), read it back, and offer a re-roll or a type-your-own in
  the same breath. Then jump straight to §5 and write the answers file with:
  `species: "slime"`, `language: <inferred>`, the chosen `name`, **no `dials`
  block**, `"statusline": true`, `"daemon": false`. That is the whole express path
  — one confirmation, then the §5 kernel run. After it succeeds, still close the
  loop with §8's report-back — above all, tell them to **restart Claude Code** so
  the pet's face appears in the statusline (§7's menu-bar offer is optional).
- **Custom (自己捏)** — meet the pet properly: walk §1–§5 below as written.

If they don't choose, or seem unsure, default to **Custom** (the richer, safer
path). Only take Express on an explicit "quick / default / 秒装 / just give me one".

For the **Custom** path, ask in this order. Keep it warm and quick — this is
meeting a new pet, not filling a form. (Express skips straight to §5 per §0.)

## 1. Species — present all 5

Offer the complete set, one short flavor line each, and let them pick by name:

- **slime** (default) — squishy, unbothered, all-round neutral.
- **cat** — sharp, impatient, low-key judging your code.
- **owl** — patient, rigorous, wants the evidence.
- **robot** — terse, exacting, all rigor no small talk.
- **bunny** — gentle, chatty, endlessly patient.

These five are the ONLY valid species. The kernel validates against them and
refuses to write a config for anything else, so do not invent new ones.

## 2. Name — three paths

Offer all three; let them choose:

1. **Type their own** — anything they like.
2. **Random** — roll a REAL generated name (adjective + species-biased noun,
   e.g. "Velvetpaw", "Glitchybolt"). Run this, passing the species — and pass
   ONLY one of the five literal species words from §1 (`slime` / `cat` / `owl`
   / `robot` / `bunny`), NEVER any other user-typed text, since it lands on a
   live command line:

   ```bash
   bun "${CLAUDE_PLUGIN_ROOT}/dist/siltpoke-cli.js" random-name cat
   ```

   (Replace `cat` with the species they picked.) Show them the result. If they
   want a different one, run it again to re-roll — as many times as they like
   — until one lands.
3. **Suggestions** — if they're unsure, roll a few (run the command above 3-4
   times) and offer the list to pick from.

## 3. Language — present all 8

This sets the language the pet SPEAKS in its bubbles. Offer all eight, and
note they can name another locale if theirs isn't listed:

- `en` — English
- `zh-CN` — 简体中文 (Simplified Chinese)
- `zh-TW` — 繁體中文 (Traditional Chinese)
- `ja` — 日本語 (Japanese)
- `ko` — 한국어 (Korean)
- `es` — Español (Spanish)
- `fr` — Français (French)
- `de` — Deutsch (German)

Any other locale code is fine too — the pet will do its best. Whatever they
say, keep the value they gave.

## 4. Personality — the five dials, five ways to set them

The pet's personality is FIVE dials, each 0-10:

- **snark** — 0 = sweet, 10 = savage.
- **patience** — 0 = trigger-happy at mistakes, 10 = saintly.
- **rigor** — 0 = vibes-based, 10 = methodical, cites evidence.
- **chattiness** — 0 = terse, 10 = verbose bubbles.
- **curiosity** — 0 = by-the-book, 10 = always suggesting alternatives.

Offer five ways to arrive at them — let the user pick the mode:

- **(a) Species default** — use THIS SPECIES' OWN default personality. It is
  NOT a flat 5/10: each species has a distinct out-of-the-box profile (a cat is
  sharp and impatient, an owl patient and rigorous, a robot terse and exacting,
  a bunny gentle and chatty; only slime happens to be all-5). Fastest. For this
  mode you write NEITHER `dials` NOR a personality name — leave both out of the
  answers file and the kernel fills in the species profile itself (see §5).
- **(b) Customize** — ask the user each of the five dials in turn, explaining
  the two poles (as above), 0-10 each. Use what they say verbatim.
- **(c) Random** — YOU roll five numbers, each 0-10, and read them back. (Just
  pick five plausible 0-10 integers yourself; no command needed.)
- **(d) Quiz** — a personality quiz (5 statements + 3 scenarios) whose dials
  are SCORED from the answers (a real weighted scoring function), NOT guessed
  by you. **Ask ONE question at a time and WAIT for their answer before asking
  the next — never dump them all at once.** It should feel like a conversation,
  not a form.

  First, five agree↔disagree statements. Ask each VERBATIM, exactly as written
  here (do not paraphrase or soften them), one per turn, and map the user's
  reply to a 1-5 score: **strongly disagree = 1, disagree = 2, neutral = 3,
  agree = 4, strongly agree = 5**. React briefly to each answer (a one-liner)
  before moving on.

  1. "I'd rather someone be honest with me than spare my feelings."
  2. "When someone makes the same mistake twice, I stay calm about it."
  3. "I like to double-check my work before I call it done."
  4. "I enjoy a good long conversation more than a quick exchange."
  5. "I like to explore a few different options before I decide."

  Then three forced-choice scenarios. Ask each VERBATIM with its options —
  **one scenario per turn, waiting for their answer each time** — and record
  the letter they pick for each (in order):

  > Scenario 1 — A friend points out you slipped up. You'd rather they:
  > - a) Tease you about it with a grin
  > - b) Gently talk you through it
  > - c) Walk you through every step so it won't happen again
  > - d) Just let it go

  > Scenario 2 — You're telling someone a story. You tend to:
  > - a) Give them the quick version
  > - b) Tell the whole thing with every detail

  > Scenario 3 — Faced with a choice, you usually:
  > - a) Go with the first good option
  > - b) Explore a few alternatives first

  Then ONE more question — how the pet's personality should RELATE to the
  user's (this is the match mode). Ask it VERBATIM, wait for the answer:

  > How should [pet name] relate to YOUR personality?
  > - **mirror** — like you (same vibe, matches your energy)
  > - **complement** — your opposite (fills your gaps)
  > - **hybrid** — a mix (matches your vibe, but fills your blindspots)

  Map their reply to one of `mirror` / `complement` / `hybrid` (default
  `mirror` if they're unsure).

  Now compute the dials — do NOT pick them yourself. Collect the five 1-5
  scores in order (statement 1 → 5) plus the three finale letters in order
  (scenario 1 → 3) and the chosen match mode, and run the real scorer. It
  takes the answers as a small constrained JSON blob (five integers 1-5 and
  one letter per scenario — no user free-text, so it is injection-safe to pass
  on the command line), plus `--match-mode`:

  ```bash
  bun "${CLAUDE_PLUGIN_ROOT}/dist/siltpoke-cli.js" quiz-score --answers '{"scores":[5,4,3,2,1],"finales":["a","a","a"]}' --match-mode mirror
  ```

  (Replace the five `scores` with the user's 1-5 answers in order, `finales`
  with their three letters in scenario order, and `--match-mode` with their
  chosen `mirror` | `complement` | `hybrid`. Omit `--match-mode` and it
  defaults to `mirror`.) It prints the five dials as JSON, e.g.
  `{"snark":9,"patience":6,"rigor":6,"chattiness":5,"curiosity":7}`. Those
  returned dials — verbatim — are what you write into the answers file in §5.
  Read them back to the user before writing.
- **(e) Read my memory** — calibrate the dials to how the USER actually works
  by reading their global Claude Code memory. Read whatever exists of
  `~/.claude/CLAUDE.md`, the files under `~/.claude/rules/`, and the files
  under `~/.claude/memory/` (expand `~` to their real home). From what those
  files reveal about their working style — tone, rigor, patience with mistakes,
  how much they want spelled out, whether they like alternatives pitched — YOU
  pick the five dial values (each 0-10) that match them, and read them back.
  Keep it HONEST: if none of those files exist (or they're just generic style
  guides with nothing personal), say so plainly and offer another mode instead
  of inventing a read.

Except for **(a) Species default** (which writes no dials at all), every mode
ENDS with five concrete dial values (each an integer 0-10). Read them back
before writing.

## 5. Write the answers to a file — with the Write tool, NOT the shell

The name, species and language are user text and could contain shell
metacharacters (a name like `"; rm -rf ~; #` would be executed by the user's
shell if you interpolated it). So the shell NEVER sees them. Use the **Write
tool** (it does not go through a shell — whatever you write lands as literal
bytes) to create:

**`~/.siltpoke/.setup-answers.json`** (expand `~` to the user's real home
directory; the Write tool needs an absolute path)

```json
{
  "name": "<name>",
  "species": "<species>",
  "language": "<language>",
  "dials": {
    "snark": 5,
    "patience": 5,
    "rigor": 5,
    "chattiness": 5,
    "curiosity": 5
  },
  "statusline": true,
  "daemon": false
}
```

Use the FINAL five dial values from step 4 (the example above shows all-5, only
as a shape illustration — NOT the "species default"). Put the name / species /
language in verbatim, exactly as the user gave them — do NOT strip, escape, or
"sanitize" anything. They are JSON string values, not shell words. Note the key
is `language` (not `lang`) and the personality is carried as `dials` — five
numbers — NOT a preset name.

**Species-default mode is the exception** (this is also the Express path from
§0): for mode (a) from §4 — or any Express install — OMIT the `dials` block
entirely (drop those lines). Do NOT substitute 5/10 for them —
sending 5/10 would give every species the slime profile. With no `dials` key
present the kernel applies this species' own default profile itself. Every
other mode (b–e) writes the five `dials` as shown.

Then run exactly this — one fixed path, zero user data on the command line:

```bash
bun "${CLAUDE_PLUGIN_ROOT}/dist/siltpoke-configure.js" --answers-file "$HOME/.siltpoke/.setup-answers.json"
```

`"statusline": true` installs the ASCII face into the statusline (a plugin
cannot set `statusLine` itself — only this command can, by running the kernel
that mutates `~/.claude/settings.json`). `"daemon": false` keeps the daemon
**opt-in** (the default): core review runs in the Stop hook and never needs the
daemon — it only powers the optional web surfaces (dashboard / chat / index).
Leave it `false`; the user turns it on whenever they want them by opening
`/siltpoke-dashboard`, which starts the daemon on demand. Do NOT set it `true`
here (that would install a launchd/systemd autostart unit nobody asked for and
bring back the reboot `ECONNREFUSED`).

The kernel validates `species` against the real list (see §1) and validates
each dial is an integer 0-10, and refuses to write a config for anything
else, so a bad value fails loudly instead of silently handing over the wrong
pet. It deletes the answers file after a successful run, backs up
`~/.claude/settings.json` itself before touching it, and asks nothing — no
host picker, no editor question, no overwrite confirmation.

## 6. If it fails

The kernel exits non-zero and prints one line to stderr. Translate it; do not
dump the raw trace:

- **`command not found: bun`** — Bun is not installed or not on PATH. Tell the
  user to install it (`curl -fsSL https://bun.sh/install | bash`) and re-run
  `/siltpoke-setup`. Nothing was written.
- **`unknown species "<x>" — valid species: …`** — you passed a species
  outside the list in §1. No config was written. Fix it (ask the user again if
  they truly typed something else), rewrite the answers file, and re-run.
- **`dial "<k>" must be an integer 0..10 …`** — a dial came through out of
  range or non-integer. No config was written. Re-read the five dials, fix the
  offending one, rewrite the answers file, and re-run.
- **`missing --name`** — the name came through empty. Ask again.
- **`cannot read --answers-file …` / `… is not valid JSON` / `… must contain a
  JSON object`** — the file was not written, or was written malformed. Re-write
  it with the Write tool and re-run.
- **`warning: … settings.json is not valid JSON — skipping settings wiring`** —
  NOT fatal: the pet IS created, only the statusline was skipped because the
  user's `~/.claude/settings.json` could not be parsed (it was left
  untouched). Tell them to fix the JSON in that file and re-run
  `/siltpoke-setup` to get the face in the statusline.
- **`warning: daemon autostart …`** — NOT fatal: the pet and statusline are
  installed; only the background dashboard's autostart unit failed. They can
  still run `/siltpoke-dashboard` manually.
- **any other error mentioning a write / `EACCES` / `EPERM` / `ENOSPC`** — the
  write failed. Report the path verbatim and suggest checking permissions on
  `~/.siltpoke/` and `~/.claude/` (and disk space).

## 7. Offer the menu-bar pet (macOS only)

Once the kernel run in §5 succeeded, offer ONE optional extra: the pet in the
macOS menu bar (a separate surface from the statusline and the dashboard, via
the free SwiftBar app). This is additive — the same thing `/siltpoke-menubar`
does standalone — so keep it a light one-liner, not a second setup flow.

**macOS only.** Only raise this on a Mac. If you're not certain of the
platform, check with `uname -s` (`Darwin` = macOS); on anything else, skip
this whole step silently — no mention, no command.

Ask, in the user's language, whether they'd also like the pet in their menu
bar. If they decline, move on to §8. If they say yes, run exactly this — one
fixed command, zero user data on the line:

```bash
bun "${CLAUDE_PLUGIN_ROOT}/dist/siltpoke-cli.js" menubar install
```

Running the command IS the consent — it never prompts and never auto-installs
anything (it will NOT `brew install` SwiftBar behind their back). Translate
the one line it prints; don't dump raw output:

- `✓ menu-bar pet installed.` — it's live; the pet shows in the menu bar
  (SwiftBar refreshes it every minute).
- `SwiftBar isn't installed …` (reason `no-swiftbar`) — the menu-bar pet needs
  the free SwiftBar app. Give them the link it printed
  (https://github.com/swiftbar/SwiftBar) and tell them to re-run
  `/siltpoke-menubar install` once SwiftBar is in place. Everything else from
  setup is already done — this is the only piece left.
- `the menu-bar pet is macOS-only.` — shouldn't appear if you guarded on
  `uname` above; if it does, just skip it.

The menu bar is optional — a "no" here costs nothing, the pet already lives in
the statusline and dashboard.

## 8. Report back

Tell the user, in their chosen language:

- **Restart Claude Code** — the pet's face then appears in the statusline.
- Next time you can go faster: `/siltpoke-setup` offers an **express** option
  (a default pet in one step) alongside the full custom flow.
- Dashboard: `/siltpoke-dashboard` (opens http://127.0.0.1:9876).
- Menu bar (macOS): `/siltpoke-menubar` — add / check / remove the menu-bar pet
  anytime. Only mention this on a Mac; skip it otherwise.
- Trouble: `/siltpoke-doctor`.
- **Reviews run on your existing `claude` CLI by default — nothing extra is
  installed.** Say this plainly; do not bury it. Siltpoke's reviewer is a
  `claude -p` subprocess reading over your shoulder, so the Brain model you
  already have is what powers it out of the box. A local model (Ollama) is
  available if you ask for it instead, but it is not part of this setup and
  downloads several GB — only bring it up if the user asks.
