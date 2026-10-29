# Title: Your Audit Log Never Saw the Break-In Attempt — Guards Run Before Interceptors

## Short version (LinkedIn)
Project 27: Sigil, a tamper-evident audit logging service for NestJS.
The thing that surprised me, and that most audit libraries get wrong:

NestJS runs guards before interceptors. A request a guard rejects never
reaches an interceptor. So the typical audit approach, one global
interceptor that logs everything, silently misses every 401 and 403. The
log is full of failures and contains no record of who was refused. Those
are the events an auditor most wants.

Three more lessons from building it:
1. Tamper-evidence is the easy half. A hash chain proves what's in the
   log hasn't changed. It can't tell you what never made it in. The hard
   part is completeness: per-source sequence numbers so loss is provable,
   heartbeats so silence is visible, signed receipts so the collector's
   promises are checkable, and a reconciler that compares the app's log
   against the API gateway's.
2. You can't trust a database sequence for ordering. Sequence order isn't
   commit order, so a poller can skip an event forever.
3. Archiving can break your proof. I only drop a partition after
   recomputing the Merkle root from the archived copy.

Repo: <your-fork-url>

## Conclusion
Audit logging is usually sold as an integrity problem, "make it
tamper-proof," and the cryptography for that is well understood and fairly
quick to build. What actually fails in practice is upstream: the endpoint
nobody annotated, the denial that bypassed the interceptor, the event
buffered on a crashed host, the service that quietly stopped reporting.
Each of those produces a log that verifies perfectly and is wrong about the
world. The craft here is making absence visible: sequence numbers that turn
loss into evidence, heartbeats that turn silence into a signal, receipts
that turn a promise into something checkable, and independent capture
points that make suppression expensive. That reframing, from "is the log
intact?" to "can the log tell me when it's incomplete?", is what separates
compliance theater from evidence.

## Medium tags
#AuditLogging #NestJS #PostgreSQL #SecurityEngineering #SystemDesign #SoftwareArchitecture #Cybersecurity #DevSecOps #DistributedSystems #Observability

## LinkedIn tags
#SoftwareEngineering #Security #SystemDesign #AuditTrail #NestJS #PostgreSQL #DataIntegrity #Cybersecurity #DeveloperExperience #Observability #Compliance

## Interview talking points
1. Open with the lifecycle gap (guards before interceptors) and the fix;
   it's concrete, checkable, and unusual.
2. Separate integrity, completeness, attribution and availability, and
   say which mechanism provides which.
3. Explain per-source sequences + heartbeats + receipts as "making absence
   visible," with the CT analogy (signed promise of inclusion).
4. The sequence-vs-commit-order bug and the per-batch locked counter.
5. Why blocks + Merkle (volume, proofs) instead of Cairn's per-asset chain.
6. Verify-then-drop, and why the block table is kept forever.
7. Cross-source reconciliation against the gateway: the defense against a
   compromised application.
8. Volunteer the limits: non-inclusion proofs, and a fully compromised
   source, before being asked.
9. Fail-closed audit-before-act for critical actions: the availability
   tradeoff, chosen per class.