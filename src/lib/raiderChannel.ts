import { Guild, ChannelType, PermissionFlagsBits, TextChannel, OverwriteType } from 'discord.js';
import { postWelcomeMessage } from './welcomeMessage';

export function isConfigured(): boolean {
  return Boolean(process.env.RAIDER_CATEGORY_ID);
}

function officerRoleIds(): string[] {
  return (process.env.OFFICER_ROLE_IDS ?? '').split(',').map(id => id.trim()).filter(Boolean);
}

/**
 * Legt einen privaten Text-Channel unter RAIDER_CATEGORY_ID an, sichtbar nur
 * für den Raider selbst und die Officer-Rollen. Die Sichtbarkeit wird
 * explizit auf dem Channel gesetzt statt sich auf die Kategorie zu verlassen,
 * damit sie auch dann stimmt, wenn die Kategorie selbst offener ist.
 */
export async function createRaiderChannel(guild: Guild, channelName: string, raiderUserId: string): Promise<TextChannel> {
  const categoryId = process.env.RAIDER_CATEGORY_ID;
  if (!categoryId) throw new Error('RAIDER_CATEGORY_ID ist nicht konfiguriert.');

  const botId = guild.client.user!.id;
  const overwrites = [
    { id: guild.roles.everyone.id, deny: [PermissionFlagsBits.ViewChannel] },
    { id: raiderUserId, type: OverwriteType.Member, allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.ReadMessageHistory] },
    // Ohne diese Ausnahme sperrt sich der Bot durch das @everyone-Deny selbst
    // aus dem Channel aus, den er gerade erst angelegt hat — ManageMessages
    // zusätzlich, weil das Anpinnen der Willkommensnachricht das braucht.
    { id: botId, type: OverwriteType.Member, allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.ReadMessageHistory, PermissionFlagsBits.ManageMessages] },
    ...officerRoleIds().map(roleId => ({ id: roleId, type: OverwriteType.Role, allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.ReadMessageHistory] })),
  ];

  const channel = await guild.channels.create({
    name: channelName,
    type: ChannelType.GuildText,
    parent: categoryId,
    permissionOverwrites: overwrites,
  });

  await postWelcomeMessage(channel, true);

  return channel;
}
