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
30 seconds, releases it when Amp exits on its own, and allows it to expire after
two minutes otherwise. It does not release on SIGTERM: while Sprites stops the
service, `sprite-env` does not answer, so the stop would wait about 10 seconds
for SIGKILL. Pause explicitly releases the lease after stopping the service. The hold prevents a quiet
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

## Sprites connectors

Orbs can call third-party APIs through the
[Sprites connector gateway](https://docs.fly.io/sprites/concepts/connectors)
without holding a token. Connectors and their access policies are set per
sprite in the Sprites organization, so an Orb must discover what its sprite may
use instead of assuming any connector exists. From inside the Orb:

```sh
curl -sS http://sprite.internal/v1/gateway/list
curl -sS http://sprite.internal/v1/gateway/<provider>/<connection-id>/<path>
```

Use plain HTTP and the `/v1` prefix; HTTPS to `sprite.internal` fails, and
`api.sprites.dev` rejects these calls. The list returns each usable
connection's `gateway_base_url` and the providers that are not yet connected.
The gateway forwards API calls only; Git clone and push through the GitHub
connector return 404.

Amp in the Orb does not read the base image's `/.fly/AGENTS.md`, so preparation
installs [the `sprite-connectors` skill](../bootstrap/sprite-connectors-skill.md)
in `/home/user/.config/amp/skills/`. It tells the agent to list connectors when
a task needs an external API, and to send the user to the Sprites dashboard
when one is missing. When Amp's own `git push` is denied, for example because
Amp's GitHub App is not installed on the repository's owner, the skill has the
agent push a branch and open the pull request through the GitHub connector's
REST API (blobs, a tree, a commit, a ref, then the pull request).

Those writes act as the GitHub account that authorized the connector, so its
access policy is the safety boundary. A connector with `allow_all` gives every
Sprite in the organization that account, including Orbs started by other
workspace members. Restrict it to this provider's Sprites with a name-prefix
policy set to the provider prefix (`SPRITES_PROVIDER_ID`) followed by `-`,
because Orb Sprites are named `<prefix>-<hash>`. Limit paths with endpoint
lists, for example:

```json
{
  "access_policy": {
    "name_prefix": "YOUR_PROVIDER_PREFIX-",
    "allowed_endpoints": ["/user", "/graphql", "/repos/OWNER/REPO/*"],
    "blocked_endpoints": ["/repos/OWNER/REPO/hooks*", "/repos/OWNER/REPO/collaborators*", "/repos/OWNER/REPO/keys*"]
  }
}
```

## Configuration

The start command reads `.env.local` and the process environment:

| Variable | Purpose |
| --- | --- |
| `AMP_ORB_PROVIDER_TOKEN` | Required Amp provider credential. |
| `SPRITES_PROVIDER_ID` | Stable Sprite prefix; defaults to `mcp-amp`. Use a distinct value for each provider in an org. |
| `SPRITES_STATE_DIR` | Persistent controller state; defaults to this repository's `.state/`. |
| `SPRITE_BIN` | Sprite executable path; defaults to `sprite` on PATH. |
| `SPRITE_TOKEN` | Optional for unattended hosts; otherwise use the saved Sprite login. |
| `SPRITES_AMP_VERSION` | Optional exact Amp release for the controller and new Sprites. Otherwise the controller installs latest once and reuses the verified cache (the hosted image ships a fixed controller release), and each spawn gives the Sprite the latest Linux release, looked up at most hourly. If the lookup fails, the spawn uses the last release found, or the controller's release if none was, and the lookup is not retried for five minutes. |

Hosted setup generates a provider prefix unless you supply one. Do not change a
provider's prefix or lose its state directory while it owns Orbs. Records bind
Orb IDs to Sprite IDs and organizations; mismatches
fail closed. One local controller runs per prefix. Do not run independent hosts
for the same provider token; distributed coordination is not implemented.

For direct dispatch/service-manager integration, set `SPRITE_ORG`,
`SPRITES_PROVIDER_ID`, `SPRITES_STATE_DIR`, `SPRITES_NATIVE_BASE=1`,
`SPRITES_AMP_BINARY_URL`, and `SPRITES_AMP_BINARY_SHA256`. Sprites receive exactly
that binary. The start command also sets `SPRITES_AMP_FOLLOW_LATEST=1` when no
`SPRITES_AMP_VERSION` is given, which lets each spawn replace the binary with the
latest official release; leave it unset to keep the one you configured. Amp supplies its job
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
- The agent runs as `user` with passwordless `sudo` on its dedicated Sprite. It can
  read its own Orb token from the service configuration and modify anything on
  that Sprite; the pinned Amp binary is re-verified on every spawn, but the
  service runs the copy Amp updates itself into once one exists.
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
