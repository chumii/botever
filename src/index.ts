const env = process.env.NODE_ENV ?? 'development';
const envFile = env === 'production' ? '.env.prod' : '.env.dev';
require('dotenv').config({ path: envFile });

import { Client, Collection, GatewayIntentBits, Partials } from 'discord.js';
import { readdirSync } from 'fs';
import { join } from 'path';
import { BotClient, Command, Monitor } from './types';
import { voiceMonitor } from './monitors/voiceMonitor';
import { lfgMonitor } from './monitors/lfgMonitor';
import { lfgSignupMonitor } from './monitors/lfgSignupMonitor';

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.GuildVoiceStates,
    GatewayIntentBits.GuildMessageReactions,
  ],
  // Reactions auf alte, nicht mehr gecachte Nachrichten (z. B. nach einem
  // Neustart) würden sonst ohne Fehler und ohne Event einfach verschluckt.
  partials: [Partials.Message, Partials.Reaction, Partials.User],
}) as BotClient;

client.commands = new Collection<string, Command>();

// Load commands
const commandsPath = join(__dirname, 'commands');
for (const folder of readdirSync(commandsPath)) {
  const folderPath = join(commandsPath, folder);
  for (const file of readdirSync(folderPath).filter(f => f.endsWith('.ts') || f.endsWith('.js'))) {
    const command: Command = require(join(folderPath, file));
    if ('data' in command && 'execute' in command) {
      client.commands.set(command.data.name, command);
    }
  }
}

// Load events
const eventsPath = join(__dirname, 'events');
for (const file of readdirSync(eventsPath).filter(f => f.endsWith('.ts') || f.endsWith('.js'))) {
  const event = require(join(eventsPath, file));
  if (event.once) {
    client.once(event.name, (...args: unknown[]) => event.execute(...args));
  } else {
    client.on(event.name, (...args: unknown[]) => event.execute(...args));
  }
}

// Load monitors
const monitors: Monitor[] = [voiceMonitor, lfgMonitor, lfgSignupMonitor];
for (const monitor of monitors) {
  monitor.init(client);
}

const token = process.env.DISCORD_TOKEN;
if (!token) throw new Error(`DISCORD_TOKEN missing in ${envFile}`);

client.login(token);
