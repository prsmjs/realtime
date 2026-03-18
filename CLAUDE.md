# @prsm/realtime

distributed websocket framework built on redis. commands, channels, records, presence, collections, rooms, persistence.

## structure

```
src/
  index.js        - server exports
  shared/         - internal shared utilities (CodeError, Logger, Status, etc)
  server/         - RealtimeServer, managers, connection, context
  client/         - RealtimeClient, connection, reconnection, subscription modules
  adapters/       - persistence adapters (sqlite, postgres) via subpath exports
  devtools/       - state inspector (express router + vue client)
tests/            - vitest integration tests (requires redis running)
```

## subpath exports

```js
import { RealtimeServer } from "@prsm/realtime"
import { RealtimeClient } from "@prsm/realtime/client"
import { createSqliteAdapter } from "@prsm/realtime/sqlite"
import { createPostgresAdapter } from "@prsm/realtime/postgres"
import { createDevtools } from "@prsm/realtime/devtools"
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

## testing

tests use vitest with `pool: "forks"` and `singleFork: true` (sequential execution, shared redis). each test file flushes its redis DB in beforeEach. all tests are client-server integration tests.

## publishing

```
npm publish --access public
```
