import { Client, Message, TextChannel, EmbedBuilder } from 'discord.js';
import { sb } from './supabase';

const DEFAULT_MESSAGE = 'Hallo test';

export async function getWelcomeMessage(): Promise<string> {
  const { data } = await sb.from('bot_settings').select('welcome_message').eq('id', true).maybeSingle();
  return data?.welcome_message ?? DEFAULT_MESSAGE;
}

export async function setWelcomeMessage(text: string): Promise<void> {
  const { error } = await sb.from('bot_settings').update({ welcome_message: text }).eq('id', true);
  if (error) { console.error('[welcomeMessage] setWelcomeMessage error:', error); throw error; }
}

function buildEmbed(text: string): EmbedBuilder {
  return new EmbedBuilder().setDescription(text);
}

async function trackMessage(channelId: string, messageId: string): Promise<void> {
  const { error } = await sb.from('welcome_messages').upsert({ channel_id: channelId, message_id: messageId }, { onConflict: 'channel_id' });
  if (error) console.error('[welcomeMessage] trackMessage error:', error);
}

export async function isTracked(channelId: string): Promise<boolean> {
  const { data } = await sb.from('welcome_messages').select('channel_id').eq('channel_id', channelId).maybeSingle();
  return Boolean(data);
}

/**
 * Postet die Willkommensnachricht in den Channel und merkt sich die
 * Nachricht in welcome_messages, damit updateAllWelcomeMessages() sie später
 * wiederfindet. Anpinnen ist optional — nur beim frischen Anlegen eines
 * Raider-Channels gewünscht, nicht beim manuellen Nachtriggern per
 * /willkommen post (sonst pinnt jeder Aufruf erneut).
 */
export async function postWelcomeMessage(channel: TextChannel, pin = false): Promise<Message> {
  const text = await getWelcomeMessage();
  const message = await channel.send({ embeds: [buildEmbed(text)] });
  if (pin) await message.pin();
  await trackMessage(channel.id, message.id);
  return message;
}

/**
 * Entpinnt alle vom Bot gepinnten Nachrichten in diesem Channel, die NICHT in
 * welcome_messages getrackt sind — das sind alte, vor der Umstellung auf
 * Tracking gepostete Willkommensnachrichten. Getrackte Pins fasst das nicht
 * an, die aktualisiert man über updateAllWelcomeMessages().
 */
export async function unpinUntrackedBotMessages(channel: TextChannel): Promise<void> {
  const { items } = await channel.messages.fetchPins();
  const trackedIds = new Set((await sb.from('welcome_messages').select('message_id').eq('channel_id', channel.id)).data?.map(r => r.message_id) ?? []);
  for (const { message } of items) {
    if (message.author.id !== channel.client.user!.id) continue;
    if (trackedIds.has(message.id)) continue;
    await message.unpin().catch(() => null);
  }
}

/** Editiert alle getrackten Willkommensnachrichten auf den aktuellen Text. Gibt Erfolge/Fehlschläge zurück. */
export async function updateAllWelcomeMessages(client: Client): Promise<{ updated: number; failed: { channelId: string; reason: string }[] }> {
  const text = await getWelcomeMessage();
  const { data: rows } = await sb.from('welcome_messages').select('channel_id, message_id');
  let updated = 0;
  const failed: { channelId: string; reason: string }[] = [];

  for (const row of rows ?? []) {
    try {
      const channel = await client.channels.fetch(row.channel_id);
      if (!channel || !(channel instanceof TextChannel)) throw new Error('Channel nicht gefunden');
      const message = await channel.messages.fetch(row.message_id);
      await message.edit({ embeds: [buildEmbed(text)] });
      updated++;
    } catch (e) {
      failed.push({ channelId: row.channel_id, reason: (e as Error).message });
    }
  }

  return { updated, failed };
}
