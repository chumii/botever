// Erkundungsskript für die WoWUtils-API. Steht bewusst neben dem Bot und wird
// von Hand gestartet:
//
//   npm run probe:wowutils                      Übersicht, nur lesend
//   npm run probe:wowutils -- --discord-id 123  sucht diese Discord-ID im Roster
//   npm run probe:wowutils -- --events 10       mehr Events für die Readiness-Suche
//   npm run probe:wowutils -- --set <eventId> <memberId> <status>
//
// Bis auf --set greift nichts schreibend zu. Ziel ist zu klären, wie sich ein
// Discord-Konto einem Roster-Mitglied zuordnen lässt: laut OpenAPI-Spec taucht
// discordUserId nur in der Readiness-Antwort auf, nicht im Roster-Export.

export {}; // erzwingt Modul-Scope, sonst kollidieren die Top-Level-Namen mit anderen Skripten in src/scripts

const env = process.env.NODE_ENV ?? 'development';
const envFile = env === 'production' ? '.env.prod' : '.env.dev';
require('dotenv').config({ path: envFile });

const BASE = 'https://api.wowutils.com';
const SIGNUP_STATUSES = ['present', 'absent', 'tentative', 'late', 'standby', 'pending'];

const apiKey = process.env.WOWUTILS_API_KEY;
if (!apiKey) {
  console.error(`WOWUTILS_API_KEY fehlt in ${envFile}.`);
  process.exit(1);
}

// Punktebudget pro Stunde: 60 im Basis-Tarif, Lesen kostet 1, Schreiben 2.
// Deshalb nach jedem Aufruf ausgeben, wie viel noch übrig ist.
async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${BASE}${path}`, {
    ...init,
    headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json', ...init?.headers },
  });

  const remaining = res.headers.get('X-RateLimit-Remaining');
  const cost = res.headers.get('X-RateLimit-Cost');
  console.log(`  ${init?.method ?? 'GET'} ${path} → ${res.status}${cost ? `, Kosten ${cost}` : ''}${remaining ? `, noch ${remaining} Punkte` : ''}`);

  if (res.status === 429) {
    throw new Error(`Rate-Limit erreicht. Retry-After: ${res.headers.get('Retry-After') ?? 'unbekannt'}s`);
  }
  if (!res.ok) {
    throw new Error(`${res.status} ${res.statusText}: ${(await res.text()).slice(0, 400)}`);
  }
  return res.json() as Promise<T>;
}

interface RosterCharacter { playerId: string; name: string; realm: string | null; status: string }
interface RosterMember {
  memberId: string;
  displayName: string;
  alias: string | null;
  battletag: string | null;
  rank: string;
  claimed: boolean;
  mainCharacter: string | null;
  characters: RosterCharacter[];
}
interface Signup { memberId: string; displayName: string | null; status: string; responded: boolean }
interface CalendarEvent {
  eventId: string;
  name: string;
  date: string;
  startTime: string;
  status: string;
  autoConfirmed: boolean;
  signups: Signup[];
}
interface ReadinessRef { memberId: string; displayName: string; discordUserId: string | null }
interface Readiness { notSignedUp: ReadinessRef[]; staleSims: ReadinessRef[]; missingWishlists: ReadinessRef[] }

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i === -1 ? undefined : process.argv[i + 1];
}

async function writeSignup(groupId: string, eventId: string, memberId: string, status: string) {
  if (!SIGNUP_STATUSES.includes(status)) {
    throw new Error(`Unbekannter Status "${status}". Erlaubt: ${SIGNUP_STATUSES.join(', ')}`);
  }
  console.log(`\n── Signup setzen (SCHREIBZUGRIFF) ──`);
  console.log(`  Event ${eventId}, Mitglied ${memberId} → ${status}`);
  const result = await api(`/v1/groups/${groupId}/calendar-events/${eventId}/signup/${memberId}`, {
    method: 'PUT',
    body: JSON.stringify({ status, comment: 'Gesetzt vom Botever-Probe-Skript' }),
  });
  console.log('  Antwort:', JSON.stringify(result, null, 2));
}

async function main() {
  const wantedDiscordId = arg('discord-id');
  const eventLimit = Number(arg('events') ?? 5);

  console.log('── Gruppe ──');
  const groups = await api<{ data: { groupId: string; name?: string }[] }>('/v1/groups');
  const group = groups.data[0];
  if (!group) throw new Error('Der Key gehört zu keiner Gruppe.');
  console.log(`  ${group.name ?? '(ohne Namen)'} — groupId ${group.groupId}`);
  const groupId = group.groupId;

  const setArgs = process.argv.indexOf('--set');
  if (setArgs !== -1) {
    const [eventId, memberId, status] = process.argv.slice(setArgs + 1, setArgs + 4);
    if (!eventId || !memberId || !status) throw new Error('--set braucht <eventId> <memberId> <status>');
    await writeSignup(groupId, eventId, memberId, status);
    return;
  }

  console.log('\n── Roster ──');
  const roster = await api<{ memberCount: number; members: RosterMember[] }>(`/v1/groups/${groupId}/roster`);
  console.log(`  ${roster.memberCount} Mitglieder. Enthält der Datensatz irgendwo eine Discord-ID?`);
  const rosterKeys = new Set(roster.members.flatMap(m => Object.keys(m)));
  console.log(`  Felder je Mitglied: ${[...rosterKeys].join(', ')}`);
  const discordish = [...rosterKeys].filter(k => /discord/i.test(k));
  console.log(discordish.length ? `  → Discord-Felder gefunden: ${discordish.join(', ')}` : '  → kein Discord-Feld im Roster, wie in der Spec beschrieben');

  console.log('\n  Mitglieder:');
  for (const m of roster.members) {
    const chars = m.characters.map(c => `${c.name}${c.realm ? '-' + c.realm : ''}`).join(', ');
    console.log(`    ${m.memberId.padEnd(30)} ${m.displayName.padEnd(18)} alias=${m.alias ?? '-'} battletag=${m.battletag ?? '-'} claimed=${m.claimed} rank=${m.rank}`);
    if (chars) console.log(`      Chars: ${chars}`);
  }

  console.log('\n── Kalender ──');
  const events = await api<{ data: CalendarEvent[]; serverTimeZone: string }>(`/v1/groups/${groupId}/calendar-events?upcoming=true&limit=100`);
  console.log(`  ${events.data.length} kommende Events, Zeitzone ${events.serverTimeZone}`);
  for (const e of events.data.slice(0, 10)) {
    console.log(`    ${e.date} ${e.startTime}  ${e.name.padEnd(24)} ${e.eventId}  status=${e.status} autoConfirmed=${e.autoConfirmed} signups=${e.signups.length}`);
  }

  const first = events.data[0];
  if (first) {
    console.log(`\n  Signups des ersten Events (${first.date} ${first.name}):`);
    for (const s of first.signups) {
      console.log(`    ${s.memberId.padEnd(30)} ${(s.displayName ?? '-').padEnd(18)} ${s.status.padEnd(10)} responded=${s.responded}`);
    }
  }

  // Der einzige Ort, an dem die API eine Discord-ID herausgibt. Die Listen
  // enthalten aber nur Mitglieder, die noch etwas erledigen müssen — deshalb
  // über mehrere Events sammeln und am Ende die Abdeckung ausweisen.
  console.log(`\n── Readiness (Discord-IDs), erste ${eventLimit} Events ──`);
  const discordIds = new Map<string, { memberId: string; displayName: string }>();
  for (const e of events.data.slice(0, eventLimit)) {
    const r = await api<Readiness>(`/v1/groups/${groupId}/calendar-events/${e.eventId}/readiness`);
    for (const ref of [...r.notSignedUp, ...r.staleSims, ...r.missingWishlists]) {
      if (ref.discordUserId) discordIds.set(ref.discordUserId, { memberId: ref.memberId, displayName: ref.displayName });
    }
  }

  console.log(`\n  ${discordIds.size} von ${roster.memberCount} Mitgliedern über Readiness auflösbar:`);
  for (const [discordId, m] of discordIds) {
    console.log(`    ${discordId.padEnd(20)} → ${m.memberId.padEnd(30)} ${m.displayName}`);
  }

  if (wantedDiscordId) {
    const hit = discordIds.get(wantedDiscordId);
    console.log(`\n  Gesucht: ${wantedDiscordId}`);
    console.log(hit ? `  → gefunden: memberId ${hit.memberId} (${hit.displayName})` : '  → nicht dabei. Entweder ist Discord nicht verknüpft, oder du stehst in keiner der Readiness-Listen (alles erledigt).');
  }
}

main().catch(err => {
  console.error('\nFehlgeschlagen:', err instanceof Error ? err.message : err);
  process.exit(1);
});
