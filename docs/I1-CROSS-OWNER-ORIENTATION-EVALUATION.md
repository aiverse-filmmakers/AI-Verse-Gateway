# I1 Tiny Cross-Owner Orientation Map Evaluation

Status: **REJECTED FOR CURRENT ARCHITECTURE**

Date: 2026-09-15

## Decision

Do not add a new cross-owner orientation graph/map to AI-Verse OS or Gateway at this time.

The current G1 context assembly already receives the proposed orientation information from canonical owner surfaces. A new map would duplicate those views, while the one genuine missing domain, durable Bots, has no existing read-only owner boundary that the map could safely consume.

## Proposed domains vs current owner surfaces

| Proposed domain | Existing owner-routed surface |
| --- | --- |
| goals / direction | OS current-context projection with Brain-owned direction refs/view |
| Memory topics | Memory L1 orientation catalog |
| Data spaces | OS structured-data orientation |
| Skills | OS capability resolver / Gateway capabilities |
| Bots | **no read-only Gateway/OS host operation today** |
| recent sessions | Memory L1 `recent_sessions` digest pointers |
| important sources | Memory L1 `source_routes` with bounded path samples |

Measured coverage before any new map: **6 / 7 domains = 85.7%**.

## Memory already provides the graft-like history orientation

Memory's accepted L1 orientation projection is already:

- derived and rebuildable;
- scope aware;
- fingerprinted;
- byte bounded;
- composed of compact metadata rather than copied Memory text;
- inclusive of topic counts;
- inclusive of recent session digest pointers;
- inclusive of important source kinds/routes.

Creating a second cross-owner map would copy this navigation metadata into another derived projection.

## The Bot gap does not justify a map

Durable Bot orientation is genuinely absent from the current G1 bundle.

However, current OS host operations expose no `list_bots` or equivalent read operation, and Gateway HostClient has no Bot read method. OS can create/use Multiple Bots through explicit owner-routed action paths, but that is not a canonical read orientation API.

A new map cannot safely fill the Bot gap by scanning Multiple Bots files directly. Doing so would steal ownership and couple OS/Gateway to another component's storage layout.

Therefore:

- proposed domains: 7
- already owner-routed domains: 6
- safely sourced new domains added by a map today: **0**
- populated map domains that would duplicate current G1 context: **6 / 6 = 100%**
- safe information gain from the map itself: **0**

## Why not add the map now and fill Bots later?

That would create a second workspace graph before there is a unique information source for it. It would also introduce freshness, fingerprint, rebuild, scope, and declassification responsibilities across owners that already expose their own bounded projections.

The correct architecture is to keep owner orientation local:

- Brain/OS current context for direction
- Memory L1 for historical orientation
- Data orientation for structured spaces
- capability resolver for Skills
- owner-specific Bot read surface in Multiple Bots if/when runtime evidence proves it is needed

Gateway can assemble those owner views without persisting another canonical or semi-canonical graph.

## Revisit condition

Re-open I1 only after:

1. Multiple Bots exposes a canonical bounded read-only orientation interface, and
2. an integrated benchmark shows that assembling owner views on demand causes a measurable correctness, latency, or token-cost problem that a tiny derived cross-owner projection materially improves.

Until both conditions are true, the correct I1 outcome is **reject as bloat, documented and tested**.
