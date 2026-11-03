# Clone-and-run setup acceptance — November 3, 2026

The supported entry point is now `./setup`. It guides account login, organization
selection, Sprite authorization, hidden Amp token entry, and deployment. ui-ex
and a separate browser wizard are intentionally out of scope.

## Real deployment

Ran `./setup --rebuild` interactively with
`DOCKER_HOST=unix:///tmp/fly-amp-no-docker.sock`. Selected **Alex Ezell
(alex-ezell)** from the account's organization list, resumed
`amp-orbs-alex-ezell`, and accepted the rebuild review.

- Fly remote build completed using `--remote-only --depot=false --build-only`.
  No local Docker command or daemon was used for build, push, or digest lookup.
- New image: `registry.fly.io/amp-orbs-alex-ezell@sha256:91d7572d5ddfb2999843c9a9f401185177b70858df998d68993127a57350c5d8`.
- Existing Machine `48e074ea939198` and volume `vol_42kx7ln6yq2w1k34` were reused.
- Hosted status confirmed the Amp provider connection after deployment.
- Fly created remote builder app `fly-builder-humming-meadowstone-368` in
  `alex-ezell`, with Machine `d893239a01edd8`. It was stopped after the test;
  its cache/resources were initially retained for later builds (subsequently
  removed in the clean-start reset below).
- A real private Amp Orb returned:

  ```text
  x86_64
  user
  setup-remote-builder-ok
  ```

  The shell command exited 0. The disposable thread
  `T-01a1a32d-db24-709e-9fcc-68ff1e7e85c3` was then deleted for cleanup.

At acceptance, the dispatcher was hosted as `amp-orbs-alex-ezell`. Its Sprite
credential expired February 1, 2027; this rebuild did not rotate credentials.
The installation and credential were subsequently removed as described below.

## Setup behavior

The actual account's existing Fly/Sprite logins were reused. New-user sign-in,
signup selection, Sprite authorization, unknown-organization refusal, duplicate
provider detection, and cancellation before provisioning are covered by isolated
workflow tests, not by creating another real account.

The hidden token prompt was exercised in a real terminal with a synthetic token.
Input was not echoed, the value was received correctly, and terminal echo was
restored afterward. Real credentials were not printed or embedded in tests.

Node.js 22+ remains a local prerequisite. Missing Fly and Sprite CLIs can be
installed into `.tools/` through their official installers. Docker and Amp CLI
installation are not required for setup. A separate Amp CLI login was used only
by the developer to submit the remote acceptance thread.

A plain rerun with `AMP_ORB_PROVIDER_TOKEN=` and the same unavailable Docker
socket completed successfully against `alex-ezell`. It reused the installed
credentials and did not rebuild or redeploy.

Plain reruns resume/check; `--rebuild` explicitly builds and replaces the image.
Local tests verify that a failed rebuild preserves the previous active image,
and that storage and runtime credentials are reused on successful rebuilds.

## Clean clone verification

Created a local Git commit and cloned it into a new temporary directory. The
clone contained no `.env.local`, `.state`, `.tools`, or scratch work. `setup`
retained its executable bit; `./setup --help` ran without npm installation.
All 54 tests, syntax checks, and ShellCheck passed from that clone. No repository
was published and no ui-ex files were changed.

Final inspection confirmed the disposable smoke Sprite was absent, the dispatcher
Machine was started, and the remote builder Machine was stopped.

## Clean-start reset — November 3, 2026

At the user's request, removed the test installation from `alex-ezell`:

- Deleted the remaining disposable Amp smoke-test thread; the dispatcher deleted
  its Sprite `mcp-amp-test-11ef38c52ffe4ca33d790e6317048cc3`.
- Deleted the task's `mcp-amp-preflight` Sprite and revoked the dispatcher's
  restricted Sprite credential. Verified both Sprites and the credential absent.
- Destroyed `amp-orbs-alex-ezell` and the task-created remote builder
  `fly-builder-humming-meadowstone-368`, including their Machines and volumes.
  Verified both apps and volume endpoints returned not found.
- Removed the local installation journal, generated configuration, and obsolete
  smoke Orb ownership record. No saved installations remain in this checkout.

Fly/Sprite logins and the existing Amp provider/token were preserved. The next
`./setup --org alex-ezell` starts a new installation and creates its app, remote
build, persistent volume, restricted credential, and dispatcher. Sprites are
created when Amp requests Orbs. Setup does not create the Amp provider itself.
No replacement infrastructure was deployed during this reset.

## Fresh installation acceptance — November 3, 2026

After the reset above, ran the actual interactive entry point:

```sh
DOCKER_HOST=unix:///tmp/fly-amp-no-docker.sock ./setup --org alex-ezell
```

There were no saved installation journals or existing project infrastructure.
Accepted the generated app name and deployment review. Existing Fly/Sprite
logins and the Amp provider token in `.env.local` were reused; this run therefore
tests fresh infrastructure provisioning, not new-account signup or manual token
entry. It required no manual cloud provisioning or local Docker daemon.

- App: [amp-orbs-alex-ezell-2a6a6d90](https://fly.io/apps/amp-orbs-alex-ezell-2a6a6d90).
- Organization: `alex-ezell`, confirmed through the Apps API for both the
  dispatcher and its new remote builder `fly-builder-broken-skylark-759`.
- Dispatcher Machine: `e820d1df645678`, started in `ord`, with no public services
  or allocated public IPs.
- New volume: `vol_re1lzndn17j0w634`, mounted by that Machine.
- Image digest: `sha256:a63b7035da4275342f1c237058b79045d579bcf13ea2e7030ceee72a6d0f90f7`.
- A newly issued restricted Sprite credential expires February 1, 2027.
  Setup verified the connection to Amp before reporting success.
- Builder Machine `811124b90e05e8` was stopped after the build; its cache remains
  available. The dispatcher is left running and incurs hosting charges.

Created a private Orb using Amp's `-ox --orb-provider fly-sprites-test` interface:
[acceptance thread](https://ampcode.com/threads/T-01a1a348-14d4-7788-af68-6d5c9a99812e).
Its actual remote `shell_command` result was:

```text
x86_64
user
fresh-setup-2a6a6d90
```

Exit status was 0. The dispatcher ownership record linked it to Sprite
`mcp-amp-test-ded90f94694819d223a6fe341be11b44`, ID
`6de1e825-dd90-4513-9360-d4f57093a6e0`, in `alex-ezell`.

Archiving the thread completed pause and the Sprite subsequently reached `warm`
through automatic idle sleep. Unarchiving and continuing resumed the same Sprite
ID; reading the original marker returned `fresh-setup-2a6a6d90` as `user`, exit 0,
without rewriting the file. The thread was archived again for inspection.
This verifies warm resume, not cold resume. No explicit suspend API was used.

Reran `./setup --org alex-ezell --app amp-orbs-alex-ezell-2a6a6d90 --yes` with the
same unavailable Docker socket. It reused the installation, confirmed the Amp
connection, and did not rebuild or redeploy. No source-code changes were needed
for this acceptance run. Repository/project hooks were not exercised: these
Orbs deliberately had no repository. This remains a custom Orb provider, not an
Amp Runner.

Created a separate disposable Orb, thread
`T-01a1a34a-cd6c-7218-9525-78fd8f8aedef`, which printed
`delete-test-2a6a6d90` with exit status 0. Deleting that thread triggered provider
cleanup. Confirmed its Sprite `mcp-amp-test-4a7a3c6fa8e6e1c1ed722736a8043ad0`
(ID `034de830-8ea1-4d37-9cda-10f7604b2c3a`) was absent and its dispatcher
ownership record was removed.

Final inspection confirmed the retained acceptance Sprite was `warm` with
`paused: true`, the dispatcher Machine was `started` with connected status, and
the builder Machine was `stopped`.
