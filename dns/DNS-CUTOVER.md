# DNS: move the delegation, then change the records

Two operations, deliberately separated. Move the nameservers with the zone
byte-identical, confirm nothing broke, and only then start repointing hosts.
Combined, a delegation problem and a records problem are indistinguishable.

## Where DNS actually lives

The nameservers are `dns1–4.p07.nsone.net`. Those are **Netlify's** — Netlify's
managed DNS runs on NS1 infrastructure. That is why logging into NS1 never
worked: the NS1 account belongs to Netlify, not to us.

The Netlify account holding the zone is *not* `hello@trifle.life`, which the
local CLI is logged into — that account has one team, zero sites and zero DNS
zones. Most likely `billy.rennekamp@gmail.com`, who authored the original
`netlify.toml` in 2017.

**None of that blocks the move.** The registrar outranks DNS: change the
delegation there and the Netlify zone becomes irrelevant.

## The zone came from Netlify in the end

`clovers.network.zone` is now generated from **Netlify's own DNS export**
(`export.csv`) by `from-export.mjs`, not reconstructed from outside. The
reconstruction is kept in `build-zone.sh` because the technique is useful when
no export is available, but it was wrong in two ways and both are instructive.

**It missed two records.** Neither is guessable and neither holds a certificate,
so no amount of Certificate Transparency or wordlist probing would have found
them:

    _github-challenge-clovers-network   TXT   GitHub domain verification
    email.mail.clovers.network          CNAME a second Mailgun alias, under mail

**It mis-modelled three, and that was the dangerous one.** Netlify's DNS has
`NETLIFY` and `NETLIFYV6` pseudo-records — ALIAS types resolving dynamically to
whatever Netlify's edge currently is. Queried from outside they answer as
ordinary addresses, so the apex, `www` and `dev` all looked like static A/AAAA
records pointing at `35.157.26.135`, `63.176.8.218` and
`2a05:d014:58f:6200::258/259`.

Imported that way the site would have worked — until Netlify rotated its edge
IPs, at which point the apex would break with nothing in the zone to explain
why. They are CNAMEs to the `netlify.app` hostname instead.

The lesson for any future zone move: an export from the provider beats querying
from outside, and the gap is not only the records you cannot see. It is also the
record *types* that look like something simpler than they are.

## Step 1 — import, unchanged

`clovers.network.zone` is a faithful copy. Regenerate it with
`node from-export.mjs export.csv > clovers.network.zone`.

22 records, covering all 25 export rows — the three fewer are `NETLIFYV6`
entries folded into their `NETLIFY` counterpart, since one CNAME serves both
address families. Every export row is accounted for; the zone parses clean.

No wildcard. No CAA, no DMARC, no DNSSEC DS at the parent, so changing the
delegation is safe and nothing is signed.

**The apex carries a CNAME alongside MX and TXT at the same name.** That is
illegal in plain DNS and legal on Cloudflare, which flattens it — resolving the
target itself and answering A/AAAA for the apex. Flattening is on by default for
the apex. Do not "fix" this by pasting in the addresses Netlify currently
answers with; see above for why.

Two adjustments, both unavoidable:

- **TTLs below 60 are raised to 60.** The live `_acme-challenge` records carry
  TTL 1, which Cloudflare rejects. Everything else keeps its real TTL.
- **NS and SOA are omitted.** Cloudflare generates its own.

**Import everything DNS-only (grey cloud).** Cloudflare's importer likes to
proxy A/AAAA/CNAME records by default; proxying changes TLS termination, origin
visibility and caching, and is a behaviour change that belongs in step 3.

## Step 2 — move the nameservers, then verify

We cannot pre-lower TTLs, because we do not control the current zone. The
longest TTL in play is 3600, so **budget an hour for propagation and the same
for rollback**.

After the switch, check every record still resolves the same:

```bash
for n in clovers.network www dev api api2 img forum mail email; do
  h=${n/#clovers.network/@}; [ "$h" = "@" ] && h=clovers.network || h=$n.clovers.network
  echo "$h: $(dig +short $h A) $(dig +short $h AAAA)"
done
dig +short clovers.network MX; dig +short clovers.network TXT
dig +short mailo._domainkey.mail.clovers.network TXT | head -c 60
```

**Mail is the thing to watch.** MX, SPF and both DKIM keys must survive intact
or outbound mail starts failing SPF/DKIM and inbound stops arriving. Send a test
message through Mailgun before declaring the move done.

## Step 3 — repoint, one record at a time

Only after step 2 is confirmed. Each of these is independent and reversible.

| Record | From | To | Notes |
|---|---|---|---|
| `api` | 206.81.16.230 | Fly | `fly certs add api.clovers.network` after the record exists |
| `api2` | 104.131.181.241 | same as `api` | path already matches; then destroy the droplet |
| `img` | 165.22.72.114 | same as `api` | the `/svg` alias makes the path match; then destroy |
| `forum` | 68.183.74.37 | `clovers-forum-archive.pages.dev` | custom domain in the Pages dashboard; then destroy |

`api2` and `img` need no code change — that is what the `/svg/:id/:size` alias
in `src/api/index.js` was for. Both hostnames stay working; only the machine
behind them changes.

Cloudflare caches at the edge: a stale response for ~15 minutes after a change
is normal and not a failed deploy. Seen during the archive work
(`cf-cache-status: HIT, age: 896`).

## Step 4 — worth adding once settled

Absent today, and cheap to add after the dust clears:

- **CAA.** Restricts who may issue certificates. Must include every issuer in
  use — Let's Encrypt, Cloudflare, and Fly — or renewals start failing.
- **DMARC.** SPF and DKIM are both present but nothing tells receivers what to
  do when they fail. Start at `p=none` and read the reports before tightening.
- **DNSSEC.** Cloudflare can sign the zone; it needs a DS record at the
  registrar to take effect.

## Two things the export settled

`_acme-challenge` answered when queried but is absent from the export — two
spent DNS-01 validation tokens, inert either way. Dropped rather than carried
forward.

And the apex points at Netlify, not at a server. Moving the nameservers does not
move the website: `clovers-no-bots` is a live site in the **bin-studio** team
and keeps serving through the CNAME. That is the right order — change the
delegation first, confirm nothing broke, then move hosts one record at a time.
It does mean whoever is still deploying that site should know the delegation is
moving, since their deploys will keep taking effect.

---

# Cutover completed — 2026-09-02

Delegation moved at **14:29:58Z** to `aleena.ns.cloudflare.com` and
`cesar.ns.cloudflare.com`. Registry updates took about 13 minutes to appear at
the `.network` servers.

## How it was verified

`verify.sh <nameserver>` resolves every name in the zone against one
authoritative server with `+norecurse`, so it reports what that server holds
rather than what a resolver cached. A baseline was captured from NS1 *before*
the switch, which is the part worth copying if this is ever done again — after
the delegation moves, the old answers are gone and there is nothing left to
compare against.

`baseline.txt` vs `after.txt` differed in exactly two lines:

    -dev.clovers.network.   CNAME  <EMPTY>
    +dev.clovers.network.   CNAME  dev-clovers.netlify.app.
    -www.clovers.network.   CNAME  <EMPTY>
    +www.clovers.network.   CNAME  clovers-no-bots.netlify.app.

Both are the intended correction. NS1 served those names as `NETLIFY`
pseudo-records, which answer nothing for a CNAME query while still returning
addresses — the behaviour that made the original reconstruction look right while
being wrong. Cloudflare serves real CNAMEs.

Everything else was byte-identical, including the flattened apex
(`35.157.26.135`, `63.176.8.218`, and both IPv6 addresses).

## Functional checks

| Target | Result |
|---|---|
| `clovers.network` | 200, certificate valid |
| `www` | 301 to apex |
| `dev`, `api`, `forum` | 200 |
| `img/svg/<board>` | 200, serving real images |
| Mailgun MX (both) | reachable on port 25 |
| SPF | `v=spf1 include:eu.mailgun.org ~all` |
| DKIM, both keys | 2048-bit, byte-identical to `export.csv` |

The DKIM check needed care. Those records are multi-string TXT values, and a
first pass that read each quoted chunk separately reported the keys as truncated
when they were not. Reassembling the chunks before comparing — and comparing
against the export rather than against a length heuristic — is the check that
actually means something. Multi-string TXT is exactly where a zone migration
truncates silently.

## What this retired

* The Netlify DNS account nobody could reach is no longer load-bearing.
* The parent/child nameserver disagreement is gone. The registry had been
  delegating to `dns*.p03.nsone.net` while the zone published
  `dns*.p07.nsone.net`; it resolved, but would have broken without warning if
  NS1 retired the p03 pool.

## Certificate renewal

The apex certificate is Let's Encrypt, valid 22 Aug – 20 Nov 2026, so Netlify
renews around 21 October. Validation is now HTTP-01 rather than DNS-01, which is
Netlify's normal path for externally-hosted DNS. A certificate warning on the
apex after that date points here, and the fix is to re-trigger provisioning.

Moot if the frontend has moved off Netlify by then.
