# Upgrade, backup and rollback

Deploy exact tested digests and record the source revision, running image IDs,
Compose project/file, network and mounts. Keep the previous proxy and MCP images
available together. The external MCP bearer, backend API bearer and admin bearer
have separate roles; do not rotate or overwrite them accidentally during upgrade.

1. Pull/load candidates before downtime. Run offline checks with synthetic data.
2. Gate incoming traffic and stop MCP, allowing in-flight calls to finish. Inspect
   queue counts and reconcile `sending`/`unknown` outcomes. Stop the proxy next.
3. Back up data and config volumes consistently, plus the installed Compose and
   runtime secret configuration, into an owner-only runtime backup directory.
   Coordinate with any file-log rotation job so it cannot mutate the archive.
4. Validate archive integrity and restore into an isolated verification directory.
   Compare credential metadata/bytes privately. Do not print credential contents.
5. Update only the intended services in the existing project, preserve named
   volumes and unrelated services, run `compose config --quiet`, and recreate
   using `--no-deps --no-build --pull never --wait`.
6. Verify exact images, health, authenticated read-only status and denied anonymous
   access. Confirm that historical legacy queue files remain untouched. Perform
   actual sends only as explicit functional tests, not deployment smoke checks.

Checkpoints contain session keys and possibly message contents/attachments: keep
archives and runtime configuration outside Git and outside an ordinary knowledge
base. Record only sanitized paths/metadata in runbooks. A backup on the same host
protects rollback, not loss of the host itself. Never use `down -v` or volume prune
as part of an upgrade.

## Rollback after testing

Stop new requests and preserve post-test state before restoring anything. An
already delivered WhatsApp message cannot be undone; a stale pending record can
cause a duplicate. Reconcile any direct-call timeout/unknown result as well as
persistent outbox state. New library versions can alter credential files, so an
old image alone may not be a compatible rollback.

`ops/rollback/restore-checkpoint.sh` accepts a protected checkpoint directory,
installed stack file, project and data/config volume paths, followed by
`--delivery-outcomes-reconciled`. It expects `data.tar.gz`, `config.tar.gz` and
`stack-before.yml`, stages a verified extraction before stopping the candidate,
preserves post-trial volume contents, restores the prior state/stack, then starts
the previous images with no build/pull. It refuses to overwrite an earlier attempt.
Hold the installation's log-retention lock around restoration where applicable.
It targets Docker's standard `/var/lib/docker/volumes/*/_data` layout; adapt and
rehearse for other volume drivers rather than weakening its path checks.

Before using it on real data, confirm compatible archives, available old images,
enough disk space and reconciled delivery outcomes. Rehearse with synthetic data
and `network_mode: none`. Keep both checkpoints until recovery is confirmed.
Never expose the legacy queue to an older implementation that automatically
replays it. No generic command can promise receipt or exactly-once delivery.

## Retention and access

Docker stdout/stderr rotation does not rotate private Pino files in the data
volume. Set a host-specific file-log policy, protect message records and attachment
storage, monitor free space and test restore periodically. The optional
`scripts/maintenance/prune-log-archive.js` filters a closed uncompressed log into
an archive; inspect its usage and validate output before removing any original.
Session volume access is equivalent to account access. Keep it out of shared mounts
and use appropriate host permissions. The current application preserves existing
auth ownership/modes; check and harden those through a verified installation-specific
procedure rather than blindly applying recursive chown/chmod.
