import { Client, Events, MessageReaction, PartialMessageReaction, User, PartialUser } from 'discord.js';
import { Monitor } from '../types';
import { getEventIdByMessageId, getEvent, setSignup, removeSignup, buildEventMessage, ROLE_BY_EMOJI } from '../lib/groupSignup';

// Rollenwahl für /lfg läuft über Reactions statt Buttons (siehe groupSignup.ts
// für die Begründung: Discord hebt die eigene Reaction nur für einen selbst
// hervor, bei Buttons geht das nicht). Reagiert jemand mit einer zweiten
// Rolle, wird die alte Reaction hier automatisch entfernt — pro Person ist
// immer nur eine Rolle gültig.

async function resolve(reaction: MessageReaction | PartialMessageReaction, user: User | PartialUser) {
  if (user.bot) return null;
  const emoji = reaction.emoji.name;
  if (!emoji || !ROLE_BY_EMOJI[emoji]) return null;

  const full = reaction.partial ? await reaction.fetch() : reaction;
  const message = full.message.partial ? await full.message.fetch() : full.message;
  const eventId = await getEventIdByMessageId(message.id);
  if (!eventId) return null;

  return { role: ROLE_BY_EMOJI[emoji], message, eventId };
}

// Hat die Person nach dieser Aktion noch irgendeine Rollen-Reaction auf der
// Nachricht? Wird sowohl nach einem Add (zum Aufräumen der alten Rolle) als
// auch nach einem Remove (um "Rolle gewechselt" von "ganz abgemeldet" zu
// unterscheiden) gebraucht.
async function currentRoleReactions(message: MessageReaction['message'], userId: string) {
  const hits: MessageReaction[] = [];
  for (const reaction of message.reactions.cache.values()) {
    const emoji = reaction.emoji.name;
    if (!emoji || !ROLE_BY_EMOJI[emoji]) continue;
    const users = await reaction.users.fetch();
    if (users.has(userId)) hits.push(reaction);
  }
  return hits;
}

export const lfgSignupMonitor: Monitor = {
  init(client: Client) {
    client.on(Events.MessageReactionAdd, async (reaction, user) => {
      try {
        const hit = await resolve(reaction, user);
        if (!hit) return;
        const event = await getEvent(hit.eventId);
        if (!event || event.status === 'closed') {
          await reaction.users.remove(user.id).catch(() => null);
          return;
        }

        // Alte Rolle(n) entfernen, falls vorhanden — jeweils löst das ein
        // eigenes MessageReactionRemove aus, das der Handler unten aber als
        // "Rolle gewechselt" erkennt (die neue Reaction ist ja schon gesetzt)
        // und deshalb nicht als Abmeldung wertet.
        const current = await currentRoleReactions(hit.message, user.id);
        for (const old of current) {
          if (old.emoji.name === reaction.emoji.name) continue;
          await old.users.remove(user.id).catch(() => null);
        }

        await setSignup(hit.eventId, user.id, hit.role);
        const rendered = await buildEventMessage(hit.message.guild!, hit.eventId);
        if (rendered) await hit.message.edit(rendered);
      } catch (err) {
        console.error('lfgSignupMonitor MessageReactionAdd error:', err);
      }
    });

    client.on(Events.MessageReactionRemove, async (reaction, user) => {
      try {
        const hit = await resolve(reaction, user);
        if (!hit) return;

        const stillHasRole = (await currentRoleReactions(hit.message, user.id)).length > 0;
        if (stillHasRole) return; // Teil eines Rollenwechsels, der Add-Handler hat das schon übernommen

        await removeSignup(hit.eventId, user.id);
        const rendered = await buildEventMessage(hit.message.guild!, hit.eventId);
        if (rendered) await hit.message.edit(rendered);
      } catch (err) {
        console.error('lfgSignupMonitor MessageReactionRemove error:', err);
      }
    });
  },
};
