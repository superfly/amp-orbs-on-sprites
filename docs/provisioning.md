# Hosted setup and recovery

`./setup` is the supported guided entry point for this self-deployable repository.
It uses `setupFlow()` to collect choices, `runInstallation()` for exclusive local
state, and the reusable `provision()` operation for infrastructure changes.

## Run from a checkout

Requires macOS/Linux (or WSL), Node.js 22+, and Sprites 2 access. Run `./setup`.
Missing Fly and Sprite CLIs can be installed into `.tools/` using their official
installers, without editing shell profiles. The user signs in or signs up with
Fly, selects an organization using its real slug, authorizes Sprites if needed,
and chooses an Amp provider name and personal/workspace scope. After the review,
setup installs a checksum-verified Amp CLI into `.tools/setup-amp/`, guides normal
Amp login if needed, and runs `amp orb provider create NAME` (with
`--workspace NAMESPACE` for workspace providers). No local Docker or preinstalled
Amp CLI is required. A cached CLI without provider creation is refreshed.

Setup reads `orb-provider-token@https://ampcode.com/` from Amp's secret store
immediately after creation and imports it as the dispatcher's
`AMP_ORB_PROVIDER_TOKEN` app secret through stdin. It does not print creation
output, tokens, or raw CLI errors, and does not transfer account login credentials.
The secret store lives at `~/.local/share/amp/secrets.json` on macOS, or
`${XDG_DATA_HOME:-$HOME/.local/share}/amp/secrets.json` on Linux. This reader is
coupled to Amp's observed CLI storage contract; unexpected formats fail closed.
Automatic creation currently targets `https://ampcode.com` only.

For existing providers, the token may still come from `AMP_ORB_PROVIDER_TOKEN`
or a private ignored `.env.local`, which skips automatic creation. No token is
passed through command arguments or written to the
installation journal. On rerun, a completed installation reuses its staged
credentials without needing the original Amp token locally.

`--org`, `--app`, `--provider`, and `--region` preselect choices. Region defaults
to `ord`; a new installation gets a unique suggested app name and Sprite prefix.
`--yes` accepts installation/deployment prompts but does not bypass authentication
or ambiguous organization/installation choices. For unattended runs, supply
`--org` and `--app` and authenticate beforehand. `--amp-provider` sets the Amp
provider name (default: app name); `--amp-workspace` selects an Amp workspace.
`--provider` remains the separate Sprite prefix. Under `--yes`, automatic creation
defaults to a personal provider. Automatic creation flags cannot be combined with
an explicit token. Existing installations retain their recorded provider identity.

`./setup --rebuild` builds the current checkout on Fly and replaces the existing
dispatcher. Plain reruns verify/resume; they do not automatically rebuild. Use
`--handoff-local` only when moving an existing local provider as described below.

## Remote builds

The build command uses `fly deploy --remote-only --depot=false --build-only --push`
with a unique image label and no image override in its temporary build config.
This uses Fly's remote builder for the selected app's organization. It can
create a Fly-managed builder app/Machine there; its lifecycle is managed by Fly.
The installer reports progress while the build runs. It resolves the published
image digest through the authenticated registry API, so Docker isn't needed
for building, pushing, or digest inspection.

The existing dispatcher is not stopped during a rebuild. A successful build
updates the journal with the new immutable image and marks activation pending;
a failed build preserves the previous active image. Repeating `--rebuild`
explicitly requests another build; rerun without it to resume a pending deploy.

## Resources and credentials

- One Fly App, one continuously running shared-CPU 512 MB Machine, and one 1 GB
  encrypted Fly Volume with scheduled snapshots. These incur ongoing charges.
- No public service, public IP, database, or HTTP credential-collection endpoint.
  App management remains in Fly's authenticated dashboard.
- One Sprite runtime credential restricted to this prefix. The token API contract
  follows the installer's authentication format, independently of the guest
  runtime. Newer parent credentials support explicit action restrictions; the
  current saved login uses prefix/expiry policy restrictions. The installer
  reads stored metadata when issuance omits it and verifies token administration
  is denied before storing the credential.
  Its requested lifetime is 90 days and may be limited by its parent. Expiry
  is recorded in the journal and printed at completion. Automatic credential
  rotation is not implemented yet; reauthorization/rotation is a release gate.
- Only the Amp provider token and child Sprite credential are installed as runtime
  secrets. The general Fly provisioning credential stays with the installer.
- The image is built once, pushed, and deployed by immutable digest. The build
  context is an allowlist; local account files, `.env.local`, state, and tests
  are excluded. The initial image uses a Node 24 Debian base and pins/checksums
  the Amp and Sprite binaries.

The private status file confirms the upstream Amp provider startup handshake.
It is not a continuous network-health guarantee or proof an Orb executed a tool;
a real remote thread is the acceptance test. The installer checks for exactly
one started Machine and that status before reporting ready.

## Retry and recovery

The caller holds an exclusive operation lock. The local client uses
`.state/installations/APP/operation.lock` and atomically saves `installation.json`.
The journal contains installation identity, a provider-token fingerprint, resource
IDs, image digest, credential expiry, and completed steps, never secret values.

Automatic creation adds the Amp provider's name, workspace, and creation phase.
It journals intent before calling Amp, then the token fingerprint after confirmed
creation. A deployment failure can reuse the matching token from Amp's store;
after Fly secrets are staged, neither the local token nor an Amp login is needed
to resume. Creating another provider replaces Amp's one default saved token. If
that happens before staging, setup refuses the mismatch: restore the original
provider token through `AMP_ORB_PROVIDER_TOKEN` to resume, or inspect and clean up
the incomplete installation before starting over. Setup does not rotate tokens
or change the selected provider automatically.

A failed/timed-out create or a crash before fingerprint capture leaves phase
`creating`; reruns stop rather than risk creating a duplicate or using a stale
token. Inspect Amp Settings → Orbs and the installation journal to establish
whether creation succeeded before manual recovery. Do not simply delete the
journal and retry. Setup also holds an exclusive
`amp-orbs-on-sprites-provider.lock` directory beside the secret store while
creating/reading. Only this installer honors that lock; avoid concurrent provider
creation through Amp's CLI or agent. After a hard crash, verify no installer is
running before removing this lock.

Rerun the same command after an ordinary failure. Completed resources and staged
credentials are reused; a verification retry does not redeploy. Deployment uses
an immediate replacement and explicitly disables spare Machines. The runtime
holds an OS lock on the persistent volume, preventing two processes from using
that state simultaneously.

A hard crash can leave an operation lock. Verify no installer process remains
before removing that exact lock directory. If app or volume creation succeeded
but its ownership record was lost, the operation refuses adoption. Inspect the
named resource and repair the journal only after establishing its ownership.
It does not delete unknown resources or silently allocate replacements.

A failure staging credentials attempts to revoke the new child token. If that
cleanup cannot reach Sprites, treat the child as potentially live until revoked
or expired. Do not log it to diagnose the failure. Provisioning retains resources
on failure so the user can retry without losing Orb files.

## Local-to-hosted handoff

Archive all threads using the local provider and wait for their ownership records
to show `paused: true`. Then use the same provider prefix with `--handoff-local`.
The operation copies only matching paused ownership records, prepares the cloud
resources, verifies the local controller PID, stops it, and activates the hosted
controller. Import is idempotent and marked complete on the volume so later
restarts do not resurrect deleted records. If activation fails after handoff,
the local controller stays stopped; inspect the hosted app before restarting it.

Only one provider process may use the Amp token. The installer cannot discover
arbitrary controllers on other computers. Amp's own duplicate-provider handling
also remains active; the installer never passes `--allow-multiple`.

## Deferred work

Runtime credential rotation and uninstall are not automated yet. Sprites 2 activation
and account billing requirements still belong to Fly's normal account setup.
