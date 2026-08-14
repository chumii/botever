// Anbindung an die WoWUtils-Gruppen-API (https://api.wowutils.com).
//
// Verwendet wird nur ein Ausschnitt: Roster lesen, Kalender-Events im Zeitraum
// lesen, Signups setzen. Ohne WOWUTILS_API_KEY ist die Anbindung stillgelegt,
// der Bot läuft dann ohne Kalender-Abgleich weiter.

const BASE = 'https://api.wowutils.com';

export type SignupStatus = 'present' | 'absent' | 'tentative' | 'late' | 'standby' | 'pending';

export interface RosterCharacter {
  name: string;
  realm: string | null;
}

export interface RosterMember {
  memberId: string;
  displayName: string;
  alias: string | null;
  battletag: string | null;
  rank: string;
  characters: RosterCharacter[];
}

interface CalendarSignup {
  memberId: string;
  status: SignupStatus;
}

interface CalendarEvent {
  eventId: string;
  name: string;
  date: string;
  status: 'planned' | 'cancelled';
  signups: CalendarSignup[];
}

export interface SyncResult {
  changed: number;
  /** Events, in denen das Mitglied nicht auf der Signup-Liste steht oder schon den Zielstatus hat. */
  skipped: number;
  failed: number;
}

export function isConfigured(): boolean {
  return Boolean(process.env.WOWUTILS_API_KEY);
}

async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${BASE}${path}`, {
    ...init,
    headers: { Authorization: `Bearer ${process.env.WOWUTILS_API_KEY}`, 'Content-Type': 'application/json', ...init?.headers },
  });

  if (res.status === 429) {
    throw new Error(`WoWUtils-Rate-Limit erreicht, erneut möglich in ${res.headers.get('Retry-After') ?? '?'}s`);
  }
  if (!res.ok) {
    throw new Error(`WoWUtils ${init?.method ?? 'GET'} ${path}: ${res.status} ${(await res.text()).slice(0, 200)}`);
  }
  return res.json() as Promise<T>;
}

// Die groupId hängt am API-Key und ändert sich nicht, also einmal je Prozess holen.
let cachedGroupId: string | undefined;

export async function getGroupId(): Promise<string> {
  if (cachedGroupId) return cachedGroupId;
  const { data } = await api<{ data: { groupId: string }[] }>('/v1/groups');
  const groupId = data[0]?.groupId;
  if (!groupId) throw new Error('WoWUtils: Der API-Key gehört zu keiner Gruppe.');
  cachedGroupId = groupId;
  return groupId;
}

export async function getRoster(): Promise<RosterMember[]> {
  const groupId = await getGroupId();
  const { members } = await api<{ members: RosterMember[] }>(`/v1/groups/${groupId}/roster`);
  return members;
}

export type RosterRank = 'GM' | 'Officer' | 'Raider' | 'Trial' | 'Social';
export type MainRole = 'tank' | 'healer' | 'melee' | 'ranged';

export interface RosterWriteFields {
  displayName?: string;
  rank?: RosterRank;
  mainRole?: MainRole;
  /** "" löscht den Battletag; undefined lässt ihn unverändert. */
  battletag?: string;
  character?: { name: string; realm: string };
}

// Der Charakter muss WoWUtils bereits aus dem verknüpften Gilden-Sync bekannt
// sein — Klasse und Spec kommen von dort. Ein unbekannter Charakter liefert
// einen 400 mit Klartext-Namen im Fehlertext, der 1:1 an den Officer geht.
export async function addRosterMember(fields: RosterWriteFields & { displayName: string }): Promise<{ memberId: string }> {
  const groupId = await getGroupId();
  const body: Record<string, unknown> = { displayName: fields.displayName };
  if (fields.rank) body.rank = fields.rank;
  if (fields.mainRole) body.mainRole = fields.mainRole;
  if (fields.battletag) body.battletag = fields.battletag;
  if (fields.character) body.characters = [{ name: fields.character.name, realm: fields.character.realm }];
  const result = await api<{ memberId: string }>(`/v1/groups/${groupId}/roster/members`, { method: 'POST', body: JSON.stringify(body) });
  return result;
}

export async function updateRosterMember(memberId: string, fields: RosterWriteFields): Promise<void> {
  const groupId = await getGroupId();
  const body: Record<string, unknown> = {};
  if (fields.displayName) body.displayName = fields.displayName;
  if (fields.rank) body.rank = fields.rank;
  if (fields.mainRole) body.mainRole = fields.mainRole;
  if (fields.battletag !== undefined) body.battletag = fields.battletag;
  if (fields.character) body.characters = [{ name: fields.character.name, realm: fields.character.realm }];
  await api(`/v1/groups/${groupId}/roster/members/${memberId}`, { method: 'PUT', body: JSON.stringify(body) });
}

export async function removeRosterMember(memberId: string): Promise<void> {
  const groupId = await getGroupId();
  await api(`/v1/groups/${groupId}/roster/members/${memberId}`, { method: 'DELETE' });
}

// Kalenderdaten kommen als YYYY-MM-DD in der Serverzeitzone der Gruppe; unsere
// Abmeldungen liegen im selben Format vor, ein Stringvergleich genügt daher.
async function getEventsInRange(isoStart: string, isoEnd: string): Promise<CalendarEvent[]> {
  const groupId = await getGroupId();
  const { data } = await api<{ data: CalendarEvent[] }>(`/v1/groups/${groupId}/calendar-events?upcoming=true&limit=500`);
  return data.filter(e => e.status === 'planned' && e.date >= isoStart && e.date <= isoEnd);
}

async function setSignup(eventId: string, memberId: string, status: SignupStatus, comment: string): Promise<void> {
  const groupId = await getGroupId();
  await api(`/v1/groups/${groupId}/calendar-events/${eventId}/signup/${memberId}`, {
    method: 'PUT',
    body: JSON.stringify({ status, comment }),
  });
}

// Setzt in allen Events des Zeitraums den Signup-Status. `only` begrenzt auf
// Signups, die aktuell einen bestimmten Status haben — damit lässt sich eine
// zurückgenommene Abmeldung aufräumen, ohne von Hand gesetzte Antworten zu
// überschreiben. Das Mitglied muss laut API bereits auf der Signup-Liste stehen;
// Events ohne passenden Eintrag werden übersprungen.
async function applyToRange(
  memberId: string,
  isoStart: string,
  isoEnd: string,
  status: SignupStatus,
  comment: string,
  only?: SignupStatus,
): Promise<SyncResult> {
  const events = await getEventsInRange(isoStart, isoEnd);
  const result: SyncResult = { changed: 0, skipped: 0, failed: 0 };

  for (const event of events) {
    const signup = event.signups.find(s => s.memberId === memberId);
    if (!signup || signup.status === status || (only && signup.status !== only)) {
      result.skipped++;
      continue;
    }
    try {
      await setSignup(event.eventId, memberId, status, comment);
      result.changed++;
    } catch (e) {
      console.error(`[wowutils] Signup für Event ${event.eventId} fehlgeschlagen:`, e);
      result.failed++;
    }
  }

  return result;
}

/** Trägt eine Abmeldung als `absent` in alle Events des Zeitraums ein. */
export function applyAbsence(memberId: string, isoStart: string, isoEnd: string): Promise<SyncResult> {
  return applyToRange(memberId, isoStart, isoEnd, 'absent', 'Abmeldung über Botever');
}

/**
 * Nimmt eine Abmeldung zurück: setzt nur die Signups auf `pending`, die noch auf
 * `absent` stehen. Wer inzwischen von Hand auf `present` gesetzt wurde, bleibt
 * unangetastet.
 */
export function clearAbsence(memberId: string, isoStart: string, isoEnd: string): Promise<SyncResult> {
  return applyToRange(memberId, isoStart, isoEnd, 'pending', 'Abmeldung über Botever zurückgenommen', 'absent');
}
