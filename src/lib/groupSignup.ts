import { Guild, Message, EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle } from 'discord.js';
import { sb } from './supabase';

export type RoleKey = 'tank' | 'healer' | 'dd' | 'tank_healer' | 'tank_dd' | 'healer_dd' | 'any';

// Rollenwahl läuft über Reactions statt Buttons, damit Discord die eigene
// Auswahl automatisch nur für einen selbst hervorhebt — bei Buttons ist das
// nicht möglich, die sehen für alle Betrachter gleich aus. Reactions können
// aber immer nur ein Emoji tragen, deshalb brauchen die drei Kombi-Rollen
// eigene, sonst ungenutzte Symbole statt zweier gestapelter Icons.
export const ROLE_EMOJI: Record<RoleKey, string> = {
  tank: '🛡️',
  healer: '💚',
  dd: '⚔️',
  tank_healer: '🔰',
  tank_dd: '🗡️',
  healer_dd: '💫',
  any: '🎲',
};

const ROLE_LABEL: Record<RoleKey, string> = {
  tank: 'Tank',
  healer: 'Heiler',
  dd: 'DD',
  tank_healer: 'Tank/Heiler',
  tank_dd: 'Tank/DD',
  healer_dd: 'Heiler/DD',
  any: 'Egal',
};

const ROLE_ORDER: RoleKey[] = ['tank', 'healer', 'dd', 'tank_healer', 'tank_dd', 'healer_dd', 'any'];

export const ROLE_BY_EMOJI: Record<string, RoleKey> = Object.fromEntries(ROLE_ORDER.map(r => [ROLE_EMOJI[r], r]));

interface EventRow {
  id: string;
  creator_discord_id: string;
  size: number;
  description: string | null;
  status: 'open' | 'closed';
}

interface SignupRow {
  discord_user_id: string;
  role: RoleKey;
  signed_up_at: string;
}

export async function createEvent(params: { guildId: string; channelId: string; creatorDiscordId: string; size: number; description?: string }): Promise<string> {
  const { data, error } = await sb.from('group_events').insert({
    guild_id: params.guildId,
    channel_id: params.channelId,
    creator_discord_id: params.creatorDiscordId,
    size: params.size,
    description: params.description || null,
  }).select('id').single();
  if (error) { console.error('[groupSignup] createEvent error:', error); throw error; }
  return data.id;
}

export async function setEventMessage(eventId: string, messageId: string): Promise<void> {
  const { error } = await sb.from('group_events').update({ message_id: messageId }).eq('id', eventId);
  if (error) console.error('[groupSignup] setEventMessage error:', error);
}

export async function getEvent(eventId: string): Promise<EventRow | null> {
  const { data } = await sb.from('group_events').select('id, creator_discord_id, size, description, status').eq('id', eventId).maybeSingle();
  return data;
}

export async function getEventIdByMessageId(messageId: string): Promise<string | null> {
  const { data } = await sb.from('group_events').select('id').eq('message_id', messageId).maybeSingle();
  return data?.id ?? null;
}

// Wer die eigene Rolle wechselt, behält ihren Platz in der Reihenfolge — ein
// Upsert, der nur `role` mitschickt, lässt signed_up_at beim bestehenden Wert.
export async function setSignup(eventId: string, discordUserId: string, role: RoleKey): Promise<void> {
  const { error } = await sb.from('group_event_signups')
    .upsert({ event_id: eventId, discord_user_id: discordUserId, role }, { onConflict: 'event_id,discord_user_id' });
  if (error) { console.error('[groupSignup] setSignup error:', error); throw error; }
}

export async function removeSignup(eventId: string, discordUserId: string): Promise<void> {
  const { error } = await sb.from('group_event_signups').delete().eq('event_id', eventId).eq('discord_user_id', discordUserId);
  if (error) { console.error('[groupSignup] removeSignup error:', error); throw error; }
}

export async function closeEvent(eventId: string): Promise<void> {
  const { error } = await sb.from('group_events').update({ status: 'closed' }).eq('id', eventId);
  if (error) { console.error('[groupSignup] closeEvent error:', error); throw error; }
}

export async function openEvent(eventId: string): Promise<void> {
  const { error } = await sb.from('group_events').update({ status: 'open' }).eq('id', eventId);
  if (error) { console.error('[groupSignup] openEvent error:', error); throw error; }
}

export async function deleteEvent(eventId: string): Promise<void> {
  const { error } = await sb.from('group_events').delete().eq('id', eventId);
  if (error) { console.error('[groupSignup] deleteEvent error:', error); throw error; }
}

/** Setzt die 7 Rollen-Reactions auf eine frisch gepostete Anmeldung. Reihenfolge = ROLE_ORDER. */
export async function addRoleReactions(message: Message): Promise<void> {
  for (const role of ROLE_ORDER) {
    await message.react(ROLE_EMOJI[role]);
  }
}

function adminButtons(eventId: string, closed: boolean): ActionRowBuilder<ButtonBuilder>[] {
  const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder().setCustomId(`lfg-delete:${eventId}`).setLabel('Löschen').setEmoji('🗑️').setStyle(ButtonStyle.Danger),
  );
  if (closed) row.addComponents(new ButtonBuilder().setCustomId(`lfg-open:${eventId}`).setLabel('Wieder öffnen').setEmoji('🔓').setStyle(ButtonStyle.Success));
  else row.addComponents(new ButtonBuilder().setCustomId(`lfg-close:${eventId}`).setLabel('Schließen').setEmoji('🔒').setStyle(ButtonStyle.Secondary));
  return [row];
}

/** Baut Embed + Buttons für den aktuellen Stand. null, wenn das Event nicht mehr existiert. */
export async function buildEventMessage(guild: Guild, eventId: string): Promise<{ embeds: EmbedBuilder[]; components: ActionRowBuilder<ButtonBuilder>[] } | null> {
  const event = await getEvent(eventId);
  if (!event) return null;

  const { data: signups } = await sb.from('group_event_signups').select('discord_user_id, role, signed_up_at').eq('event_id', eventId).order('signed_up_at');
  const rows = (signups ?? []) as SignupRow[];

  // Server-Alias, falls gesetzt, sonst der allgemeine Discord-Name — genau
  // das liefert GuildMember.displayName, dafür braucht es den Guild-Member-
  // statt den reinen User-Fetch.
  const members = await Promise.all(rows.map(s => guild.members.fetch(s.discord_user_id).catch(() => null)));
  const lines = rows.map((s, i) => `${ROLE_EMOJI[s.role]} ${members[i]?.displayName ?? `<@${s.discord_user_id}>`}`);

  const confirmed = lines.slice(0, event.size);
  const waitlist = lines.slice(event.size);

  const embed = new EmbedBuilder()
    .setTitle(event.status === 'closed' ? '🔒 Anmeldung (geschlossen)' : '📋 Anmeldung')
    .addFields({ name: `✅ Angemeldet (${Math.min(rows.length, event.size)}/${event.size})`, value: confirmed.join('\n') || '_Noch niemand angemeldet_' });
  if (event.description) embed.setDescription(event.description);
  if (waitlist.length) embed.addFields({ name: `⏳ Warteliste (${waitlist.length})`, value: waitlist.join('\n') });
  if (event.status === 'open') embed.setFooter({ text: ROLE_ORDER.map(r => `${ROLE_EMOJI[r]} ${ROLE_LABEL[r]}`).join('  ') });

  return { embeds: [embed], components: adminButtons(eventId, event.status === 'closed') };
}
