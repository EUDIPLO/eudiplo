#!/bin/sh
# Entrypoint of the backend image: runs the command as a non-root user.
#
# Started as a non-root user (docker run --user, Compose `user:`, Kubernetes
# runAsUser), it runs the command as that user and changes nothing.
#
# Started as root (the image default), it picks the user that owns the data
# folder FOLDER, or node (1000:1000) when root owns it or it does not exist yet.
# It hands root-owned files in the folders the backend writes to that user,
# because images before this entrypoint ran the backend as root and created
# them as root, then runs the command as that user. EUDIPLO_RUN_AS_ROOT=true keeps the
# command running as root.
set -eu

log() {
    echo "eudiplo-entrypoint: $*" >&2
}

# As the entrypoint of the node base image: a first argument that is a flag or
# no command runs with node, so `docker run <image> --version` keeps working.
if [ "$#" -gt 0 ] && { [ "${1#-}" != "$1" ] || [ -z "$(command -v "$1" || true)" ] || { [ -f "$1" ] && [ ! -x "$1" ]; }; }; then
    set -- node "$@"
fi

if [ "$(id -u)" != "0" ] || [ "${EUDIPLO_RUN_AS_ROOT:-false}" = "true" ]; then
    exec "$@"
fi

# Without CAP_SETUID and CAP_SETGID (for example Compose `cap_drop: [ALL]` on a
# root container) the user cannot be changed. Keep running as root then, as
# images before this entrypoint did, instead of failing to start.
cap_eff="$(awk '/^CapEff:/ { print $2 }' /proc/self/status)"
if [ $(( 0x$cap_eff & 0xc0 )) -ne $(( 0xc0 )) ]; then
    log "no CAP_SETUID and CAP_SETGID, so the backend keeps running as root; start the container as a non-root user instead, see https://docs.eudiplo.dev/operate/docker-compose#non-root-user"
    exec "$@"
fi

folder="${FOLDER:-/app/config}"
config_folder="${CONFIG_FOLDER:-$folder/config}"
storage_folder="$folder/uploads"
storage_named=false
if [ "${STORAGE_DRIVER:-local}" = "local" ] && [ -n "${LOCAL_STORAGE_DIR:-}" ]; then
    storage_folder="$LOCAL_STORAGE_DIR"
    storage_named=true
fi
log_folder=""
if [ "${LOG_TO_FILE:-false}" = "true" ]; then
    log_folder="$(dirname "${LOG_FILE_PATH:-./logs/session.log}")"
fi

# Rootless Podman maps root in the container to the unprivileged user that
# started it. There, root-owned files in a bind mount belong to that user on the
# host, and handing them to 1000:1000 would take them away from that user. So
# root-owned data stays with root in a user namespace (rootless Podman, Docker
# with userns-remap).
in_user_namespace=false
if [ -r /proc/self/uid_map ] && ! awk '$1 == 0 && $2 == 0 { found = 1 } END { exit !found }' /proc/self/uid_map; then
    in_user_namespace=true
fi

owner="1000:1000"
if [ -d "$folder" ]; then
    folder_owner="$(stat -c '%u:%g' "$folder")"
    if [ "${folder_owner%%:*}" != "0" ]; then
        owner="$folder_owner"
    elif [ "$in_user_namespace" = "true" ]; then
        log "$folder belongs to root in a user namespace (rootless Podman, userns-remap); running as root, see https://docs.eudiplo.dev/operate/docker-compose#non-root-user"
        exec "$@"
    fi
fi
uid="${owner%%:*}"
gid="${owner##*:}"
# A folder of group root (the image's own folders are node:0 for root
# containers without capabilities) must not give the backend group root.
if [ "$gid" = "0" ]; then
    gid="$uid"
fi

# Hand the folders the backend writes to the chosen user:
# - Only a mount point other than / or a folder the image created for the
#   backend (/app/config, /app/uploads, /app/logs) is touched, so a path such as
#   LOG_FILE_PATH=/app/session.log cannot hand image files to that user.
# - Only root-owned entries change, so files of other users in a bind mount
#   keep their owner. An empty folder that node owns, such as a new named volume
#   created from the image, is handed over too when the user is not node.
# - find does not follow symbolic links, -execdir changes each entry from its
#   own folder and chown -h changes a link itself, so a link swapped in while
#   find runs cannot redirect the change. -xdev stays on the folder's file
#   system, and a file with more than one hard link is skipped, so a link the
#   backend user placed in the folder cannot hand it a root-owned file from
#   elsewhere in the image.
# - A read-only mount leaves the files as they are; the backend then reports
#   what it cannot write.
# A missing folder is created only when the operator named it (create=true):
# the backend creates the default ones itself, and an extra folder in
# CONFIG_FOLDER would be read as a tenant folder.
hand_over() {
    dir="$1"
    create="$2"
    case "$dir" in
        /*) ;;
        *) dir="$(pwd)/$dir" ;;
    esac
    if [ ! -e "$dir" ]; then
        if [ "$create" = "true" ] && mkdir -p "$dir" 2>/dev/null; then
            chown "$uid:$gid" "$dir" 2>/dev/null || true
        fi
        return 0
    fi
    real="$(realpath "$dir")"
    # A symbolic link anywhere in the path is refused: the backend user owns
    # FOLDER and could replace config/ or uploads/ with a link to another
    # mount, which this root process would then hand over.
    if [ "$real" != "$(realpath -s "$dir")" ]; then
        log "left the owners in $dir unchanged: its path contains a symbolic link"
        return 0
    fi
    case "$real" in
        /app/config | /app/config/* | /app/uploads | /app/uploads/* | /app/logs | /app/logs/*) ;;
        *)
            if [ "$real" = "/" ] || ! mountpoint -q "$real"; then
                log "left the owners in $dir unchanged: it is neither a mount point nor a folder of the image"
                return 0
            fi
            ;;
    esac
    if [ "$uid" != "1000" ] && [ "$(stat -c '%u' "$real")" = "1000" ] && [ -z "$(ls -A "$real")" ]; then
        chown "$uid:$gid" "$real" || log "could not change the owner of $dir to $uid:$gid"
    fi
    if [ -n "$(find "$real" -xdev -user 0 \( -type d -o -links 1 \) -print -quit 2>/dev/null)" ]; then
        if find "$real" -xdev -user 0 \( -type d -o -links 1 \) -execdir chown -h "$uid:$gid" {} +; then
            log "changed the owner of root-owned files in $dir to $uid:$gid"
        else
            log "could not change the owner of all root-owned files in $dir to $uid:$gid"
        fi
    fi
}

hand_over "$folder" true
hand_over "$config_folder" true
hand_over "$storage_folder" "$storage_named"
if [ -n "$log_folder" ]; then
    hand_over "$log_folder" true
fi

# HOME of node, or a folder every user can write for another owner of FOLDER.
if [ "$uid" = "1000" ]; then
    export HOME=/home/node
else
    export HOME=/tmp
fi

exec setpriv --reuid="$uid" --regid="$gid" --clear-groups --inh-caps=-all --no-new-privs -- "$@"
