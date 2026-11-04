# Automatic Amp provider setup — November 4, 2026

Ran the new `./setup` from an isolated checkout with no `.env.local`, saved
installation, or downloaded Amp binary. Used the existing Fly/Sprite/Amp account
logins, organization **alex-ezell**, and the account's Sprites 2 runtime.

```sh
DOCKER_HOST=unix:///tmp/amp-orbs-no-docker.sock ./setup \
  --org alex-ezell --app amp-orbs-auto-20261104 \
  --amp-provider sprites-auto-20261104
```

Selected personal scope and accepted the deployment review. Setup downloaded
and checksum-verified Amp `0.0.1793829508-g91ac5b`, created the provider through
`amp orb provider create`, read its saved token, and staged it in Fly app
secrets. There was no token prompt, copy/paste, or manual cloud provisioning.
The remote build completed with an unavailable local Docker socket.

## Deployment and transfer

- App: [amp-orbs-auto-20261104](https://fly.io/apps/amp-orbs-auto-20261104), with
  organization `alex-ezell` verified through the Apps API.
- Machine: `82d16e5c207258`, region `ord`.
- Volume: `vol_40o7e0g2enjnl194`.
- Image digest: `sha256:3c584809ef5f12d1876d836062346adbeeeaddfa9cb1b4767e1a9a2159d26f8f`.
- Amp provider: `sprites-auto-20261104`, personal scope.
- Sprite prefix: `amp-fb0baae6`.
- Restricted Sprite credential expires February 2, 2027.

Setup reported ready only after the hosted dispatcher confirmed its Amp
connection. Compared the runtime provider-token fingerprint with the installation
journal: it matched the token created by setup. Neither `AMP_API_KEY` nor
`FLY_API_TOKEN` was present in the dispatcher environment. The comparison exposed
no credential values, and no account secret file was copied to the app.

A plain rerun with `--org alex-ezell --app amp-orbs-auto-20261104 --yes` reused
the provider and installation, confirmed the connection, and did not create,
rebuild, redeploy, or prompt for a token.

## Real Orb execution

Created private thread `T-01a1a8b0-3329-72c9-b006-9eba6496f169` through
`-ox --orb-provider sprites-auto-20261104`. The actual `shell_command` returned:

```text
x86_64
user
automatic-provider-20261104
```

Exit status was 0. It wrote the marker to
`/home/user/automatic-provider-test/marker.txt`. The provider created Sprite
`amp-fb0baae6-ab16668dab9a33abb214667bd29ed1e3`, ID
`de4e188c-e9a0-4dc2-b865-c018a3ff94e8`, in `alex-ezell`.

Archiving completed the provider's pause operation, recorded `paused: true`,
and the Sprite subsequently reached `warm` through automatic idle sleep.
Unarchiving and continuing the thread reused the same Sprite ID and read the
original marker as `user`, exit status 0, without rewriting it. Deleting the
disposable thread then removed the Sprite and its dispatcher ownership record;
both absences were verified.

The dispatcher remains started and connected for further testing. The existing
remote builder `fly-builder-broken-skylark-759` in `alex-ezell` was reused; its
Machine `811124b90e05e8` was stopped after the build. The new dispatcher and volume
incur ongoing charges. The earlier provider and dispatcher were left untouched.

Local validation: 70 tests passed, along with Node/Bash syntax checks, ShellCheck,
workflow validation, and `git diff --check`.

## Coverage limits

Personal provider creation and automatic credential transfer were tested live.
Workspace creation, new-account login, concurrent-installer refusal, ambiguous
creation, changed secret-store format, replaced saved tokens, and failed-build
retries are covered by isolated tests. This run reused account logins and did
not exercise a fresh login dialog or the Amp agent's `manage_amp` tool.

The adapter reads Amp's observed secret-store contract, not a documented token
export API. Amp has one default provider-token entry per server, so callers must
not create other providers concurrently with setup. Unexpected or changed tokens
are rejected. Orbs had no repository; repository hooks and cold resume remain
separate acceptance work. This is an Orb provider, not an Amp Runner.
