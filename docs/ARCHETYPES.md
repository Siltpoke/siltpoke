# Siltpoke Archetype ↔ MBTI Mapping

**Date:** 2026-05-14
**Purpose:** Map each of Siltpoke's 16 base archetypes (or 48 with the
curiosity prefix) to its closest MBTI personality type. **Not a 1:1
academic mapping** — Siltpoke uses 5 Big-Five-aligned dials while MBTI
uses 4 binary axes derived loosely from Jungian functions. Treat this
as a fun reference, not a serious typing system.

---

## How the mapping works

Siltpoke dials (Big Five) vs MBTI axes (Jung-derived):

| Siltpoke dial | High = | MBTI mapping |
|---|---|---|
| `snark` | savage / blunt | T-leaning (Thinking) |
| `patience` | chill / saintly | F + low-N (Feeling, stable) |
| `rigor` | methodical | J-leaning (Judging) |
| `chattiness` | verbose / outgoing | E-leaning (Extraversion) |
| `curiosity` | exploratory | N-leaning (iNtuition) — used as prefix only |

Logic: `snark` ≈ Thinking-vs-Feeling, `patience` modulates Feeling
warmth, `rigor` ≈ J vs P, `chattiness` ≈ E vs I, `curiosity` ≈ N vs S.

So each archetype has a closest-fit MBTI type, with the curiosity
prefix shifting the S↔N axis.

---

## The 16 base archetypes

Each row: `snark`, `patience`, `rigor`, `chattiness` (high `+` / low `-`)
→ archetype name → MBTI nearest + flavor.

| Snark | Patience | Rigor | Chatty | Archetype | MBTI (nearest) | Vibe |
|:-:|:-:|:-:|:-:|---|---|---|
| + | − | + | − | **The Hawk** | **ISTJ** ("The Logistician") | Sharp-eyed, low-tolerance, surgical. Hunts in silence. |
| + | − | + | + | **The Drill Sergeant** | **ESTJ** ("The Executive") | Yells out every typo. Cares deeply, expresses it via volume. |
| + | + | + | − | **The Sly Fox** | **INTJ** ("The Architect") | Sees everything, says little, lands devastating one-liners. |
| + | + | + | + | **The Wry Coach** | **ENTJ** ("The Commander") | Snarky mentor energy. Will roast you AND teach you. |
| + | − | − | − | **The Snapper** | **ISTP** ("The Virtuoso") | Quick, sharp comments. No follow-up. Walks away. |
| + | − | − | + | **The Rant** | **ESTP** ("The Entrepreneur") | Long impassioned tirades, low evidence, high energy. |
| + | + | − | − | **The Tease** | **INTP** ("The Logician") | Playful jabs. Doesn't actually want you to feel bad. |
| + | + | − | + | **The Roaster** | **ENTP** ("The Debater") | Sharp tongue, big heart, loves the audience. |
| − | − | + | − | **The Perfectionist** | **ISFJ** ("The Defender") | Anxiously careful. Doesn't yell, just worries visibly. |
| − | − | + | + | **The Anxious Officer** | **ESFJ** ("The Consul") | Frets out loud about every detail. Means well. |
| − | + | + | − | **The Patient Sage** | **INFJ** ("The Advocate") | Quiet, methodical, kind. Cites evidence with gentle voice. |
| − | + | + | + | **The Saint** | **ENFJ** ("The Protagonist") | Patient, careful, warm, vocal cheerleader. Pure good. |
| − | − | − | − | **The Worrier** | **ISFP** ("The Adventurer") | Quietly anxious. Vibes-based. Doesn't share much. |
| − | − | − | + | **The Frantic** | **ESFP** ("The Entertainer") | Anxious + chatty. Pure vibes, all volume. Loveable mess. |
| − | + | − | − | **The Zen Monk** | **INFP** ("The Mediator") | Lets everything slide. Vibes only. Dreamy detachment. |
| − | + | − | + | **The Cheerleader** | **ENFP** ("The Campaigner") | Sunshine. Patient, chatty, no rigor. Hypes you up. |

---

## Curiosity prefix flips the S/N axis

Curiosity adds a flavor prefix:

- **High curiosity** (`curiosity ≥ 7`) → "Curious ___" → shifts MBTI toward **N (iNtuition)** — exploratory, suggests alternatives.
- **Low curiosity** (`curiosity ≤ 3`) → "Steady ___" → shifts MBTI toward **S (Sensing)** — concrete, by-the-book.
- **Mid curiosity** (`4-6`) → no prefix → neutral.

Example: **The Hawk** is closest to ISTJ. With `curiosity = 9` it
becomes **Curious Hawk** — closer to INTJ. With `curiosity = 1` it
becomes **Steady Hawk** — pure ISTJ.

That's how 16 base × 3 curiosity flavors = 48 distinct labels with a
loose MBTI shape underneath.

---

## Important caveats

- **This is for fun.** MBTI itself is widely contested in psychology
  (Big Five has stronger empirical support). The mapping above
  squishes 5 continuous dials into 4 binary axes — information is lost.
- **One archetype ≠ one MBTI.** A Hawk could feel ISTJ to one person
  and INTJ to another depending on dial precision. Treat the mapping
  as "vibes adjacent" not "scientifically equivalent".
- **Curiosity prefix is the cleanest mapping** — it's a direct S/N
  flip in MBTI's vocabulary.

---

## Why we don't use MBTI directly

The original quiz design considered MBTI directly as the framework.
Decision was against because:

1. MBTI binary forced-choice needs ~20 items per axis for stable
   signal. In a 5-question budget, binary throws away half the
   resolution.
2. Big Five Likert gives a continuous 0-10 dial natively (sum 1-5
   responses → normalize).
3. Big Five has empirical support in academic psychology; MBTI does
   not (per the Big Five wiki, MBTI test-retest reliability is poor,
   ~50% of people get a different type on re-test).

We use MBTI here only as a recognizable shorthand for users who know
their type. The actual scoring is Big-Five-aligned.

---

## Sources for the MBTI types

- [16Personalities — type descriptions](https://www.16personalities.com/personality-types)
- [MBTI Foundation — official type table](https://www.themyersbriggs.com/en-US/Products-and-Services/Myers-Briggs)

The "function/title" labels (Logistician, Defender, etc.) come from
16Personalities, which is the most widely-recognized consumer source.
