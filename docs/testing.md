# Verification and test strategy

## Local checks

```sh
npm test
npm run check
shellcheck setup bootstrap/*.sh
```

The tests use mock Sprites responses and a local fake `sprite` executable. They
need no credentials, network access, cloud resources, or third-party packages.
They cover:

- Create/reuse, token refresh, pause/resume, repeated deletion, and missing Sprites.
- Untracked-name collisions, changed Sprite IDs, wrong organizations, and locks.
- Interrupted creation and retry after failed preparation without disk deletion.
- Private URL settings, unsupported snapshots, rejected types and bad configuration.
- Header authentication, redirect refusal, 404 versus authentication errors,
  response limits, truncated/error streams, and split UTF-8 stream chunks.
- Preparation argv/stdin, remote timeout, and exclusion of Amp credentials.
- Verified Amp installation, cache integrity, activity-hold renewal and cleanup.
- Sprites 2 service schema and refusal to bootstrap the legacy/default runtime.
- Automatic personal/workspace provider creation, login, cached CLI upgrade,
  secret-store parsing, and credential-free completed-installation retries.
- Failed or ambiguous creation, replaced default tokens, concurrent setup locks,
  and resuming after build failure without duplicating providers.

## Continuous integration

[CI](../.github/workflows/ci.yml) runs on pull requests to `main`, pushes to
`main`, and manual dispatch. Both Node.js 22 and 24 run the full test suite,
syntax checks, ShellCheck, and `./setup --help` on Ubuntu. There are no npm
dependencies to install or cloud credentials to configure. These are offline
checks; CI does not deploy a dispatcher or create live Orbs.

The `main` branch requires both `Checks (Node 22)` and `Checks (Node 24)`, an
up-to-date branch, one approving review, and resolved review conversations.
New commits dismiss stale approvals. Protection applies to administrators, and
force pushes and branch deletion are disabled.

These tests establish adapter behavior against fixtures. See [live-test.md](live-test.md)
for the real Sprites 2 results; unlisted scenarios remain release gates.
The downloaded public OpenAPI specification was also inspected for the create,
service get/put/stop, and delete interfaces. The published service schema differs from the deployed Sprites 2 runtime.
The adapter uses its `process`, `desired_state`, and `restart` fields and accepts
JSON or final NDJSON service/Sprite confirmations before checking runtime state.

## Live acceptance sequence

Use a dedicated provider, organization prefix, and disposable repository. Record
Amp CLI version, Sprite CLI version/build, Sprite environment version, binary
digest, and the returned Sprite ID without recording tokens.

1. **Provision:** Start a real Amp thread through the provider. Confirm one Sprite
   is created, bootstrap runs as `user`, the thread connects, setup completes,
   and a command can create a marker file in the repository.
2. **Retry:** Trigger another spawn for the same Orb with valid current credentials.
   Verify the Sprite ID is unchanged and there is one bootstrap service/process.
3. **Pause:** Let Amp issue pause. Confirm bootstrap stops. Leave the Sprite alone;
   observe the control-plane state separately without exec, URL probes, or service
   polling that would wake it. Record warm/cold status. Billing was not independently
   measured by the smoke test.
4. **Warm resume:** Send another thread message. Verify the same ID and marker
   file, a renewed connection, and no duplicate bootstrap process.
5. **Cold resume:** Repeat after the platform has naturally reached cold sleep.
   Confirm files survive and Amp reconnects. Do not assume warm/cold timing.
6. **Background work:** Repeat with a quiet service, a service with an open
   connection, and the Sprites 2 keep-awake lease. Determine what blocks sleep and whether stopping
   bootstrap leaves Amp subprocesses or tunnels alive. Document the result before
   promising idle behavior to users.
7. **Failures:** Try an incorrect digest and an expired Orb token. The first should
   retain a retryable Sprite; the second must be visible as an Amp connection
   failure even if the service momentarily reports running. Test cold wake with
   an expired stored token followed by a fresh spawn.
8. **Deletion:** Delete the disposable thread/Orb and confirm the mapped Sprite
   is gone. Repeat the adapter delete job to check idempotency.

Exercise project snapshots only to verify the stated fallback, not to claim
snapshot support. Test Terminal, portals, external agents, and Desktop separately
if the intended workflow depends on them.

## Remaining release gates

- Check that sticky service stop survives cold wake and disables reconnection.
- Verify credential redaction in upstream Amp/Sprites logs as well as adapter logs.
- Repeat timing on an entirely fresh Sprite; the observed first smoke spawn was
  about ten seconds, comfortably below Amp's five-minute job limit.
- Add recorded, sanitized live contract fixtures after the first smoke test.

Do not start a second provider with the same token for tests. Offline tests do
not justify deploying this as an unattended production provider.
