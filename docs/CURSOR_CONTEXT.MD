# Agent context: building Sigil from scratch

Read `docs/ARCHITECTURE.md` fully first. Most-likely-to-be-simplified
sections: §2.1 (guard denials), §3 (reliability, fail-closed, gaps), §4
(sequence vs commit order), §7.4 (what Merkle can't prove), §9
(verify-then-drop). Write the **spec and test vectors before the server**.

## Step 0: infra (set up yourself, not included)
npm workspace with: `apps/collector` (NestJS ingest + query API),
`apps/sealer` (worker), `packages/nest` (`@sigil/nest`: interceptor, guard
wrapper, filter, `@Audit`, `@NoAudit`, buffer + shipper), `packages/verifier`
(**no Nest, no DB client, no shared writer code**), `apps/demo` (two NestJS
services to audit). Docker Compose: Postgres + MinIO (enable object lock on
the cold bucket; verify) + a stub "gateway log" source for reconciliation.
Deps: `nestjs-cls`, `@nestjs/core` (Discovery), `pg`, a JCS (RFC 8785)
library; Node's built-in `crypto` covers SHA-256 and Ed25519. Hand-written SQL
migrations, as in earlier projects.

## Step 1: data model (tenant-scoped everywhere)
- `tenants`, `streams` (id, tenant_id, shard, `next_pseq` counter,
  `last_block_no`, `last_block_hash`).
- `sources` (id, tenant_id, name, kind APP|GATEWAY|DB|IDP, heartbeat_s),
  `source_keys` (source_id, public_key, valid_from, revoked_at).
- `source_batches` (id, source_id, first_source_seq, last_source_seq,
  batch_hash, signature, stream_id, first_pseq, last_pseq, received_at).
- `events` (stream_id, pseq PK; event_id; source_id; source_seq;
  claim_hash; event_hash; occurred_at; ingested_at; action; outcome;
  sensitivity; actor_type, actor_id; resource_type, resource_id;
  trace_id, request_id; body jsonb; payload_commitment; block_no NULL until
  sealed). `UNIQUE(source_id, source_seq)`, `UNIQUE(tenant_id, event_id)`.
  **Partition by day on `ingested_at`.** Append-only: row trigger +
  **statement-level BEFORE TRUNCATE trigger** + REVOKE.
- `blocks` (stream_id, block_no, first_pseq, last_pseq, event_count,
  merkle_root, prev_block_hash, block_hash, sealed_at, key_id, signature,
  anchor_ref). `UNIQUE(stream_id, block_no)`. Append-only, **retained
  forever**.
- `gap_records` (source_id, from_seq, to_seq, count, reason, reported_at).
- `checkpoints`, `witness_receipts` (as in Cairn).
- `archives` (stream_id, first_block, last_block, object_key, sha256,
  merkle_verified_at, locked_until, status).
- `retention_policies` (sensitivity, framework, hot_days, total_days),
  `legal_holds`, `retention_approvals` (dual-control).
- `reconciliation_findings` (source_a, source_b, correlation key, kind,
  detected_at, resolved_at).
- `route_registry` (generated in CI: route, method, audited, no_audit_reason,
  approved_by).

## Step 2: build in this order
1. **Pure modules + vectors:** JCS wrapper, claim/event hash builders,
   RFC 6962-style Merkle (leaf/node prefixes, root, inclusion proof
   generate/verify), block-hash binary layout, batch-hash, Ed25519 sign/
   verify. Publish vectors.
2. **`@sigil/nest` capture:** `@Audit`/`@NoAudit`, CLS context middleware,
   outermost `AuditInterceptor` (success/failure/exception with
   `reason_code` enum, never message text), **`AuditedGuard` wrapper and
   fallback exception-filter path for denials**, http/rpc/ws extractors,
   `traceparent` propagation.
3. **CI coverage check:** enumerate routes via DiscoveryService + Reflector;
   fail on unannotated mutating routes; emit `route_registry`.
4. **Durable buffer + shipper:** outbox table (same transaction as business
   write) and fsynced file journal variants; per-source `source_seq`;
   signed batch envelopes; heartbeat events; at-least-once with backoff +
   jitter; **fail-closed ATTEMPT-before-act** for CRITICAL; gap records on
   drop.
5. **Collector:** verify batch signature and `source_seq` contiguity;
   per-stream counter row locked once per batch (gap-free `pseq`);
   hashing; idempotent insert; signed ingest receipt; 429 backpressure.
6. **Sealer:** seal `(last_sealed, n]` every S seconds, force-close at
   partition boundary; Merkle root; block hash; sign; unique-block-number
   race safety; optional advisory-lock election.
7. **Verifier package + continuous verification job** (layers 1-4) and a
   dead-man heartbeat from the verifier.
8. **Source self-audit** (request/verify inclusion proofs after
   `seal_deadline`).
9. **Checkpoints + witness delivery** through Dispatcher; layer-4 verification.
10. **Reconciler** between the demo gateway source and app source.
11. **Query API** (keyset pagination, tenant-scoped, role-separated),
    **meta-audit stream** for reads/exports/verifications, evidence-package
    export (whole blocks + proofs).
12. **Tiering:** archive exporter, **verify-then-drop** job, manifest,
    object lock, cold-read path, restore job, legal holds, dual-control
    retention deletion with meta events.
13. **Privacy:** allowlist declarations, HMAC for sensitive fields,
    off-chain payload store with salted commitments, erasure path.
14. **Metrics and alerts** per §13; ensure alerts flow via Dispatcher.

## Step 3: tests that prove the claims
- **Lifecycle gap (key test):** a request rejected by a guard produces a
  `DENIED` event; show that an interceptor-only implementation records
  nothing for the same request (keep that test as documentation of why).
- **Coverage:** adding an unannotated mutating route fails the CI check;
  `@NoAudit` without a reason fails; with an approved reason passes.
- **Outcome semantics:** validation failure, handler exception, success,
  client abort after commit, and SSE completion each yield exactly one
  correctly-classified event; no raw exception text appears.
- **Context propagation:** an action fanning out across two services shares
  one `trace_id` and correct actors; works in an RPC and a WS handler.
- **Buffer durability:** kill the process between business commit and
  shipping; the event is delivered after restart exactly once effectively
  (idempotent). Same-transaction outbox: rolled-back business write leaves
  no event.
- **Fail-closed:** with the buffer unavailable, a `CRITICAL` action is
  denied and an `ATTEMPT` is never lost; a `STANDARD` action proceeds and
  a gap record with the exact dropped count appears.
- **Per-source gaps and silence:** delete a mid-range event (triggers off)
  → completeness check names source and `source_seq`; stop a source's
  heartbeat → alert after the configured interval.
- **Sequence vs commit order (key test):** reproduce the naive-sequence
  bug (T1 draws 100, T2 draws 101 and commits first; poller skips 100),
  then show the per-batch counter-row collector yields gap-free `pseq` in
  commit order under 20 concurrent sources.
- **Merkle:** matches vectors; every inclusion proof verifies; flipping any
  bit fails; second-preimage prefixes enforced.
- **Sealer races:** two sealers concurrently → exactly one block per
  number, correct `prev_block_hash`; crash mid-seal and resume; block is
  force-closed at the partition boundary.
- **Tamper layers:** edit an event (triggers disabled) → layer 2 names the
  block and event; **rewrite-and-rehash of a block suffix** → layers 1-3
  pass, layer 4 (witness checkpoint) fails; tail truncation → layer 4
  fails; delete an unsealed event whose receipt exists → source self-audit
  yields signed evidence of a missed promise.
- **Completeness limit demonstration:** a filtered query result cannot be
  verified as complete via Merkle alone; the whole-block evidence export
  can.
- **Reconciliation (key test):** a gateway-observed write with no
  application event produces a finding after the settle window; matching
  pairs produce none.
- **Tiering:** verify-then-drop refuses when the archived copy is corrupted
  (flip one byte), unsealed, held, or unexpired; after archiving, an
  inclusion proof for an archived event still verifies from the cold
  object; the block table remains complete; retention deletion requires two
  approvers and emits meta events.
- **Append-only:** UPDATE/DELETE/**TRUNCATE** on events and blocks rejected
  for the app role and by triggers.
- **Access control:** ingest credential cannot read; auditor cannot write;
  every query/export/verify produces a meta event; tenant A can't read B.
- **Privacy:** scan stored events for planted secrets/PII fields not on the
  allowlist (zero matches); HMAC values can't be reversed with a dictionary
  without the key; erasing a payload keeps the chain verifying and the
  verifier reports "erased," not "tampered."
- **Log injection:** newline/control characters and oversized strings in
  attacker-controlled fields can't forge fields or break parsing.
- **Performance:** measure interceptor overhead with the local buffer;
  ingest throughput by batch size; seal lag under burst; record the numbers.
- **Self-observation:** seal lag beyond the max delay, missed heartbeat,
  and verifier-stopped each raise the corresponding alert.

## Design decisions already made (don't relitigate)
1. Guard denials are captured explicitly; an interceptor alone is
   insufficient. Coverage is a CI-enforced property.
2. Durable local buffer, never a network call on the request path;
   fail-closed audit-before-act for CRITICAL, fail-open with counted gaps
   otherwise.
3. Per-source monotonic sequences, heartbeats and gap records make absence
   visible; receipts are signed promises that sources verify.
4. Per-stream `pseq` from a counter row locked per batch; never trust DB
   sequence order as commit order.
5. Sealed Merkle blocks chained by hash, signed, witnessed; blocks never
   span partitions; the sealer is race-safe, not singleton-dependent.
6. Per-batch source signatures; signatures prove source, not truth.
7. Independent verifier, no shared code with the writer.
8. Cross-source reconciliation is required, not optional.
9. Verify-then-drop against the Merkle root; the `blocks` table is kept
   forever.
10. Evidence export unit is the block; no claims of provable completeness
    for filtered queries.
11. Allowlisted fields, HMACed sensitive values, erasable off-chain
    payloads; reading the audit log is itself audited.
12. Append-only enforced by row triggers, TRUNCATE trigger, and REVOKE.
13. Reuse Dispatcher, GateKeeper, Foghorn, VaultKeep, ArchiveVault; don't
    rebuild them.