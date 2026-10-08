# Purpose Context Value Gate

`gateway.purpose-value-gate.v1` freezes the Phase 7.3 evaluation contract. It does not declare a gate outcome.

## Evaluation law

- Compare representative `operator` and exact `workspace:<id>` scenarios with Purpose enabled and with Purpose absent where technically fair.
- Keep underlying canonical owner state identical between comparison arms.
- Use predefined prompts and quality dimensions rather than selecting examples after seeing results.
- Record output/context differences and all mandatory anti-bloat measurements.
- Include a trivial task that must load zero Purpose context.
- Include a Purpose-owner-unavailable case that must preserve ordinary task execution without stale substitution.
- Record touched scopes so unrelated-workspace access is observable.
- Record latency/cost deltas when measurable; use `null`, not invented estimates, when the runtime cannot measure them.
- Do not infer `VALUE PROVEN` from context availability alone. Final outcome requires the complete Slice 7.3 evidence set.

## Frozen scenario set

1. operator rationale/explainability
2. workspace next-action decision
3. workspace prioritization
4. workspace blocker/material-change awareness
5. irrelevant formatting task
6. Purpose-owner-unavailable strategic task

The authoritative machine-readable scenario and measurement contract lives in `src/purpose-value-gate.mjs`.
