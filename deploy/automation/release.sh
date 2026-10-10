#!/usr/bin/env bash
# Install outside the repository; execute only through the host publisher.
set -Eeuo pipefail
umask 077
SHA=${1:?commit SHA required}
ARCHIVE=${2:?git archive required}
ROOT=${3:-/opt/yuanplan}
[[ "$SHA" =~ ^[0-9a-f]{40}$ && "$ROOT" = /* && "$ARCHIVE" = /* ]] || exit 2
command -v docker >/dev/null
command -v flock >/dev/null
command -v python3 >/dev/null
command -v curl >/dev/null
test -d "$ROOT"
ROOT=$(realpath "$ROOT")
test -s "$ROOT/deploy/.env"
test -s "$ROOT/compose.yaml"

mkdir -p "$ROOT/.data/automation"
exec 9>"$ROOT/.data/automation/release.lock"
flock -n 9 || { echo 'Another release is active' >&2; exit 3; }
STAMP=$(date -u +%Y%m%dT%H%M%SZ)
RUN="$ROOT/.data/automation/$SHA-$STAMP"
CODE="$RUN/source"
BACKUP="$RUN/backup"
IMAGE="yuanplan:$SHA"
mkdir -p "$CODE" "$BACKUP"
OPTS=(-p "${YUANPLAN_COMPOSE_PROJECT:-yuanplan}" --project-directory "$ROOT" -f "$ROOT/compose.yaml")
if test -f "$ROOT/compose.server.yaml"; then OPTS+=(-f "$ROOT/compose.server.yaml"); fi
if test -f "$ROOT/compose.release.yaml"; then OPTS+=(-f "$ROOT/compose.release.yaml"); fi
dc_old() { docker compose "${OPTS[@]}" --env-file "$ROOT/deploy/.env" "$@"; }
dc_new() { docker compose "${OPTS[@]}" -f "$RUN/candidate.yaml" --env-file "$ROOT/deploy/.env" "$@"; }
PHASE=prepare
failure() { echo "Release stopped during $PHASE. Protected state: $RUN. Maintenance is not automatically disabled." >&2; }
trap failure ERR
trap 'failure; exit 130' INT TERM
dc_old config --quiet
PUBLIC_HEALTH_URL=$(dc_old config --format json | python3 "$(dirname "$0")/public_health_url.py")
APP_ID=$(dc_old ps -q app)
DB_ID=$(dc_old ps -q db)
test -n "$APP_ID" && test -n "$DB_ID"
test "$(docker inspect -f '{{.State.Health.Status}}' "$APP_ID")" = healthy
test "$(docker inspect -f '{{.State.Health.Status}}' "$DB_ID")" = healthy
OLD_IMAGE=$(docker inspect -f '{{.Image}}' "$APP_ID")
docker image tag "$OLD_IMAGE" "yuanplan:before-$SHA-$STAMP"
cp "$ROOT/compose.yaml" "$BACKUP/"
if test -f "$ROOT/compose.server.yaml"; then cp "$ROOT/compose.server.yaml" "$BACKUP/"; fi
cp "$ROOT/deploy/.env" "$BACKUP/production.env"
if test -f "$ROOT/compose.release.yaml"; then cp "$ROOT/compose.release.yaml" "$BACKUP/"; fi
printf '%s\n' "$OLD_IMAGE" >"$BACKUP/old-image-id"
# Source archives may not create links, devices or paths outside the release.
python3 - "$ARCHIVE" "$CODE" <<'PY'
import pathlib, shutil, sys, tarfile
root = pathlib.Path(sys.argv[2])
with tarfile.open(sys.argv[1], 'r:') as archive:
    members = archive.getmembers()
    for member in members:
        p = pathlib.PurePosixPath(member.name)
        if p.is_absolute() or '..' in p.parts or not (member.isdir() or member.isfile()):
            raise SystemExit('Unsafe source archive')
        if '.git' in p.parts or p.name == '.env' or (p.name.startswith('.env.') and p.name != '.env.example'):
            raise SystemExit('Source archive contains protected files')
    for member in members:
        target = root / member.name
        if member.isdir():
            target.mkdir(parents=True, exist_ok=True)
        else:
            target.parent.mkdir(parents=True, exist_ok=True)
            with archive.extractfile(member) as source, target.open('xb') as output:
                shutil.copyfileobj(source, output)
            target.chmod(member.mode & 0o755)
PY
test -s "$CODE/Dockerfile"
test -s "$CODE/deploy/migrate.mjs"
PHASE=build
docker build --tag "$IMAGE" "$CODE" >"$RUN/build.log" 2>&1
# A unique immutable image is used for app, migrate and ops. Existing networks,
# ports and named volumes continue to come from the host Compose configuration.
python3 - "$RUN/candidate.yaml" "$IMAGE" "$CODE" <<'PY'
import json, pathlib, sys
pathlib.Path(sys.argv[1]).write_text(json.dumps({'services': {
    name: {'image': sys.argv[2], 'build': {'context': sys.argv[3]}}
    for name in ('app', 'migrate', 'ops')}}))
PY
dc_new config --quiet
PHASE=backup
dc_old run --rm --no-deps ops node apps/server/dist/cli.js maintenance --state on >"$RUN/maintenance-on.log" 2>&1
dc_old stop app
CONTAINER="yuanplan-auto-backup-${SHA:0:12}-$STAMP"
DEST="auto-before-$SHA-$STAMP"
dc_old run --no-deps --name "$CONTAINER" ops node apps/server/dist/cli.js backup --output "/backups/$DEST" >"$RUN/backup.log" 2>&1
docker cp "$CONTAINER:/backups/$DEST" "$BACKUP/data"
docker rm -v "$CONTAINER" >/dev/null
python3 - "$BACKUP/data" <<'PY'
import hashlib, json, pathlib, re, sys
root = pathlib.Path(sys.argv[1])
manifest = json.loads((root / 'manifest.json').read_text())
def digest(path):
    h = hashlib.sha256()
    with path.open('rb') as data:
        for chunk in iter(lambda: data.read(1024*1024), b''):
            h.update(chunk)
    return h.hexdigest()
if manifest.get('format') != 1 or digest(root / 'database.dump') != manifest['databaseChecksum']:
    raise SystemExit('Invalid database backup')
seen = set()
for item in manifest['files']:
    key = item['storageKey']
    if not re.fullmatch(r'[0-9a-f-]{36}', key) or key in seen:
        raise SystemExit('Invalid backup attachment key')
    seen.add(key)
    path = root / 'uploads' / key
    if path.stat().st_size != item['size'] or digest(path) != item['checksum']:
        raise SystemExit('Invalid attachment backup')
PY
docker run --rm --network none --user 0 --read-only --cap-drop ALL --security-opt no-new-privileges --entrypoint pg_restore --mount "type=bind,source=$BACKUP/data,target=/backup,readonly" "$OLD_IMAGE" --list /backup/database.dump >"$RUN/backup-catalog.log"
PHASE=migrate
dc_new run --rm --no-deps migrate >"$RUN/migrate.log" 2>&1
PHASE=start
dc_new up -d --no-deps --no-build --force-recreate app >"$RUN/start.log" 2>&1
NEW_APP=$(dc_new ps -q app)
for ((i=0; i<90; i++)); do
  HEALTH=$(docker inspect -f '{{.State.Health.Status}}' "$NEW_APP")
  if [[ "$HEALTH" = healthy ]]; then break; fi
  [[ "$HEALTH" != unhealthy ]]
  sleep 2
done
test "$HEALTH" = healthy
test "$(dc_new ps -q db)" = "$DB_ID"
PHASE=verify
docker exec "$NEW_APP" node -e "fetch('http://127.0.0.1:18420/api/health').then(async r=>{if(!r.ok||(await r.json()).status!=='ok')process.exit(1)}).catch(()=>process.exit(1))"
curl --fail --silent --show-error --max-time 15 "$PUBLIC_HEALTH_URL" >"$RUN/public-health.json"
python3 - "$RUN/public-health.json" <<'PY'
import json, sys
if json.load(open(sys.argv[1])).get('status') != 'ok':
    raise SystemExit('Public health check failed')
PY
# Commit the image override before reopening, so a later maintenance command
# cannot accidentally select the old image after a process interruption.
cp "$RUN/candidate.yaml" "$ROOT/compose.release.yaml.tmp"
mv "$ROOT/compose.release.yaml.tmp" "$ROOT/compose.release.yaml"
PHASE=open
dc_new run --rm --no-deps ops node apps/server/dist/cli.js maintenance --state off >"$RUN/maintenance-off.log" 2>&1
printf '%s\n' "$SHA" >"$ROOT/DEPLOYED_COMMIT.tmp"
mv "$ROOT/DEPLOYED_COMMIT.tmp" "$ROOT/DEPLOYED_COMMIT"
printf '%s\n' "$CODE" >"$ROOT/DEPLOYED_SOURCE_DIR.tmp"
mv "$ROOT/DEPLOYED_SOURCE_DIR.tmp" "$ROOT/DEPLOYED_SOURCE_DIR"
PHASE=complete
printf 'Published %s; backup and logs: %s\n' "$SHA" "$RUN"
