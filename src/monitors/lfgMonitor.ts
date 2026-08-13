import { Client, Events, AnyThreadChannel, ChannelType, TextBasedChannel } from 'discord.js';
import { Monitor } from '../types';

const pendingTagDeletionTimers = new Map<string, ReturnType<typeof setTimeout>>();

export const lfgMonitor: Monitor = {
  init(client: Client) {
    client.on(Events.ThreadCreate, async (thread: AnyThreadChannel) => {
      try {
        if (!isInMonitoredForum(thread)) return;
        await announceThread(client, thread);
        if (hasDoneTag(thread)) scheduleTagDeletion(thread);
        if (await isOlderThanConfigured(thread)) await safeDelete(thread, 'Auto-cleanup on create (age)');
      } catch (err) {
        console.error('lfgMonitor ThreadCreate error:', err);
      }
    });

    client.on(Events.ThreadUpdate, async (_old: AnyThreadChannel, thread: AnyThreadChannel) => {
      try {
        if (!isInMonitoredForum(thread)) return;
        if (hasDoneTag(thread)) {
          if (!pendingTagDeletionTimers.has(thread.id)) scheduleTagDeletion(thread);
        } else {
          cancelScheduledDeletion(thread.id);
        }
        if (await isOlderThanConfigured(thread)) await safeDelete(thread, 'Auto-cleanup on update (age)');
      } catch (err) {
        console.error('lfgMonitor ThreadUpdate error:', err);
      }
    });

    setInterval(() => performSweep(client).catch(() => {}), 6 * 60 * 60 * 1000);
    setTimeout(() => performSweep(client).catch(() => {}), 15 * 1000);
  },
};

function isInMonitoredForum(thread: AnyThreadChannel): boolean {
  if (!thread.parent) return false;
  if (thread.parent.type !== ChannelType.GuildForum) return false;
  const forumId = process.env.FORUM_SOURCE_CHANNEL;
  if (forumId && thread.parentId !== forumId) return false;
  return true;
}

async function announceThread(client: Client, thread: AnyThreadChannel) {
  try {
    const channelId = process.env.FORUM_ANNOUNCE_CHANNEL ?? process.env.ANN_CHANNEL;
    if (!channelId) return;
    const channel = client.channels.cache.get(channelId) as TextBasedChannel | undefined;
    if (!channel || !('send' in channel)) return;
    await channel.send(`https://discord.com/channels/${thread.guildId}/${thread.id}`);
  } catch (err) {
    console.error('lfgMonitor announce error:', err);
  }
}

function hasDoneTag(thread: AnyThreadChannel): boolean {
  const tag = process.env.FORUM_DONE_TAG_NAME;
  if (!tag) return false;
  return hasTag(thread, tag);
}

function hasTag(thread: AnyThreadChannel, tag: string): boolean {
  if (!thread.parent || !Array.isArray(thread.appliedTags)) return false;
  if (!('availableTags' in thread.parent)) return false;
  const available = (thread.parent as { availableTags: { id: string; name: string }[] }).availableTags ?? [];
  const appliedNames = thread.appliedTags
    .map(id => available.find(t => t.id === id))
    .filter(Boolean)
    .map(t => t!.name.toLowerCase());
  return appliedNames.includes(tag.toLowerCase());
}

async function isOlderThanConfigured(thread: AnyThreadChannel): Promise<boolean> {
  const noDeleteTag = process.env.FORUM_NO_DELETE_TAG_NAME;
  if (noDeleteTag && hasTag(thread, noDeleteTag)) return false;

  const cleanupDays = Number(process.env.FORUM_CLEANUP_DAYS);
  if (!Number.isFinite(cleanupDays) || cleanupDays <= 0) return false;

  let retentionDays = cleanupDays;
  let lastUpdate: number;

  try {
    const lastMessage = thread.lastMessageId
      ? await thread.messages.fetch(thread.lastMessageId)
      : null;
    lastUpdate = lastMessage?.createdAt.getTime() ?? thread.createdAt?.getTime() ?? Date.now();
  } catch {
    lastUpdate = thread.createdAt?.getTime() ?? Date.now();
    retentionDays = 14;
  }

  return Date.now() - lastUpdate >= retentionDays * 24 * 60 * 60 * 1000;
}

function scheduleTagDeletion(thread: AnyThreadChannel) {
  try {
    if (pendingTagDeletionTimers.has(thread.id)) return;
    thread.send('LFG - fertig - Post wird in 1 Minute geschlossen').catch(() => {});
    const timeout = setTimeout(async () => {
      pendingTagDeletionTimers.delete(thread.id);
      try {
        const fresh = await thread.fetch().catch(() => null);
        if (!fresh || !hasDoneTag(fresh)) return;
        await safeDelete(fresh, 'Auto-cleanup after 1m (fertig tag)');
      } catch (err) {
        console.error('lfgMonitor delayed delete error:', err);
      }
    }, 60 * 1000);
    pendingTagDeletionTimers.set(thread.id, timeout);
  } catch (err) {
    console.error('lfgMonitor schedule error:', err);
  }
}

function cancelScheduledDeletion(threadId: string) {
  const t = pendingTagDeletionTimers.get(threadId);
  if (t) {
    clearTimeout(t);
    pendingTagDeletionTimers.delete(threadId);
  }
}

async function safeDelete(thread: AnyThreadChannel, reason: string) {
  try {
    await thread.delete(reason);
  } catch {
    try {
      await thread.setLocked(true, reason);
      await thread.setArchived(true, reason);
      await thread.send('Dieser Post wurde vom Bot geschlossen.');
    } catch (err) {
      console.error('lfgMonitor delete fallback failed:', err);
    }
  }
}

async function performSweep(client: Client) {
  try {
    const forumId = process.env.FORUM_SOURCE_CHANNEL;
    if (!forumId) return;
    const forum = await client.channels.fetch(forumId).catch(() => null);
    if (!forum || forum.type !== ChannelType.GuildForum) return;

    const active = await forum.threads.fetchActive().catch(() => null);
    if (active?.threads) {
      for (const [, th] of active.threads) {
        if (await isOlderThanConfigured(th)) {
          await safeDelete(th, 'lfgMonitor periodic cleanup (active, age)');
        } else if (hasDoneTag(th) && !pendingTagDeletionTimers.has(th.id)) {
          scheduleTagDeletion(th);
        }
      }
    }

    const archived = await forum.threads.fetchArchived({ limit: 50 }).catch(() => null);
    if (archived?.threads) {
      for (const [, th] of archived.threads) {
        if (await isOlderThanConfigured(th)) {
          await safeDelete(th, 'lfgMonitor periodic cleanup (archived, age)');
        } else if (hasDoneTag(th) && !pendingTagDeletionTimers.has(th.id)) {
          scheduleTagDeletion(th);
        }
      }
    }
  } catch (err) {
    console.error('lfgMonitor sweep error:', err);
  }
}
