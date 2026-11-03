# Hosted provisioning v1

`./setup` is the supported guided entry point for this self-deployable repository.
It uses `setupFlow()` to collect choices, `runInstallation()` for exclusive local
state, and the reusable `provision()` operation for infrastructure changes.
No changes to ui-ex or a separate web setup service are required.

## Run from a checkout

Requires macOS/Linux (or WSL), Node.js 22+, and Sprites 2 access. Run `./setup`.
Missing Fly and Sprite CLIs can be installed into `.tools/` using their official
installers, without editing shell profiles. The user signs in or signs up with
Fly, selects an organization using its real slug, authorizes Sprites if needed,
and pastes an Amp provider token. No local Docker or Amp CLI is required.

The hidden token prompt restores terminal echo on completion or interruption.
The token may also come from `AMP_ORB_PROVIDER_TOKEN` or a private ignored
`.env.local`. No token is passed through command arguments or written to the
installation journal. On rerun, a completed installation reuses its staged
credentials without needing the original Amp token locally.

`--org`, `--app`, `--provider`, and `--region` preselect choices. Region defaults
to `ord`; a new installation gets a unique suggested app name and Sprite prefix.
`--yes` accepts installation/deployment prompts but does not bypass authentication
or ambiguous organization/installation choices. For unattended runs, supply
`--org` and `--app`, authenticate beforehand, and supply the Amp token in the
environment for a new installation.

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

Browser onboarding and ui-ex integration are intentionally out of scope. Runtime
credential rotation and uninstall are not automated yet. Sprites 2 activation
and account billing requirements still belong to Fly's normal account setup.
