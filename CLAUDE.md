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
- server uses composition (owns a WebSocketServer) not inheritance
- `listen(port)` or `attach(httpServer)` handles all initialization in one call
- MessageStream is per-server instance, not a singleton
- connection IDs are crypto.randomUUID()
- writeChannel auto-stringifies non-string values
- the vue layer observes the client, it never drives the connection. useConnection/RealtimeStatus only read client.status and connection events - the client connects and reconnects on its own. do not add connect/reconnect calls to the vue layer. the component is named RealtimeStatus (not RealtimeConnection) precisely so nobody mistakes it for the thing that opens the connection
- useConnection has a `grace` window (ms, default 0): isStable stays true for that long after a drop so gated UI doesn't unmount on a brief blip. the window opens from the first drop and a reconnect inside it cancels the timer. grace logic is timer-based and tested deterministically with fake timers + a fake client (tests/integration/connection.test.js)
- useConnectionMetadata treats the local ref as source of truth: set() writes through and the value is re-pushed on reconnect, since a reconnect gets a fresh server-side connection
- vue layer tests: connection.test.js is pure unit (fake client, no infra), vue.test.js is live client-server (needs redis)

## testing

tests use vitest with `pool: "forks"` and `singleFork: true` (sequential execution, shared redis). each test file flushes its redis DB in beforeEach. all tests are client-server integration tests.

## publishing

```
npm publish --access public
```
