# Amp Orbs on Sprites

Run your own Amp Orb provider on [Fly.io](https://fly.io) Sprites. Clone this
repository, run `./setup`, and start coding in Amp.

Setup deploys a small, always-on dispatcher in your Fly.io account. When Amp
asks for an Orb, the dispatcher creates a persistent Sprite for it and manages
its lifecycle. This is an experimental **Sprites 2** integration and an **Orb
provider, not an Amp Runner**.

Fresh setup, remote command execution, file persistence, pause, warm sleep,
resume on the same Sprite, and deletion have passed live tests. See the
[setup acceptance record](docs/setup-live-test.md) for evidence and remaining limits.

## Before you start

- **macOS or Linux (including WSL) with Node.js 22 or newer.** Nothing else is
  installed globally. Missing Fly and Sprite CLIs are installed into `.tools/`
  inside this checkout, and only after you confirm.
- **A Fly.io account.** Setup can create one. New organizations need a payment
  method before Fly will create apps; add one at
  [fly.io/dashboard](https://fly.io/dashboard) if setup fails right after sign-in.
- **Sprites 2 access** for the Fly organization that will host the dispatcher.
  Sprites 2 is not enabled for every organization yet. If setup reports that
  Sprites access is not ready after you authorize it in the browser, ask Fly
  support to enable Sprites 2 for that organization, then rerun `./setup`.
  See the [Sprites docs](https://docs.fly.io/sprites/).
- **An Amp account.** Setup tells you exactly when to create the provider.

You do **not** need Docker, npm packages, or a local Amp installation. Sign-in
happens on Fly's and Sprites' normal login pages; there is no separate setup site.

## Install

```sh
git clone https://github.com/superfly/amp-orbs-on-sprites.git
cd amp-orbs-on-sprites
./setup
```

Setup walks through these steps in order:

1. Installs the Fly and Sprite CLIs into `.tools/` if they are missing.
2. Signs you in to Fly, or creates an account, and lists your organizations.
   Pick the one that will host the dispatcher and be billed for it.
3. Authorizes Sprites for that organization in the browser if needed.
4. Asks for an Amp provider token. Open [Amp Settings → Orbs](https://ampcode.com/settings/orbs),
   create a provider, copy its token (it starts with `aop_live_`), and paste it
   at the hidden prompt. The token is not echoed, is never written to disk by
   setup, and never appears on a command line or in a child process environment.
5. Shows the app name, organization, region, and ongoing cost, then asks to continue.
   Answering no changes nothing.
6. Builds the image on Fly's remote builder, creates the volume and a restricted
   Sprite credential, deploys the dispatcher, and waits for it to confirm its
   connection to Amp.

The remote build usually takes a few minutes. Setup prints a line every
20 seconds while it runs. When it prints `Ready`, you can close the terminal.

**What it creates and what it costs.** One Fly app with one always-on
shared-CPU 512 MB Machine and one 1 GB volume, plus a Fly remote builder app
that stops after each build, plus one Sprite per Orb. All of it is billed to the
organization you selected. The dispatcher has no public IP or service.

## Verify it works

In Amp, start a new thread and select the provider you created. Ask it to run
`uname -m` and `id -un`. A working Orb returns `x86_64` and `user`.

Archiving the thread pauses the Orb. Its Sprite goes to sleep on its own and
resumes with its files intact when you continue the thread. Deleting the thread
deletes the Sprite.

The dispatcher keeps running in your Fly account; you can watch it at
`https://fly.io/apps/YOUR_APP_NAME`.

## Everyday use

- **Rerun `./setup`** to resume an interrupted install or to check an existing
  one. A completed installation reuses its stored credentials and does not ask
  for the Amp token again.
- **After pulling code changes**, rebuild and redeploy with `./setup --rebuild`.
  The old dispatcher keeps running until the new image is ready; a failed build
  leaves it untouched.
- **Keep `.state/`.** It records which Fly and Sprite resources this checkout
  owns and makes reruns safe. It never contains tokens.
- **For automation**, put the token in the environment for the first install
  and pass explicit flags:

  ```sh
  AMP_ORB_PROVIDER_TOKEN=... ./setup --org YOUR_ORG --app UNIQUE_APP_NAME --yes
  ```

  `./setup --help` lists every option.

## Credential expiry

The Sprite credential the dispatcher uses expires **90 days** after it is
issued. Setup prints the date, and `.state/installations/YOUR_APP_NAME/installation.json`
records it as `credentialExpiresAt`. After expiry, Orbs stop spawning until a
new credential is installed. Automatic rotation is not implemented yet.

To rotate manually before expiry, with the Amp token available in the
environment or ready to paste:

1. Stop the dispatcher's use of the old credential by editing
   `installation.json`: remove `secretsConfigured`, `credentialExpiresAt`, and
   `credentialTokenId`, and set `activated` to `false`.
2. Run `./setup --app YOUR_APP_NAME`. It mints a new restricted credential,
   restages both secrets, and redeploys the same Machine.
3. If the old `credentialTokenId` was recorded, revoke it:

   ```sh
   sprite -o YOUR_ORG api /v1/tokens/OLD_TOKEN_ID -- --request DELETE
   ```

## Remove the installation

1. In Amp, delete (not just archive) every thread that used this provider so the
   dispatcher deletes their Sprites. Confirm none remain, using the `provider`
   value from `installation.json` as the prefix:

   ```sh
   sprite -o YOUR_ORG list --prefix YOUR_PREFIX-
   ```

2. Destroy the Fly app. This removes its Machine and volume:

   ```sh
   fly apps destroy YOUR_APP_NAME --yes
   ```

3. Revoke the Sprite credential if `credentialTokenId` is recorded in
   `installation.json` (see the command above). Otherwise it expires on its own.
4. Delete the provider in [Amp Settings → Orbs](https://ampcode.com/settings/orbs),
   or keep it to reinstall later with the same token.
5. Remove `.state/installations/YOUR_APP_NAME`. The `fly-builder-*` app Fly
   created for remote builds can also be destroyed.

## Limits and security

- Sprites 2 (`runtime_kind=flyfs`) only; the legacy runtime is rejected. Native
  Sprite base only: `ORB_IMAGE` is acknowledged but not applied, and project
  snapshots (`ORB_SNAPSHOT_ID`) are unsupported.
- The Fly credential used by the installer stays on your computer. Only the Amp
  provider token and a prefix-restricted, 90-day Sprite credential are installed
  as Fly secrets on the dispatcher. Anyone with access to the Fly organization
  can read those secrets.
- Only the short-lived Orb token and Amp URL enter a Sprite. They are stored in
  the Sprite's service configuration, which may appear in snapshots or backups;
  restrict access to the organization.
- The agent runs as `user` with passwordless `sudo` on its own single-tenant
  Sprite. It can read its own Orb token and modify anything on that Sprite; the
  pinned Amp binary is re-verified on every spawn.
- The dispatcher never prints API bodies, CLI stderr, or raw remote errors.
  Credentials are passed over stdin, never as command arguments.
- One dispatcher per provider token. Do not run a local development controller
  and a hosted dispatcher with the same token.
- Failed preparation keeps the Sprite for retry. Unrecognized Sprites are never
  adopted or deleted automatically.

Amp's agent loop and inference stay on Amp; the Sprite hosts its tools and
working files. A [Runner](https://ampcode.com/docs/cli/runners) serves threads in
an existing environment and does not use this provisioning lifecycle.

## More

- [Local development provider](docs/local-development.md): run the controller
  on your own machine, lifecycle details, configuration variables, CLI testing.
- [Provisioning and recovery](docs/provisioning.md): what setup creates, retry
  semantics, and local-to-hosted handoff.
- [Operations](docs/operations.md), [testing](docs/testing.md), and the
  [hosted](docs/hosted-live-test.md) and [guided setup](docs/setup-live-test.md)
  acceptance records.

Run `npm test`, `npm run check`, and `shellcheck setup bootstrap/*.sh` for local checks.
