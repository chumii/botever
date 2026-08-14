// Schlägt die Erstbefüllung von members.wowutils_member_id vor.
//
//   npm run seed:wowutils
//
// Gleicht members.name gegen displayName und alias im WoWUtils-Roster ab
// (kleingeschrieben, ohne Akzente) und gibt fertige UPDATE-Statements aus. Das
// Skript schreibt selbst nichts — die Zuordnung über Namen ist eine Vermutung
// und gehört vor dem Anwenden durchgesehen, besonders bei gleichen Vornamen.
//
// Danach ist der Weg für neue Leute der Verknüpfen-Button in /abmeldungen; auf
// diesen Abgleich sollte man sich nicht dauerhaft verlassen, weil automatisch
// angelegte Mitglieder ihren Discord-Namen als name tragen, nicht den Vornamen.

const env = process.env.NODE_ENV ?? 'development';
require('dotenv').config({ path: env === 'production' ? '.env.prod' : '.env.dev' });

// require() statt import: statische ES-imports werden von esbuild/tsx vor dem
// restlichen Dateiinhalt ausgewertet, auch wenn sie textuell danach stehen —
// lib/supabase würde dann vor dem dotenv.config() oben laufen und sofort wegen
// fehlender SUPABASE_URL werfen. Siehe dasselbe Muster in src/index.ts.
const { sb } = require('../lib/supabase');
import { getRoster, isConfigured } from '../lib/wowutils';
import type { RosterMember } from '../lib/wowutils';

interface Member {
  id: string;
  name: string | null;
  discord_name: string | null;
  wowutils_member_id: string | null;
}

function normalize(s: string): string {
  return s.normalize('NFKD').replace(/[\u0300-\u036f]/g, '').toLowerCase().trim();
}

function sqlQuote(s: string): string {
  return `'${s.replace(/'/g, "''")}'`;
}

async function main() {
  if (!isConfigured()) throw new Error('WOWUTILS_API_KEY fehlt.');

  const roster = await getRoster();
  const { data: members, error } = await sb.from('members').select('id, name, discord_name, wowutils_member_id').order('name');
  if (error) throw error;

  // Ein Roster-Eintrag ist über displayName und über alias auffindbar. Namen, die
  // mehrfach vorkommen, werden verworfen statt geraten.
  const byName = new Map<string, RosterMember | null>();
  for (const m of roster) {
    for (const candidate of [m.displayName, m.alias]) {
      if (!candidate) continue;
      const key = normalize(candidate);
      byName.set(key, byName.has(key) && byName.get(key)?.memberId !== m.memberId ? null : m);
    }
  }

  const matches: { member: Member; roster: RosterMember }[] = [];
  const ambiguous: string[] = [];
  const unmatched: string[] = [];
  let already = 0;

  for (const member of (members ?? []) as Member[]) {
    if (member.wowutils_member_id) { already++; continue; }
    if (!member.name) { unmatched.push('(ohne Namen)'); continue; }

    const hit = byName.get(normalize(member.name));
    if (hit === null) {
      ambiguous.push(member.name);
    } else if (hit) {
      matches.push({ member, roster: hit });
    } else {
      unmatched.push(`${member.name} (${member.discord_name ?? '-'})`);
    }
  }

  const mappedRosterIds = new Set(matches.map(m => m.roster.memberId));
  const rosterWithout = roster.filter(m => !mappedRosterIds.has(m.memberId));

  console.log(`Roster: ${roster.length} Mitglieder · Supabase: ${members?.length ?? 0} Zeilen · bereits verknüpft: ${already}\n`);

  console.log(`── Vorschläge (${matches.length}) ──`);
  for (const { member, roster: hit } of matches) {
    console.log(`update members set wowutils_member_id = ${sqlQuote(hit.memberId)} where id = ${sqlQuote(member.id)}; -- ${member.name} → ${hit.displayName}`);
  }

  if (ambiguous.length) {
    console.log(`\n── Mehrdeutig, nicht zugeordnet (${ambiguous.length}) ──`);
    console.log('  Der Name kommt im Roster mehrfach vor. Von Hand zuordnen.');
    for (const a of ambiguous) console.log(`  ${a}`);
  }

  if (unmatched.length) {
    console.log(`\n── Ohne Roster-Treffer (${unmatched.length}) ──`);
    for (const u of unmatched) console.log(`  ${u}`);
  }

  if (rosterWithout.length) {
    console.log(`\n── Roster-Mitglieder ohne Supabase-Zeile (${rosterWithout.length}) ──`);
    console.log('  Diese Leute legen ihre Zeile an, sobald sie den Bot benutzen, und verknüpfen sich dann selbst.');
    for (const m of rosterWithout) console.log(`  ${m.displayName.padEnd(18)} ${m.memberId}`);
  }

  console.log('\nDie UPDATE-Zeilen prüfen und im Supabase-SQL-Editor ausführen.');
}

main().catch(err => {
  console.error('\nFehlgeschlagen:', err instanceof Error ? err.message : err);
  process.exit(1);
});
