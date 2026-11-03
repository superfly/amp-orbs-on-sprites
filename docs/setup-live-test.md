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
  its cache/resources are retained for later builds.
- A real private Amp Orb returned:

  ```text
  x86_64
  user
  setup-remote-builder-ok
  ```

  The shell command exited 0. The disposable thread
  `T-01a1a32d-db24-709e-9fcc-68ff1e7e85c3` was then deleted for cleanup.

The dispatcher remains hosted at
[amp-orbs-alex-ezell](https://fly.io/apps/amp-orbs-alex-ezell). Its Sprite credential
still expires February 1, 2027; this rebuild did not rotate credentials.

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
