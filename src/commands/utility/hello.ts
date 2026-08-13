import { ChatInputCommandInteraction, SlashCommandBuilder } from 'discord.js';

module.exports = {
  data: new SlashCommandBuilder()
    .setName('hello')
    .setDescription('Sagt Hallo!'),

  async execute(interaction: ChatInputCommandInteraction) {
    await interaction.reply(`Hallo, ${interaction.user.displayName}! Ich bin Botever.`);
  },
};
