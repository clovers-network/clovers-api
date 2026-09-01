#!/bin/bash
# Audit clovers.network against its authoritative nameserver.
#
# AXFR is refused, so the zone cannot simply be listed. This queries every name
# we can think of, from three sources: the reconstruction we already have,
# Certificate Transparency, and a wordlist. Absence of proof is not proof of
# absence -- a subdomain that never got a certificate and is not in the list
# stays invisible.
NS=dns1.p07.nsone.net
D=clovers.network
q() { dig +noall +answer +time=3 +tries=2 @$NS "$1" "$2" 2>/dev/null; }

# names from the reconstruction
grep -oE "^[a-z0-9_.*-]+\.clovers\.network\." clovers.network.zone | sed "s/\.$//" | sort -u > /tmp/names.txt
echo "$D" >> /tmp/names.txt

# names from Certificate Transparency
curl -s --max-time 45 "https://crt.sh/?q=%25.$D&output=json" 2>/dev/null \
  | python3 -c "
import sys,json
try:
  for r in json.load(sys.stdin):
    for n in r.get('name_value','').split('\n'):
      n=n.strip().lstrip('*.').lower()
      if n.endswith('clovers.network'): print(n)
except Exception: pass
" >> /tmp/names.txt

# common subdomains
for s in www api api2 api3 img images cdn static assets forum blog docs dev staging test \
         beta app mail email smtp imap pop webmail mx ftp ns1 ns2 vpn admin dashboard \
         status monitor grafana metrics git gitlab ci build deploy node eth rpc ipfs \
         graph subgraph analytics shop store pay wallet oracle bot discord telegram \
         m mobile old legacy new v2 www2 autoconfig autodiscover _dmarc _domainkey; do
  echo "$s.$D" >> /tmp/names.txt
done

sort -u /tmp/names.txt | grep -E "\.?clovers\.network$" > /tmp/candidates.txt
echo "  probing $(wc -l < /tmp/candidates.txt | tr -d ' ') candidate names against $NS"

: > /tmp/found.txt
while read -r n; do
  for t in A AAAA CNAME MX TXT SRV CAA NS; do
    out=$(q "$n" "$t")
    [ -n "$out" ] && echo "$out" >> /tmp/found.txt
  done
done < /tmp/candidates.txt

# wildcard check
echo "  wildcard: $(q "definitely-not-a-real-name-$RANDOM.$D" A | head -1 || echo none)"
sort -u /tmp/found.txt | grep -vE "^;" > /tmp/live.txt
echo "  live records found: $(wc -l < /tmp/live.txt | tr -d ' ')"
