# Provider internals and local development

For the hosted setup, start with the [README](../README.md). This guide covers
running a controller locally, its configuration, and the adapter implementation.
Run the commands below from the repository root.

## Start a local development provider

Prerequisites: an organization with Sprites 2 enabled, Node.js 22+, and the [Sprite CLI](https://docs.fly.io/sprites/cli/installation).
There are no npm dependencies to install.

1. Sign into the target Sprites organization if you have not already:

   ```sh
   sprite login -o YOUR_ORG
   ```

2. In [Amp Settings → Orbs](https://ampcode.com/settings/orbs), create a provider.
   Save its token in a private `.env.local` file in this repository:

   ```dotenv
   AMP_ORB_PROVIDER_TOKEN=your-provider-token
   ```

   Keep the token out of shell history and Git. `.env.local` is ignored by Git;
   restrict its permissions with `chmod 600 .env.local`.

3. Start the controller:

   ```sh
   npm start -- --org YOUR_ORG
   ```

The launcher verifies Sprites access, downloads and checksum-verifies Amp from
its official release source, caches it in `.tools/`, selects the matching Linux
binary, and starts the provider. It reuses the Sprite CLI's saved login; you do
not need to extract or copy a Sprites token. The organization is always explicit.

Keep the controller running. Select your provider in Amp's new-thread composer.
The controller's provider token is sufficient; a separate Amp account login is
needed only if you want to create/control threads through the Amp CLI here.

For CLI testing:

```sh
.tools/amp login
.tools/amp -ox 'Run uname -m and id -un' --orb-provider YOUR_PROVIDER_NAME
```

To continue an Orb remotely, keep `-ox`:

```sh
.tools/amp threads continue THREAD_ID -ox 'Read the file we created earlier'
```

Using plain `-x` to continue selects local execution. Do not use it to validate
this provider. A returned thread URL means the job was submitted; inspect the
thread's tool results to establish success.

## Lifecycle

| Job | Behavior |
| --- | --- |
| `spawn` | Create/reuse the owned Sprite, prepare Amp, and start supervised bootstrap with fresh credentials. |
| `pause` | Persistently stop bootstrap, release its activity hold, and leave the disk for natural idle sleep. |
| `delete` | Delete the owned Sprite, wait for disappearance, and remove its ownership record. |

Quiet outbound connections do not reliably keep a Sprite awake. Bootstrap holds
an expiring Sprites 2 `keep-awake` lease while Amp considers the Orb active. The wrapper renews it every
30 seconds, attempts release on exit, and allows it to expire after two minutes
if killed abruptly. Pause explicitly releases the lease after stopping the service,
because group termination can interrupt shell cleanup. The hold prevents a quiet
connection from sleeping and causing repeated spawn requests while the Orb is active.
The guest command is `/.sprite/bin/sprite-env keep-awake`; the published
[Tasks API guide](https://docs.fly.io/sprites/keeping-sprites-running) describes
the motivation, but its endpoints are absent on this target runtime.

Pause does not call a VM suspend API. Other workload activity can still delay
sleep. Warm sleep preserves process memory; cold sleep does not. Disk persists
in both cases. [Lifecycle](https://docs.fly.io/sprites/concepts/lifecycle).

To pause a test Orb, archive its thread in Amp (or use
`.tools/amp threads archive THREAD_ID`). Pause active Orbs before stopping the
controller with Ctrl-C; stopping the controller alone does not stop their Sprites.

## Configuration

The start command reads `.env.local` and the process environment:

| Variable | Purpose |
| --- | --- |
| `AMP_ORB_PROVIDER_TOKEN` | Required Amp provider credential. |
| `SPRITES_PROVIDER_ID` | Stable Sprite prefix; defaults to `mcp-amp`. Use a distinct value for each provider in an org. |
| `SPRITES_STATE_DIR` | Persistent controller state; defaults to this repository's `.state/`. |
| `SPRITE_BIN` | Sprite executable path; defaults to `sprite` on PATH. |
| `SPRITE_TOKEN` | Optional for unattended hosts; otherwise use the saved Sprite login. |
| `SPRITES_AMP_VERSION` | Optional exact Amp release. Otherwise install latest once and reuse the verified cache. |

Hosted setup generates a provider prefix unless you supply one. Do not change a
provider's prefix or lose its state directory while it owns Orbs. Records bind
Orb IDs to Sprite IDs and organizations; mismatches
fail closed. One local controller runs per prefix. Do not run independent hosts
for the same provider token; distributed coordination is not implemented.

For direct dispatch/service-manager integration, set `SPRITE_ORG`,
`SPRITES_PROVIDER_ID`, `SPRITES_STATE_DIR`, `SPRITES_NATIVE_BASE=1`,
`SPRITES_AMP_BINARY_URL`, and `SPRITES_AMP_BINARY_SHA256`. Amp supplies its job
variables. Custom adapter settings use `SPRITES_*`; use those names rather than
`AMP_BINARY_*` so Amp forwards the configuration to the adapter.

## Limits and security

- Sprites 2 (`runtime_kind=flyfs`) only; the existing default runtime is rejected.
  The organization must already route creation to Sprites 2. Native Sprite base only. `ORB_IMAGE` is acknowledged but not applied. Project
  snapshots (`ORB_SNAPSHOT_ID`) are unsupported; new Orbs run ordinary setup.
- The launcher currently selects Linux x64 for Sprites. Desktop, portals,
  repository checkout, and cold-wake behavior still need dedicated acceptance tests.
- This dedicated Sprite's global keep-awake lease is owned by bootstrap; other
  applications must not independently renew/release that same lease.
- An active activity hold keeps compute running until Amp issues pause. A missing
  pause or stuck provider job must be investigated; the wrapper is not a separate
  idle-timeout policy.
- `npm start` runs a local development controller. `npm run provision` deploys
  the hosted controller; do not run both with the same provider token.
- Org/provider credentials stay on the controller. Only the short-lived Orb token
  and Amp URL enter the Sprite service. Its environment is persisted sensitive
  configuration and may appear in snapshots/backups; restrict access.
- API bodies and CLI stderr are not printed by the adapter. Requests containing
  credentials use stdin, not process arguments. Bootstrap logs remain sensitive.
- Failed preparation retains the Sprite for retry. Ambiguous creation requires
  inspection rather than automatic adoption; deletion never targets an unowned ID.

Amp's agent loop and inference stay on Amp; the Sprite hosts its tools and
working files. A [Runner](https://ampcode.com/docs/cli/runners) serves threads in
an existing environment and does not use this provisioning lifecycle.

Run `npm test`, `npm run check`, and `shellcheck setup bootstrap/*.sh` for local checks.
See [testing](testing.md) and [operations](operations.md) for the full
verification and recovery guidance.
