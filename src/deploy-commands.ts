import { readdirSync } from 'fs';
import { join } from 'path';

const env = process.env.NODE_ENV ?? 'development';
const envFile = env === 'production' ? '.env.prod' : '.env.dev';
require('dotenv').config({ path: envFile });

import { REST, Routes } from 'discord.js';

const commands: unknown[] = [];
const commandsPath = join(__dirname, 'commands');

for (const folder of readdirSync(commandsPath)) {
  const folderPath = join(commandsPath, folder);
  for (const file of readdirSync(folderPath).filter(f => f.endsWith('.ts') || f.endsWith('.js'))) {
    const command = require(join(folderPath, file));
    if ('data' in command) commands.push(command.data.toJSON());
  }
}

const token = process.env.DISCORD_TOKEN;
const clientId = process.env.DISCORD_CLIENT_ID;
const guildId = process.env.DISCORD_GUILD_ID;

if (!token || !clientId || !guildId) {
  throw new Error(`DISCORD_TOKEN, DISCORD_CLIENT_ID oder DISCORD_GUILD_ID fehlt in ${envFile}`);
}

const rest = new REST().setToken(token);

(async () => {
  console.log(`[${env}] Registriere ${commands.length} Commands auf Guild ${guildId}...`);
  const data = await rest.put(
    Routes.applicationGuildCommands(clientId, guildId),
    { body: commands },
  ) as unknown[];
  console.log(`[${env}] ${data.length} Commands erfolgreich registriert.`);
})();
