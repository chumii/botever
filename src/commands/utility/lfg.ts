import {
  SlashCommandBuilder,
  ChatInputCommandInteraction,
  ButtonInteraction,
  ModalSubmitInteraction,
  ModalBuilder,
  TextInputBuilder,
  TextInputStyle,
  ActionRowBuilder,
  MessageFlags,
  GuildMember,
} from 'discord.js';
import { isRaiderOrOfficer, isOfficer } from '../../lib/permissions';
import * as signup from '../../lib/groupSignup';

function requireRaiderOrOfficer(interaction: ChatInputCommandInteraction | ButtonInteraction): boolean {
  return interaction.member instanceof GuildMember && isRaiderOrOfficer(interaction.member);
}

function isCreatorOrOfficer(interaction: ButtonInteraction | ModalSubmitInteraction, event: { creator_discord_id: string }): boolean {
  return interaction.member instanceof GuildMember
    && (isOfficer(interaction.member) || event.creator_discord_id === interaction.user.id);
}

module.exports = {
  data: new SlashCommandBuilder()
    .setName('lfg')
    .setDescription('Einfache Gruppen-Anmeldung mit Rollen-Reactions erstellen')
    .addIntegerOption(opt => opt.setName('groesse').setDescription('Anzahl fester Plätze (Standard: 5)').setMinValue(1))
    .addStringOption(opt => opt.setName('beschreibung').setDescription('Freitext, z. B. was ansteht (optional)')),

  async execute(interaction: ChatInputCommandInteraction) {
    if (!requireRaiderOrOfficer(interaction)) {
      await interaction.reply({ content: 'Dafür fehlt dir die Berechtigung.', flags: MessageFlags.Ephemeral });
      return;
    }

    const size = interaction.options.getInteger('groesse') ?? 5;
    const description = interaction.options.getString('beschreibung') ?? undefined;

    const eventId = await signup.createEvent({
      guildId: interaction.guildId!,
      channelId: interaction.channelId,
      creatorDiscordId: interaction.user.id,
      size,
      description,
    });

    const message = await signup.buildEventMessage(interaction.guild!, eventId);
    await interaction.reply(message!);
    const reply = await interaction.fetchReply();
    await signup.setEventMessage(eventId, reply.id);
    // Rollenwahl läuft über die Reactions auf genau dieser Nachricht — Klicks
    // darauf fängt lfgSignupMonitor ab, nicht dieser buttonHandler.
    await signup.addRoleReactions(reply);
  },

  async buttonHandler(interaction: ButtonInteraction) {
    if (!interaction.customId.startsWith('lfg-')) return;
    const [action, eventId] = interaction.customId.slice('lfg-'.length).split(':');
    if (!eventId) return;

    const event = await signup.getEvent(eventId);
    if (!event) { await interaction.reply({ content: 'Dieses Event existiert nicht mehr.', flags: MessageFlags.Ephemeral }); return; }
    if (!isCreatorOrOfficer(interaction, event)) {
      await interaction.reply({ content: 'Dafür fehlt dir die Berechtigung — nur der Ersteller oder ein Officer.', flags: MessageFlags.Ephemeral });
      return;
    }

    if (action === 'delete') {
      await interaction.deferUpdate();
      await interaction.message.delete().catch(() => null);
      await signup.deleteEvent(eventId);
      return;
    }

    if (action === 'close' || action === 'open') {
      if (action === 'close') await signup.closeEvent(eventId);
      else await signup.openEvent(eventId);
      await interaction.deferUpdate();
      const rendered = await signup.buildEventMessage(interaction.guild!, eventId);
      if (rendered) await interaction.editReply(rendered);
      return;
    }

    if (action === 'ping' || action === 'ping-waitlist') {
      const mode = action === 'ping' ? 'confirmed' : 'waitlist';
      await interaction.showModal(
        new ModalBuilder().setCustomId(`lfg-pingmodal:${mode}:${eventId}`).setTitle('Anmeldung pingen').addComponents(
          new ActionRowBuilder<TextInputBuilder>().addComponents(
            new TextInputBuilder().setCustomId('text').setLabel('Nachricht (optional)').setStyle(TextInputStyle.Paragraph).setRequired(false).setMaxLength(300),
          ),
        ),
      );
    }
  },

  async modalHandler(interaction: ModalSubmitInteraction) {
    if (!interaction.customId.startsWith('lfg-pingmodal:')) return;
    const [, mode, eventId] = interaction.customId.split(':');

    const event = await signup.getEvent(eventId);
    if (!event) { await interaction.reply({ content: 'Dieses Event existiert nicht mehr.', flags: MessageFlags.Ephemeral }); return; }
    if (!isCreatorOrOfficer(interaction, event)) {
      await interaction.reply({ content: 'Dafür fehlt dir die Berechtigung — nur der Ersteller oder ein Officer.', flags: MessageFlags.Ephemeral });
      return;
    }
    // 'send' statt instanceof TextChannel, weil eine Anmeldung auch in einem
    // Forum-Thread liegen kann (automatischer Post über den LFG-Forum-Monitor).
    if (!interaction.channel || !('send' in interaction.channel)) {
      await interaction.reply({ content: 'Dieser Channel-Typ unterstützt kein Posten.', flags: MessageFlags.Ephemeral });
      return;
    }

    const { confirmed, waitlist } = await signup.getSignupUserIds(eventId, event.size);
    const targets = mode === 'waitlist' ? [...confirmed, ...waitlist] : confirmed;
    if (targets.length === 0) {
      await interaction.reply({ content: 'Niemand zum Pingen.', flags: MessageFlags.Ephemeral });
      return;
    }

    const text = interaction.fields.getTextInputValue('text').trim();
    const mentions = targets.map(id => `<@${id}>`).join(' ');
    const link = event.message_id ? `\nhttps://discord.com/channels/${interaction.guildId}/${interaction.channelId}/${event.message_id}` : '';
    const body = text ? `📢 ${text}\n${mentions}` : mentions;
    await interaction.channel.send(`${body}${link}`);

    await interaction.reply({ content: `📢 ${targets.length} Person${targets.length === 1 ? '' : 'en'} gepingt.`, flags: MessageFlags.Ephemeral });
  },
};
