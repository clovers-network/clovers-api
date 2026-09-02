/**
 * Convert Netlify's DNS export into a Cloudflare-importable zone.
 *
 * This supersedes the reconstruction in build-zone.sh, which was built by
 * querying the authoritative nameservers because AXFR was refused. That
 * reconstruction was close but not correct, in two different ways -- both worth
 * recording, because they are the general hazards of rebuilding a zone from the
 * outside.
 *
 * MISSED, because they cannot be guessed and hold no certificate:
 *   _github-challenge-clovers-network   GitHub domain verification
 *   email.mail.clovers.network          a second Mailgun CNAME, nested under mail
 *
 * MIS-MODELLED, which was the dangerous one:
 *   Netlify's own DNS has NETLIFY and NETLIFYV6 pseudo-records -- ALIAS types
 *   that resolve dynamically to whatever Netlify's edge currently is. Querying
 *   from outside returns the *resolved* addresses, so the apex, www and dev all
 *   looked like ordinary A/AAAA records pointing at 35.157.26.135,
 *   63.176.8.218 and 2a05:d014:58f:6200::258/259.
 *
 *   Imported that way the site would have worked -- until Netlify rotated its
 *   edge IPs, at which point the apex would break with nothing in the zone to
 *   suggest why. They become CNAMEs to the netlify.app hostname instead.
 *
 * DROPPED: two _acme-challenge TXT records that answered when queried but are
 *   absent from the export. Spent DNS-01 validation tokens, inert either way.
 *
 *   node from-export.mjs export.csv > clovers.network.zone
 *   node from-export.mjs export.csv --import-safe > clovers.network.cloudflare.zone
 *
 * --import-safe omits the apex CNAME. A CNAME at the zone apex alongside MX and
 * TXT records at the same name is illegal under RFC 1034, and while Cloudflare
 * supports it through CNAME flattening, its BIND importer's behaviour is
 * undocumented -- it may reject the file, skip the record, or accept it. Rather
 * than find out during a migration, the apex goes in by hand afterwards, where
 * the dashboard definitely allows it. One manual record beats a partial import
 * whose failure mode you have to reverse-engineer.
 */
import fs from 'fs'

const argv = process.argv.slice(2)

const rows = fs.readFileSync(argv.find(a => !a.startsWith('--')) || 'export.csv', 'utf8')
  .split('\n').slice(1).filter(l => l.trim())
  .map(l => {
    const m = [...l.matchAll(/"((?:[^"]|"")*)"/g)].map(x => x[1].replace(/""/g, '"'))
    return { name: m[0], ttl: m[1], type: m[2].toUpperCase(), value: m[3] }
  })

const importSafe = argv.includes('--import-safe')

const out = []
const say = (s) => out.push(s)

say(`; clovers.network -- from Netlify's own DNS export`)
say(`; Converted by dns/from-export.mjs. ${rows.length} source records.`)
say(';')
say('; Netlify ALIAS types are rewritten as CNAMEs. At the apex that needs')
say("; Cloudflare's CNAME flattening, which is on by default -- Cloudflare")
say('; answers A/AAAA for the apex by resolving the target itself. Do not')
say('; substitute static A records: the addresses Netlify currently answers with')
say('; are not stable, and hard-coding them is a breakage with no visible cause.')
say(';')
say('; Everything here is DNS-only (grey cloud). Proxying changes TLS')
say('; termination and caching and is a separate decision.')
say(';')
say('; NOTE: the apex still points at Netlify, so moving the nameservers does')
say('; not move the website -- clovers-no-bots is a live site in the bin-studio')
say('; team and keeps serving. That is deliberate: change the delegation first,')
say('; then move hosts one record at a time.')
say('$TTL 3600')

const groups = [
  ['apex', (r) => r.name === 'clovers.network'],
  ['hosts', (r) => /^(www|dev|api|api2|img|forum)\./.test(r.name)],
  ['mail (Mailgun, EU region)', (r) => /^(mail|email|email\.mail)\./.test(r.name)],
  ['DKIM', (r) => r.name.includes('_domainkey')],
  ['domain verification', (r) => r.name.startsWith('_github-challenge')]
]
const used = new Set()

for (const [label, match] of groups) {
  const mine = rows.filter(r => !used.has(r) && match(r))
  if (!mine.length) continue
  mine.forEach(r => used.add(r))
  say('')
  say(`; ---- ${label} ----`)
  for (const r of mine) {
    const name = r.name.endsWith('.') ? r.name : r.name + '.'
    if (r.type === 'NETLIFY' || r.type === 'NETLIFYV6') {
      // One CNAME covers both; NETLIFYV6 is the same alias for AAAA.
      if (r.type === 'NETLIFYV6') continue
      if (importSafe && r.name === 'clovers.network') {
        say(`; APEX OMITTED FOR IMPORT -- add this by hand after importing:`)
        say(`;   Type CNAME  Name @  Target ${r.value}  Proxy off  TTL Auto`)
        continue
      }
      say(`${name}\t${r.ttl}\tIN\tCNAME\t${r.value}.`)
    } else if (r.type === 'TXT') {
      // TXT strings are capped at 255 bytes per chunk; the DKIM keys exceed it.
      const v = r.value
      const chunks = v.match(/.{1,255}/g) || [v]
      say(`${name}\t${r.ttl}\tIN\tTXT\t${chunks.map(c => `"${c}"`).join(' ')}`)
    } else if (r.type === 'MX') {
      say(`${name}\t${r.ttl}\tIN\tMX\t10 ${r.value}.`)
    } else if (r.type === 'CNAME') {
      say(`${name}\t${r.ttl}\tIN\tCNAME\t${r.value}.`)
    } else {
      say(`${name}\t${r.ttl}\tIN\t${r.type}\t${r.value}`)
    }
  }
}

const left = rows.filter(r => !used.has(r))
if (left.length) {
  say('')
  say('; ---- ungrouped (add a group in from-export.mjs) ----')
  left.forEach(r => say(`${r.name}.\t${r.ttl}\tIN\t${r.type}\t${r.value}`))
}

say('')
say('; ---- deliberately absent ----')
if (importSafe) say('; apex CNAME: see the note above -- added by hand after import.')
say('; NS/SOA: Cloudflare generates its own.')
say('; _acme-challenge: two spent DNS-01 tokens, live when queried but not in')
say(';   the export. Inert; dropped rather than carried forward.')
say('; CAA, DMARC, DNSSEC: none today. See DNS-CUTOVER.md.')

console.log(out.join('\n'))
