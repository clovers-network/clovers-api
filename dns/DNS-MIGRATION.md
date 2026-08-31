# Moving clovers.network DNS to Cloudflare

**Status:** proposed, not executed. **Prepared:** 2026-08-31

DNS is hosted at NS1 (`dns1–4.p07.nsone.net`) and the NS1 login and account
recovery are both failing, so the zone cannot be edited or exported. Nameservers
can still be changed at the registrar.

## Verified before recommending anything

**DNSSEC is not enabled.** No `DS` record exists at the parent. This matters more
than anything else here: changing nameservers on a DNSSEC-signed domain without
first removing the DS record takes the domain *completely* offline — every name,
including mail — and the fix has to propagate before service returns. That risk
does not apply.

**Email is live** via Mailgun's EU region, with SPF on the apex and on
`mail.clovers.network`, plus **two DKIM keys**. Losing any of it degrades or
breaks mail silently rather than loudly.

## The reconstructed zone

`dns/clovers.network.zone` — 26 records, captured by querying NS1
authoritatively. Summary:

| Name | Type | Value |
|---|---|---|
| apex | A | 35.157.26.135, 63.176.8.218 *(AWS — the dapp)* |
| apex | AAAA | 2a05:d014:58f:6200::258, ::259 |
| apex | MX | mxa/mxb.eu.mailgun.org (10) |
| apex | TXT ×5 | SPF, **two** google-site-verification, brave-ledger, fortmatic |
| `pic._domainkey` | TXT | DKIM |
| www, dev | A | AWS (same pair as apex) |
| api | A | 206.81.16.230 |
| api2 | A | 104.131.181.241 |
| img | A | 165.22.72.114 |
| forum | A | 68.183.74.37 |
| mail | MX, TXT | Mailgun + SPF |
| `mailo._domainkey.mail` | TXT | DKIM |
| email | CNAME | eu.mailgun.org *(Mailgun tracking)* |

## Why AXFR cannot solve this for us

`AXFR` — a zone transfer — is the canonical way to obtain a *complete* record
list, with no guessing. It is refused here, and correctly so.

Authorization for AXFR is one of: an **IP allowlist** on the authoritative
server, a **TSIG** shared secret (RFC 8945), or occasionally SIG(0)/mutual TLS.
All three are configured **server-side by whoever controls the zone**. There is
nothing to sign up for, and there cannot be: a zone transfer exposes a domain's
entire infrastructure, so outsider access would be a vulnerability rather than a
feature. Confirmed refused on both NS1 pools, while ordinary TCP queries to the
same servers succeed — so it is an authorization denial, not a network problem.

Cloudflare's onboarding does **not** close the gap either. Their own docs: "the
quick scan is not guaranteed to find all existing DNS records", and you "need to
review your records." It is the same best-effort name-guessing approach.

## How complete is this reconstruction?

Better than pure guessing, thanks to two independent sources.

**Certificate Transparency gives near-certainty on the HTTPS surface.** Every
publicly-trusted certificate is logged, so any subdomain that ever served HTTPS
is discoverable. Across **765 certificates** for `%.clovers.network`, crt.sh
returns exactly **7 names** — apex, www, dev, api, api2, img, forum — every one
of which is already in the zone file. No hostname was missed.

**What CT cannot see** is anything that never had a certificate: mail-only names
and TXT-only records. Those were swept explicitly — ~20 further DKIM selectors,
DMARC, MTA-STS, BIMI, PSL, ACME, common SRV names, CAA, and a wildcard. That
found one more record (`_acme-challenge`, a stale DNS-01 token, now included)
and nothing else.

So the residual risk is narrow but real: a TXT or non-HTTPS record under a name
neither the CT logs nor a ~60-name sweep surfaced. Two earlier finds show why it
is not zero — `pic._domainkey` sits on a selector nothing would suggest, and a
**second** `google-site-verification` TXT was initially hidden by truncated
output. Impact if something is missed: a third-party integration quietly stops
trusting the domain, or a mail-only name breaks. Recoverable, but hard to
diagnose later.

**NS1 recovery is still worth one real attempt**, because it converts "narrow
residual risk" into "none". And there is a strong lever for it: **the registrar
is Name.com and it is accessible**, which is proof of domain control — exactly
what a DNS provider needs to justify account recovery or a zone export. That is
a far better case than a forgotten password. NS1 is IBM-owned, so escalate
through IBM support. Ask for either account access *or* AXFR allowlisted to an
IP you control; either one ends the guessing.

## If proceeding anyway

1. **Add the zone to Cloudflare.** Its onboarding runs an *independent* record
   scan. Diff its findings against `clovers.network.zone` — the union of two
   imperfect discoveries beats either alone.
2. **Import the zone file** to fill whatever the scan missed.
3. **Set every record to DNS-only (grey cloud) at first.** Proxying the apex
   would route dapp traffic through Cloudflare and move TLS termination, which
   is a behaviour change on top of a migration. Replicate today exactly, then
   enable proxying deliberately and separately.
4. **Verify before switching.** Cloudflare assigns nameservers on zone creation
   and answers on them immediately. Diff every known name against NS1 *before*
   touching the registrar:

   ```sh
   CF_NS=<assigned>.ns.cloudflare.com
   for n in @ www dev api api2 img forum mail email; do
     h=$([ "$n" = "@" ] && echo clovers.network || echo $n.clovers.network)
     echo "$h  NS1=$(dig +short A $h @dns1.p07.nsone.net | sort | tr '\n' ',')  CF=$(dig +short A $h @$CF_NS | sort | tr '\n' ',')"
   done
   ```
   Do the same for `MX`, `TXT`, and both `_domainkey` names. Only switch when
   every answer matches.
5. **Change nameservers at the registrar — Name.com** (IANA 625; domain expires
   2027-08-12; status `client transfer prohibited`, which is a normal anti-hijack
   lock and does *not* block a nameserver change).

   **Note the delegation oddity.** The registry delegates to the **p03** pool,
   while the zone's own NS records name **p07**:

   ```
   parent delegation (.network registry) -> dns1-4.p03.nsone.net
   in-zone NS records                    -> dns1-4.p07.nsone.net
   ```

   Both pools answer correctly, so nothing is broken — NS1 evidently moved the
   zone and one side was never updated. Resolvers follow the parent, so **p03 is
   what you are actually replacing**. Record both sets for rollback:
   `dns1-4.p03.nsone.net` and `dns1-4.p07.nsone.net`.
6. **Afterwards, send a test email** both directions and check the Mailgun
   dashboard for SPF/DKIM alignment. Mail is the failure most likely to go
   unnoticed.

## Rollback

Point the registrar back at the four NS1 nameservers above. NS1 still holds the
authoritative zone — nothing here deletes it — so reverting restores the exact
prior state, subject to propagation.

## Registrar migration: not yet

Moving the registrar to Cloudflare is a separate decision and should not be
bundled with this. Do the DNS move, let it sit, then consider it.
