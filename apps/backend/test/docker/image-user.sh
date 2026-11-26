#!/usr/bin/env bash
# Checks which user the backend image runs as and how its entrypoint
# (apps/backend/docker-entrypoint.sh) hands data folders to that user.
# Needs Docker. Usage: apps/backend/test/docker/image-user.sh <image>
# Most cases pass a command instead of starting the backend: the entrypoint
# runs any command as the user it picked.
set -euo pipefail

img="${1:?usage: $0 <image>}"
run_id="eudiplo-image-user-$$"
backend_env=(
    -e MASTER_SECRET=ci-docker-test-secret-min-32-chars
    -e AUTH_CLIENT_ID=ci-docker-client
    -e AUTH_CLIENT_SECRET=ci-docker-secret
    -e ENCRYPTION_KEY=0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef
)

# Containers and volumes are named after run_id, so cleanup finds them even
# when they were created in a command substitution.
cleanup() {
    docker ps -aq --filter "name=$run_id" | xargs docker rm -f >/dev/null 2>&1 || true
    docker volume ls -q --filter "name=$run_id" | xargs docker volume rm -f >/dev/null 2>&1 || true
}
trap cleanup EXIT

volume() {
    echo "$run_id-$1"
}

# Prepare a volume as root, without the entrypoint.
as_root() {
    local vol="$1" mount="$2"
    shift 2
    docker run --rm -v "$vol:$mount" --entrypoint sh "$img" -c "$*"
}

check() {
    local name="$1" expected="$2" actual="$3"
    if [ "$actual" != "$expected" ]; then
        echo "FAIL $name: expected '$expected', got '$actual'" >&2
        exit 1
    fi
    echo "ok   $name"
}

# Start the backend and wait until /health answers; print the logs on failure.
start_backend() {
    local name="$run_id-$1"
    shift
    docker run -d --name "$name" "${backend_env[@]}" "$@" "$img" >/dev/null
    for _ in $(seq 1 45); do
        if docker exec "$name" curl -fs http://localhost:3000/health >/dev/null 2>&1; then
            echo "$name"
            return 0
        fi
        if [ "$(docker inspect -f '{{.State.Running}}' "$name")" != "true" ]; then
            break
        fi
        sleep 2
    done
    echo "FAIL backend $name did not become healthy" >&2
    docker logs "$name" >&2 || true
    exit 1
}

ids() { docker exec "$1" awk '/^Uid:/ { u = $2 } /^Gid:/ { g = $2 } END { print u ":" g }' /proc/1/status; }

# --- Default start: node, no capabilities, GID 1000 although /app/config is node:0
c=$(start_backend default)
check "default start runs as 1000:1000" "1000:1000" "$(ids "$c")"
check "default start has no capabilities" "0000000000000000" "$(docker exec "$c" awk '/^CapEff:/ { print $2 }' /proc/1/status)"

# --- A volume of an earlier release, root-owned, is handed to node
v=$(volume legacy)
as_root "$v" /app/config 'mkdir -p /app/config/config/t && touch /app/config/config/t/kms.json && chown -R 0:0 /app/config'
c=$(start_backend legacy -v "$v:/app/config")
check "root-owned volume: backend runs as 1000" "1000:1000" "$(ids "$c")"
check "root-owned volume: nothing left to root" "" "$(docker exec "$c" find /app/config ! -user 1000)"
docker logs "$c" 2>&1 | grep 'changed the owner of root-owned files in /app/config to 1000:1000' >/dev/null
echo "ok   root-owned volume: hand-over logged"

# --- FOLDER of another user (a CLI bind mount): the backend runs as that user,
# and an empty new uploads volume (node-owned) is handed over too
v=$(volume other)
u=$(volume other-uploads)
as_root "$v" /app/config 'touch /app/config/keep /app/config/legacy && chown 1234:0 /app/config /app/config/keep && chown 0:0 /app/config/legacy'
c=$(start_backend other -v "$v:/app/config" -v "$u:/app/uploads" -e CONFIG_FOLDER=/app/config -e LOCAL_STORAGE_DIR=/app/uploads)
check "other owner: backend runs as 1234 with GID 1234" "1234:1234" "$(ids "$c")"
check "other owner: root-owned file handed over" "1234" "$(docker exec "$c" stat -c %u /app/config/legacy)"
check "other owner: empty uploads volume handed over" "1234" "$(docker exec "$c" stat -c %u /app/uploads)"
check "other owner: HOME is /tmp" "/tmp" "$(docker run --rm -v "$v:/app/config" "$img" sh -c 'echo "$HOME"')"

# --- Ways to keep or set the user
check "--user is kept" "1234" "$(docker run --rm --user 1234:1234 "$img" id -u)"
check "EUDIPLO_RUN_AS_ROOT=true keeps root" "0" "$(docker run --rm -e EUDIPLO_RUN_AS_ROOT=true "$img" id -u)"
check "cap_drop ALL keeps root" "0" "$(docker run --rm --cap-drop ALL "$img" id -u)"
check "a flag runs with node" "$(docker run --rm --entrypoint node "$img" --version)" "$(docker run --rm "$img" --version)"

# --- A mounted folder outside /app is handed over; a subfolder of / is not
v=$(volume data)
as_root "$v" /data 'touch /data/legacy && chown -R 0:0 /data'
check "mount point outside /app is handed over" "1000" "$(docker run --rm -v "$v:/data" -e LOCAL_STORAGE_DIR=/data "$img" stat -c %u /data/legacy)"
check "LOG_FILE_PATH in /app leaves /app alone" "0 0" "$(docker run --rm -e LOG_TO_FILE=true -e LOG_FILE_PATH=/app/session.log "$img" stat -c %u /app/dist /app/package.json | tr '\n' ' ' | sed 's/ $//')"

# --- Links: a hard link to an image file and a symlinked folder are not followed
check "hard link to an image file stays root" "0" "$(docker run --rm --entrypoint sh "$img" -c \
    'ln /usr/local/bin/eudiplo-entrypoint.sh /app/config/link && /usr/local/bin/eudiplo-entrypoint.sh stat -c %u /usr/local/bin/eudiplo-entrypoint.sh')"
v=$(volume secret)
as_root "$v" /secrets 'touch /secrets/key && chmod 600 /secrets/key && chown -R 0:0 /secrets'
check "symlinked config folder to another mount stays root" "0" "$(docker run --rm -v "$v:/secrets" --entrypoint sh "$img" -c \
    'ln -s /secrets /app/config/config && /usr/local/bin/eudiplo-entrypoint.sh stat -c %u /secrets/key' 2>/dev/null)"

# --- Read-only mount: logged, and the command still runs as node
v=$(volume readonly)
as_root "$v" /app/config 'touch /app/config/legacy && chown -R 0:0 /app/config'
out=$(docker run --rm -v "$v:/app/config:ro" "$img" id -u 2>&1)
check "read-only mount: command still runs as node" "1000" "$(echo "$out" | tail -1)"
echo "$out" | grep 'could not change the owner of all root-owned files in /app/config' >/dev/null
echo "ok   read-only mount: failure logged"

# --- A root-only file the backend reads fails loudly and names the opt-out
v=$(volume tls)
as_root "$v" /certs 'echo key > /certs/key.pem && echo cert > /certs/cert.pem && chmod 600 /certs/*.pem && chown -R 0:0 /certs'
out=$(docker run --rm "${backend_env[@]}" -v "$v:/certs:ro" -e TLS_ENABLED=true -e TLS_CERT_PATH=/certs/cert.pem -e TLS_KEY_PATH=/certs/key.pem "$img" 2>&1 || true)
echo "$out" | grep 'TLS_CERT_PATH (/certs/cert.pem) cannot be read: EACCES' >/dev/null || { echo "$out" >&2; echo "FAIL root-only TLS file: no EACCES" >&2; exit 1; }
echo "$out" | grep 'EUDIPLO_RUN_AS_ROOT=true' >/dev/null || { echo "$out" >&2; echo "FAIL root-only TLS file: no hint" >&2; exit 1; }
echo "ok   root-only TLS file: error names the file and EUDIPLO_RUN_AS_ROOT"

# --- User namespace (rootless Podman): a root-owned FOLDER keeps root
check "user namespace with root-owned FOLDER keeps root" "0" "$(docker run --rm --user 1000:1000 \
    --security-opt seccomp=unconfined --security-opt apparmor=unconfined --entrypoint sh "$img" -c \
    'mkdir -p /tmp/f && unshare --user --map-root-user sh -c "FOLDER=/tmp/f /usr/local/bin/eudiplo-entrypoint.sh id -u"' 2>/dev/null)"

echo "all image user checks passed"
