// Roster-Verwaltung für Officer: Rechtsklick auf einen User → Apps → "Roster
// verwalten" öffnet ein Panel mit einzeln anklickbaren, überspringbaren
// Schritten (WoWUtils-Roster, Discord-Rolle, privater Channel). Jeder Schritt
// funktioniert unabhängig von den anderen.
import {
  ContextMenuCommandBuilder,
  ApplicationCommandType,
  UserContextMenuCommandInteraction,
  ButtonInteraction,
  ModalSubmitInteraction,
  ModalBuilder,
  TextInputBuilder,
  TextInputStyle,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  MessageFlags,
  RepliableInteraction,
  GuildMember,
} from 'discord.js';
import { findOrCreateMember } from '../../lib/members';
import { sb } from '../../lib/supabase';
import * as wowutils from '../../lib/wowutils';
import { RosterRank, MainRole } from '../../lib/wowutils';
import { isOfficer } from '../../lib/permissions';
import { createRaiderChannel, isConfigured as channelConfigured } from '../../lib/raiderChannel';

// Panel-Aufräumen wie in abmeldungen.ts: jeder Schritt ersetzt die vorherige
// ephemere Nachricht, damit nicht bei jedem Klick ein neues Panel im Channel
// hängen bleibt. Pro Officer statt pro Ziel-User, weil ein Officer immer nur
// an einem Roster-Vorgang gleichzeitig arbeitet.
const activePanel = new Map<string, RepliableInteraction>();
// customId trägt keinen Platz für eine Discord-Snowflake mehr, deshalb hier
// gemerkt: welcher Ziel-User gehört zur laufenden Aktion des Officers.
const targetUser = new Map<string, { id: string; username: string }>();
// Zwischenspeicher für die Modal-Eingabe zwischen "anzeigen" und "bestätigen".
const pendingRoster = new Map<string, Record<string, string>>();

async function replacePanel(interaction: RepliableInteraction, payload: { content: string; components?: ActionRowBuilder<ButtonBuilder>[] }): Promise<void> {
  const previous = activePanel.get(interaction.user.id);
  activePanel.set(interaction.user.id, interaction);
  if (interaction.deferred || interaction.replied) {
    await interaction.editReply({ components: [], ...payload });
  } else {
    await interaction.reply({ ...payload, flags: MessageFlags.Ephemeral });
  }
  if (!previous || previous.id === interaction.id) return;
  try {
    await previous.deleteReply();
  } catch (e) {
    console.debug('[roster] altes Panel nicht löschbar:', (e as Error).message);
  }
}

function requireOfficer(interaction: UserContextMenuCommandInteraction | ButtonInteraction | ModalSubmitInteraction): boolean {
  return interaction.member instanceof GuildMember && isOfficer(interaction.member);
}

// --- Hauptpanel ---

async function showMainPanel(interaction: RepliableInteraction, target: { id: string; username: string }): Promise<void> {
  targetUser.set(interaction.user.id, target);

  const [wowutilsMember, discordMember] = await Promise.all([
    // Ohne API-Key gar nicht erst versuchen — findRosterEntry würde sonst bei
    // einem Mitglied mit bereits gesetzter wowutils_member_id einen 401
    // auslösen und das ganze Panel zum Absturz bringen.
    wowutils.isConfigured() ? findRosterEntry(target.id) : null,
    interaction.guild?.members.fetch(target.id).catch(() => null) ?? null,
  ]);

  const raiderRoleId = process.env.RAIDER_ROLE_ID;
  const hasRole = Boolean(raiderRoleId && discordMember?.roles.cache.has(raiderRoleId));

  const buttons: ButtonBuilder[] = [];
  if (wowutils.isConfigured()) {
    buttons.push(wowutilsMember
      ? new ButtonBuilder().setCustomId('roster-edit').setLabel('✏️ Roster bearbeiten').setStyle(ButtonStyle.Primary)
      : new ButtonBuilder().setCustomId('roster-add').setLabel('📋 Zum Roster hinzufügen').setStyle(ButtonStyle.Primary));
    if (wowutilsMember) buttons.push(new ButtonBuilder().setCustomId('roster-remove').setLabel('🗑️ Aus Roster entfernen').setStyle(ButtonStyle.Danger));
  }
  if (raiderRoleId) {
    buttons.push(hasRole
      ? new ButtonBuilder().setCustomId('roster-unrole').setLabel('➖ Raider-Rolle entziehen').setStyle(ButtonStyle.Secondary)
      : new ButtonBuilder().setCustomId('roster-role').setLabel('🎖️ Raider-Rolle vergeben').setStyle(ButtonStyle.Success));
  }
  if (channelConfigured()) buttons.push(new ButtonBuilder().setCustomId('roster-channel').setLabel('💬 Raider-Channel anlegen').setStyle(ButtonStyle.Secondary));

  if (buttons.length === 0) {
    await replacePanel(interaction, { content: '⚠️ Nichts konfiguriert — WOWUTILS_API_KEY, RAIDER_ROLE_ID und RAIDER_CATEGORY_ID fehlen alle.' });
    return;
  }

  const rows: ActionRowBuilder<ButtonBuilder>[] = [];
  for (let i = 0; i < buttons.length; i += 5) rows.push(new ActionRowBuilder<ButtonBuilder>().addComponents(buttons.slice(i, i + 5)));

  await replacePanel(interaction, { content: `Roster-Verwaltung für **${target.username}**:`, components: rows });
}

async function findRosterEntry(discordUserId: string): Promise<{ memberId: string; roster: wowutils.RosterMember } | null> {
  const { data: row } = await sb.from('members').select('wowutils_member_id').eq('discord_id', discordUserId).maybeSingle();
  if (!row?.wowutils_member_id) return null;
  const roster = await wowutils.getRoster();
  const entry = roster.find(m => m.memberId === row.wowutils_member_id);
  return entry ? { memberId: row.wowutils_member_id, roster: entry } : null;
}

// --- Charakter-Feld "Name-Realm" ---

// Charakternamen enthalten nie einen Bindestrich, Realm-Slugs manchmal
// (z. B. "tarren-mill") — deshalb am ersten Bindestrich trennen.
function parseCharacter(raw: string): { name: string; realm: string } {
  const trimmed = raw.trim();
  const i = trimmed.indexOf('-');
  if (i < 1 || i === trimmed.length - 1) throw new Error(`Ungültiges Format: „${trimmed}". Bitte **Charname-Realm** verwenden (z. B. Thrall-Blackrock).`);
  return { name: trimmed.slice(0, i), realm: trimmed.slice(i + 1) };
}

const RANKS: RosterRank[] = ['GM', 'Officer', 'Raider', 'Trial', 'Social'];
const ROLES: MainRole[] = ['tank', 'healer', 'melee', 'ranged'];

function parseRank(raw: string): RosterRank | undefined {
  if (!raw.trim()) return undefined;
  const hit = RANKS.find(r => r.toLowerCase() === raw.trim().toLowerCase());
  if (!hit) throw new Error(`Unbekannter Rang: „${raw}". Erlaubt: ${RANKS.join(', ')} (oder leer lassen).`);
  return hit;
}

function parseMainRole(raw: string): MainRole | undefined {
  if (!raw.trim()) return undefined;
  const hit = ROLES.find(r => r === raw.trim().toLowerCase());
  if (!hit) throw new Error(`Unbekannte Rolle: „${raw}". Erlaubt: ${ROLES.join(', ')} (oder leer lassen).`);
  return hit;
}

// --- Roster-Modal ---

function buildRosterModal(customId: string, prefill: Record<string, string> = {}): ModalBuilder {
  const field = (id: string, label: string, opts: { required?: boolean; placeholder?: string } = {}) => {
    const input = new TextInputBuilder().setCustomId(id).setLabel(label).setStyle(TextInputStyle.Short).setRequired(opts.required ?? false);
    if (opts.placeholder) input.setPlaceholder(opts.placeholder);
    if (prefill[id]) input.setValue(prefill[id]);
    return input;
  };
  return new ModalBuilder().setCustomId(customId).setTitle('Roster-Eintrag').addComponents(
    new ActionRowBuilder<TextInputBuilder>().addComponents(field('displayName', 'Anzeigename', { required: true })),
    new ActionRowBuilder<TextInputBuilder>().addComponents(field('character', 'Charakter (Name-Realm)', { required: true, placeholder: 'Thrall-Blackrock' })),
    new ActionRowBuilder<TextInputBuilder>().addComponents(field('rank', 'Rang (optional)', { placeholder: `Standard: Raider — ${RANKS.join('/')}` })),
    new ActionRowBuilder<TextInputBuilder>().addComponents(field('mainRole', 'Hauptrolle (optional)', { placeholder: ROLES.join('/') })),
    new ActionRowBuilder<TextInputBuilder>().addComponents(field('battletag', 'Battletag (optional)', { placeholder: 'Name#1234' })),
  );
}

function confirmRow(yesId: string): ActionRowBuilder<ButtonBuilder> {
  return new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder().setCustomId(yesId).setLabel('✅ Bestätigen').setStyle(ButtonStyle.Success),
    new ButtonBuilder().setCustomId('roster-cancel').setLabel('✖ Abbrechen').setStyle(ButtonStyle.Secondary),
  );
}

// --- Command export ---

module.exports = {
  // Der Name muss exakt dem customId-Präfix entsprechen (siehe unten) — das
  // Interaktions-Routing in interactionCreate.ts findet den Command über
  // customId.split('-')[0] gegen genau diesen Namen.
  data: new ContextMenuCommandBuilder().setName('roster').setType(ApplicationCommandType.User),

  async execute(interaction: UserContextMenuCommandInteraction) {
    if (!requireOfficer(interaction)) {
      await interaction.reply({ content: 'Dafür fehlt dir die Berechtigung.', flags: MessageFlags.Ephemeral });
      return;
    }
    await showMainPanel(interaction, { id: interaction.targetUser.id, username: interaction.targetUser.username });
  },

  async buttonHandler(interaction: ButtonInteraction) {
    if (!interaction.customId.startsWith('roster-')) return;
    if (!requireOfficer(interaction)) {
      await interaction.reply({ content: 'Dafür fehlt dir die Berechtigung.', flags: MessageFlags.Ephemeral });
      return;
    }
    const action = interaction.customId.slice('roster-'.length);
    const target = targetUser.get(interaction.user.id);
    if (!target) { await replacePanel(interaction, { content: 'Sitzung abgelaufen — bitte über das Kontextmenü neu starten.' }); return; }

    if (action === 'add' || action === 'edit') {
      let prefill: Record<string, string> = { displayName: target.username };
      if (action === 'edit') {
        const entry = await findRosterEntry(target.id);
        if (!entry) { await replacePanel(interaction, { content: 'Kein Roster-Eintrag gefunden.' }); return; }
        const char = entry.roster.characters[0];
        prefill = {
          displayName: entry.roster.displayName,
          character: char ? `${char.name}-${char.realm ?? ''}` : '',
          rank: entry.roster.rank,
          battletag: entry.roster.battletag ?? '',
        };
      }
      await interaction.showModal(buildRosterModal(`roster-modal-${action}`, prefill));
      return;
    }

    if (action === 'retry') {
      const prefill = pendingRoster.get(interaction.user.id) ?? {};
      const mode = prefill.mode === 'edit' ? 'edit' : 'add';
      await interaction.showModal(buildRosterModal(`roster-modal-${mode}`, prefill));
      return;
    }

    if (action === 'confirmadd' || action === 'confirmedit') {
      const p = pendingRoster.get(interaction.user.id);
      if (!p) { await replacePanel(interaction, { content: 'Nichts zum Bestätigen — bitte neu starten.' }); return; }
      await interaction.deferReply({ flags: MessageFlags.Ephemeral });

      try {
        const character = parseCharacter(p.character);
        const rank = parseRank(p.rank);
        const mainRole = parseMainRole(p.mainRole);

        if (action === 'confirmadd') {
          const { memberId } = await wowutils.addRosterMember({ displayName: p.displayName, rank, mainRole, battletag: p.battletag || undefined, character });
          const member = await findOrCreateMember(target);
          await sb.from('members').update({ wowutils_member_id: memberId }).eq('id', member.id);
          pendingRoster.delete(interaction.user.id);
          await replacePanel(interaction, { content: `✅ **${p.displayName}** zum Roster hinzugefügt.`, components: [nextStepsRow()] });
        } else {
          const entry = await findRosterEntry(target.id);
          if (!entry) { await replacePanel(interaction, { content: 'Kein Roster-Eintrag mehr gefunden.' }); return; }
          // Battletag nur mitschicken, wenn er sich wirklich geändert hat — ein
          // "claimed" Mitglied (mit Battle.net-Konto verknüpft) lehnt sonst
          // jede Bearbeitung ab, auch wenn der Wert unverändert bleibt.
          const battletagChanged = p.battletag !== (entry.roster.battletag ?? '');
          await wowutils.updateRosterMember(entry.memberId, { displayName: p.displayName, rank, mainRole, battletag: battletagChanged ? p.battletag : undefined, character });
          pendingRoster.delete(interaction.user.id);
          await replacePanel(interaction, { content: `✅ Roster-Eintrag für **${p.displayName}** aktualisiert.`, components: [nextStepsRow()] });
        }
      } catch (e) {
        console.error('[roster] Roster-Schreibzugriff fehlgeschlagen:', e);
        await replacePanel(interaction, {
          content: `⚠️ ${(e as Error).message}`,
          components: [new ActionRowBuilder<ButtonBuilder>().addComponents(new ButtonBuilder().setCustomId('roster-retry').setLabel('✏️ Erneut eingeben').setStyle(ButtonStyle.Primary))],
        });
      }
      return;
    }

    if (action === 'remove') {
      const entry = await findRosterEntry(target.id);
      if (!entry) { await replacePanel(interaction, { content: 'Kein Roster-Eintrag gefunden.' }); return; }
      await replacePanel(interaction, {
        content: `**${entry.roster.displayName}** wirklich aus dem WoWUtils-Roster entfernen?`,
        components: [confirmRow('roster-removeyes')],
      });
      return;
    }

    if (action === 'removeyes') {
      await interaction.deferReply({ flags: MessageFlags.Ephemeral });
      const entry = await findRosterEntry(target.id);
      if (!entry) { await replacePanel(interaction, { content: 'Kein Roster-Eintrag mehr gefunden.' }); return; }
      await wowutils.removeRosterMember(entry.memberId);
      const member = await findOrCreateMember(target);
      await sb.from('members').update({ wowutils_member_id: null }).eq('id', member.id);
      await replacePanel(interaction, {
        content: `🗑️ **${entry.roster.displayName}** aus dem WoWUtils-Roster entfernt.\nAuch Discord-Rolle entziehen oder den privaten Channel löschen?`,
        components: [new ActionRowBuilder<ButtonBuilder>().addComponents(
          new ButtonBuilder().setCustomId('roster-unrole').setLabel('➖ Rolle entziehen').setStyle(ButtonStyle.Secondary),
          new ButtonBuilder().setCustomId('roster-delchannel').setLabel('🗑️ Channel löschen').setStyle(ButtonStyle.Danger),
          new ButtonBuilder().setCustomId('roster-done').setLabel('Fertig').setStyle(ButtonStyle.Secondary),
        )],
      });
      return;
    }

    if (action === 'role' || action === 'unrole') {
      await interaction.deferReply({ flags: MessageFlags.Ephemeral });
      const raiderRoleId = process.env.RAIDER_ROLE_ID;
      if (!raiderRoleId) { await replacePanel(interaction, { content: 'RAIDER_ROLE_ID ist nicht konfiguriert.' }); return; }
      const discordMember = await interaction.guild?.members.fetch(target.id).catch(() => null);
      if (!discordMember) { await replacePanel(interaction, { content: 'Konnte das Discord-Mitglied nicht laden.' }); return; }
      try {
        if (action === 'role') await discordMember.roles.add(raiderRoleId);
        else await discordMember.roles.remove(raiderRoleId);
        await replacePanel(interaction, { content: `${action === 'role' ? '🎖️ Rolle vergeben' : '➖ Rolle entzogen'} für **${target.username}**.`, components: [nextStepsRow()] });
      } catch (e) {
        console.error('[roster] Rollenänderung fehlgeschlagen:', e);
        await replacePanel(interaction, { content: `⚠️ Rollenänderung fehlgeschlagen: ${(e as Error).message}\nSteht die Bot-Rolle über der Raider-Rolle?` });
      }
      return;
    }

    if (action === 'channel') {
      await interaction.showModal(
        new ModalBuilder().setCustomId('roster-modal-channel').setTitle('Raider-Channel anlegen').addComponents(
          new ActionRowBuilder<TextInputBuilder>().addComponents(
            new TextInputBuilder().setCustomId('name').setLabel('Channel-Name').setStyle(TextInputStyle.Short).setRequired(true).setPlaceholder(`${target.username.toLowerCase()}-raid`),
          ),
        ),
      );
      return;
    }

    if (action === 'delchannel') {
      await interaction.deferReply({ flags: MessageFlags.Ephemeral });
      const member = await findOrCreateMember(target);
      if (!member.raider_channel_id) { await replacePanel(interaction, { content: 'Kein Channel hinterlegt — vermutlich von Hand angelegt oder benannt.' }); return; }
      try {
        const channel = await interaction.guild?.channels.fetch(member.raider_channel_id).catch(() => null);
        if (channel) await channel.delete('Roster-Verwaltung: Mitglied entfernt');
        await sb.from('members').update({ raider_channel_id: null }).eq('id', member.id);
        await replacePanel(interaction, { content: '🗑️ Channel gelöscht.', components: [nextStepsRow()] });
      } catch (e) {
        console.error('[roster] Channel löschen fehlgeschlagen:', e);
        await replacePanel(interaction, { content: `⚠️ Channel löschen fehlgeschlagen: ${(e as Error).message}` });
      }
      return;
    }

    if (action === 'done') {
      pendingRoster.delete(interaction.user.id);
      await replacePanel(interaction, { content: 'Fertig.' });
      return;
    }

    if (action === 'cancel') {
      pendingRoster.delete(interaction.user.id);
      await replacePanel(interaction, { content: 'Abgebrochen.' });
      return;
    }

    if (action === 'menu') {
      await showMainPanel(interaction, target);
      return;
    }
  },

  async modalHandler(interaction: ModalSubmitInteraction) {
    if (!interaction.customId.startsWith('roster-modal-')) return;
    if (!requireOfficer(interaction)) {
      await interaction.reply({ content: 'Dafür fehlt dir die Berechtigung.', flags: MessageFlags.Ephemeral });
      return;
    }
    const mode = interaction.customId.slice('roster-modal-'.length);
    const target = targetUser.get(interaction.user.id);
    if (!target) { await interaction.reply({ content: 'Sitzung abgelaufen — bitte über das Kontextmenü neu starten.', flags: MessageFlags.Ephemeral }); return; }

    if (mode === 'channel') {
      const name = interaction.fields.getTextInputValue('name');
      await interaction.deferReply({ flags: MessageFlags.Ephemeral });
      try {
        const channel = await createRaiderChannel(interaction.guild!, name, target.id);
        const member = await findOrCreateMember(target);
        await sb.from('members').update({ raider_channel_id: channel.id }).eq('id', member.id);
        await replacePanel(interaction, { content: `💬 Channel <#${channel.id}> angelegt, Willkommensnachricht gepostet und angepinnt.`, components: [nextStepsRow()] });
      } catch (e) {
        console.error('[roster] Channel anlegen fehlgeschlagen:', e);
        await replacePanel(interaction, { content: `⚠️ Channel anlegen fehlgeschlagen: ${(e as Error).message}` });
      }
      return;
    }

    // mode === 'add' | 'edit'
    const displayName = interaction.fields.getTextInputValue('displayName');
    const character = interaction.fields.getTextInputValue('character');
    const rank = interaction.fields.getTextInputValue('rank');
    const mainRole = interaction.fields.getTextInputValue('mainRole');
    const battletag = interaction.fields.getTextInputValue('battletag');

    let parseError: string | undefined;
    try {
      parseCharacter(character);
      parseRank(rank);
      parseMainRole(mainRole);
    } catch (e) {
      parseError = (e as Error).message;
    }

    pendingRoster.set(interaction.user.id, { mode, displayName, character, rank, mainRole, battletag });

    if (parseError) {
      await replacePanel(interaction, {
        content: `⚠️ ${parseError}`,
        components: [new ActionRowBuilder<ButtonBuilder>().addComponents(new ButtonBuilder().setCustomId('roster-retry').setLabel('✏️ Erneut eingeben').setStyle(ButtonStyle.Primary))],
      });
      return;
    }

    const summary = [`**${displayName}**`, character, rank && `Rang: ${rank}`, mainRole && `Rolle: ${mainRole}`, battletag].filter(Boolean).join(' · ');
    await replacePanel(interaction, {
      content: `${mode === 'add' ? 'Zum Roster hinzufügen' : 'Roster-Eintrag aktualisieren'}?\n${summary}`,
      components: [confirmRow(mode === 'add' ? 'roster-confirmadd' : 'roster-confirmedit')],
    });
  },
};

function nextStepsRow(): ActionRowBuilder<ButtonBuilder> {
  return new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder().setCustomId('roster-menu').setLabel('↩️ Zurück zur Übersicht').setStyle(ButtonStyle.Secondary),
  );
}
