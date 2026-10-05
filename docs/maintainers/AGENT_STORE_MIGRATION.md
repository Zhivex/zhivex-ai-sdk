# Agent store identity upgrade

The agent stores use canonical keys that distinguish the complete run ID, tenant,
user and namespace. An omitted user or namespace differs from a literal `*` or
`default`. Journal IDs encode run ID and tool-call ID as separate components.

## Existing run stores

Stop all workers sharing the store before upgrading them together. Older SDK
workers cannot resolve the new canonical keys or the upgraded file-store locks.
Keep a backup of the complete store, including journals, indices, leases and
incremental SQLite history.

File, SQLite and PostgreSQL stores continue to read existing runs after verifying
that the stored run ID and scope match the requested identity exactly. Verified
runs retain their existing physical key for writes, leases and history; no bulk
rewrite or deletion occurs. New runs use canonical keys. Legacy idempotency and
parent indices are read only after checking the stored state's identity.

If a legacy identity occupies another identity's canonical key, the operation
raises a conflict instead of overwriting it. Resolve this offline using a complete
store export: move the identified run and all its indices, journal entries,
leases and incremental history consistently, or import the complete verified
run into a separate store. Do not edit the JSON run ID or scope merely to bypass
verification. Journal entries with missing or conflicting identity metadata must
be reconciled before resuming side-effecting tools; they are not treated as absent
operations that can be executed again.

## Existing memory stores

Persistent agent memory now stores messages in an envelope containing its
canonical identity. Legacy memory arrays do not include a verifiable owner.
The default stores therefore reject legacy memory on both load and save instead
of guessing the scope or discarding existing messages. A literal `*` user cannot
read the omitted user's legacy memory through an alias.

To migrate memory:

1. Stop workers and back up the source. Establish the owner of each legacy key from
   trusted application records. If ownership is ambiguous, keep the record
   quarantined until it can be resolved.
2. Read the verified source using the memory store's explicit `key` callback,
   selecting that exact legacy key. Explicit custom keys remain application-owned
   and retain their existing serialization; do not expose this migration reader
   to agents or untrusted scope selection.
3. Write into a **new directory or table** using the default key function and the
   verified `runId`, `agentId` and `scope`. Use `selectMessages: state =>
   state.messages` during migration to preserve the complete selected message
   array; the usual default retains only the final assistant message.
4. Reload each migrated record under its intended identity and verify its message
   array. Verify that other scopes cannot load it, then switch workers to the new
   store. Retain the backup according to the application's retention policy.

Custom `key` callbacks continue to define their own isolation contract. Applications
using them must ensure that distinct users and namespaces cannot select the same
key unless sharing is intentional.

## Existing pagination cursors

New run-list cursors include the scoped identity as a third component, so aggregate
lists can page through different scopes that reuse a run ID and timestamp. Legacy
two-component cursors remain accepted with their original boundary semantics.
They cannot recover scope ties that the old cursor never recorded; restart an
aggregate listing without a cursor to enumerate those tied records completely.

## PostgreSQL listing and retention

PostgreSQL applies scope, status, time, cursor and page-size constraints before
returning run states. It transfers at most the requested limit plus one matching
state for cursor construction. Retention uses the same bounded selection. Scope
matching uses tenant, user and namespace fields, including legacy rows, rather
than relying on physical key prefixes. Additional scope properties do not change
the identity contract.

Store initialization adds indexes for logical timestamps and scope-filtered
pagination with `CREATE INDEX IF NOT EXISTS`; existing rows and keys are unchanged.
The scope index stores fixed-size hashes so long scope identifiers fit within
PostgreSQL index limits; exact field comparisons remain in the query.
Index creation can block writes while the indexes are built, so initialize the upgraded
store during the application's usual database maintenance window when necessary.
