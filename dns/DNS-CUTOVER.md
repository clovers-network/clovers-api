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

## Step 1 — import, unchanged

`clovers.network.zone` is a faithful copy, regenerate it with
`./audit.sh && ./build-zone.sh > clovers.network.zone`.

31 records. Verified complete against three independent name sources — the
earlier reconstruction, Certificate Transparency, and a subdomain wordlist —
with every name and every record cross-checked against the live authoritative
server. No wildcard. No CAA, no DMARC, no DNSSEC DS at the parent, so changing
the delegation is safe and nothing is signed.

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

## The leftover ACME tokens

`_acme-challenge` holds two DNS-01 validation tokens from a completed issuance.
They are inert — DNS-01 tokens are per-issuance and these are long spent — and
they are carried over only because this step copies rather than edits. Safe to
delete once the move is verified.
