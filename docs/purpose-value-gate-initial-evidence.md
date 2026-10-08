# Purpose Context Value Gate - Initial Evidence

**Stage:** Slice 7.3 Task 2  
**Evidence level:** runtime-context comparison only  
**Gate outcome:** NOT YET RECORDED

This evidence uses the frozen `gateway.purpose-value-gate.v1` scenarios and the real Gateway `assembleProgressiveOwnerContext()` path. Strategic with-Purpose and Purpose-absent arms use identical ordinary owner context. The Purpose-absent arm is represented by genuine owner unavailability, which preserves the same underlying evaluation fixture while withholding the Purpose projection without introducing a production bypass mode.

## Initial results

| Scenario | Purpose reads | Purpose context | Decision-basis delta | Scope result |
| --- | ---: | --- | ---: | --- |
| operator rationale | 1 | loaded, bounded <= 16,384 bytes | +3 predefined evidence classes | exact `operator` only |
| workspace next action | 1 | loaded, bounded <= 16,384 bytes | +4 predefined evidence classes | exact `workspace:alpha` only |
| workspace prioritization | 1 | loaded, bounded <= 16,384 bytes | +5 predefined evidence classes | exact `workspace:alpha` only |
| workspace blocker | 1 | loaded, bounded <= 16,384 bytes | +4 predefined evidence classes | exact `workspace:alpha` only |
| trivial formatting | 0 | not loaded | 0 | exact `workspace:alpha` only |
| Purpose owner unavailable | 1 attempted | absent, no stale substitute | not scored in Task 2 | ordinary context assembly completes |

## What Task 2 proves

- All four predefined strategic scenarios gain explicit owner-backed decision basis when Purpose is present.
- The required planning/prioritization scenarios already show positive context-level deltas, including next-action and prioritization.
- The trivial scenario performs zero Purpose owner reads and adds zero Purpose bytes.
- Genuine Purpose-owner unavailability still permits ordinary context assembly and injects no stale Purpose substitute.
- No scenario touches an unrelated workspace.
- Purpose authority remains `ai-verse-os`; no Gateway authority regression is introduced.
- Exact Purpose envelope bytes are emitted by `npm run benchmark:purpose-value-initial` and asserted by the CI evaluation to be positive for strategic with-Purpose arms and no greater than 16,384 bytes.

## What Task 2 does not prove

This stage intentionally does **not** claim model-output improvement, real latency overhead, or real provider cost overhead. Those fields remain `null` or explicitly marked unmeasured rather than estimated. Task 3 must complete the remaining output/overhead/context-noise evidence before any final gate outcome is allowed.

## Reproducibility

- Evaluator: `benchmarks/purpose-value-initial.mjs`
- Regression: `test/purpose-value-initial-evaluation.test.mjs`
- Frozen scenario/measurement contract: `src/purpose-value-gate.mjs`
