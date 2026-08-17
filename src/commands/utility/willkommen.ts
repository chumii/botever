import {
  SlashCommandBuilder,
  ChatInputCommandInteraction,
  ButtonInteraction,
  ModalSubmitInteraction,
  ModalBuilder,
  TextInputBuilder,
  TextInputStyle,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  MessageFlags,
  GuildMember,
  TextChannel,
  ChannelType,
  Guild,
} from 'discord.js';
import { isOfficer } from '../../lib/permissions';
import { postWelcomeMessage, unpinUntrackedBotMessages, isTracked, getWelcomeMessage, setWelcomeMessage, updateAllWelcomeMessages } from '../../lib/welcomeMessage';

// Channel-Liste zwischen der Bestätigungsfrage von post-alle und dem
// Bestätigen-Klick — kurzlebig, wie die pending-Maps in abmeldungen.ts/roster.ts.
const pendingPostAlle = new Map<string, string[]>();

function raiderChannels(guild: Guild): TextChannel[] {
  const categoryId = process.env.RAIDER_CATEGORY_ID;
  if (!categoryId) return [];
  return [...guild.channels.cache.values()].filter(
    (c): c is TextChannel => c.type === ChannelType.GuildText && c.parentId === categoryId,
  );
}

module.exports = {
  data: new SlashCommandBuilder()
    .setName('willkommen')
    .setDescription('Willkommensnachricht verwalten')
    .addSubcommand(sub => sub.setName('post').setDescription('In diesem Channel posten'))
    .addSubcommand(sub => sub.setName('post-alle').setDescription('In allen Raider-Channeln posten (Erstverteilung)'))
    .addSubcommand(sub => sub.setName('aktualisieren').setDescription('Text ändern und alle bestehenden Pins aktualisieren')),

  async execute(interaction: ChatInputCommandInteraction) {
    if (!(interaction.member instanceof GuildMember) || !isOfficer(interaction.member)) {
      await interaction.reply({ content: 'Dafür fehlt dir die Berechtigung.', flags: MessageFlags.Ephemeral });
      return;
    }

    const sub = interaction.options.getSubcommand();

    if (sub === 'post') {
      if (!(interaction.channel instanceof TextChannel)) {
        await interaction.reply({ content: 'Das geht nur in einem normalen Text-Channel.', flags: MessageFlags.Ephemeral });
        return;
      }
      // Discord verlangt immer eine Antwort auf die Interaktion — bei Erfolg
      // wird die Bestätigung deshalb sofort wieder gelöscht, bei einem Fehler
      // bleibt sie stehen.
      await interaction.deferReply({ flags: MessageFlags.Ephemeral });
      try {
        await postWelcomeMessage(interaction.channel);
        await interaction.deleteReply();
      } catch (e) {
        console.error('[willkommen] post fehlgeschlagen:', e);
        await interaction.editReply({ content: `⚠️ Fehlgeschlagen: ${(e as Error).message}` });
      }
      return;
    }

    if (sub === 'post-alle') {
      if (!interaction.guild) return;
      const channels = raiderChannels(interaction.guild);
      if (channels.length === 0) {
        await interaction.reply({ content: 'RAIDER_CATEGORY_ID ist nicht konfiguriert oder enthält keine Text-Channel.', flags: MessageFlags.Ephemeral });
        return;
      }
      pendingPostAlle.set(interaction.user.id, channels.map(c => c.id));
      await interaction.reply({
        content: `${channels.length} Channel in der Raider-Kategorie gefunden. Bereits aktuelle (getrackte) Channel werden übersprungen, alte ungetrackte Pins werden ersetzt.\nWirklich posten?`,
        components: [new ActionRowBuilder<ButtonBuilder>().addComponents(
          new ButtonBuilder().setCustomId('willkommen-postalle-confirm').setLabel('✅ Posten').setStyle(ButtonStyle.Success),
          new ButtonBuilder().setCustomId('willkommen-postalle-cancel').setLabel('✖ Abbrechen').setStyle(ButtonStyle.Secondary),
        )],
        flags: MessageFlags.Ephemeral,
      });
      return;
    }

    if (sub === 'aktualisieren') {
      const current = await getWelcomeMessage();
      const input = new TextInputBuilder().setCustomId('text').setLabel('Willkommensnachricht').setStyle(TextInputStyle.Paragraph).setRequired(true).setMaxLength(4000).setValue(current);
      await interaction.showModal(
        new ModalBuilder().setCustomId('willkommen-aktualisieren-modal').setTitle('Willkommensnachricht ändern').addComponents(
          new ActionRowBuilder<TextInputBuilder>().addComponents(input),
        ),
      );
    }
  },

  async buttonHandler(interaction: ButtonInteraction) {
    if (!interaction.customId.startsWith('willkommen-')) return;
    const action = interaction.customId.slice('willkommen-'.length);

    if (action === 'postalle-cancel') {
      pendingPostAlle.delete(interaction.user.id);
      await interaction.update({ content: 'Abgebrochen.', components: [] });
      return;
    }

    if (action === 'postalle-confirm') {
      const channelIds = pendingPostAlle.get(interaction.user.id);
      if (!channelIds) { await interaction.update({ content: 'Sitzung abgelaufen — bitte `/willkommen post-alle` neu starten.', components: [] }); return; }
      pendingPostAlle.delete(interaction.user.id);
      await interaction.update({ content: '⏳ Wird gepostet…', components: [] });

      let posted = 0, skipped = 0, failed = 0;
      for (const channelId of channelIds) {
        try {
          const channel = await interaction.guild?.channels.fetch(channelId);
          if (!channel || !(channel instanceof TextChannel)) { failed++; continue; }
          if (await isTracked(channelId)) { skipped++; continue; }
          await unpinUntrackedBotMessages(channel);
          await postWelcomeMessage(channel, true);
          posted++;
        } catch (e) {
          console.error(`[willkommen] post-alle Channel ${channelId} fehlgeschlagen:`, e);
          failed++;
        }
      }

      await interaction.editReply({ content: `✅ ${posted} gepostet, ⏭️ ${skipped} übersprungen (schon aktuell), ${failed ? `⚠️ ${failed} fehlgeschlagen` : ''}` });
    }
  },

  async modalHandler(interaction: ModalSubmitInteraction) {
    if (interaction.customId !== 'willkommen-aktualisieren-modal') return;
    const text = interaction.fields.getTextInputValue('text');

    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    await setWelcomeMessage(text);
    const { updated, failed } = await updateAllWelcomeMessages(interaction.client);

    const failedLines = failed.map(f => `<#${f.channelId}>: ${f.reason}`).join('\n');
    await interaction.editReply({
      content: `✅ Text gespeichert, ${updated} bestehende Pin${updated === 1 ? '' : 's'} aktualisiert.${failed.length ? `\n⚠️ ${failed.length} fehlgeschlagen:\n${failedLines}` : ''}`,
    });
  },
};
