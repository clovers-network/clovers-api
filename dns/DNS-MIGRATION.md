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

## The one honest caveat

**This reconstruction cannot be proven complete.** DNS offers no enumeration —
`AXFR` is refused, as expected — so every record above was found by *guessing a
name and asking*. Two finds show that is a real gap, not a theoretical one:

- `pic._domainkey.clovers.network` — an unusual selector, found only because the
  guess list was broad. Nothing would have suggested "pic".
- A **second** `google-site-verification` TXT on the apex, initially hidden by
  truncated output.

If a record exists under a name nobody guessed, it will be silently dropped.
Likely candidates and impact: a verification TXT (a third-party integration
quietly stops trusting the domain) or an obscure subdomain (that host becomes
unreachable). Neither is catastrophic; both are annoying and hard to diagnose
later.

**So try NS1 recovery once more first.** A real zone export makes this whole
exercise risk-free. NS1 is now part of IBM, so support may be reachable through
IBM channels even if self-service recovery is broken. One attempt is worth more
than any amount of guessing.

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
5. **Change nameservers at the registrar**, keeping the NS1 names recorded:
   `dns1.p07.nsone.net`, `dns2.p07.nsone.net`, `dns3.p07.nsone.net`,
   `dns4.p07.nsone.net`.
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
