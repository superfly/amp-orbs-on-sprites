# Live test — November 3, 2026

Target: **Sprites 2**, organization **alex-ezell**, Amp provider
**fly-sprites-test**. Existing Sprite CLI login and the user's provider token
were reused. Amp account login is separate and was completed for CLI tests.
No credentials are recorded here.

## Environment and resources

- Local Fly CLI v0.5.2, authenticated; flyctl displays this personal org using
  its `personal` alias, but all adapter operations pass `alex-ezell` explicitly.
- Verified Amp release: `0.0.1793707234-gc72860`. Official macOS and Linux x64
  binaries were checksum-verified; the launcher caches the local CLI in `.tools/`.
- Native Sprite: Linux x86_64, glibc 2.43, Git 2.53.0, passwordless sudo.
- Preflight Sprite: `mcp-amp-preflight`, ID
  `01c49126-0aad-474f-bc99-bca8b884ebd2`, checkpoint `v1` before preparation.
- Retained smoke Sprite: `mcp-amp-test-11ef38c52ffe4ca33d790e6317048cc3`, ID
  `ea2083c0-fbfb-4e1a-964e-b40dcd91b0ab`.
- [Smoke thread](https://ampcode.com/threads/T-01a1a1e7-2fe8-73c6-981b-e8b35e50babb).
- Earlier disposable failed-test Sprite
  `mcp-amp-test-93307322e4d56307272abc48f4848d16` was deleted and absence verified.
  Its disposable Amp thread was deleted too. Other existing Sprites were untouched.

## Verified end to end

1. The provider connected to Amp and received real spawn/pause/delete jobs.
2. Spawn created a private-URL Sprite, prepared the `user` account, installed Amp,
   and connected supervised bootstrap to the remote Orb.
3. A remote `shell_command` ran in `/home/user/workspace` and returned:

   ```text
   x86_64
   user
   fly-amp-persistence-20261103
   ```

   The marker was written to `/home/user/amp-sprites-smoke/marker.txt`.
4. Archiving the thread caused Amp to dispatch pause. Bootstrap stopped and
   control-plane metadata subsequently reported `warm` without a suspend call.
5. Unarchiving and continuing with `-ox` read the existing marker without
   modifying it. The Sprite ID was unchanged and the remote command exited 0.
6. Deleting the earlier disposable test triggered deletion; GET eventually
   returned absent. A repeated adapter delete succeeded harmlessly.
7. The actual `npm start -- --org alex-ezell` launcher downloaded/verified Amp,
   reused saved Sprite authentication, and connected the provider.

The initial successful spawn took about ten seconds; warm resume about seven.
These are observations of this account/runtime, not performance guarantees.
Billing was not independently inspected.

## Live discoveries incorporated into the adapter

- Amp did not forward custom `AMP_BINARY_*` settings. Adapter configuration now
  uses `SPRITES_AMP_BINARY_*`.
- Sprites 2 services use `process.argv/cwd/env`, `desired_state`, and `restart`;
  GET wraps configuration/runtime in `data`. PUT may return final `type=sprite`
  NDJSON rather than the legacy terminal `complete` event.
- Runtime-only service stop does not persist intent. Pause writes
  `desired_state=stopped`; an already-asleep runtime reports
  `{error: "vm_not_running", running: false}`, which is accepted with that intent.
- Delete acknowledgement can precede disappearance. Ownership remains until
  bounded polling confirms the Sprite is absent.
- Quiet bootstrap connections allowed natural sleep and repeated Amp spawn jobs
  roughly every minute. A supervised wrapper now maintains a two-minute
  Sprites 2 keep-awake lease, renewed every 30 seconds. The shell attempts
  release on exit; pause explicitly releases it after stopping the service.
  Live service termination interrupted shell cleanup, so the trap alone was
  insufficient. A failed explicit release leaves pause retryable.
- The published Tasks API returned 404 on this target. The supported interface
  is `/.sprite/bin/sprite-env keep-awake`; sudo's PATH does not include it.
- This runtime lacked usable `/dev/stdin` for `install`. Wrapper installation
  now writes a temporary file before installing it.
- CLI `-x` selects local execution; `-ox` is required for remote execution.
  A returned URL is submission evidence only; thread tool results establish success.

## Final stability and cleanup check

The final Sprites 2 wrapper connected at 15:13:09 UTC. The remote marker read
completed successfully as `user`. With no guest exec or service probes from
15:13:55 through 15:16:06, control-plane metadata still reported `running` on
the same Sprite ID. The keep-awake deadline advanced from 15:15:38 to 15:17:39,
confirming renewal. No additional spawn jobs appeared during that interval;
the earlier roughly-minute reconnect loop did not recur.

A further real resume read the marker successfully with exit status 0. Final pause
completed at 15:18:24 UTC, and the guest reported `keep_awake_until_ms=null`.
At 15:19:18, read-only control-plane metadata reported the retained smoke Sprite
`warm`; the preflight Sprite was also `warm`. No VM suspend API was called.
The smoke thread is archived. The later [hosted deployment](hosted-live-test.md)
migrated its ownership record and stopped the local controller.

Local validation: 36 passing tests, Node/Bash syntax checks, and ShellCheck.
A local Git repository was initialized; secrets, state, downloaded tools, and
scratch work are ignored. No commit, remote repository, PR, or GitHub comment
was created.

## Remaining acceptance work

Cold sleep, repository/project hooks, Desktop, portals, snapshots, expired-token
recovery, upstream log redaction, and clean-account onboarding remain unverified.
The initial test used a local controller. The later hosted acceptance record
covers deployment to a Fly Machine. Nothing has been published to GitHub or
made available as clean-account browser onboarding.
Sprites 2 access and organization routing are prerequisites.
