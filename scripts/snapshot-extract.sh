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
  if [ -n "${DID:-}" ]; then
    echo "destroying droplet $DID"
    # shellcheck disable=SC2086
    doctl compute droplet delete "$DID" $CTX --force || \
      echo "FAILED TO DESTROY $DID -- delete it by hand, it is still billing" >&2
  fi
}
trap cleanup EXIT INT TERM

# Attach every SSH key on the account at creation time.
#
# The snapshot carries its original authorized_keys, which is enough when the
# key that opened the live machine is still on this laptop -- true for the
# Clovers boxes, where `billy` worked. It is not true generally: this account
# has nine registered keys named for machines going back years, and a droplet
# built in 2023 was authorised with whichever of them was selected then. Only
# id_rsa is held locally, so those snapshots refuse every login.
#
# Attaching all of them makes cloud-init write them into root's
# authorized_keys on first boot, which sidesteps the question entirely -- and
# root is exactly the login the database directories need. Verified on
# viper-server: without this, all six candidate users are refused; with it,
# root logs straight in.
#
# It does not help the 2012-era images, where cloud-init never runs and sshd
# cannot complete key exchange at all. Those still need the console.
# shellcheck disable=SC2086
ALLKEYS=$(doctl compute ssh-key list $CTX --format ID --no-header 2>/dev/null | tr '\n' ',' | sed 's/,$//')
# shellcheck disable=SC2086
DID=$(doctl compute droplet create "$DROPLET" \
        --image "$SNAP" --size "$SIZE" --region "$REGION" \
        ${ALLKEYS:+--ssh-keys "$ALLKEYS"} \
        --wait --format ID --no-header $CTX)
# shellcheck disable=SC2086
IP=$(doctl compute droplet get "$DID" $CTX --format PublicIPv4 --no-header)
echo "booted $DID at $IP"

# The host key is new and belongs to a machine that exists for minutes, so
# StrictHostKeyChecking is off here and known_hosts is left untouched.
SSHOPTS="-o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null -o LogLevel=ERROR -o ConnectTimeout=10 -o BatchMode=yes"

# Which user to log in as is discovered, not assumed. The first version
# connected as root with a key injected through cloud-init user-data, and every
# extraction failed: port 22 came up in twenty seconds, the key was never
# applied, and sixty attempts later the tar wrote a zero-byte file. cloud-init
# does not re-run its ssh_authorized_keys module on a droplet booted from a
# snapshot of an already-configured machine.
#
# None of that was necessary. The snapshot carries the original
# ~/.ssh/authorized_keys, so the key that opened the live droplet still opens a
# droplet booted from its snapshot -- as the ordinary user, not root. On these
# boxes that is `billy`; root refuses with Permission denied (publickey).
CANDIDATES="${SSH_USERS:-root billy ubuntu admin deploy debian}"
SSHUSER=""

# Wait for the port first, then try users. Doing it the other way round means an
# unreachable box costs 30 rounds x 6 users x a 10s timeout -- half an hour of
# billed droplet per failure. This caps a hopeless box at about two minutes.
for i in $(seq 1 30); do
  nc -z -G 5 "$IP" 22 2>/dev/null && break
  sleep 5
done
if ! nc -z -G 5 "$IP" 22 2>/dev/null; then
  echo "port 22 never opened" >&2; exit 1
fi

for round in 1 2 3; do
  for u in $CANDIDATES; do
    # shellcheck disable=SC2086
    if ssh $SSHOPTS "$u@$IP" true 2>/dev/null; then SSHUSER="$u"; break 2; fi
  done
  sleep 10
done
if [ -z "$SSHUSER" ]; then
  echo "could not log in as any of: $CANDIDATES" >&2
  echo "If the banner shows OpenSSH 5.x, sshd cannot complete key exchange and no" >&2
  echo "client version helps -- use the DigitalOcean web console instead." >&2
  echo "set SSH_USERS to override, e.g. SSH_USERS=\"someuser\"" >&2
  exit 1
fi
echo "logged in as $SSHUSER"

# Root-owned paths need elevation, and a non-root login may or may not have it.
# Established once rather than per-command so the failure is reported here
# instead of as a silently short archive.
# shellcheck disable=SC2086
if [ "$SSHUSER" = root ]; then SUDO=""
elif ssh $SSHOPTS "$SSHUSER@$IP" 'sudo -n true' 2>/dev/null; then SUDO="sudo "
else
  SUDO=""
  echo "WARNING: no passwordless sudo as $SSHUSER -- root-owned files will be missing from the archive" >&2
fi

if [ "$MEASURE" = "1" ]; then
  # What would actually come down, without transferring it. `du -sb` on the
  # same paths the extraction uses, plus the compressed size of a dry tar --
  # the second is what matters, since the archive is gzipped and a Discourse
  # box is mostly already-compressed images while a home directory is not.
  # shellcheck disable=SC2086
  ssh $SSHOPTS "$SSHUSER@$IP" '
    echo "  --- disk overall ---"
    df -h / | sed -n 2p
    echo "  --- candidate paths (uncompressed) ---"
    du -shc /home /root /etc /srv /opt /var/www             /var/lib/postgresql /var/lib/mysql /var/lib/rethinkdb /var/discourse             2>/dev/null | sort -rh
    echo "  --- what the tar.gz would weigh ---"
    tar czf - --ignore-failed-read       /home /root /etc /srv /opt /var/www       /var/lib/postgresql /var/lib/mysql /var/lib/rethinkdb /var/discourse 2>/dev/null       | wc -c | while read -r b; do echo "  compressed: $((b / 1048576)) MiB"; done
  ' || echo "  (measurement failed)"
  exit 0
fi

if [ "$FULL" = "1" ]; then
  DEST="$OUT/${NAME// /_}.img.gz"
  echo "streaming raw disk to $DEST -- this is the whole disk, not just data"
  # shellcheck disable=SC2086
  ssh $SSHOPTS "$SSHUSER@$IP" "${SUDO}dd if=/dev/vda bs=4M status=none | gzip -1" > "$DEST"
else
  DEST="$OUT/${NAME// /_}.tar.gz"
  echo "what is large on this disk:"
  # shellcheck disable=SC2086
  ssh $SSHOPTS "$SSHUSER@$IP" "${SUDO}du -sh /home /root /etc /srv /opt /var/www /var/lib/postgresql /var/lib/mysql /var/lib/rethinkdb /var/discourse 2>/dev/null | sort -rh" || true
  echo "extracting to $DEST"
  # shellcheck disable=SC2086
  ssh $SSHOPTS "$SSHUSER@$IP" \
    "${SUDO}tar czf - --ignore-failed-read \
       /home /root /etc /srv /opt /var/www \
       /var/lib/postgresql /var/lib/mysql /var/lib/rethinkdb /var/discourse \
       2>/dev/null" > "$DEST" || TAR_RC=$?

  # tar exits non-zero for warnings as well as errors -- a path absent on this
  # box, or a file changing while it is read -- and --ignore-failed-read
  # suppresses the message without changing the status. Under `set -e` that
  # aborted between writing the archive and reporting it, so subscribe-divide
  # produced a complete tarball and was recorded as a failure.
  if [ "${TAR_RC:-0}" != "0" ]; then
    echo "  tar exited ${TAR_RC}; warnings are normal, validating the archive"
  fi
fi

# An archive that cannot be listed is worthless however cleanly it was written.
# And "lists cleanly" is not enough on its own: `tar tzf` on a zero-byte file
# exits 0 with no output, so chameleon-node reported "wrote ... 0B, 0 entries"
# as a success after ssh died with 255. Require actual contents.
ENTRIES=$(tar tzf "$DEST" 2>/dev/null | wc -l | tr -d ' ')
if [ "${ENTRIES:-0}" -lt 10 ]; then
  echo "ARCHIVE EMPTY OR UNREADABLE ($ENTRIES entries) -- discarding $DEST" >&2
  rm -f "$DEST"
  exit 1
fi

echo "wrote $DEST ($(du -h "$DEST" | cut -f1), $ENTRIES entries)"
AFTER=$(free_gb)
echo "free on target volume: ${AFTER}GB (was ${FREE}GB, used $((FREE - AFTER))GB)"
if [ "$AFTER" -lt "$MIN_FREE_GB" ]; then
  echo "WARNING: now below the ${MIN_FREE_GB}GB floor -- stop before the next one." >&2
fi
echo "verifying the archive reads back:"
if [ "$FULL" = "1" ]; then gzip -t "$DEST" && echo "  gzip stream intact"
else tar tzf "$DEST" >/dev/null && echo "  tar lists cleanly ($(tar tzf "$DEST" | wc -l | tr -d ' ') entries)"; fi
