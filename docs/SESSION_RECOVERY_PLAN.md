# Session recovery fix

## Failure and intended behaviour

A retained session closed with code 500, stayed disconnected and resumed on the
first non-destructive administrative reconnect. The old policy treated 500 as
terminal and also stopped recoverable transport retries after five attempts.
Recoverable closures must instead retain credentials, schedule bounded-frequency
retries and expose their state. Genuine rejection, conflict, manual disconnect
and credential-storage failure must remain explicit blocked states.

## Scope and checkpoints

1. Implement one serialized reconnect scheduler shared by close, initialization
   failure and socket timeout. Keep existing auth storage and send semantics.
2. Test 500 recovery, backoff beyond five attempts, failed initialization,
   watchdog recovery, storage failure, terminal reasons and manual cancellation
   with synthetic credentials and fake timers. Exercise both pairing views.
3. Run Node/MCP suites, production dependency audits, image builds and image
   scans. Release through the existing manual CI pipeline, reusing tested images.
4. Before runtime upgrade, record installed images/Compose/ports, reconcile
   sending/unknown outcomes, stop affected services and verify protected backups.
5. Update only the proxy image, preserving installed LAN/loopback bindings,
   tokens, mounts, session and unrelated services. Verify read-only status and
   actual health probes; perform no real send/pairing/reset as a smoke test.
6. Keep the previous image and compatible checkpoint. Roll back only after
   reconciling delivery outcomes; preserve post-upgrade session state first.

## Acceptance and limits

There is at most one active socket/retry timer; stale callbacks cannot undo a
manual disconnect. A 500 with usable auth reconnects without operator action.
Sustained recoverable outages remain scheduled at five-minute intervals instead
of becoming an unexplained idle state. Persistent upstream refusal is reported,
not hidden by deleting credentials or generating a new QR automatically.
Production evidence and private deployment values stay in the local KB.
