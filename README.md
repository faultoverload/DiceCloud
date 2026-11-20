# DiceCloud, self-hosted

A fork of [ThaumRystra/DiceCloud](https://github.com/ThaumRystra/DiceCloud), the character
sheet behind [dicecloud.com](https://dicecloud.com), packaged to run on your own server with
Docker.

For what DiceCloud is, and for developing it with Meteor, see the
[upstream README](https://github.com/ThaumRystra/DiceCloud#readme). This page covers running
the containers.

## What you run

| Service | Image | Purpose |
| --- | --- | --- |
| `dicecloud-db` | `mongo:7` | The database |
| `dicecloud` | `ghcr.io/faultoverload/dicecloud` | The app, on port 3000 |
| `dicecloud-library-sync` | `ghcr.io/faultoverload/dicecloud-library-sync` | Copies the community libraries from dicecloud.com and keeps them up to date |

Both DiceCloud images are built for `linux/amd64` only.

## Quick start

You need Docker with the compose plugin, and a [dicecloud.com](https://dicecloud.com)
account for copying the community libraries.

**1. Make a folder** and work in it:

```bash
mkdir dicecloud && cd dicecloud
```

**2. Create `docker-compose.yml`:**

```yaml
services:
  dicecloud-db:
    image: mongo:7
    restart: unless-stopped
    environment:
      MONGO_INITDB_ROOT_USERNAME: meteor
      MONGO_INITDB_ROOT_PASSWORD: ${MONGO_PASSWORD:?set MONGO_PASSWORD in .env}
    volumes:
      - ./data/db:/data/db
    healthcheck:
      test: ["CMD-SHELL", "mongosh --quiet --eval \"db.adminCommand('ping').ok\" || exit 1"]
      interval: 10s
      timeout: 10s
      retries: 5
      start_period: 20s

  dicecloud:
    image: ghcr.io/faultoverload/dicecloud:latest
    restart: unless-stopped
    depends_on:
      dicecloud-db:
        condition: service_healthy
    ports:
      - "3000:3000"
    environment:
      ROOT_URL: ${ROOT_URL:-http://localhost:3000}
      PORT: "3000"
      MONGO_URL: mongodb://meteor:${MONGO_PASSWORD}@dicecloud-db:27017/meteor?authSource=admin
      METEOR_SETTINGS: '{"public":{"environment":"production","disablePatreon":true}}'
    healthcheck:
      test: ["CMD-SHELL", "wget -q -O /dev/null http://127.0.0.1:3000/ || exit 1"]
      interval: 15s
      timeout: 10s
      retries: 5
      start_period: 120s

  dicecloud-library-sync:
    image: ghcr.io/faultoverload/dicecloud-library-sync:latest
    restart: unless-stopped
    depends_on:
      dicecloud:
        condition: service_healthy
    environment:
      MONGO_URL: mongodb://meteor:${MONGO_PASSWORD}@dicecloud-db:27017/meteor?authSource=admin
    volumes:
      - ./library-sync.yml:/config/config.yml:ro
```

**3. Create `.env`** next to it, with a database password of your own. Use letters and
digits only, because it becomes part of a URL (`openssl rand -hex 24` makes one):

```bash
MONGO_PASSWORD=change-me-to-a-long-random-string
ROOT_URL=http://localhost:3000
```

`ROOT_URL` is the address people will type to reach the app.

**4. Create `library-sync.yml`** with your dicecloud.com login. Do this before starting:
if the file is missing, Docker creates a folder with that name instead.

```yaml
source:
  username: your-dicecloud-username
  password: your-dicecloud-password

# "all", or a list of library and collection ids
libraries: all

schedule:
  interval: 7d
```

The container reads this file as user id 1000, so it has to be readable by that user
(`chmod 644 library-sync.yml` if in doubt).

**5. Start everything:**

```bash
docker compose up -d
docker compose ps
```

The app is ready when `docker compose ps` shows `dicecloud` as `healthy`. The library sync
starts after that.

**6. Open <http://localhost:3000>** and register an account.

**7. Subscribe to libraries.** Follow the first sync with
`docker compose logs -f dicecloud-library-sync`; it ends with a line starting `done:`.
Copying a library does not subscribe anyone to it: open **Community Libraries** in the
app (`/community-libraries`) and subscribe to what you want.

To run without the community libraries, leave out the `dicecloud-library-sync` service and
skip step 4.

## Settings

Environment of the `dicecloud` service:

| Variable | Needed | Meaning |
| --- | --- | --- |
| `ROOT_URL` | yes | The address users reach the app at, such as `https://dice.example.com` |
| `PORT` | yes | The port the app listens on inside the container. Without it the app picks a random one. |
| `MONGO_URL` | yes | The database |
| `METEOR_SETTINGS` | yes | JSON settings, see below |
| `MAIL_URL` | no | `smtp://user:password@host:port`. Without it the app cannot send verification or password reset emails. |
| `DEFAULT_LIBRARY_COLLECTIONS` | no | Collection ids, comma separated, that new users are subscribed to |
| `DEFAULT_LIBRARIES` | no | Library ids, comma separated, that new users are subscribed to. A collection id here is ignored without an error. |

Keys inside `METEOR_SETTINGS`, under `public`:

| Key | Meaning |
| --- | --- |
| `disablePatreon: true` | Turns off the Patreon tiers: every user can create libraries and has no limit on characters or tabletops. Without it, users get 5 characters and cannot create libraries. |
| `disallowCreatureApiImport: true` | Turns off importing a character from another DiceCloud instance |

The database only reads `MONGO_INITDB_ROOT_USERNAME` and `MONGO_INITDB_ROOT_PASSWORD` the
first time it starts with an empty `data/db`. Changing `MONGO_PASSWORD` later does not
change the password in the database.

Settings of the library sync are in its own [README](docker/library-sync/README.md).

## Community libraries

A new instance has no libraries, and DiceCloud has no way to export them. The
`dicecloud-library-sync` container reads them from dicecloud.com with your account and
writes them into your database. With `schedule.interval` it stays running and picks up
changes each interval.

```bash
docker compose logs -f dicecloud-library-sync                      # watch a sync
docker compose run --rm dicecloud-library-sync --once              # sync now
docker compose run --rm dicecloud-library-sync --once --dry-run    # show what would change
```

What it copies, how updates work, and what it deliberately leaves alone are described in
[docker/library-sync/README.md](docker/library-sync/README.md).

## Day to day

```bash
docker compose logs -f dicecloud      # app log
docker compose pull                   # fetch newer images
docker compose up -d                  # apply them
docker compose down                   # stop; data stays in ./data
```

`:latest` follows the `develop` branch of this repository. To stay on one build, use a
`sha-<short sha>` tag instead.

In the app log, `fatal: not a git repository` at startup is noise from the image, not an error.

### Backup and restore

Everything except uploaded files is in the database.

```bash
# backup
docker compose exec -T dicecloud-db sh -c 'mongodump --quiet -u "$MONGO_INITDB_ROOT_USERNAME" -p "$MONGO_INITDB_ROOT_PASSWORD" --authenticationDatabase admin --db meteor --archive --gzip' > dicecloud-backup.archive.gz

# restore, replacing what is in the database
docker compose stop dicecloud dicecloud-library-sync
docker compose exec -T dicecloud-db sh -c 'mongorestore --quiet -u "$MONGO_INITDB_ROOT_USERNAME" -p "$MONGO_INITDB_ROOT_PASSWORD" --authenticationDatabase admin --drop --archive --gzip' < dicecloud-backup.archive.gz
docker compose start dicecloud dicecloud-library-sync
```

### Uploaded files

Images that users upload and archived characters are files, not database records. The app
stores them inside its own container, so they are lost whenever the container is replaced,
which every update does. To keep them, give the app two folders owned by its user (id 1001):

```bash
mkdir -p data/userImages data/archiveCreatures
sudo chown 1001:1001 data/userImages data/archiveCreatures
```

and add them to the `dicecloud` service:

```yaml
    volumes:
      - ./data/userImages:/app/programs/server/assets/app/userImages
      - ./data/archiveCreatures:/app/programs/server/assets/app/archiveCreatures
```

If the folders belong to another user, the app still starts but cannot save files.

### Behind a reverse proxy

Set `ROOT_URL` to the public address, and proxy to port 3000 of the `dicecloud` container.
The app talks to the browser over a websocket, so the proxy has to pass websocket
connections through. If the proxy reaches the container over a Docker network, the `ports`
entry can go.

Anyone who can reach the app can register an account.

## Images

Both images are built by GitHub Actions, tested, and pushed to GitHub Container Registry
only if the tests pass.

| Image | Workflow | Test |
| --- | --- | --- |
| `ghcr.io/faultoverload/dicecloud` | `.github/workflows/docker-image.yml` | [Smoke test](docker/smoke-test/README.md) against the built image |
| `ghcr.io/faultoverload/dicecloud-library-sync` | `.github/workflows/library-sync-image.yml` | Unit tests, then an end-to-end test against the built image |

| Tag | When |
| --- | --- |
| `latest` | pushes to `develop` |
| `<branch>` | pushes to any branch (`/` becomes `-`) |
| `sha-<short sha>` | every build |

## Building from source

```bash
git clone https://github.com/faultoverload/DiceCloud && cd DiceCloud

docker build -t dicecloud:local .
docker/smoke-test/run.sh dicecloud:local

docker build -t dicecloud-library-sync:local docker/library-sync
(cd docker/library-sync && npm ci && test/run.sh dicecloud-library-sync:local)
```

The tests need Node 22 or newer.

`Dockerfile` is the recipe from [arbel-arad/DiceCloud](https://github.com/arbel-arad/DiceCloud),
which also supplied the pinned AWS SDK versions in `app/package.json` and the matching
`app/package-lock.json`. The build uses Meteor 2.16, and both it and the runtime stage
(`node:14-alpine`) run Node 14.

The `docker-compose.yml` in the root of this repository builds the app from source. The
quick start above does not use it.

## What this fork changes

Everything else is upstream's `develop` branch.

- **Docker images** built, tested and published by CI.
- **Library sync**, the sidecar described above.
- **Fixes** for faults that stopped character creation from the community libraries:
  - properties inserted from a library, or filled into a slot, did not appear on the sheet
  - slot fillers with a condition were never offered
  - a point buy never worked out what its rows cost
  - a trigger fired whether or not its condition was true
  - a buff remover logged the removal but removed nothing
  - without a MongoDB oplog, a second change to the same property was not recalculated,
    and results took up to ten seconds to show

## License

[GPL-3.0](License.md), as upstream.
