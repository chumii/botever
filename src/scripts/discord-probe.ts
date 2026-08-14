// Listet Rollen und Kanäle/Kategorien des konfigurierten Servers mit ihren IDs.
// Reiner Lesezugriff über die REST-API, kein Gateway-Login — läuft parallel
// zu einem laufenden `npm run dev`, ohne zu kollidieren.
//
//   npm run probe:discord

const env = process.env.NODE_ENV ?? 'development';
require('dotenv').config({ path: env === 'production' ? '.env.prod' : '.env.dev' });

// require() statt import: siehe Kommentar in wowutils-seed-mapping.ts — statische
// imports werden vor diesem dotenv.config() ausgewertet.
const { REST, Routes } = require('discord.js');

export {}; // erzwingt Modul-Scope, sonst kollidieren die Top-Level-Namen mit anderen Skripten in src/scripts

interface Role { id: string; name: string; position: number; managed: boolean }
interface Channel { id: string; name: string; type: number; parent_id: string | null; position: number }

const CHANNEL_TYPES: Record<number, string> = {
  0: 'Text', 2: 'Voice', 4: 'Kategorie', 5: 'Ankündigung', 13: 'Stage', 15: 'Forum',
};

async function main() {
  const token = process.env.DISCORD_TOKEN;
  const guildId = process.env.DISCORD_GUILD_ID;
  const clientId = process.env.DISCORD_CLIENT_ID;
  if (!token || !guildId || !clientId) throw new Error('DISCORD_TOKEN, DISCORD_GUILD_ID oder DISCORD_CLIENT_ID fehlt.');

  const rest = new REST().setToken(token);

  console.log('── Rollen (für RAIDER_ROLE_ID / OFFICER_ROLE_ID) ──');
  const roles = (await rest.get(Routes.guildRoles(guildId))) as Role[];
  for (const r of roles.filter(r => !r.managed).sort((a, b) => b.position - a.position)) {
    console.log(`  ${r.id}  ${r.name}`);
  }

  console.log('\n── Kategorien und Kanäle (für RAIDER_CATEGORY_ID) ──');
  const channels = (await rest.get(Routes.guildChannels(guildId))) as Channel[];
  const categories = channels.filter(c => c.type === 4).sort((a, b) => a.position - b.position);
  const uncategorized = channels.filter(c => c.type !== 4 && !c.parent_id);

  for (const cat of categories) {
    console.log(`  📁 ${cat.id}  ${cat.name}`);
    const children = channels.filter(c => c.parent_id === cat.id).sort((a, b) => a.position - b.position);
    for (const ch of children) {
      console.log(`      ${ch.id}  ${(CHANNEL_TYPES[ch.type] ?? `Typ ${ch.type}`).padEnd(11)} ${ch.name}`);
    }
  }
  if (uncategorized.length) {
    console.log('  (ohne Kategorie)');
    for (const ch of uncategorized) {
      console.log(`      ${ch.id}  ${(CHANNEL_TYPES[ch.type] ?? `Typ ${ch.type}`).padEnd(11)} ${ch.name}`);
    }
  }

  console.log('\n── Bot-eigene Rollenposition ──');
  const me = await rest.get(Routes.guildMember(guildId, clientId)) as { roles: string[] };
  const myTop = roles.filter(r => me.roles.includes(r.id)).sort((a, b) => b.position - a.position)[0];
  console.log(myTop
    ? `  Höchste eigene Rolle: ${myTop.name} (Position ${myTop.position}). Der Bot kann nur Rollen UNTERHALB dieser Position vergeben.`
    : '  Der Bot hat keine eigene Rolle über @everyone.');
}

main().catch(err => {
  console.error('\nFehlgeschlagen:', err instanceof Error ? err.message : err);
  process.exit(1);
});
