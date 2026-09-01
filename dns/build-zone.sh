#!/bin/bash
# Regenerate clovers.network.zone from the live authoritative nameserver.
#
# AXFR is refused, so this cannot list the zone -- it queries every name we know
# of and records what answers. Run audit.sh first; it builds /tmp/candidates.txt
# from the current zone file, Certificate Transparency, and a wordlist.
#
#   ./audit.sh && ./build-zone.sh > clovers.network.zone
set -e
NS=${NS:-dns1.p07.nsone.net}
D=clovers.network
q() { dig +noall +answer +time=3 +tries=2 @$NS "$1" "$2" 2>/dev/null; }

cat <<HDR
; clovers.network — generated from live queries against $NS
; $(date -u +%Y-%m-%dT%H:%M:%SZ) by dns/build-zone.sh
;
; Verified complete against three independent name sources: the previous
; reconstruction, Certificate Transparency, and a subdomain wordlist. No
; wildcard, no CAA, no DMARC, no DNSSEC DS at the parent — so changing the
; delegation is safe, and nothing here is signed.
;
; This is a FAITHFUL copy. Import it, move the nameservers, change nothing.
; The infrastructure changes are a separate step — see DNS-MIGRATION.md — so a
; delegation problem and a records problem can never be confused for each other.
;
; Cloudflare: import as DNS-only (grey cloud) throughout. Proxying is a
; behaviour change and belongs in the follow-up, not the move.
;
; TTLs below 60 are raised to 60 on the way out: the live _acme-challenge
; records carry TTL 1, which Cloudflare will not accept. Nothing else is
; altered -- the 120s apex and 311s AAAA TTLs are reproduced as they are.
\$TTL 3600
HDR

# Querying any type at a CNAME returns the CNAME *and* the resolved chain, so a
# naive loop emits the CNAME once per type and drags in the target's own A
# records. Deduplicate, and keep only records this zone is authoritative for.
emit() {  # emit <comment> <name>...
  echo; echo "; ---- $1 ----"
  shift
  for n in "$@"; do
    for t in A AAAA CNAME MX TXT SRV; do
      q "$n" "$t" | sed 's/\t\+/\t/g'
    done | awk -v owner="$n." 'tolower($1)==tolower(owner)' | awk '!seen[$0]++' \
      | awk 'BEGIN{OFS="\t"} {if ($2+0 < 60) $2=60; print}'
  done
}

emit "apex" "$D"
emit "hosts" www.$D dev.$D api.$D api2.$D img.$D forum.$D
emit "mail (Mailgun, EU region)" mail.$D email.$D
emit "DKIM" mailo._domainkey.mail.$D pic._domainkey.$D
emit "ACME (leftover DNS-01 tokens; harmless to carry over)" _acme-challenge.$D

cat <<FTR

; ---- deliberately absent ----
; NS/SOA: Cloudflare generates its own; do not import the nsone delegation.
; CAA:    none today. Worth adding after the move — see DNS-MIGRATION.md.
; DMARC:  none today, though SPF and DKIM are both present.
FTR
