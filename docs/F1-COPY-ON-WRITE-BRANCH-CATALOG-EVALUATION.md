# F1 Copy-on-Write Branch Catalog Evaluation

Status: **REJECTED FOR CURRENT ARCHITECTURE**

Date: 2026-09-15

## Decision

Do not add a copy-on-write branch/fork catalog layer to AI-Verse Gateway at this time.

F1 is an evaluation gate, not a requirement to ship branch infrastructure. The current architecture has no canonical branch/fork lineage, and the immutable fold store already keeps each fold card as one content-addressed file. Adding a branch catalog now would add visibility semantics without a canonical owner and would not remove an existing immutable-history copy cost.

## Current live architecture

The F1 re-audit used current Gateway main and current AI-Verse Multiple Bots main.

Gateway session identity is bound by system, workspace and principal. Runs are bound to sessions and keep canonical raw messages. Neither persisted sessions, runs nor fold cards define a branch ID, fork ID, parent branch or fork point.

Multiple Bots owns durable Bot identity, workers, rooms, threads, messages, tasks, handoffs, artifacts and team runs. Its current protocol has no branch/fork lineage object and no parent-run/session branch identity. Repository code search also finds no active `branch`, `fork`, `parent_run` or `parent_session` implementation in Gateway or Multiple Bots.

Fold cards are immutable and content-addressed. The fold catalog is disposable derived metadata rebuilt by scanning card files. It does not copy raw source messages and does not copy card summaries.

## Benchmark result

The executable F1 evaluation creates one pre-divergence immutable card, then opens two independent catalog views over the same scope.

Measured result:

- card files before the two views: 1
- card files after the two views: 1
- duplicated immutable-card bytes added by the views: **0**
- copy-on-write storage savings over the current baseline: **0 bytes**

This means the existing architecture already shares the immutable pre-divergence card physically. There is no duplicate branch copy for a new COW layer to eliminate.

The evaluation then creates two divergent later cards in the same workspace. Because AI-Verse currently has no canonical branch identity, both hypothetical branch readers see all three cards. A catalog-only branch feature therefore cannot safely isolate divergent history without inventing a new branch authority/visibility model.

Cross-workspace ancestry remains fail-closed: attempting to build one recursive fold from cards in different workspaces is rejected with `FOLD_SCOPE_MISMATCH`.

## Security and ownership consequence

Shipping branch catalogs now would create a new visibility/declassification dimension before AI-Verse has a canonical branch owner. A summary inherited into a hypothetical branch could reveal source content that the branch should not see, and Gateway or Multiple Bots would have to invent lineage/visibility authority to prevent it.

That would violate the current ownership boundary and provide no measured storage benefit.

## Revisit condition

Re-open F1 only after AI-Verse introduces a canonical branch/fork identity with an explicit fork point and visibility contract, or after production evidence shows immutable pre-fork history is actually being duplicated across branches.

At that point the benchmark should compare:

1. naive duplicated pre-fork history,
2. shared immutable pre-fork cards,
3. independent post-fork cards,
4. straddling-card expansion/backfill,
5. unauthorized-summary leakage,
6. catalog/card bytes and rebuild cost.

Until then the correct F1 outcome is **reject, documented and tested**.
