import { Client, Events } from 'discord.js';

module.exports = {
  name: Events.ClientReady,
  once: true,
  execute(client: Client) {
    console.log(`[${process.env.NODE_ENV}] Eingeloggt als ${client.user?.tag}`);
  },
};
