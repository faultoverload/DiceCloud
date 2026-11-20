#!/usr/bin/env bash
# Runs the end-to-end test against a throwaway MongoDB. Everything it starts is removed on exit.
#
#   docker/library-sync/test/run.sh            # tests the source in this checkout (node src/sync.mjs)
#   docker/library-sync/test/run.sh <image>    # tests a built image
#
# Needs docker, Node 22+ and `npm ci` run in docker/library-sync.
set -euo pipefail

HERE=$(cd "$(dirname "$0")" && pwd)
DB=library-sync-test-db-$$

cleanup() {
  status=$?
  docker rm -f "$DB" >/dev/null 2>&1 || true
  exit "$status"
}
trap cleanup EXIT

docker run -d --name "$DB" -p 127.0.0.1::27017 mongo:7 >/dev/null
PORT=$(docker port "$DB" 27017/tcp | head -1 | sed 's/.*://')
for i in $(seq 1 60); do
  if docker exec "$DB" mongosh --quiet --eval 'db.runCommand({ ping: 1 }).ok' >/dev/null 2>&1; then break; fi
  if [ "$i" = 60 ]; then echo "MongoDB did not start within 60s" >&2; exit 1; fi
  sleep 1
done

MONGO_URL="mongodb://127.0.0.1:$PORT/meteor" IMAGE="${1:-}" node "$HERE/integration.mjs"
