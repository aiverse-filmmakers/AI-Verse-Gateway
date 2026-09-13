# Architecture

## Ownership

Gateway owns only client-edge state: authenticated client sessions, runs, run checkpoints, streaming events, control/idempotency records, and Gateway audit receipts.

Owner boundaries remain external:

| Responsibility | Owner |
|---|---|
| Goals / strategic intent / verification | Brain |
| current system/workspace policy floor | OS |
| historical memory | Memory |
| structured domain truth | Data |
| reusable capabilities | Skills |
| bot/team coordination truth | Multiple Bots |
| external credentials / connections | Connections |
| token/cost truth | Token |
| schedules / durable future wakes | Automations |
| visual control-room state | Dashboard |

## Adapters

### OS host

Gateway uses the maintained `ai-verse-brain-bridge/1.0` JSON-subprocess contract already shipped by AI-Verse OS. The host adapter dynamically discovers optional component owners and keeps action authorization at OS.

### Runtime

Runtime selection is an execution concern, not domain ownership. Initial adapters are:

- `deterministic`, test only;
- `openai-compatible`, HTTP `/v1/chat/completions` upstream;
- `json-subprocess`, portable contract for Hermes/Codex/Claude/OpenClaw or later runtimes.

### Brain Goal owner

Goal continuation uses a separate `ai-verse-goal-owner/1.0` adapter contract. Gateway has no fallback Goal database. If Brain does not expose that owner adapter, Goal-bound runs are unavailable.

## Run state machine

Core states:

```text
queued -> running -> completed
                  -> awaiting_approval -> resuming -> running
                  -> paused -> resuming
                  -> parked -> resuming
                  -> paused_no_progress -> resuming
                  -> paused_recovery_required -> resuming
                  -> blocked
                  -> budget_limited
                  -> failed
                  -> canceled
```

Each important state transition is atomically checkpointed before later work relies on it.

## Goal continuation

```text
read Brain Goal
-> bind goal_id + version + activation_epoch
-> admit bounded turn
-> invoke runtime / tools through OS
-> collect evidence
-> Brain evaluates
-> complete | blocked | wait | continue
-> before continue: re-read Goal and validate exact binding
```

The outer default is 20 continuation turns per activation epoch. Configured/user requested budgets are intersected so a request cannot widen the outer limit.

## Extensibility

Multiple Bots, Token, Connections, and Automations should integrate through adapter/event boundaries. They must not be represented by new Gateway-owned domain tables. Gateway may emit receipts/events or route calls to those owners when their public contracts are available.
