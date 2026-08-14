import {
  SlashCommandBuilder,
  ContextMenuCommandBuilder,
  ChatInputCommandInteraction,
  UserContextMenuCommandInteraction,
  ButtonInteraction,
  ModalSubmitInteraction,
  StringSelectMenuInteraction,
  Client,
  Collection,
} from 'discord.js';

export interface Command {
  data: SlashCommandBuilder | Omit<SlashCommandBuilder, 'addSubcommand' | 'addSubcommandGroup'> | ContextMenuCommandBuilder;
  execute(interaction: ChatInputCommandInteraction | UserContextMenuCommandInteraction): Promise<void>;
  buttonHandler?(interaction: ButtonInteraction): Promise<void>;
  modalHandler?(interaction: ModalSubmitInteraction): Promise<void>;
  selectionHandler?(interaction: StringSelectMenuInteraction): Promise<void>;
}

export interface BotClient extends Client {
  commands: Collection<string, Command>;
}

export interface Monitor {
  init(client: Client): void;
}
