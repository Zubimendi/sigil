# Sigil

[![Node](https://img.shields.io/badge/Node-20%2B-339933.svg)](https://nodejs.org/)
[![NestJS](https://img.shields.io/badge/NestJS-10-ED2945.svg)](https://nestjs.com/)
[![PostgreSQL](https://img.shields.io/badge/PostgreSQL-16-336791.svg)](https://www.postgresql.org/)
[![MinIO](https://img.shields.io/badge/MinIO-Object%20Storage-C7D2FE.svg)](https://min.io/)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
[![Status](https://img.shields.io/badge/Status-Architecture%20%26%20Spec%20First-8B5CF6.svg)]()

A tamper-evident audit logging service for NestJS, PostgreSQL, and MinIO. Project 27 of a 15-week backend roadmap.

The problem behind most audit systems is not hashing; it is completeness. An audit log that verifies perfectly is still useless if it never saw the denied request, the buffered failure, the silent source, or the missing event. Sigil is built around that gap.

---

## Architectural Core: The Three Pillars

Sigil is designed around three principles documented in `docs/ARCHITECTURE.MD`.

### 1. Capture Must Not Miss the Denials

In NestJS, guards run before interceptors. An interceptor-only audit library records what reaches the handler, but it silently misses the 401 and 403s that matter most in an audit trail.

The design therefore includes:

- `@sigil/nest` guard wrappers that capture denies explicitly
- audit filter and interceptor paths for success, failure, and exception outcomes
- route coverage checks in CI so unannotated mutating routes fail the build
- explicit `@NoAudit({ reason })` approval for routes intentionally excluded

### 2. Reliable Capture Must Make Absence Visible

A log is not evidence unless it can prove what was lost.

- durable local buffer and outbox pattern for at-least-once shipping
- per-source monotonic `source_seq` counters and heartbeat events
- exact gap records when a source drops messages or stalls
- signed ingest receipts that act like CT-style inclusion promises
- fail-closed behavior for `CRITICAL` actions and fail-open accounting for less sensitive work

### 3. The Log Must Stay Verifiable Long After It Is Written

Hashing a row is easy. Proving the whole history stayed intact is harder, and that is the job of Sigil's block chain and archive model.

- append-only `events` and `blocks` tables
- RFC 6962-style Merkle roots and inclusion proofs
- per-stream chained block hashes and signed witnesses
- verify-then-drop archiving against the cold copy
- object lock, legal holds, dual-control retention deletion, and meta events for all reads and exports

---

## Additional Systems

- **Cross-source reconciliation:** compare application events with gateway and DB-side capture points to detect suppression.
- **Source self-audit:** verify receipt inclusion after the seal deadline and report a missed promise.
- **Privacy by construction:** allowlisted fields, keyed HMACs for sensitive values, and erasable off-chain payloads.
- **Dispatcher integration:** alerts for seal lag, heartbeat silence, verifier stoppage, and archive verification failures.
- **Role separation:** tenant-scoped storage, collector cannot read the source credential, auditor cannot write, and all query/export/verify actions emit meta-audit events.

---

## System Architecture

```text
 service A (NestJS)         service B             API gateway / DB-level audit
 ┌─────────────────┐       ┌───────────┐          (independent capture points)
 │ @sigil/nest      │       │           │                  │
 │ guard wrapper +   │       │           │                  │
 │ filter +          │       │           │                  │
 │ interceptor       │       │           │                  │
 │  ↓                │       │           │                  │
 │ durable local     │       │           │                  │
 │ buffer (WAL)     │       │           │                  │
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

## Project Structure

```text
sigil/
├── README.MD
├── docker-compose.yml          # Postgres + MinIO + gateway stub source
├── package.json                # workspace metadata for NestJS packages
├── apps/
│   ├── collector/              # ingest + query API
│   ├── sealer/                 # sealing worker
│   └── demo/                   # demo services to audit
├── packages/
│   ├── nest/                   # @sigil/nest: interceptor, guard, filter, audit decorators
│   └── verifier/              # independent verification package
├── docs/
│   ├── ARCHITECTURE.MD         # governing design and threat model
│   ├── CURSOR_CONTEXT.MD       # implementation sequence, tests, and decision log
│   ├── STORY.MD                # narrative and post-ready writing notes
│   └── sigil.postman_collection.json
├── migrations/                 # hand-written SQL schema and append-only protections
├── scripts/                    # CI route registry and verification tooling
└── .github/                    # GitHub Actions and coverage checks
```

---

## Getting Started

### 1. Start infrastructure

```bash
docker compose up -d
```

This brings up PostgreSQL, MinIO, and the gateway log stub defined in the project plan.

### 2. Install dependencies

```bash
npm install
```

### 3. Run the collector

```bash
npm run start:collector
```

### 4. Run the sealer worker

```bash
npm run start:sealer
```

### 5. Run the verifier job

```bash
npm run start:verifier
```

The project is intentionally documentation-first at this stage; the implementation work follows the exact build order in `docs/CURSOR_CONTEXT.MD`.

---

## API Capabilities

| Method | Path | Purpose |
|---|---|---|
| `GET` | `/health` | service liveness |
| `POST` | `/api/v1/tenants` | create tenant |
| `POST` | `/api/v1/sources` | register a source and key |
| `POST` | `/api/v1/events` | ingest signed batch or event payload |
| `GET` | `/api/v1/events` | query events with tenant scoping |
| `GET` | `/api/v1/blocks/{streamId}` | fetch sealed block evidence |
| `POST` | `/api/v1/verify/inclusion` | verify inclusion proof |
| `POST` | `/api/v1/archive` | export and lock cold archive |
| `POST` | `/api/v1/retention/approve` | dual-control retention approval |
| `GET` | `/api/v1/reconciliation/findings` | list cross-source reconciliation findings |

---

## Test Strategy

The repository is built to prove the architectural claims with concrete failing tests before implementation is considered complete. The design sequence in `docs/CURSOR_CONTEXT.MD` is the test target and the implementation order.

| Test family | Claim |
|---|---|
| Lifecycle gap | guard denials produce `DENIED` events; interceptor-only audit misses them |
| Coverage | mutating routes without `@Audit` fail CI |
| Outcome semantics | success/failure/exception/client-abort/SSE cases each yield one correct event |
| Context propagation | one trace flows across services over RPC and WS |
| Buffer durability | no event is lost across crashes and restarts |
| Sequence vs commit order | collector assigns `pseq` in commit order with no gaps under concurrency |
| Merkle proofing | inclusion proofs verify and fail on tampering |
| Sealer race safety | exactly one block per number and crash-safe recovery |
| Reconciliation | gateway events without app events produce findings |
| Tiering | verify-then-drop rejects corrupted or expired archives |
| Privacy and append-only | ERASURE and trigger protections are enforced |

---

## Postman Collection

A starter Postman collection covering the core API flow is included here:

```text
docs/sigil.postman_collection.json
```

Import it into Postman, or run via Newman:

```bash
newman run docs/sigil.postman_collection.json \
  --env-var "baseUrl=http://localhost:3000" \
  --env-var "authToken=dev-token"
```

---

## Design Decisions (Settled — Don't Relitigate)

1. **Guard denials are explicit.** An interceptor alone is insufficient.
2. **Durable local buffer, never a request-path network call.**
3. **Per-source monotonic sequences and heartbeats make silence visible.**
4. **`pseq` is assigned by a locked counter row per batch; never trust DB sequence order.**
5. **Sealed Merkle blocks are chained, signed, and witnessed.**
6. **Source signatures prove origin, not truth.**
7. **Verifier is independent from the writer.**
8. **Cross-source reconciliation is required, not optional.**
9. **Verify-then-drop keeps the block table forever.**
10. **Evidence export is block-based; filtered queries are not complete by Merkle alone.**

---

## Known Limitations & Out of Scope

- full app implementation is not yet built out in this workspace
- no multi-tenant production deployment yet
- no hardware-backed KMS or enterprise key vault integration
- no compliance-specific retention policy automation beyond the design language
- no algorithmic benchmarking for large-batch sealing and archive verification yet

---

## License

MIT licensed. Engineering design and architecture only, not legal or compliance advice.
