import { GuildMember } from 'discord.js';

// OFFICER_ROLE_IDS ist kommagetrennt, damit z. B. "GM" und "Officer" beide
// zählen können, ohne dass in Discord eine gemeinsame Rolle nötig ist.
function officerRoleIds(): string[] {
  return (process.env.OFFICER_ROLE_IDS ?? '').split(',').map(id => id.trim()).filter(Boolean);
}

export function isOfficer(member: GuildMember): boolean {
  const ids = officerRoleIds();
  return ids.length > 0 && ids.some(id => member.roles.cache.has(id));
}

export function isRaiderOrOfficer(member: GuildMember): boolean {
  const raiderRoleId = process.env.RAIDER_ROLE_ID;
  return isOfficer(member) || Boolean(raiderRoleId && member.roles.cache.has(raiderRoleId));
}
