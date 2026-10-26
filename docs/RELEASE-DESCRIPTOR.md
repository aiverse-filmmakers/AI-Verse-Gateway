# Release Descriptor Maintainer Handoff

`release/component-release.json` is the owner-local release metadata record for AI-Verse Gateway. The owner-local gate is `.github/workflows/release-descriptor.yml`, and its designated native workflow is `.github/workflows/ci.yml` (`CI`).

The descriptor is pinned to the exact G4.1 merged owner revision `386ff40135a841c27bfd106531b38a7f37c1c227`, whose **six-job** Linux/macOS/Windows, Node 20/22 native CI [40391434958](https://github.com/aiverse-filmmakers/AI-Verse-Gateway/actions/runs/40391434958) passed. The prior T2 revision `1772b75e2add73a524715f746e87b3a6b5561bf6` is historical. The descriptor remains **candidate**, not Distribution accepted: the operator-approved real-model Mac proof ran against the exact PR source `81d49a04c14caf2429cc0acd3a77f1072a1465f0`, which was then merged with a separate owner-native green check. The descriptor records that distinction; it is not a member publication, rollback acceptance, or Full profile gate release.

The gate must find a successful native workflow run whose `head_sha` equals `descriptor.revision` exactly. Do not substitute current branch health, a later commit, or a latest-success result. Missing, inaccessible, malformed, mismatched, or unsuccessful evidence fails closed.

A pinned candidate revision remains valid after later metadata-only maintainer commits unless component code or the designated native workflow contract changes.

This record has owner-local metadata authority only. It cannot qualify or modify the AI-Verse Distribution component set, admit an Agent or Full release, publish a member feature-release record, grant permissions, change scope/direction ownership, enable a disabled component, expose a remote listener, or report live-health truth.
