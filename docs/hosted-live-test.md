# Hosted dispatcher acceptance — November 3, 2026

Deployed with the reusable provisioning operation and its CLI client:

```sh
npm run provision -- --org alex-ezell --app amp-orbs-alex-ezell \
  --provider mcp-amp-test --region ord --handoff-local
```

## Installation

- App: [amp-orbs-alex-ezell](https://fly.io/apps/amp-orbs-alex-ezell)
- Organization: `alex-ezell` (verified with the Apps API)
- Region: `ord`
- Machine: `48e074ea939198`, one shared CPU and 512 MB RAM
- Volume: `vol_42kx7ln6yq2w1k34`, `dispatcher_data`, 1 GB
- Image index digest: `sha256:1e0e49db6eac1039c3f437cf7d0ebdaba729c401a98cf053c60058e0b1182220`
- Amp provider: `fly-sprites-test`
- Runtime credential expires February 1, 2027. Rotation is not automated yet.
- No public IPs or public HTTP service. Only the prefix-restricted Sprite
  credential and Amp provider token are installed as runtime credentials.
- The former local controller was stopped before hosted activation and remains
  stopped. The hosted dispatcher is left running and incurs ongoing charges.

## Verified

1. Created the app, built/pushed the image, created the encrypted volume, staged
   secrets, and deployed exactly one Machine. Private status confirmed Amp
   provider startup. General Fly credentials were not copied into the image or app.
2. Imported the original paused Orb's ownership record. Resuming its
   [thread](https://ampcode.com/threads/T-01a1a1e7-2fe8-73c6-981b-e8b35e50babb)
   through the hosted provider read `fly-amp-persistence-20261103` as `user`.
   Its original Sprite ID remained `ea2083c0-fbfb-4e1a-964e-b40dcd91b0ab`.
3. Created a fresh private Amp thread through the hosted provider. Its remote
   shell returned `x86_64`, `user`, and `hosted-dispatcher-ok`, exit status 0.
4. Archived that thread, restarted the dispatcher Machine, verified its new
   connection, and resumed the thread. It read the existing marker successfully.
   This exercised persistent state, the volume lock, and stale PID-file recovery.
5. Reran provisioning twice. Both runs reused the original app, image, volume,
   credentials, and Machine; neither rebuilt nor redeployed the dispatcher.
6. Deleted the fresh disposable thread `T-01a1a31a-ae65-7291-9d64-0eb79871bf86`.
   Its Sprite `mcp-amp-test-1e80511a6f0eaa2ce7e920751c615950` was confirmed absent.
   The retained original smoke-test Sprite is warm and its thread is archived.
7. The installed runtime credential successfully managed its prefix and was
   verified unable to list/manage token metadata (HTTP 403 before installation).
   A request from the deployed Machine to the unrelated preflight Sprite also
   returned HTTP 403, confirming the prefix boundary in the live runtime.

## Contract differences found and addressed

- `fly apps create --org alex-ezell` rejected the personal organization's real
  slug. Direct Apps API creation accepted it and returned the expected org. The
  operation uses the API for app ownership checks and creation.
- Token issuance depends on the parent credential format, even on Sprites 2.
  This account's saved CLI login selected the policy-based issuance path. The
  live response omitted policy metadata, while the token-list endpoint exposed
  it. The provisioner now supplies restrictions for both contracts, verifies
  stored prefix/expiry when needed, and verifies administration is denied.
- Unused credentials from failed contract probes were revoked. None was installed
  in the dispatcher. Resource retries reused the previously created app/volume.

## Scope and release gates

45 local tests pass, along with Node/Bash syntax checks and ShellCheck. Tests
cover resumability, collision refusal, identity checks, failed secret upload,
credential restriction verification, and cleanup in addition to Orb lifecycle.

This completes the reusable provisioning operation and hosted deployment test.
The subsequent [clone-and-run setup](setup-live-test.md) adds guided login and
remote builds/upgrades. Browser onboarding is intentionally deferred. Automatic
credential rotation, uninstall, and clean-account live acceptance remain open. Repository checkout/project hooks and cold Orb resume were not tested.
There is no GitHub remote, PR, comment, or commit from this work.
