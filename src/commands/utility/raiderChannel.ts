// Eigener Kontextmenüpunkt für den einzelnen Schritt "Raider-Channel
// anlegen", falls kein voller Roster-Durchlauf nötig ist (siehe roster.ts für
// den vollständigen Ablauf inkl. WoWUtils-Roster und Rolle).
import {
  ContextMenuCommandBuilder,
  ApplicationCommandType,
  UserContextMenuCommandInteraction,
  ModalSubmitInteraction,
  ModalBuilder,
  TextInputBuilder,
  TextInputStyle,
  ActionRowBuilder,
  MessageFlags,
  GuildMember,
} from 'discord.js';
import { findOrCreateMember } from '../../lib/members';
import { sb } from '../../lib/supabase';
import { isOfficer } from '../../lib/permissions';
import { createRaiderChannel, isConfigured } from '../../lib/raiderChannel';

// Ziel-User zwischen dem Kontextmenü-Klick und der Modal-Eingabe merken —
// analog zu roster.ts.
const targetUser = new Map<string, { id: string; username: string }>();

function requireOfficer(interaction: UserContextMenuCommandInteraction | ModalSubmitInteraction): boolean {
  return interaction.member instanceof GuildMember && isOfficer(interaction.member);
}

module.exports = {
  // Name muss exakt dem customId-Präfix "raiderchannel-" entsprechen, siehe
  // Kommentar in roster.ts.
  data: new ContextMenuCommandBuilder().setName('raiderchannel').setType(ApplicationCommandType.User),

  async execute(interaction: UserContextMenuCommandInteraction) {
    if (!requireOfficer(interaction)) {
      await interaction.reply({ content: 'Dafür fehlt dir die Berechtigung.', flags: MessageFlags.Ephemeral });
      return;
    }
    if (!isConfigured()) {
      await interaction.reply({ content: 'RAIDER_CATEGORY_ID ist nicht konfiguriert.', flags: MessageFlags.Ephemeral });
      return;
    }
    targetUser.set(interaction.user.id, { id: interaction.targetUser.id, username: interaction.targetUser.username });
    await interaction.showModal(
      new ModalBuilder().setCustomId('raiderchannel-modal').setTitle('Raider-Channel anlegen').addComponents(
        new ActionRowBuilder<TextInputBuilder>().addComponents(
          new TextInputBuilder().setCustomId('name').setLabel('Channel-Name').setStyle(TextInputStyle.Short).setRequired(true).setPlaceholder(`${interaction.targetUser.username.toLowerCase()}-raid`),
        ),
      ),
    );
  },

  async modalHandler(interaction: ModalSubmitInteraction) {
    if (interaction.customId !== 'raiderchannel-modal') return;
    if (!requireOfficer(interaction)) {
      await interaction.reply({ content: 'Dafür fehlt dir die Berechtigung.', flags: MessageFlags.Ephemeral });
      return;
    }
    const target = targetUser.get(interaction.user.id);
    if (!target) { await interaction.reply({ content: 'Sitzung abgelaufen — bitte über das Kontextmenü neu starten.', flags: MessageFlags.Ephemeral }); return; }

    const name = interaction.fields.getTextInputValue('name');
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    try {
      const channel = await createRaiderChannel(interaction.guild!, name, target.id);
      const member = await findOrCreateMember(target);
      await sb.from('members').update({ raider_channel_id: channel.id }).eq('id', member.id);
      await interaction.editReply({ content: `💬 Channel <#${channel.id}> angelegt, Willkommensnachricht gepostet und angepinnt.` });
    } catch (e) {
      console.error('[raiderChannel] Channel anlegen fehlgeschlagen:', e);
      await interaction.editReply({ content: `⚠️ Channel anlegen fehlgeschlagen: ${(e as Error).message}` });
    }
  },
};
