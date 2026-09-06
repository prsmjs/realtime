# @prsm/realtime

distributed websocket framework built on redis. commands, channels, records, presence, collections, rooms, persistence. devtools moved to separate package (prsm-devtools).

## structure

```
src/
  index.js        - server exports
  shared/         - internal shared utilities (CodeError, Logger, Status, etc)
  server/         - RealtimeServer, managers, connection, context
  client/         - RealtimeClient, connection, reconnection, subscription modules
  vue/            - optional Vue layer (composables + renderless components), exported via /vue subpath
  adapters/       - persistence adapters (sqlite, postgres) via subpath exports
tests/            - vitest integration tests (requires redis running)
```

the vue layer wraps the imperative client. one composable per subscription primitive (useRoom, useRecord, useChannel, useCollection, usePresence) plus useConnection and useConnectionMetadata, each with an optional renderless component. they subscribe on mount and tear down on unmount.

## subpath exports

```js
import { RealtimeServer } from "@prsm/realtime"
import { RealtimeClient } from "@prsm/realtime/client"
import { createSqliteAdapter } from "@prsm/realtime/sqlite"
import { createPostgresAdapter } from "@prsm/realtime/postgres"
```

## dev

```
make up        # start redis + postgres via docker compose
make test      # run tests
make down      # stop containers
```

redis must be running on localhost:6379 for tests.

## key decisions

- plain javascript, ESM, no build step. package ships raw .js files
- persistence adapters are subpath exports, not bundled. sqlite3/pg are optional peer deps
- record deletion flushes through persistence. `deleteRecord` fires `onRecordRemoved`, which calls `persistenceManager.handleRecordRemoved`, buffered alongside writes and flushed via `adapter.removeRecords(ids)` (custom hooks use the optional `remove` hook). adapters MUST implement `removeRecords` or deleted records get resurrected by `restorePersistedRecords` on the next restart. within a flush window the last write/delete for a record id wins (each supersedes the other's buffer entry)
- server uses composition (owns a WebSocketServer) not inheritance
- `listen(port)` or `attach(httpServer)` handles all initialization in one call
- MessageStream is per-server instance, not a singleton
- connection IDs are crypto.randomUUID()
- writeChannel auto-stringifies non-string values
- the redis sub client is created with enableReadyCheck:false. ioredis runs a ready check (INFO) on reconnect, which a subscriber-mode connection rejects with "Connection in subscriber mode" - an unhandled rejection that crashes under load. only the sub client needs this; pub client keeps the ready check. pub and sub clients also get their own error handlers (only the main client had one). this surfaced as a CI-only flake in multi-instance.test.js that never reproduced locally
- collection diff processing is serialized per collection (`collectionProcessingChain` in pubsub.js). resolvers can await (DB-backed guards, redis scans), so two overlapping `_processCollectionUpdates` runs would read the same version and emit duplicate version numbers, desyncing every subscriber. do not call `_runCollectionUpdate` directly - go through `_processCollectionUpdates`
- a collection member's identity is `entry.id` (the full record key the resolver injects via `listRecordsMatching`), NOT the stored record value's own `id`. record values often don't carry that key (e.g. they store a bare `docId`). when a member record updates, the server re-broadcasts `rt/record-update` with the raw value, and `records.js handleUpdate` turns it into a `changed` collection diff - it MUST stamp `id: recordId` onto the record, and consumers (`useCollection`) must key stored items by `entry.id`. if the raw value (no id) replaces the item, a later `removed` diff can't match it and the item is stranded until the collection re-resolves (page refresh). this only bites records whose value lacks the injected id, which is why it hid behind tests that stored records with an `id` field
- collection desync recovery must converge: when the client detects a version gap it resubscribes and replays a fresh snapshot tagged `reset: true`. `useCollection` (and any consumer) must REPLACE its items on a reset, not merge. a merge strands records that were removed during the gap (they're absent from the snapshot but never explicitly removed), so a deleted item lingers until remount. this is why a delete could "stay in the list until refresh"
- the vue layer observes the client, it never drives the connection. useConnection/RealtimeStatus only read client.status and connection events - the client connects and reconnects on its own. do not add connect/reconnect calls to the vue layer. the component is named RealtimeStatus (not RealtimeConnection) precisely so nobody mistakes it for the thing that opens the connection
- useConnection has a `grace` window (ms, default 0): isStable stays true for that long after a drop so gated UI doesn't unmount on a brief blip. the window opens from the first drop and a reconnect inside it cancels the timer. grace logic is timer-based and tested deterministically with fake timers + a fake client (tests/integration/connection.test.js)
- useConnectionMetadata treats the local ref as source of truth: set() writes through and the value is re-pushed on reconnect, since a reconnect gets a fresh server-side connection
- vue layer tests: connection.test.js is pure unit (fake client, no infra), vue.test.js is live client-server (needs redis)

## transaction invariants

- `record-store.js` is shared by transactions and ordinary record mutations. global locks exclude all record writers; explicit record sets permit disjoint work. acquisition is atomic, leases renew, and commit verifies ownership plus every read snapshot before mutations
- JSON values remain opaque strings in Lua. merging and patch generation happen in JavaScript before commit; do not decode and re-encode record values with Redis cjson (empty arrays and precise numbers change)
- transaction contexts close when callbacks finish. explicit records must include every accessed ID; nested transactions and ordinary writes inside callbacks reject. server staging is last-operation-wins; duplicate IDs in client batches reject
- Redis storage commits are separate from subscriber notifications and buffered persistence. all writers must run the same lock protocol; direct Redis writes and older servers bypass it
- `tests/integration/transaction-regressions.test.js` covers rollback, contention across instances, ordinary writer exclusion, lease renewal/loss, JSON fidelity, context lifetime, and storage validation

## testing

tests use vitest with `pool: "forks"` and `singleFork: true` (sequential execution, shared redis). each test file flushes its redis DB in beforeEach. all tests are client-server integration tests.

## publishing

publishing runs through `.github/workflows/publish.yml` on version tags (for example `realtime@1.8.0`), never through a local publish command. the workflow uses npm trusted publishing with node 24, current npm, and `id-token: write`; no `NPM_TOKEN` is used. package.json repository.url must match `prsmjs/realtime` for provenance verification. npm's trusted publisher must name owner `prsmjs`, repository `realtime`, and workflow `publish.yml` (no environment). verify that configuration before tagging a release.
