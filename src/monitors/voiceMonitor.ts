import { Client, Events, GuildMember, VoiceState, TextBasedChannel } from 'discord.js';
import { Monitor } from '../types';

export const voiceMonitor: Monitor = {
  init(client: Client) {
    client.on(Events.VoiceStateUpdate, async (oldState: VoiceState, newState: VoiceState) => {
      try {
        const monitorChannel = process.env.VOICE_MONITOR_CHANNEL;
        const annChannelId = process.env.VOICE_ANN_CHANNEL;
        if (!monitorChannel || !annChannelId) return;

        const member = newState.member ?? oldState.member;
        if (!member) return;

        if (oldState.channelId === monitorChannel && newState.channelId !== monitorChannel) {
          await announce(client, member, 'left', annChannelId);
        } else if (newState.channelId === monitorChannel && oldState.channelId !== monitorChannel) {
          await announce(client, member, 'joined', annChannelId);
        }
      } catch (err) {
        console.error('voiceMonitor VoiceStateUpdate error:', err);
      }
    });
  },
};

async function announce(client: Client, member: GuildMember, action: string, channelId: string) {
  try {
    const channel = client.channels.cache.get(channelId) as TextBasedChannel | undefined;
    if (!channel || !('send' in channel)) return;
    await channel.send(`🔊 **${member.displayName}** ${action}`);
  } catch (err) {
    console.error('voiceMonitor announce error:', err);
  }
}
