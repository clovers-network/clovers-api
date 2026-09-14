#!/bin/bash
#
# Pull the contents of a DigitalOcean snapshot down to this machine.
#
#   ./snapshot-extract.sh --list
#   ./snapshot-extract.sh <snapshot-id> [--context clovers] [--full] [--yes]
#
# DigitalOcean has no snapshot export. doctl offers get/list/delete only, and
# `image create` imports from a URL rather than exporting. The only way to get
# data out is to boot a droplet from the snapshot, copy what you want, and
# destroy it. That is what this does.
#
# DEFAULT: extracts data, not a disk image. A 20 GiB Ubuntu snapshot is mostly
# Ubuntu -- the part worth keeping is usually a few hundred megabytes of
# application data. Pulling the whole disk means hours of transfer and hundreds
# of gigabytes locally for content you can reinstall from apt.
#
# --full instead streams the raw disk with dd, gzipped. That produces something
# re-importable via `doctl compute image create --image-url`, and is the right
# choice only if you need the machine back rather than its data.
#
# COST: the droplet is billed hourly from creation. At 25-50 GB that is
# $0.009-$0.018/hour, so a run costs under two cents. The droplet is destroyed
# on exit, including on failure or Ctrl-C -- see the trap. Verify with
# `doctl compute droplet list` afterwards regardless; an orphaned droplet is
# the one expensive way this can go wrong.
set -euo pipefail

CTX=""; FULL=0; YES=0; MEASURE=0; SNAP=""
OUT="${SNAPSHOT_OUT:-$HOME/clovers-backups/snapshots}"
while [ $# -gt 0 ]; do
  case "$1" in
    --list)    LIST=1 ;;
    --context) CTX="--context $2"; shift ;;
    --full)    FULL=1 ;;
    --measure) MEASURE=1; YES=1 ;;   # implies --yes: measuring requires booting
    --yes)     YES=1 ;;
    --out)     OUT="$2"; shift ;;
    -*)        echo "unknown flag: $1" >&2; exit 2 ;;
    *)         SNAP="$1" ;;
  esac
  shift
done

if [ "${LIST:-0}" = "1" ]; then
  echo "--- personal ---"; doctl compute snapshot list --format ID,Name,SizeGigabytes,MinDiskSize 2>/dev/null || doctl compute snapshot list
  echo "--- clovers ---";  doctl compute snapshot list --context clovers --format ID,Name,SizeGigabytes,MinDiskSize 2>/dev/null || doctl compute snapshot list --context clovers
  exit 0
fi
[ -z "$SNAP" ] && { echo "usage: $0 <snapshot-id> [--context clovers] [--full] [--yes]" >&2; exit 2; }

# shellcheck disable=SC2086
META=$(doctl compute snapshot get "$SNAP" $CTX -o json)
# doctl returns an array even for a single get, hence the [0] throughout.
# If the id is wrong it returns an {"errors":[...]} object instead, which fails
# here with a KeyError rather than proceeding to create a droplet -- which is
# the failure mode you want.
NAME=$(printf '%s' "$META" | python3 -c 'import json,sys;print(json.load(sys.stdin)[0]["name"])')
MIN=$(printf '%s' "$META" | python3 -c 'import json,sys;print(json.load(sys.stdin)[0]["min_disk_size"])')
REGION=$(printf '%s' "$META" | python3 -c 'import json,sys;print(json.load(sys.stdin)[0]["regions"][0])')

# Smallest size whose disk fits the snapshot. Sorted by hourly price so this
# picks the cheapest that can actually boot it.
# shellcheck disable=SC2086
SIZE=$(doctl compute size list $CTX --format Slug,Disk,PriceHourly --no-header \
       | awk -v m="$MIN" '$2>=m {print $3, $1}' | sort -n | head -1 | awk '{print $2}')
[ -z "$SIZE" ] && { echo "no droplet size has a disk >= ${MIN}GB" >&2; exit 1; }
HOURLY=$(doctl compute size list $CTX --format Slug,PriceHourly --no-header | awk -v s="$SIZE" '$1==s{print $2}')

# A throwaway keypair, generated per run and destroyed with the droplet.
#
# The obvious approach is `--ssh-keys <id>` with a key already on the account,
# and the first version did that -- taking `ssh-key list | head -1`. Two things
# were wrong with it. It needs an ssh_key:read scope on the API token, and it
# picks whichever key DigitalOcean happens to list first, whose private half may
# not be on this machine at all. Here it resolved to "xps", which does match
# ~/.ssh/id_rsa, but that was luck: the same list holds "iPhone" and "ipad".
#
# Injecting a fresh public key via cloud-init instead means the droplet trusts
# exactly one key, that key exists for the life of this run, and no scope beyond
# droplet create/read/delete and image:read is required. Nothing is added to the
# account, so there is nothing to clean up there either.
TMPKEY=$(mktemp -u "${TMPDIR:-/tmp}/snapx-key-XXXXXX")
ssh-keygen -t ed25519 -N '' -C "snapshot-extract throwaway" -f "$TMPKEY" -q
USERDATA=$(printf '#cloud-config
ssh_authorized_keys:
  - %s
' "$(cat "$TMPKEY.pub")")

echo "snapshot : $NAME ($SNAP)"
echo "region   : $REGION   min disk: ${MIN}GB"
echo "droplet  : $SIZE at \$$HOURLY/hour, destroyed on exit"
if [ "$MEASURE" = 1 ]; then MODE='MEASURE ONLY -- boots, sizes the disk, downloads nothing'
elif [ "$FULL" = 1 ]; then MODE='FULL raw disk image (large)'
else MODE='data extraction'; fi
echo "mode     : $MODE"
echo "output   : $OUT"
if [ "$YES" != "1" ]; then
  echo
  echo "Dry run. This creates a billable droplet. Re-run with --yes to proceed."
  exit 0
fi

# Refuse to start if the disk is already tight. The extraction streams straight
# to a file and cannot know its final size in advance, so the guard is a floor
# on what must remain free rather than a check against the incoming size.
# MIN_FREE_GB is deliberately generous: filling a working machine's disk is a
# much worse outcome than a failed extraction you can retry.
MIN_FREE_GB="${MIN_FREE_GB:-100}"
mkdir -p "$OUT"
free_gb () { df -g "$OUT" | awk 'NR==2 {print $4}'; }
FREE=$(free_gb)
echo "free on target volume: ${FREE}GB (floor ${MIN_FREE_GB}GB)"
if [ "$FREE" -lt "$MIN_FREE_GB" ]; then
  echo "REFUSING: only ${FREE}GB free, floor is ${MIN_FREE_GB}GB. Raise MIN_FREE_GB or free space." >&2
  exit 1
fi
DROPLET="extract-$(echo "$NAME" | tr -cd 'a-zA-Z0-9-' | cut -c1-30)-$$"

cleanup () {
  rm -f "${TMPKEY:-}" "${TMPKEY:-}.pub"
  if [ -n "${DID:-}" ]; then
    echo "destroying droplet $DID"
    # shellcheck disable=SC2086
    doctl compute droplet delete "$DID" $CTX --force || \
      echo "FAILED TO DESTROY $DID -- delete it by hand, it is still billing" >&2
  fi
}
trap cleanup EXIT INT TERM

# shellcheck disable=SC2086
DID=$(doctl compute droplet create "$DROPLET" \
        --image "$SNAP" --size "$SIZE" --region "$REGION" \
        --user-data "$USERDATA" --wait --format ID --no-header $CTX)
# shellcheck disable=SC2086
IP=$(doctl compute droplet get "$DID" $CTX --format PublicIPv4 --no-header)
echo "booted $DID at $IP"

# The host key is new and belongs to a machine that exists for minutes, so
# StrictHostKeyChecking is off here and known_hosts is left untouched.
SSHOPTS="-i $TMPKEY -o IdentitiesOnly=yes -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null -o LogLevel=ERROR -o ConnectTimeout=10"
for i in $(seq 1 60); do
  # shellcheck disable=SC2086
  ssh $SSHOPTS root@"$IP" true 2>/dev/null && break
  sleep 5
done

if [ "$MEASURE" = "1" ]; then
  # What would actually come down, without transferring it. `du -sb` on the
  # same paths the extraction uses, plus the compressed size of a dry tar --
  # the second is what matters, since the archive is gzipped and a Discourse
  # box is mostly already-compressed images while a home directory is not.
  # shellcheck disable=SC2086
  ssh $SSHOPTS root@"$IP" '
    echo "  --- disk overall ---"
    df -h / | sed -n 2p
    echo "  --- candidate paths (uncompressed) ---"
    du -shc /home /root /etc /srv /opt /var/www             /var/lib/postgresql /var/lib/mysql /var/lib/rethinkdb /var/discourse             2>/dev/null | sort -rh
    echo "  --- what the tar.gz would weigh ---"
    tar czf - --ignore-failed-read       /home /root /etc /srv /opt /var/www       /var/lib/postgresql /var/lib/mysql /var/lib/rethinkdb /var/discourse 2>/dev/null       | wc -c | awk "{printf "  compressed: %.1f MiB\n", \$1/1048576}"
  ' || echo "  (measurement failed)"
  exit 0
fi

if [ "$FULL" = "1" ]; then
  DEST="$OUT/${NAME// /_}.img.gz"
  echo "streaming raw disk to $DEST -- this is the whole disk, not just data"
  # shellcheck disable=SC2086
  ssh $SSHOPTS root@"$IP" "dd if=/dev/vda bs=4M status=none | gzip -1" > "$DEST"
else
  DEST="$OUT/${NAME// /_}.tar.gz"
  echo "what is large on this disk:"
  # shellcheck disable=SC2086
  ssh $SSHOPTS root@"$IP" "du -sh /home /root /etc /srv /opt /var/www /var/lib/postgresql /var/lib/mysql /var/lib/rethinkdb /var/discourse 2>/dev/null | sort -rh" || true
  echo "extracting to $DEST"
  # shellcheck disable=SC2086
  ssh $SSHOPTS root@"$IP" \
    "tar czf - --ignore-failed-read \
       /home /root /etc /srv /opt /var/www \
       /var/lib/postgresql /var/lib/mysql /var/lib/rethinkdb /var/discourse \
       2>/dev/null" > "$DEST"
fi

echo "wrote $DEST ($(du -h "$DEST" | cut -f1))"
AFTER=$(free_gb)
echo "free on target volume: ${AFTER}GB (was ${FREE}GB, used $((FREE - AFTER))GB)"
if [ "$AFTER" -lt "$MIN_FREE_GB" ]; then
  echo "WARNING: now below the ${MIN_FREE_GB}GB floor -- stop before the next one." >&2
fi
echo "verifying the archive reads back:"
if [ "$FULL" = "1" ]; then gzip -t "$DEST" && echo "  gzip stream intact"
else tar tzf "$DEST" >/dev/null && echo "  tar lists cleanly ($(tar tzf "$DEST" | wc -l | tr -d ' ') entries)"; fi
