#!/bin/sh
# Poll the .network registry until the delegation stops being NS1.
#
# The registry is the authority on delegation; resolver caches lag it, so asking
# a resolver reports the old answer long after the change has landed.
#
# NOTE: the NS records come back in the AUTHORITY section, not ANSWER, because
# the TLD server is referring us downward rather than answering. `dig +short`
# prints only ANSWER, so it shows nothing here -- parse the section instead.
extract() {
  dig +norec @v0n0.nic.network clovers.network NS 2>/dev/null \
    | awk '/^clovers\.network\.[[:space:]]/ && $4=="NS" {print $5}' \
    | sort | paste -sd' ' -
}
for i in $(seq 1 40); do
  NS=$(extract)
  T=$(date -u +%H:%M:%SZ)
  case "$NS" in
    *nsone.net*) echo "$T  still NS1: $NS" ;;
    '')          echo "$T  no NS records returned" ;;
    *)           echo "$T  CHANGED -> $NS"; exit 0 ;;
  esac
  sleep 45
done
echo "gave up after ~30 min -- delegation still NS1"
exit 1
