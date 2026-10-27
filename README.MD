# Sigil

A centralized, tamper-evident audit logging service in NestJS and
PostgreSQL. Project 27 of a 15-week backend roadmap. The problem it
addresses is SOC 2 / HIPAA-style evidence: every sensitive action across
every service is recorded, queryable years later, and demonstrably
unaltered.

The common mistake is treating that as a hashing problem. Hashing is the
easy half. The hard half is **completeness**: proving the events that
mattered were captured and weren't suppressed on the way in. Sigil is
built around that (design in `docs/ARCHITECTURE.md`):

1. **Capture that doesn't miss the denials.** In NestJS, guards run before
   interceptors, so an interceptor-only audit library can't see rejected
   requests, the events auditors care about most. Sigil's NestJS package
   covers denials explicitly and fails the build when a route is
   unannotated.
2. **Reliable capture.** Durable local buffers, per-source sequence
   numbers and heartbeats so loss is provable, fail-closed
   audit-before-act for critical actions, and signed **ingest receipts**
   (Certificate Transparency-style promises) that sources verify.
3. **Sealed Merkle blocks, chained and anchored.** A multi-writer,
   high-volume shape (not Cairn's per-asset chain), with offline-
   verifiable inclusion proofs and witnessed checkpoints for protection
   against the operator.
4. **Cross-source reconciliation.** Gateway logs and database audit as
   independent witnesses that catch an application that stays silent.
5. **Tiered storage that stays verifiable.** Verify-then-drop archiving
   against the Merkle root, with a permanent block chain, object-locked
   cold storage, legal holds and audited retention deletion.
6. **Privacy by construction.** Allowlisted fields, keyed hashes for
   sensitive values, and erasable off-chain payloads.

It also states what it cannot prove: events that were never reported by a
fully compromised service, and non-inclusion.

Stack: NestJS, PostgreSQL, MinIO, Docker. Reuses Dispatcher (alerts),
GateKeeper (independent capture), Foghorn (monitoring), VaultKeep
(keys), ArchiveVault (erasure) and Cairn's anchoring design.

Documentation-first; see `docs/CURSOR_CONTEXT.md` for the build plan.
Engineering design only, not compliance or legal advice.

MIT licensed.