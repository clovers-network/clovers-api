# What CI can and cannot check

## Runs on every push

| Job | What it proves |
|---|---|
| `build` | compiles, lints, and **installs without dev dependencies** — the thing that silently broke while `babel-runtime` was in the wrong section |
| `writes` | 31 mutation checks against a real RethinkDB 2.4 service container, plus a writer and reader on separate connections |
| `endpoints` | query plans and N+1 counts; all six authenticated write paths over real HTTP with real signatures; impersonation rejected; realtime events confirmed arriving at a connected client |
| `image` | the container builds and serves against a mounted volume |

## Deliberately not in CI

`parity.mjs`, `endpoint-parity.mjs` and `http-parity.mjs` compare against
**the live production API**. They were built to answer "does the port match what
is running", and they answered it: 38, 155 and 40 checks. They cannot run on a
schedule, for two reasons. They need production to be up and the local database
to be a current copy of it — and once production *is* the ported code, they
compare it with itself.

Run them by hand before a cutover, never after.

## Two things that are not constants

**Query plans depend on table size.** SQLite scans a small table because
scanning it really is cheaper. The fixture is 13 MB and production is 371 MB, so
the planner legitimately differs — CI passes `--max-scans=2 --max-sorts=2` while
the script's defaults are production's `1` and `1`. The N+1 threshold is
different in kind: 24 user lookups for a page of 24 rows is structural, and the
same number holds at any size.

**The fixture is not "some rows".** `make-fixture.mjs` reproduces the shapes
that caused bugs — burned clovers that are symmetrical and priced, prices stored
as a bare `'0'`, `foundBy` holding a whole user document, album logs with
`board: false`, two orders sharing a log coordinate, a clover whose owner has no
users row. If it were random data the regression tests would have nothing to
catch.
