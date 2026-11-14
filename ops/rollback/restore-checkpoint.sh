#!/bin/sh
# Restore only after delivery outcomes since the checkpoint have been reconciled.
set -eu
if [ "$#" -ne 6 ] || [ "$6" != '--delivery-outcomes-reconciled' ]; then
    echo 'Usage: restore-checkpoint.sh CHECKPOINT STACK_FILE PROJECT DATA_DIR CONFIG_DIR --delivery-outcomes-reconciled' >&2
    exit 2
fi
checkpoint=$1
stack=$2
project=$3
data=$4
config=$5
for dir in "$checkpoint" "$data" "$config"; do
    test -d "$dir" && test ! -L "$dir"
    case "$dir" in /*) ;; *) echo 'Absolute directories required' >&2; exit 2;; esac
done
case "$data" in /var/lib/docker/volumes/*/_data) ;; *) echo 'Unexpected data volume path' >&2; exit 2;; esac
case "$config" in /var/lib/docker/volumes/*/_data) ;; *) echo 'Unexpected config volume path' >&2; exit 2;; esac
test "$data" != "$config"
test -s "$checkpoint/stack-before.yml"
# Refuse to overwrite evidence from a prior rollback attempt.
test ! -e "$checkpoint/post-trial-data"
test ! -e "$checkpoint/post-trial-config"
test ! -e "$checkpoint/restored-data"
test ! -e "$checkpoint/restored-config"
for archive in data config; do
    gzip -t "$checkpoint/$archive.tar.gz"
    if tar -tzf "$checkpoint/$archive.tar.gz" | grep -Eq '(^/|(^|/)\.\.(/|$))'; then
        echo 'Unsafe archive member path' >&2; exit 2
    fi
    mkdir -m 700 "$checkpoint/restored-$archive"
    tar -xzpf "$checkpoint/$archive.tar.gz" -C "$checkpoint/restored-$archive"
done
test -s "$checkpoint/restored-data/auth/creds.json"
# Parsing the prior stack must succeed before stopping the candidate.
docker compose --project-directory "$(dirname "$stack")" -p "$project" -f "$checkpoint/stack-before.yml" config --quiet
docker compose --project-directory "$(dirname "$stack")" -p "$project" -f "$stack" stop -t 20 whatsapp-mcp whatsapp-proxy
mkdir -m 700 "$checkpoint/post-trial-data" "$checkpoint/post-trial-config"
move_contents() {
    source=$1
    target=$2
    for entry in "$source"/* "$source"/.[!.]* "$source"/..?*; do
        if [ -e "$entry" ] || [ -L "$entry" ]; then mv "$entry" "$target/"; fi
    done
}
# Preserve candidate state on the same host filesystem instead of deleting it.
move_contents "$data" "$checkpoint/post-trial-data"
move_contents "$config" "$checkpoint/post-trial-config"
move_contents "$checkpoint/restored-data" "$data"
move_contents "$checkpoint/restored-config" "$config"
cp -p "$stack" "$checkpoint/stack-candidate.yml"
cp -p "$checkpoint/stack-before.yml" "$stack.rollback-tmp"
mv "$stack.rollback-tmp" "$stack"
docker compose --project-directory "$(dirname "$stack")" -p "$project" -f "$stack" up -d --no-deps --no-build --pull never --wait --wait-timeout 120 whatsapp-proxy whatsapp-mcp
echo 'Checkpoint restored. Verify read-only connection state and preserve post-trial evidence.'
