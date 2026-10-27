# Architecture: principles → design

> Engineering design, not legal or compliance advice. Control references
> (SOC 2, HIPAA, PCI DSS) are illustrative; what an auditor accepts, and
> required retention periods, vary. Confirm with your auditor and counsel.
> Version-specific statements about NestJS, Postgres and MinIO are marked
> "verify": confirm against the versions you install.

## System shape

```
 service A (NestJS)         service B             API gateway / DB-level audit
 ┌─────────────────┐       ┌───────────┐          (INDEPENDENT capture points)
 │ @sigil/nest      │       │           │                  │
 │ guard wrapper +   │       │           │                  │
 │ filter +          │       │           │                  │
 │ interceptor       │       │           │                  │
 │  ↓                │       │           │                  │
 │ durable local     │       │           │                  │
 │ buffer (WAL)      │       │           │                  │
 └───────┬─────────┘       └─────┬─────┘                  │
         │ signed batches (per-source seq) │                 │
         ▼                                  ▼                 ▼
 ┌──────────────────────────────────────────────────────────────┐
 │ collector: verify batch sig · assign per-stream pseq (gap-free) │
 │ · compute event_hash · issue signed INGEST RECEIPT (promise)    │
 └──────────────┬───────────────────────────────────────────────┘
                ▼                                   ┌──────────────────┐
 ┌─────────────────────────┐  seal every S sec   │ reconciler        │
 │ events (append-only,     │──────────────────▶ │ cross-source diff │
 │ day-partitioned, hot)    │   ┌──────────────┐  └──────────────────┘
 └──────────┬──────────────┘   │ blocks         │ Merkle root + prev_block_hash,
            │                   │ (append-only,   │ signed, anchored to witnesses
            ▼ verify-then-drop  │  kept forever)  │
 ┌─────────────────────────┐   └──────────────┘
 │ cold archive (MinIO,     │    verifier (independent code, no DB client)
 │ object lock) + manifest  │    sources self-audit their own receipts
 └─────────────────────────┘
```

---

## 0. What an audit log must guarantee, and against whom

Four properties, provided by different mechanisms. Conflating them is how
"we have audit logging" turns out not to hold up under audit.

| Property | Question | Mechanism |
|---|---|---|
| **Completeness** | Is every sensitive action recorded? | CI-enforced coverage, guard-denial capture, durable buffers, per-source sequences, heartbeats, cross-source reconciliation (§2, §3, §8) |
| **Integrity** | Was a recorded event altered or removed? | Append-only storage, sealed Merkle blocks, signed and witnessed heads (§5, §7) |
| **Attribution** | Which system said this? | Per-source signed batches (§6) |
| **Availability** | Can an auditor query it, years later? | Tiered storage that stays verifiable (§9) |

**Threat model (who we defend against, and with what):**

| Adversary | Does | Defended by | Residual |
|---|---|---|---|
| Developer mistake | Forgets to audit a new endpoint | CI coverage check (§2.5) | Business logic outside annotated handlers |
| Compromised application | Forges or suppresses its own events | Source signatures bind events to a source; reconciliation against independent capture points (§8) | Fully owning every capture layer defeats it |
| Insider with DB access | Edits/deletes rows | Triggers, role separation, sealed blocks, anchors (§5, §7) | A superuser can still drop triggers; anchors are what catch it |
| Audit operator | Rewrites history and recomputes | Witnessed signed checkpoints held by others (§5.4) | Collusion of all witnesses + operator |
| Collector outage / DoS | Prevents capture | Durable local buffers, gap records, heartbeats (§3) | Source disk exhaustion (bounded and alarmed) |
| Data exposure | Reads the audit store | Redaction by allowlist, access control, meta-audit (§10, §11) | |

Two honest limits, stated up front: the log proves what was **recorded**,
not that the recording was **true** (a source can lie), and an attacker
who controls both the application and every independent capture point
can omit events undetectably.

---

## 1. The event model

**Fields are split into claimed vs assigned**, because only one side can be
trusted:

- **Claimed by the source** (signed by it): `event_id` (UUIDv7, so
  time-ordered and unique), `source_id`, `source_seq` (per-source
  monotonic counter), `occurred_at` (the source's clock; untrusted for
  ordering), `actor {type, id, session_id}`, `action` (stable dotted name,
  e.g. `patient.record.read`), `resource {type, id}`, `outcome`
  (`SUCCESS|FAILURE|DENIED|ATTEMPT`), `reason_code` (bounded enum, never a
  raw error message), `sensitivity` class, `correlation {trace_id,
  request_id}`, `policy_version`, `changes` (§11), `schema_version`.
- **Assigned by the collector**: `stream_id`, `pseq` (per-stream
  gap-free sequence), `ingested_at` (database clock), `claim_hash`,
  `event_hash`.

**Taxonomy** (so "what must be audited" has an answer): authentication
(login, MFA, failure, lockout), **authorization decisions (allow and deny)**,
data access (reads of sensitive records: HIPAA-style access logging is
about reads, not just writes), data change (create/update/delete),
privileged/admin actions and configuration changes, **break-glass access**,
export/download, and security events.

**Record the decision, not just the request.** For authorization events,
store the policy/rule version and decision basis. "Allowed" is only
meaningful relative to the policy in force.

**Outcome states matter:** `ATTEMPT` (recorded before the action, §3.3),
`SUCCESS`, `FAILURE`, `DENIED`. A log of only successes hides probing;
a log of only attempts hides what actually happened.

**Log injection:** events are structured JSON built from typed fields, never
string-concatenated, with bounded lengths. Attacker-controlled strings
(usernames, user agents) are stored as data and can't forge fields or
newlines in downstream text tooling. `reason_code` is an enum; raw
exception messages (which can contain SQL, tokens, or personal data) are
never stored.

**Canonical form:** `claim_hash = SHA-256(JCS(claimed fields))` (RFC 8785
canonicalization, for the same reason as Cairn: byte-identical hashing
across implementations). `event_hash = SHA-256(domain-tag ‖ stream_id ‖
pseq ‖ ingested_at ‖ claim_hash)`, with length-prefixed fields.

---

## 2. Capture in NestJS: where the obvious design has a hole

### 2.1 The lifecycle gap

NestJS request lifecycle: middleware → **guards** → interceptors (before)
→ pipes → handler → interceptors (after) → exception filters. A guard that
rejects a request throws before any interceptor has run, so **an
interceptor never sees an authorization denial**. Validation-pipe failures
and handler exceptions *do* flow back through an interceptor, so the bug
is subtle: the audit log shows plenty of failures, and none of the
401/403s.

An interceptor-only audit library therefore can't record "who tried to
read patient 442 and was refused," arguably the highest-value event class.

**Design (three cooperating pieces):**

1. **`AuditInterceptor`**, outermost interceptor, records outcomes of
   everything that reaches the handler pipeline (success, validation
   failure, handler exception) via `tap`/`catchError` on the Observable.
2. **Guard denial capture.** Options, in order of fidelity: (a) wrap
   guards in an `AuditedGuard` decorator-style base that catches a denial
   and records it with full handler metadata (`ExecutionContext` exposes
   `getHandler()`/`getClass()`); (b) a global **exception filter** that
   records `DENIED` for `UnauthorizedException`/`ForbiddenException`
   using method + route template (always available) and enriches with
   decorator metadata where your Nest version exposes it to the filter
   (verify). Either way, a denial must produce an event.
3. **Authentication-layer events** (failed logins, token failures) usually
   happen in guards/strategies, so they flow through the same denial path.

### 2.2 Context propagation

Actor, tenant, request ID and trace ID are set once in middleware and held
in `AsyncLocalStorage` (e.g., `nestjs-cls`), so any code path, including
service-to-service calls, background jobs, and queue consumers, can emit an
event with correct context without threading arguments. Propagate W3C
`traceparent` across services so one user action reconstructs as a single
cross-service story. `ExecutionContext.getType()` distinguishes
`http`/`rpc`/`ws`; each needs its own actor and resource extractor.

### 2.3 Declarative annotation, with explicit resource extraction

```
@Audit({ action: 'patient.record.read',
         resource: { type: 'patient', idFrom: 'params.id' },
         sensitivity: 'PHI', changes: ['status','assignee'] })
```

The decorator declares *what* the action is; the library handles *how*. For
mutations, resource IDs created by the handler come from the response, so
extraction supports both request and response sources.

### 2.4 Outcome semantics

Define precisely when an event is emitted so behavior is predictable:
buffered/streaming (SSE) responses record on handler completion or error,
not first byte; a request aborted by the client after the handler committed
still records `SUCCESS`; exceptions are classified (`reason_code`) without
leaking message text.

### 2.5 Coverage as a CI-enforced property

The commonest real-world failure is an endpoint nobody annotated. At
startup and in CI, enumerate every route (e.g., `DiscoveryService` +
`Reflector` over controllers; verify the API for your Nest version) and
**fail the build** when a mutating route (or any route touching a
sensitivity class) has neither `@Audit(...)` nor an explicit
`@NoAudit({ reason })` that a reviewer must approve. Coverage becomes a
checkable property instead of a hope. (Same family of idea as
ArchiveVault's schema-drift coverage monitor.)

---

## 3. Capture reliability: not losing the event, not inventing it

### 3.1 The dual-write problem

The business action commits to the service's database; the audit event goes
to another system. No shared transaction exists, so either the action
commits and the event is lost, or the event is recorded for an action that
rolled back. Naive fire-and-forget after commit loses events on every
crash window.

### 3.2 Local durable buffer (outbox for audit)

Events are written to a **durable local buffer** (an outbox table in the
service's own database, ideally in the *same transaction* as the business
change, or a fsynced on-disk journal for non-transactional actions) and a
background shipper sends batches to the collector. Delivery is
at-least-once; the collector dedupes on `(source_id, source_seq)` and
`event_id`. This is the transactional-outbox pattern from Dispatcher,
applied to audit, and it keeps the request path free of network calls to
the collector.

### 3.3 Fail-closed vs. fail-open, per sensitivity class

Is it acceptable to perform an action whose audit record cannot be
durably captured? It depends on the data:

| Class | Policy | Behavior |
|---|---|---|
| `CRITICAL` (PHI access, privilege grants, break-glass, money movement) | **Fail-closed, audit-before-act** | Write an `ATTEMPT` record to the durable buffer *before* acting; if the buffer is unavailable or full, **deny the action**. Follow with the outcome event. |
| `STANDARD` | Fail-open with loud accounting | Action proceeds; on buffer exhaustion, drop with a counted **gap record** (§3.4) |
| `LOW` | Sampled or coalesced (§12) | |

Fail-closed trades availability for assurance, deliberately and per class,
so it must be configured, not accidental. Audit-before-act also captures
the dangerous case where an action succeeds but the process dies before
the after-event: the `ATTEMPT` row proves it was initiated.

### 3.4 Gaps must be visible, never silent

Every source stamps events with a **per-source monotonic `source_seq`**.
The collector sees the numbers it received; a hole is *provable* evidence of
loss or deletion between that source and storage. When a source drops
events (buffer exhaustion), it emits a signed **gap record** with exact
counts on recovery, so loss is recorded, bounded and alarmed rather than
discovered by an auditor.

Silence is also a signal. Sources emit **heartbeat events** at a fixed
cadence even when idle, so "service stopped sending" (crash, network
partition, or an attacker silencing it) becomes detectable by absence,
exactly the "absence needs a timer" lesson from Foghorn's UNKNOWN state.

### 3.5 Two-phase acknowledgement: receipts as promises

An `INGESTED` acknowledgement is not integrity, since the collector could
still lose or alter the event before sealing. The collector returns a
**signed ingest receipt**: `{stream, pseq range, batch_hash, ingested_at,
seal_deadline}`, a promise that the batch will appear in a sealed block by
`seal_deadline` (the **maximum seal delay**). This is the Certificate
Transparency model (RFC 6962's signed promise and "maximum merge delay"):
receipts are evidence. A source keeps events until it holds proof of
inclusion in a sealed block (§7.3). A receipt for something absent from
the log after its deadline is signed proof the operator misbehaved.

---

## 4. Ingestion and ordering

**Collector.** Receives signed batches, verifies the batch signature and
that `source_seq` is contiguous with what that source sent before, assigns
`pseq`, computes hashes, inserts, and returns the receipt. Many collector
instances run concurrently.

**Why not rely on a database sequence for ordering.** Sequences are
non-transactional: values aren't rolled back (gaps), and, more subtly,
**sequence order is not commit order**. Transaction T1 draws 100, T2 draws
101, T2 commits first; a poller that has seen 101 and advances its cursor
past 100 will never read T1's event when it commits. Any sealer built on
"read everything above the last cursor" silently drops events. This is a
well-known outbox/CDC polling bug, and for an audit log, losing an event at
the integrity layer is unacceptable.

**Two sound options:**

1. **Per-stream counter row, locked once per batch** (chosen).
   `UPDATE streams SET next_pseq = next_pseq + $n ... RETURNING` takes a
   row lock held until commit, so `pseq` values are **gap-free and assigned
   in commit order**. Locking per *batch* (hundreds of events), not per
   event, keeps contention manageable; streams are sharded by (tenant,
   shard) to scale writes. This is the same lock-the-sequence-row
   discipline as Switchboard's message numbers.
2. **Snapshot-horizon sealing.** Record the inserting transaction ID and
   seal only events below `pg_snapshot_xmin(pg_current_snapshot())` (the
   oldest still-running transaction; PG 13+ names, verify), so no
   in-flight transaction can later commit into the sealed range. Higher
   write concurrency, harder to reason about; documented alternative.

**Idempotency:** `UNIQUE (source_id, source_seq)` and `UNIQUE (tenant_id,
event_id)`: a retried batch collapses into the original.

**Backpressure:** bounded collector concurrency, `429`/`Retry-After` with
jitter to sources (which keep buffering locally), so an ingest spike
degrades into delay, not loss.

**Time:** ordering authority is `pseq`. `occurred_at` is a claim;
`ingested_at` is the DB clock; seal time is the sealer's. Large skew between
claimed and ingest time is itself a flagged signal.

---

## 5. Sealing: blocks with Merkle roots, chained

### 5.1 Why blocks, not a per-event chain

A linear per-event chain (Cairn's per-asset shape) forces strictly serial
appends per chain and offers only "walk the whole chain" verification. For
a high-volume, multi-writer log, per-event chaining is both a throughput
bottleneck and a poor proof format. Batching events into **sealed blocks**
amortizes the cost: each block is one hash-chain link, and a **Merkle tree
inside the block** gives O(log n) inclusion proofs for any single event.

### 5.2 Construction

- **Leaf:** `SHA-256(0x00 ‖ event_hash)`. **Node:** `SHA-256(0x01 ‖ left ‖
  right)`. The distinct prefixes prevent second-preimage tricks (RFC 6962
  tree hashing).
- **Block hash** (fixed binary layout, length-prefixed, domain-tagged):
  `SHA-256("sigil/block/v1" ‖ stream_id ‖ block_no ‖ first_pseq ‖ last_pseq
  ‖ event_count ‖ merkle_root ‖ sealed_at ‖ key_id ‖ prev_block_hash)`.
  Genesis `prev_block_hash` is bound to the stream (not zeros), as in Cairn.
- Blocks are **signed** by the operator key (held in a secret store/KMS,
  never in the app database; VaultKeep's envelope pattern).
- A block seals contiguous `pseq` range `(last_sealed, n]`. Events never
  change after sealing, and **blocks never span a storage partition**: the
  sealer force-closes a block at each partition boundary (§9), so archive
  units are always whole blocks.

### 5.3 The sealer

Triggered every `S` seconds per stream (and on size). It is *not* a
correctness-critical singleton: `UNIQUE (stream_id, block_no)` plus a
check that `prev_block_hash` equals the actual head means two racing
sealers can't both succeed; the loser discards and retries. Running one
active sealer per stream (advisory-lock election, as in CronMesh) is an
efficiency optimization.

### 5.4 Anchoring: what makes it tamper-evident against the operator

Same mechanism as Cairn §8, not repeated in full: periodically build a
Merkle checkpoint over all stream heads (chained to the previous
checkpoint, signed) and deliver it to **witnesses** (customer, regulator,
secondary store). Without independently held copies, an owner of the
database can rewrite blocks and recompute. With them, any rewrite contradicts
a statement the operator signed. Archive buckets use **object lock**
(compliance retention mode; MinIO supports S3-style object lock, verify)
as a second, storage-level control.

### 5.5 The pending window, stated honestly

Between ingestion and sealing, an event is protected only by its receipt
(§3.5) and the database's append-only constraints. The window is bounded by
`S`, and the "maximum seal delay" is `S` + sealer lag. Choose `S` small
(seconds) for `CRITICAL`; larger is cheaper for `LOW`. Source self-audit
(§7.3) closes the loop even inside this window.

---

## 6. Attribution: signed batches

Per-event signatures are costly at volume and unnecessary: a source signs a
**batch**: `batch_hash = SHA-256(domain ‖ source_id ‖ first_source_seq ‖
last_source_seq ‖ count ‖ ordered claim_hashes)`. The signature simultaneously
proves *who sent it*, *exactly which contiguous sequence range*, and
*what content*, so completeness per source falls out of attribution.

- Keys are per-source with validity windows; a signature is valid if the
  key was valid at the collector's `ingested_at`.
- A signature proves a **source** made the claim, not that the claim is
  true. A compromised service can sign false events or stay silent.
  Defense against that is independent evidence (§8), not stronger
  cryptography.

---

## 7. Verification

| Layer | Check | Catches |
|---|---|---|
| 1 Structural (DB) | `pseq` contiguity, `UNIQUE(stream, block_no)`, append-only triggers, role separation | Forks, gaps, casual edits |
| 2 Cryptographic | Recompute event hashes, Merkle roots, block hashes, verify batch and block signatures | Altered content, swapped signatures |
| 3 Completeness | Per-source `source_seq` contiguity, gap records, heartbeat continuity, cross-source reconciliation | Dropped/suppressed events |
| 4 External | Compare heads with witness-held checkpoints; check receipts against sealed blocks | **Operator-level** rewrite and truncation |

### 7.1 The verifier is independent

A separate package with no database client and no shared code with the
writer. Input: events, keys, blocks, checkpoints. Output: verdict. It runs
continuously; a verifier that stops running is itself an alert (dead-man).

### 7.2 Proofs

An **inclusion proof** (event → Merkle path → block → signed head →
checkpoint) lets an auditor verify one event offline. Publish test vectors
for JCS, event hashes, leaves/nodes, block hashes.

### 7.3 Sources as witnesses

After a receipt's `seal_deadline`, each source requests inclusion proofs
for a sample (always the last event of each batch) and verifies against the
signed block head. Every service thereby audits the collector's handling of
*its own* data. A deleted-before-sealing event surfaces as an unproduceable
proof for a promised inclusion.

### 7.4 What a Merkle log cannot prove

It proves an event **is** in the log. It cannot, by itself, prove an event
**is not**, and it cannot prove a *filtered query result* is complete
("all admin logins in Q3") without exposing the surrounding data. Honest
consequences: (a) evidence exports use the **block** as the unit (the
auditor receives whole blocks for the period and filters locally against
the verified root); (b) completeness of filtered answers is established
through source sequences (§3.4) and reconciliation (§8), not Merkle
proofs. Sorted/indexed authenticated structures (sparse Merkle trees) could
provide non-inclusion proofs; explicitly out of scope for v1.

---

## 8. Cross-source reconciliation: catching suppression by the application

A compromised or buggy service can simply not report. Independent capture
points are the defense:

- **API gateway logs** (GateKeeper): every mutating request that returned
  2xx at the gateway should correspond to an application audit event with
  the same `request_id` within a window.
- **Database-level audit** (e.g., Postgres `pgaudit`, verify): schema changes
  and privileged statements, independent of application code.
- **Identity provider events** (logins), infrastructure/cloud audit logs.

A reconciler joins by correlation ID over a settle window and emits
**findings**: *gateway saw a write, application recorded nothing*. This is
the same discipline as every reconciliation job in this portfolio
(Dispatcher, LedgerLine, SearchCraft), applied to attackers instead of
bugs. An attacker must now defeat several independent layers at once. Each
independent source is itself a Sigil source with its own signed stream.

---

## 9. Tiered storage that stays verifiable

**Hot** (e.g., 90 days; many frameworks expect recent data immediately
available): Postgres, range-partitioned by `ingested_at` (daily). Keep few
indexes (audit is write-heavy and read-rare): typed columns for the common
filters and a composite for each hot access path (tenant+time, tenant+actor+time,
tenant+resource+time, correlation ID); BRIN on time for large partitions;
a GIN `jsonb_path_ops` index on the free-form body **only** where ad-hoc
containment queries justify the write amplification. Pagination is keyset
on `(ingested_at, stream_id, pseq)`, never `OFFSET`.

**Cold:** whole blocks exported as compressed NDJSON (or Parquet) objects
with a **manifest** `{stream, block range, object key, sha256, merkle_root,
event_count}`, written to object-locked storage.

**The rule that keeps it verifiable: verify-then-drop.**
1. Export the block range to cold storage.
2. **Re-read the object, recompute event hashes → Merkle root, and compare
   to the block's stored root** (not just a file checksum: a checksum
   proves the file is intact, the root proves it's the right events).
3. Only then may the partition be detached. The job refuses to drop
   anything unsealed, unarchived, unverified, under legal hold, or inside
   its retention period.

**The `blocks` table is tiny and kept forever**, in hot storage: one row
per block regardless of event volume. So the chain, signatures, and anchors
remain complete after event rows are gone, and an archived event is still
provable: fetch its cold object, recompute the path, check against the
retained block. Archiving never breaks the chain.

**Cold queries:** manifest pruning by time/stream, then scan; a restore job
re-materializes ranges into a scratch partition for ad-hoc search. State the
cost/latency honestly.

**Retention** is policy per sensitivity class and framework (illustratively:
PCI DSS expects ≥12 months with the latest 3 immediately available; HIPAA
documentation retention is commonly 6 years; verify yours). **Legal holds**
override expiry. **Deleting at end of retention is itself a privileged,
audited operation**: dual-control approval, emits meta-audit events, only
operates on archived+verified+expired ranges.

---

## 10. Access control, separation of duties, and who watches the watchers

- **Ingest credentials can write but never read**; **auditor credentials can
  read and verify but never write**; configuration, key management, and
  retention are separate roles. Separate DB roles, with `REVOKE UPDATE,
  DELETE, TRUNCATE` on event/block tables plus row triggers **and
  statement-level `BEFORE TRUNCATE` triggers** (row triggers don't fire on
  `TRUNCATE`; this is also a correction to the earlier append-only tables in
  this portfolio).
- **The people who administer the application must not be able to alter its
  audit trail**: different credentials, ideally different team/account.
- **Reading the audit log is an audited act.** Every query, export and
  verification is recorded in a separate `meta` stream (chained and
  anchored like any other). Audit data is among the most sensitive data
  the company holds.
- **Tenant isolation at the query level**, never post-filtered.
- **Evidence packages** for auditors: whole blocks for the period + keys +
  block signatures + checkpoint proofs + verifier output, signed, and
  logged as a meta event.

---

## 11. Privacy: the audit log must not become the largest PII store

- **Allowlist, not denylist.** Request bodies are not captured by default.
  Each resource type declares which fields may appear. A denylist ("strip
  `password`") fails the day someone adds `ssn_last4`.
- **Changes:** record `changed_fields` and, for allowlisted fields,
  before/after values; for sensitive fields record only a **keyed hash
  (HMAC)** so an auditor can confirm "this value changed" or match two
  records without values being exposed. An unkeyed hash of low-entropy data
  is reversible by dictionary.
- **Pseudonymous actors/subjects:** events reference opaque IDs; the
  mapping to real identity lives in a separate, access-controlled, erasable
  table.
- **Erasure vs. retention.** Audit logs are often retained under a legal
  obligation that can outweigh an erasure request, and what applies is a
  legal question. Engineering supports both outcomes: payloads off-chain
  behind salted commitments with per-subject keys (crypto-shredding,
  per ArchiveVault and Cairn §10), so identity-bearing detail can be
  destroyed while the chain and the commitment remain verifiable.
- **Encryption at rest and in transit**; keys per tenant (VaultKeep pattern).

---

## 12. Volume, latency and what must never be sampled

- **Latency budget:** the request path performs only a local durable write
  (fsynced journal or same-transaction outbox row), never a collector
  round trip. Measure and publish interceptor overhead; `CRITICAL`
  audit-before-act adds one local durable write by design.
- **Reads dominate volume.** Optional **coalescing** of identical
  `(actor, action, resource, outcome)` within a short window into one event
  with `count`, `first_at`, `last_at`, never applied to `CRITICAL`
  classes, and always recorded explicitly (a sampled log that doesn't say
  it's sampled is a lie).
- **Sampling is prohibited for sensitive classes.** Allowed only for `LOW`,
  with the rate recorded in the events.
- **Sizing:** `events/s × avg size × retention`; compute it for your
  numbers (typical events are a few hundred bytes to a few KB) and decide
  hot window and compression accordingly. Do not guess; measure.

---

## 13. Observability of the auditor

An audit system that silently degrades is worse than none, because people
believe it. Page-worthy: **seal lag over the maximum seal delay**, source
heartbeat missed, gap records, receipts past deadline without inclusion,
verifier failure or verifier stopped, witness delivery lag, archive
verification failure, reconciler findings, coverage-check failures in CI,
buffer fullness at sources, fail-closed denials (a spike means the audit
path is down and the product is refusing work). Monitor Sigil itself with
Foghorn heartbeats, and deliver alerts through Dispatcher.

---

## 14. How this fits the portfolio, and how it differs from Cairn

| | Cairn (Project 24) | Sigil (this) |
|---|---|---|
| Unit of chaining | Per-asset linear chain | Per-stream sealed blocks |
| Proof format | Walk the chain | Merkle inclusion proof |
| Writers | Parties, low volume per chain | Many services, high volume |
| Ordering | Head-row lock per asset | Per-stream counter locked per batch |
| Attribution | Per-event signature | Per-batch signature |
| Completeness | Asset state machine | Source sequences, heartbeats, reconciliation |
| Anchoring | Witnessed Merkle checkpoints | Same mechanism |

Migration path for earlier projects: each has its own append-only audit
table (VaultKeep, FlagForge, LedgerLine events). Dual-write into Sigil,
reconcile, then cut over. GateKeeper becomes an independent source (§8).

---

## 15. Out of scope / known limitations

- **A compromised source that owns every capture layer** can omit events
  undetectably; defenses reduce, not eliminate (§0).
- **Non-inclusion proofs** and provably complete filtered queries (§7.4).
- **Real-time SIEM correlation/detection**; Sigil is the system of record,
  not the analytics engine. Export hooks are the integration point.
- **Legal sufficiency** for any specific framework.
- **Sharded multi-region collectors** and cross-region ordering.
- **Capturing application-internal state changes that bypass the annotated
  paths** (raw SQL scripts, out-of-band tooling): covered only by DB-level
  audit as an independent source.