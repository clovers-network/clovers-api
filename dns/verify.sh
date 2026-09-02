#!/bin/sh
# Resolve every name in the zone against a given nameserver.
#   ./verify.sh dns1.p07.nsone.net > baseline.txt
#   ./verify.sh <cloudflare-ns>    > after.txt
#   diff baseline.txt after.txt
#
# Queries the authoritative server directly with +norecurse, so it reports what
# that server holds rather than whatever a resolver has cached. Output is sorted
# and normalised so a diff shows real differences and not ordering noise.
NS="$1"
[ -z "$NS" ] && { echo "usage: $0 <nameserver>" >&2; exit 1; }
ZONE=clovers.network

# name:type pairs to check, derived from the zone rather than hardcoded.
awk '!/^;/ && NF>=4 && $1 ~ /\.$/ { print $1 " " $4 }' clovers.network.zone \
  | sort -u \
  | while read -r name type; do
      # CNAME and A at the apex are the flattening case: ask for both.
      out=$(dig +norecurse +short "@$NS" "$name" "$type" 2>/dev/null \
            | sed 's/[[:space:]]\+/ /g' | sed 's/ *$//' | sort | paste -sd'|' -)
      printf '%-46s %-6s %s\n' "$name" "$type" "${out:-<EMPTY>}"
    done
# The apex resolves to addresses via flattening on Cloudflare and via ALIAS on
# NS1, so compare the addresses too -- this is the record most likely to differ.
for t in A AAAA; do
  out=$(dig +norecurse +short "@$NS" "$ZONE." $t 2>/dev/null | sort | paste -sd'|' -)
  printf '%-46s %-6s %s\n' "$ZONE. (flattened)" "$t" "${out:-<EMPTY>}"
done
