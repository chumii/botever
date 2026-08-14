import { Events, Interaction, InteractionReplyOptions, MessageFlags } from 'discord.js';
import { BotClient } from '../types';

module.exports = {
  name: Events.InteractionCreate,
  async execute(interaction: Interaction) {
    const client = interaction.client as BotClient;

    if (interaction.isChatInputCommand() || interaction.isUserContextMenuCommand()) {
      const command = client.commands.get(interaction.commandName);
      if (!command) { console.error(`Unbekannter Command: ${interaction.commandName}`); return; }
      try {
        await command.execute(interaction);
      } catch (error) {
        console.error(error);
        const msg: InteractionReplyOptions = { content: 'Fehler beim Ausführen des Commands.', flags: MessageFlags.Ephemeral };
        if (interaction.replied || interaction.deferred) await interaction.followUp(msg);
        else await interaction.reply(msg);
      }
      return;
    }

    // Route component interactions by customId prefix (e.g. "abmeldungen-confirm" → "abmeldungen")
    const customId = 'customId' in interaction ? (interaction as { customId: string }).customId : null;
    if (!customId) return;
    const commandName = customId.split('-')[0];
    const command = client.commands.get(commandName);
    if (!command) return;

    try {
      if (interaction.isButton() && command.buttonHandler) {
        await command.buttonHandler(interaction);
      } else if (interaction.isModalSubmit() && command.modalHandler) {
        await command.modalHandler(interaction);
      } else if (interaction.isStringSelectMenu() && command.selectionHandler) {
        await command.selectionHandler(interaction);
      }
    } catch (error) {
      console.error(`[${commandName}] interaction error:`, error);
    }
  },
};
