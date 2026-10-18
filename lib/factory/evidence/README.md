# Caveat private evidence: isolated collector candidate

Owner: dotagents collector (Dorothy). This directory contains pure validation and metadata transitions. It is not imported by the public scan, command, scheduler, reporter or update entry points. It does not open a channel, write raw data, start a worker, discover capabilities, or enable collection.

The product owns the contract and its schemas. The three injected schemas and synthetic fixture used by the tests come from Caveat; their fixed source and hashes are in [fixture provenance](../../../tests/fixtures/caveat-private-evidence/provenance.json). These copies are test inputs, not a factory-owned replacement for product distribution or discovery. The product archive advertises no transports.

## Modules

- `strict-json.mjs` rejects duplicate keys, malformed UTF-8, comments, trailing commas and over-budget private input.
- `private-contract.mjs` consumes product schemas, validates synthetic capability/request/frame/public-byte/peer relationships, and projects fixed local statuses. `simulateEvidenceCollection` is a test seam: OFF calls only the normal callback. Its OS and worker snapshots represent assertions that a future verified adapter must establish; they are not native proofs.
- `report-binding.mjs` hashes supplied final v9 bytes including newlines. Prepared and finalized records are separate and immutable. Only the toolchain `last_update` projection may differ. Missing or conflicting parents remain unbound. Delivery outcomes attach to an individual finalized report body, not an aggregate send count.
- `retention.mjs` reserves capacity before capture and retains charges for partial records and deletion tombstones. Unknown ownership or liveness prevents cleanup. Reclaiming an abandoned reservation requires a verified dead process identity after 24 hours. Deletion acknowledgement is a separate transition.

## Validation

Install the lock with `npm ci --ignore-scripts`. Focused entry:

```sh
node --test tests/factory-scan/caveat-evidence-contract.test.mjs tests/factory-scan/caveat-evidence-state.test.mjs
```

The external review harness supplies isolated HOME/PATH and refuses subprocesses, network, real workers and filesystem writes in the test processes. The existing v9 scan is exercised only with a fake command runner. Public check, exit and delivery values are preserved across the synthetic seam, including private refusal and exceptions.

These tests do not establish real CLI OFF acceptance, a nonblocking native worker, safe POSIX handles or Windows DACL/pipe identity, secure raw writes, installed package availability, or any of the three OS by four harness real-use combinations. Before runtime integration, these need separate implementation, fault tests and the normal repository CI gates. No integration or release date is implied by this candidate.
