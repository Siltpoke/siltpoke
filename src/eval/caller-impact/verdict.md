# Caller-Impact Eval — verdict

Frozen set; 9 planted-bug examples; 3 clean controls; 1 repeat(s)/arm.

## Per-arm catch (planted bugs)

| arm | caught | n | rate | Wilson 95% CI |
| --- | --- | --- | --- | --- |
| baseline | 0 | 9 | 0.0% | [0.0%, 29.9%] |
| grep-sigdelta | 6 | 9 | 66.7% | [35.4%, 87.9%] |
| graph-sigdelta | 2 | 9 | 22.2% | [6.3%, 54.7%] |
| coherent-irrelevant | 0 | 9 | 0.0% | [0.0%, 29.9%] |

## False-positive rate (clean controls)

| arm | false positives | controls | FP rate |
| --- | --- | --- | --- |
| baseline | 0 | 3 | 0.0% |
| grep-sigdelta | 0 | 3 | 0.0% |
| graph-sigdelta | 0 | 3 | 0.0% |
| coherent-irrelevant | 0 | 3 | 0.0% |

## McNemar — graph-sigdelta vs grep-sigdelta

- b (graph-caught, grep-missed): 0
- c (grep-caught, graph-missed): 4
- discordant pairs: 4
- exact two-sided p: 0.1250

**graph earns keep: underpowered**

> discordant pairs 4 < floor 6; not enough signal to decide (pre-registered: report underpowered, do not call it a loss)

## Honest limits

- **Grader is a different TIER, not a different FAMILY (OQ4).** Claude-only infra means the blind semantic grader runs on a different Claude tier than the arm under test, not a different model family. Cross-family confirmation is logged as an open question, not claimed.
- The deterministic catch oracle is primary; semantic confirmation is secondary and only annotates.
- Verdict semantics are pre-registered; `underpowered` (discordant < floor) is reported honestly and never massaged into a loss.
