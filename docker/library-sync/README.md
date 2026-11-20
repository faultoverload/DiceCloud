# Library sync

DiceCloud has no export for libraries. This is a small container that copies the community
libraries from [dicecloud.com](https://dicecloud.com/community-libraries) into the database
of a self-hosted DiceCloud, and keeps them up to date. It runs next to the app as a sidecar
and is configured with one file.

- Reads from dicecloud.com the way the web client does (DDP over a websocket). It never writes there.
- Writes straight into the self-hosted MongoDB: `libraries`, `libraryNodes` and
  `libraryCollections`, plus one small document of its own in `librarySyncState`.
- Never touches users, characters, or libraries made on your own server.

Image: `ghcr.io/faultoverload/dicecloud-library-sync`, built by
`.github/workflows/library-sync-image.yml`.

## Setting it up

1. **A dicecloud.com account.** Libraries are only visible to logged-in users. The account
   needs no special access to read public libraries.

2. **A config file.** Copy [`config.example.yml`](config.example.yml) to `config.yml` and fill in:

   ```yaml
   source:
     username: your-dicecloud-username
     password: your-dicecloud-password
   target:
     mongo_url: mongodb://meteor:password@dicecloud-db:27017/meteor?authSource=admin
   libraries: all
   schedule:
     interval: 7d
   ```

   The file holds a password. Keep it out of git. The container runs as uid 1000 and has to
   be able to read it.

3. **The sidecar**, in the same compose file as the app and its database:

   ```yaml
   services:
     dicecloud-library-sync:
       image: ghcr.io/faultoverload/dicecloud-library-sync:latest
       restart: unless-stopped
       depends_on:
         - dicecloud-db
       volumes:
         - ./library-sync/config.yml:/config/config.yml:ro
   ```

   It needs to reach the database (same network as `dicecloud-db`) and dicecloud.com
   (outbound HTTPS). It listens on nothing.

4. **Start it.** The first sync starts straight away. The log has one line per library and
   a summary at the end:

   ```
   done: 3 libraries selected, 2 new, 1 updated, 0 unchanged, 0 not viewable, 0 failed; nodes +2636 ~1 -1; collections 0 new, 0 updated; 15s, 27 requests to the source
   ```

   `libraries: all` was about 410 libraries and 290,000 nodes in November 2026. Expect that
   to take a quarter of an hour or more.

5. **Make the libraries visible to your users.** Copying a library does not subscribe anyone to it.
   - Users can subscribe themselves from the Community Libraries page of your instance.
   - New users can be subscribed automatically, with two variables in the app's
     environment: `DEFAULT_LIBRARY_COLLECTIONS` takes collection ids and `DEFAULT_LIBRARIES`
     takes library ids, both comma separated. A collection id in `DEFAULT_LIBRARIES` is
     ignored without an error.

To try it without changing anything, add `--dry-run` (or `dry_run: true`): it fetches,
compares, and reports what it would write.

## Choosing what to copy

`libraries: all` copies everything on the community libraries page, plus every library that
a collection on that page lists. Most libraries are only reachable through a collection, so
this is more than twice what the page shows.

A list copies exactly what it names. The id is the last part of a page's address, and a
whole link works too. A collection brings all of its libraries:

```yaml
libraries:
  - jp6xTaHDZK4ELYzvN                                  # collection: Libraries of Vexus (5e2014)
  - https://dicecloud.com/library/hAQmc87ty6DbWwZ42    # library: DiceCloud 5th Edition SRD
```

Libraries often refer to nodes in other libraries. If you list single libraries, a
reference to something you did not copy cannot be resolved when it is added to a sheet.

## Updates

Every run fetches each selected library again and makes the local copy match:

- nodes that are new at the source are added, changed ones replaced, deleted ones deleted
- a library or collection that is new to the selection is copied
- documents that are already identical are not written at all, so a run with nothing new
  changes nothing

Things an update deliberately does not do:

- **It never deletes a library.** One that was deleted or made private at the source, or
  that left the selection, keeps its last copy. The summary lists the ones it could not view.
- **It does not change characters.** Properties already copied onto a sheet stay as they
  were; they update when re-added from the library.
- **It keeps your subscriber counts.** A library that already exists locally keeps its own count.

`schedule.interval` (`12h`, `7d`, `2w`; minimum `1h`) keeps the container running and syncs
again each interval. The time of the last attempt is stored in the database, so restarting
the container does not start another sync early. Changing the config file does: the next
start syncs at once.

Without an interval the container syncs once and exits: 0 when it worked, 1 when it did not.
`--once` does the same whatever the config says, which is how to force a sync now:

```bash
docker compose run --rm dicecloud-library-sync --config /config/config.yml --once
```

## Configuration reference

| Key | Default | Meaning |
| --- | --- | --- |
| `source.username`, `source.password` | required | The dicecloud.com account. An email address works as the username. |
| `source.url` | `wss://dicecloud.com/websocket` | The server to copy from. |
| `source.throttle_ms` | `400` | Pause between requests. Minimum 250; the server allows 50 subscriptions per 10 seconds. |
| `target.mongo_url` | required | The self-hosted database, as in the app's `MONGO_URL`. |
| `libraries` | required | `all`, or a list of library and collection ids or links. |
| `schedule.interval` | none | Sync again this often. Without it, sync once and exit. |
| `dry_run` | `false` | Report what would change, write nothing. |

Environment variables win over the file: `DICECLOUD_USERNAME`, `DICECLOUD_PASSWORD`,
`DICECLOUD_URL`, `MONGO_URL`, and `CONFIG_FILE` for the path (default `/config/config.yml`).

## What to expect in the log

```
[  1/3] WugQNXFRRvoDFJZfS Jon Evan's Introduction to the Library   new              68 nodes  +68 ~0 -0
[  2/3] eYXJyyPFCf6Yajgz8 {Homebrew Templates} - Kalliste's Tome o updated         235 nodes  +10 ~1 -1
[  3/3] hAQmc87ty6DbWwZ42 DiceCloud 5th Edition SRD                unchanged      2558 nodes  +0 ~0 -0
```

- **new / updated / unchanged**, with nodes added (`+`), changed (`~`) and deleted (`-`).
- **inaccessible** is normal: collections list libraries that are private or were deleted.
  A private library reveals nothing, not even its name. The summary says which collections
  have such gaps.
- **failed** means a library could not be fetched or written after three attempts. The run
  carries on, ends with exit code 1, and the next run tries again.

The summary of the last run is also kept in the database:

```js
db.librarySyncState.findOne({ _id: 'state' }).lastRun
```

## How it stays complete

The `libraryNodes` publication returns a fixed set of tree fields and, beyond those, only
the fields a client asks for by name. A short list gives an export with the right number of
nodes that is missing spell casting times, reference targets and more.

- `schema-keys.json` lists every field name found in the property schemas, taken from this
  repository's current code and several older commits (dicecloud.com runs older code than
  `develop`).
- After each library a few nodes per type are fetched whole, through `libraryNode`, which
  applies no filter, and compared. A field that was not asked for is added to the list
  (and remembered in `librarySyncState`), and the libraries that could contain it are
  fetched again.

## How documents are converted

dicecloud.com serves the version 2 tree layout (`ancestors`, `parent`, `order`). This fork
is at database version 3 (`root`, `parentId`, `left`, `right`). The conversion is the one
the app's own migration does (`app/imports/migrations/server/dbv3/dbv3.ts`). The tool
refuses to write into a database at any other version.

Ids are kept, so references between libraries, collection membership, `DEFAULT_LIBRARIES`
and user subscriptions all keep working.

## Good to know

- **Be a light client.** dicecloud.com is run by volunteers. The example config pulls once
  a week with a request every 400 ms. Please don't sync much more often than daily.
- **A wrong password is tried once.** In scheduled mode the next attempt is one interval
  later, or as soon as the config file changes.
- **It is other people's work.** The libraries are community-authored, and some authors
  have turned copying off for readers. Keep an instance that holds copies private.
- **Images stay where they are.** Pictures in libraries are links to other hosts.
- **Libraries copied this way are read-only locally**: their owners are dicecloud.com users.
- **No backup is taken.** The tool only replaces copies of what the source holds, but if
  you want the previous state, back up the three library collections first.

## Development

```bash
cd docker/library-sync
npm ci
npm test                                    # unit tests
test/run.sh                                 # end to end: a fake dicecloud.com and a throwaway MongoDB
docker build -t dicecloud-library-sync:local .
test/run.sh dicecloud-library-sync:local    # the same, against the built image
```

| File | Purpose |
| --- | --- |
| `src/sync.mjs` | Command line, schedule loop |
| `src/run.mjs` | One run: selection, fetch, convert, apply, summary |
| `src/source.mjs`, `src/ddp.mjs` | Reading from the source, and the field completeness check |
| `src/tree.mjs` | Tree conversion |
| `src/target.mjs` | Comparing with and writing to MongoDB |
| `src/config.mjs` | Config file |
| `test/fake-dicecloud.mjs` | A DDP server with the app's library publications, for the tests |
