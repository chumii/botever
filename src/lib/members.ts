import { sb } from './supabase';

export interface Member {
  id: string;
  wowutils_member_id: string | null;
  raider_channel_id: string | null;
}

const COLUMNS = 'id, wowutils_member_id, raider_channel_id';

// Sucht primär über die unveränderliche Discord-User-ID. Ältere Datensätze
// haben noch keine discord_id; die werden über den Namen gefunden und dabei
// nachgetragen.
export async function findOrCreateMember(user: { id: string; username: string }): Promise<Member> {
  const { data: byId, error: idErr } = await sb.from('members').select(COLUMNS).eq('discord_id', user.id).maybeSingle();
  if (idErr) { console.error('[members] select by discord_id error:', idErr); throw idErr; }
  if (byId) return byId;

  const { data: byName, error: nameErr } = await sb.from('members').select(COLUMNS).eq('discord_name', user.username).is('discord_id', null).maybeSingle();
  if (nameErr) { console.error('[members] select by discord_name error:', nameErr); throw nameErr; }
  if (byName) {
    const { error: backfillErr } = await sb.from('members').update({ discord_id: user.id }).eq('id', byName.id);
    if (backfillErr) console.error('[members] discord_id backfill error:', backfillErr);
    return byName;
  }

  const { data: created, error: insertErr } = await sb.from('members').insert({ name: user.username, discord_name: user.username, discord_id: user.id }).select(COLUMNS).single();
  if (insertErr) { console.error('[members] insert error:', insertErr); throw insertErr; }
  return created;
}
