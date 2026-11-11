# Operations

## State and recovery

Each record under `SPRITES_STATE_DIR/<provider>/` contains only the Orb ID,
organization, Sprite ID, and paused flag. Directory permissions are private on
creation; keep the parent secure too. Do not edit these files while the controller
is running. A local directory lock protects each record during a job.

If a job crashes hard, a `.lock` directory may remain. Stop the controller, verify
that its old dispatch and remote preparation are finished, inspect the named
Sprite, then remove only that Orb's stale lock. Resume the controller afterward.
Never remove locks purely because they are old.

If creation reached Sprites but its response or state write was lost, the next
job refuses ownership. An operator must verify the Orb/name/organization/Sprite-ID
mapping and recover the matching record while the controller is stopped. Do not
delete an unrecognized Sprite to clear the error. There is intentionally no
automatic adoption command in this provider.

The controller aborts at 270 seconds and exits by 280 seconds. Remote preparation
has its own 220-second timeout plus a five-second kill grace. Requests have a
45-second cap. Mutations are not blindly retried after ambiguous failures.
Bootstrap failure keeps the disk; deletion removes it. Back up state separately
from secret-bearing Sprite files.

The API is addressed by name, so the ID ownership check and subsequent mutation
are not one atomic operation. Reserve the prefix to this controller and prohibit
out-of-band deletion/recreation during dispatch. This is not a distributed lease.

## Controller and bootstrap separation

The controller needs outbound access to Amp, the Sprites API, and normal Amp
update services. Sprites need outbound Amp connections and access to the binary
URL, Git host, and project package registries. No inbound controller endpoint or
public Sprite URL is configured by the adapter.

`prepare.sh` runs with sudo in the dedicated Sprite, checks prerequisites, creates
the `user` account if absent, verifies the downloaded executable's digest, and
checks bootstrap command availability. Project-specific installs belong in the
repository's setup/resume hooks. The script does not install desktop packages.
The executable is rechecked on each spawn; automatic updates performed by Amp
itself are outside this adapter's pinning guarantee. Amp updates itself into
`/home/user/.amp/bin/amp` and restarts into an update by re-executing the path
it was started from. Started from the pinned `/usr/local/bin/amp`, that restart
runs the old binary again and loops without connecting, so the Orb fails to
resume. The service therefore runs the self-updated copy once a working one
exists and uses the pinned binary only until then.

The service is named `amp-orb-bootstrap`. It launches Amp as `user` with sudo's
home-directory handling. Stop uses the supervised service API rather than a PID
signal, because the supervisor may restart a process killed as a crash. The
service has no HTTP port. Creation output is consumed privately, then state is
checked. The repository does not expose a debug HTTP endpoint.

## Sources checked on November 3, 2026

| Source | What it establishes |
| --- | --- |
| [Amp self-hosted Orbs](https://ampcode.com/docs/orbs/self-hosted) | Dispatch variables, bootstrap, repeatability, deadline, native-provider examples, image expectations, setup, and snapshot fallback. |
| [Amp Runners](https://ampcode.com/docs/cli/runners) | Runner command and existing-directory execution model. |
| [Sprites OpenAPI](https://docs.fly.io/sprites/api/openapi.json) | Published REST schemas and API base URL. |
| [Create Sprite](https://docs.fly.io/sprites/api/sprites/create-a-sprite) | Native create request and returned identity. |
| [Create service](https://docs.fly.io/sprites/api/services/create-service) | Command, argument, environment, and service-state fields. |
| [Stop service](https://docs.fly.io/sprites/api/services/stop-service) | Stop request and streamed completion/error events. |
| [Services guide](https://docs.fly.io/sprites/concepts/services) | Supervision, sticky stop, warm/cold behavior, and streamed creation. |
| [Lifecycle guide](https://docs.fly.io/sprites/concepts/lifecycle) | Warm memory preservation, cold memory loss, disk persistence, and natural idle sleep. |

## Sprites 2 contract

This adapter targets the live `flyfs` runtime, not the published legacy service
schema. Create uses the organization's existing runtime routing; an unexpected
runtime is retained with its ownership record for safe cleanup and rejected
before bootstrap. Confirm that the organization routes creation to Sprites 2
before installing this provider.

The live guest exposes `sprite-env keep-awake --for`, `--release`, and `status`.
The published `/v1/tasks` endpoint returns 404 here. Service creation uses
`process.argv/cwd/env`, `restart=always`, and `desired_state=running`.
Service GET wraps configuration and runtime in `data`; PUT streams a final
`type=sprite` confirmation. DELETE may acknowledge before the Sprite disappears;
the adapter retains ownership until absence is verified.
