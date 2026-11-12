# Amp Orbs on Sprites

Run [Amp](https://ampcode.com) Orbs on persistent [Fly.io](https://fly.io) Sprites
in your own account. Each Orb gets its own Sprite for tools and working files.
Once set up, you can use Amp and close your laptop—the provider runs on Fly.io.

## Before you start

You'll need:

- macOS or Linux, including Windows through WSL.
- Git and **Node.js 22 or newer**.
- A Fly.io account with a payment method on file; setup can create the account,
  but Fly will not create apps for an organization without billing details.
- An organization with **Sprites 2 enabled**. The original Sprites runtime is
  not supported. Sprites 2 is not yet enabled everywhere: if setup reports that
  Sprites access is not ready after you authorize it in the browser, ask Fly
  support to enable Sprites 2 for that organization, then rerun `./setup`.
- An Amp account. Setup will guide you through signing in if needed.

This integration is experimental. Check the [current limitations](#current-limitations)
before relying on it for your workflow.

## Set up

```sh
git clone https://github.com/superfly/amp-orbs-on-sprites.git
cd amp-orbs-on-sprites
./setup
```

Follow the prompts to:

1. Connect your Fly.io account, choose an organization, and authorize Sprites.
2. Choose a provider name and whether it belongs to you or an Amp workspace.
3. Review the deployment and costs, then sign into Amp if needed.

Setup installs the tools it needs, creates the Amp provider, makes it your
personal or workspace default, transfers its credentials, and deploys the service
that manages your Orbs. Setting a workspace default requires a workspace admin.
You don't need Docker, an existing Amp CLI installation, or any token copying and
pasting.

Wait for **“Dispatcher connected to Amp.”** Setup then prints your Fly.io app
link and the provider name to select in Amp. You can close the terminal.

## Use your Orbs

Start a thread in Amp and select the provider name printed by setup. To check
that it works, ask it to run `uname -m` and `id -un`: a working Orb returns
`x86_64` and `user`.

- **Work:** Amp runs tools and keeps working files on that thread's Sprite.
- **Pause:** Archive the thread to pause its Orb and let the Sprite sleep.
- **Resume:** Unarchive and continue the thread to use its saved files.
- **Delete:** Deleting the thread removes its Sprite and the files on it.

This is an **Amp Orb provider**. For running Amp in an existing environment,
see [Amp Runners](https://ampcode.com/docs/cli/runners).

## What runs in your account

Setup creates one always-on **512 MB Fly Machine** and a **1 GB volume** to run
the dispatcher, plus a Sprite for each Orb you create. Builds run remotely on
Fly.io. Hosting, storage, build resources, and Sprite usage are billed to the
organization you choose.

The dispatcher keeps running when your laptop is off. Archiving an Orb lets
its Sprite sleep; it does not stop the dispatcher. Deleting the dispatcher alone
does not remove its Sprites.

## Check or update your installation

Keep this checkout, including its hidden `.state/` directory. Setup uses it to
recognize your installation and resume safely.

To check the connection or resume an interrupted setup, run:

```sh
./setup
```

To deploy a newer version:

```sh
git pull --ff-only
./setup --rebuild
```

Rebuilding keeps the existing storage and credentials. The dispatcher briefly
restarts when the new version is deployed.

### Rotate the Sprite credential

The dispatcher's Sprite credential expires **90 days** after it is issued. Setup
prints the expiry date when it finishes and warns on any rerun once fewer than
14 days remain. After expiry, Orbs stop spawning until the credential is
replaced. To replace it:

```sh
./setup --rotate-credential --app YOUR_APP_NAME
```

This mints a new restricted credential, restages only that secret, redeploys
the same dispatcher image (it briefly restarts), waits for the Amp connection,
then revokes the previous credential. The Amp provider token is not needed
again. If restaging or the redeploy fails, the new credential is revoked and
the previous one stays in place; rerun the command to try again.

### Remove the installation

1. In Amp, delete (not just archive) every thread that used this provider so
   the dispatcher deletes their Sprites.
2. Run the teardown and type the app name when asked. `--yes` does not skip
   that confirmation:

   ```sh
   ./setup --destroy --app YOUR_APP_NAME
   ```

   It refuses while any Sprite with the installation's prefix still exists.
   Otherwise it destroys the Fly app with its Machine and volume, revokes the
   Sprite credential, and removes `.state/installations/YOUR_APP_NAME`.
3. Delete the provider in [Amp Settings → Orbs](https://ampcode.com/settings/orbs).
   Teardown does not touch it, nor the `fly-builder-*` app Fly created for
   remote builds; destroy that app yourself if you no longer want it.

For setup options, run `./setup --help`. To use an existing provider, automate
setup, or recover from a failure, see [setup and recovery](docs/provisioning.md).
If setup reports an ambiguous creation or ownership problem, follow that guide
before retrying or deleting saved state.

## Current limitations

- Sprites 2 access is required; setup does not enable it for your organization.
- Custom container images and project snapshots are not supported.
- Desktop, portals, repository checkout, and cold resume have not yet been
  verified end to end. Command execution, file persistence, warm sleep/resume,
  and deletion have been tested with real Orbs.
- Credential rotation is manual: run `./setup --rotate-credential` when setup
  warns that the Sprite credential expires within 14 days. Rotation and
  `--destroy` have been exercised against fixtures only, not yet end to end.
- The agent runs with passwordless `sudo` on its own single-tenant Sprite, so it
  can read its own Orb token and change anything on that Sprite.

## Help and development

For setup problems, [open an issue](https://github.com/superfly/amp-orbs-on-sprites/issues)
with the step that failed and the error message. Keep tokens and credentials
out of the report.

- [Setup options and recovery](docs/provisioning.md)
- [Provider internals and local development](docs/provider.md)
- [Operations](docs/operations.md)
- [Testing](docs/testing.md)
