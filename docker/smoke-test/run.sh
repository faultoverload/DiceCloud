#!/usr/bin/env bash
# Starts a DiceCloud image next to a throwaway MongoDB, runs smoke.mjs against it and
# checks the database afterwards. Everything it starts is removed on exit.
#
#   docker/smoke-test/run.sh <image>
#
# Needs docker and Node 22+ (smoke.mjs uses the built-in WebSocket client).
set -euo pipefail

IMAGE=${1:?usage: run.sh <image>}
HERE=$(cd "$(dirname "$0")" && pwd)
ID=dc-smoke-$$
NET=$ID
DB=$ID-db
APP=$ID-app

cleanup() {
  status=$?
  if [ "$status" -ne 0 ]; then
    echo "---- app log (last 60 lines)"
    docker logs --tail 60 "$APP" 2>&1 || true
  fi
  docker rm -f "$APP" "$DB" >/dev/null 2>&1 || true
  docker network rm "$NET" >/dev/null 2>&1 || true
  exit "$status"
}
trap cleanup EXIT

docker network create "$NET" >/dev/null
docker run -d --name "$DB" --network "$NET" mongo:7 >/dev/null
docker run -d --name "$APP" --network "$NET" -p 127.0.0.1::3000 \
  -e ROOT_URL=http://localhost:3000 \
  -e PORT=3000 \
  -e MONGO_URL="mongodb://$DB:27017/meteor" \
  -e METEOR_SETTINGS='{"public":{"environment":"production","disablePatreon":true}}' \
  "$IMAGE" >/dev/null

PORT=$(docker port "$APP" 3000/tcp | head -1 | sed 's/.*://')
echo "waiting for the app on port $PORT"
for i in $(seq 1 90); do
  if [ "$(curl -s -o /dev/null -w '%{http_code}' "http://127.0.0.1:$PORT/" || true)" = "200" ]; then
    break
  fi
  if [ "$i" = 90 ]; then echo "app did not answer HTTP 200 within 180s" >&2; exit 1; fi
  sleep 2
done

node "$HERE/smoke.mjs" "ws://127.0.0.1:$PORT/websocket"

# Nothing may be left behind outside a creature: before the fix, copies of library nodes
# were stored with the library as their root.
STRAY=$(docker exec "$DB" mongosh --quiet meteor --eval '
  const creatureIds = db.creatures.find({}, { _id: 1 }).toArray().map(c => c._id);
  print(db.creatureProperties.countDocuments({
    $or: [{ "root.collection": { $ne: "creatures" } }, { "root.id": { $nin: creatureIds } }],
  }));')
if [ "$STRAY" != "0" ]; then
  echo "FAIL: $STRAY creature properties are not rooted in a creature" >&2
  exit 1
fi
echo "PASS database: no creature properties rooted outside a creature"
