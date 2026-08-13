import {
  SlashCommandBuilder,
  ModalBuilder,
  TextInputBuilder,
  TextInputStyle,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  StringSelectMenuBuilder,
  ChatInputCommandInteraction,
  ButtonInteraction,
  ModalSubmitInteraction,
  StringSelectMenuInteraction,
  Client,
} from 'discord.js';
import { sb } from '../../lib/supabase';

const pending = new Map<string, Record<string, unknown>>();

// --- Date helpers ---

function parseGermanDate(s: string): string {
  const trimmed = s.trim();
  const parts = trimmed.split(/[.\-\/]/);
  if (parts.length !== 3) throw new Error(`Ungültiges Format: „${trimmed}". Bitte **TT.MM.JJJJ** verwenden (z. B. 24.12.2026).`);
  let [rawDay, rawMonth, rawYear] = parts;
  if (rawYear.length === 2) rawYear = '20' + rawYear;
  if (rawYear.length !== 4 || isNaN(Number(rawYear))) throw new Error(`Ungültiges Jahr: „${rawYear}". Bitte vollständig angeben (z. B. 2026).`);
  const day = rawDay.padStart(2, '0');
  const month = rawMonth.padStart(2, '0');
  const d = parseInt(day, 10), m = parseInt(month, 10), y = parseInt(rawYear, 10);
  if (isNaN(d) || isNaN(m)) throw new Error(`Ungültige Ziffern im Datum: „${trimmed}".`);
  const date = new Date(y, m - 1, d);
  if (date.getFullYear() !== y || date.getMonth() + 1 !== m || date.getDate() !== d) throw new Error(`Dieses Datum existiert nicht: „${trimmed}".`);
  return `${rawYear}-${month}-${day}`;
}

function isoToGerman(iso: string): string {
  const [y, m, d] = iso.split('-');
  return `${d}.${m}.${y}`;
}

function parsePrelim(s: string): boolean {
  if (!s?.trim()) return false;
  return s.trim().toLowerCase().startsWith('j');
}

// --- Supabase helpers ---

async function findOrCreateMember(discordName: string): Promise<string> {
  const { data: found, error: findErr } = await sb.from('members').select('id').eq('discord_name', discordName).maybeSingle();
  if (findErr) { console.error('[abmeldungen] members select error:', findErr); throw findErr; }
  if (found) return found.id;
  const { data: created, error: insertErr } = await sb.from('members').insert({ name: discordName, discord_name: discordName }).select('id').single();
  if (insertErr) { console.error('[abmeldungen] members insert error:', insertErr); throw insertErr; }
  return created.id;
}

async function postLog(client: Client, action: 'create' | 'edit' | 'delete', user: { id: string }, entry: { start_date: string; end_date: string; note?: string | null; is_preliminary?: boolean }) {
  try {
    const channelId = process.env.ABMELDUNGEN_LOG_CHANNEL;
    const ch = channelId ? client.channels.cache.get(channelId) : null;
    if (!ch || !('send' in ch)) return;
    const start = isoToGerman(entry.start_date);
    const end = isoToGerman(entry.end_date);
    const note = entry.note ? ` · ${entry.note}` : '';
    const prelim = entry.is_preliminary ? ' _(vorläufig)_' : '';
    const labels = { create: '📝 Neue Abmeldung', edit: '✏️ Abmeldung geändert', delete: '🗑️ Abmeldung gelöscht' };
    await ch.send(`${labels[action]} — <@${user.id}>: **${start} – ${end}**${note}${prelim}`);
  } catch (e) {
    console.error('[abmeldungen] postLog error:', e);
  }
}

// --- Modal builders ---

function buildCreateModal(prefill: Record<string, string> = {}): ModalBuilder {
  const startInput = new TextInputBuilder().setCustomId('start').setLabel('Von (TT.MM.JJJJ)').setStyle(TextInputStyle.Short).setPlaceholder('z. B. 24.12.2026').setRequired(true);
  if (prefill.rawStart) startInput.setValue(prefill.rawStart);
  const endInput = new TextInputBuilder().setCustomId('end').setLabel('Bis (TT.MM.JJJJ, inklusiv)').setStyle(TextInputStyle.Short).setPlaceholder('z. B. 02.01.2027').setRequired(true);
  if (prefill.rawEnd) endInput.setValue(prefill.rawEnd);
  const noteInput = new TextInputBuilder().setCustomId('note').setLabel('Notiz (optional)').setStyle(TextInputStyle.Paragraph).setMaxLength(200).setRequired(false);
  if (prefill.rawNote) noteInput.setValue(prefill.rawNote);
  const prelimInput = new TextInputBuilder().setCustomId('prelim').setLabel('Vorläufig? (ja / nein)').setStyle(TextInputStyle.Short).setPlaceholder('nein').setMaxLength(10).setRequired(false);
  if (prefill.rawPrelim) prelimInput.setValue(prefill.rawPrelim);
  return new ModalBuilder().setCustomId('abmeldungen-new').setTitle('Neue Abmeldung').addComponents(
    new ActionRowBuilder<TextInputBuilder>().addComponents(startInput),
    new ActionRowBuilder<TextInputBuilder>().addComponents(endInput),
    new ActionRowBuilder<TextInputBuilder>().addComponents(noteInput),
    new ActionRowBuilder<TextInputBuilder>().addComponents(prelimInput),
  );
}

function buildEditModal(id: string, prefill: Record<string, string> = {}): ModalBuilder {
  const startInput = new TextInputBuilder().setCustomId('start').setLabel('Von (TT.MM.JJJJ)').setStyle(TextInputStyle.Short).setPlaceholder('z. B. 24.12.2026').setRequired(true);
  if (prefill.rawStart) startInput.setValue(prefill.rawStart);
  const endInput = new TextInputBuilder().setCustomId('end').setLabel('Bis (TT.MM.JJJJ, inklusiv)').setStyle(TextInputStyle.Short).setPlaceholder('z. B. 02.01.2027').setRequired(true);
  if (prefill.rawEnd) endInput.setValue(prefill.rawEnd);
  const noteInput = new TextInputBuilder().setCustomId('note').setLabel('Notiz (optional)').setStyle(TextInputStyle.Paragraph).setMaxLength(200).setRequired(false);
  if (prefill.rawNote) noteInput.setValue(prefill.rawNote);
  const prelimInput = new TextInputBuilder().setCustomId('prelim').setLabel('Vorläufig? (ja / nein)').setStyle(TextInputStyle.Short).setPlaceholder('nein').setMaxLength(10).setRequired(false);
  if (prefill.rawPrelim) prelimInput.setValue(prefill.rawPrelim);
  return new ModalBuilder().setCustomId(`abmeldungen-edit-${id}`).setTitle('Abmeldung bearbeiten').addComponents(
    new ActionRowBuilder<TextInputBuilder>().addComponents(startInput),
    new ActionRowBuilder<TextInputBuilder>().addComponents(endInput),
    new ActionRowBuilder<TextInputBuilder>().addComponents(noteInput),
    new ActionRowBuilder<TextInputBuilder>().addComponents(prelimInput),
  );
}

function confirmRow(): ActionRowBuilder<ButtonBuilder> {
  return new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder().setCustomId('abmeldungen-confirm').setLabel('✅ Bestätigen').setStyle(ButtonStyle.Success),
    new ButtonBuilder().setCustomId('abmeldungen-cancel').setLabel('✖ Abbrechen').setStyle(ButtonStyle.Secondary),
  );
}

// --- Command export ---

module.exports = {
  data: new SlashCommandBuilder()
    .setName('abmeldungen')
    .setDescription('Abmeldungen (AFK/Urlaub) verwalten'),

  async execute(interaction: ChatInputCommandInteraction) {
    const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder().setCustomId('abmeldungen-new').setLabel('➕ Neue Abmeldung').setStyle(ButtonStyle.Primary),
      new ButtonBuilder().setCustomId('abmeldungen-manage').setLabel('📋 Meine Abmeldungen').setStyle(ButtonStyle.Secondary),
    );
    await interaction.reply({ content: 'Was möchtest du tun?', components: [row], ephemeral: true });
  },

  async buttonHandler(interaction: ButtonInteraction) {
    const parts = interaction.customId.split('-');
    const action = parts[1];
    const entryId = parts.slice(2).join('-');

    if (action === 'new') {
      await interaction.showModal(buildCreateModal());

    } else if (action === 'retrynew') {
      await interaction.showModal(buildCreateModal((pending.get(interaction.user.id) ?? {}) as Record<string, string>));

    } else if (action === 'manage') {
      await interaction.deferReply({ ephemeral: true });
      const memberId = await findOrCreateMember(interaction.user.username);
      const { data: entries } = await sb.from('vacations').select('id, start_date, end_date, note, is_preliminary').eq('member_id', memberId).order('start_date');
      if (!entries || entries.length === 0) {
        await interaction.editReply({ content: 'Du hast keine Abmeldungen eingetragen.', components: [] });
        return;
      }
      const options = entries.slice(0, 25).map((e: { id: string; start_date: string; end_date: string; note?: string | null }) => ({
        label: `${isoToGerman(e.start_date)} – ${isoToGerman(e.end_date)}${e.note ? ' · ' + e.note : ''}`.slice(0, 100),
        value: e.id,
      }));
      const select = new StringSelectMenuBuilder().setCustomId('abmeldungen-pick').setPlaceholder('Abmeldung auswählen…').addOptions(options);
      const overflow = entries.length > 25 ? `\n_Nur die ersten 25 von ${entries.length} Einträgen._` : '';
      await interaction.editReply({ content: `Deine Abmeldungen:${overflow}`, components: [new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(select)] });

    } else if (action === 'edit' && entryId) {
      const { data: entry } = await sb.from('vacations').select('start_date, end_date, note, is_preliminary').eq('id', entryId).single();
      if (!entry) { await interaction.reply({ content: 'Eintrag nicht gefunden.', ephemeral: true }); return; }
      await interaction.showModal(buildEditModal(entryId, {
        rawStart: isoToGerman(entry.start_date),
        rawEnd: isoToGerman(entry.end_date),
        rawNote: entry.note ?? '',
        rawPrelim: entry.is_preliminary ? 'ja' : 'nein',
      }));

    } else if (action === 'retryedit' && entryId) {
      await interaction.showModal(buildEditModal(entryId, (pending.get(interaction.user.id) ?? {}) as Record<string, string>));

    } else if (action === 'del' && entryId) {
      const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
        new ButtonBuilder().setCustomId(`abmeldungen-delyes-${entryId}`).setLabel('🗑️ Ja, löschen').setStyle(ButtonStyle.Danger),
        new ButtonBuilder().setCustomId('abmeldungen-delno').setLabel('Abbrechen').setStyle(ButtonStyle.Secondary),
      );
      await interaction.reply({ content: 'Diese Abmeldung wirklich löschen?', components: [row], ephemeral: true });

    } else if (action === 'delyes' && entryId) {
      await interaction.deferReply({ ephemeral: true });
      const memberId = await findOrCreateMember(interaction.user.username);
      const { data: entry } = await sb.from('vacations').select('*').eq('id', entryId).eq('member_id', memberId).maybeSingle();
      if (!entry) { await interaction.editReply({ content: 'Eintrag nicht gefunden oder nicht dein Eintrag.', components: [] }); return; }
      await sb.from('vacations').delete().eq('id', entryId);
      await postLog(interaction.client, 'delete', interaction.user, entry);
      await interaction.editReply({ content: `🗑️ Abmeldung **${isoToGerman(entry.start_date)} – ${isoToGerman(entry.end_date)}** gelöscht.`, components: [] });

    } else if (action === 'delno') {
      await interaction.reply({ content: 'Abgebrochen.', ephemeral: true });

    } else if (action === 'confirm') {
      const p = pending.get(interaction.user.id);
      if (!p) { await interaction.reply({ content: 'Nichts zum Bestätigen — bitte `/abmeldungen` neu starten.', ephemeral: true }); return; }
      await interaction.deferReply({ ephemeral: true });
      const memberId = await findOrCreateMember(interaction.user.username);

      if (p.action === 'create') {
        const { data: inserted } = await sb.from('vacations').insert({ member_id: memberId, start_date: p.isoStart, end_date: p.isoEnd, note: p.note, is_preliminary: p.is_preliminary }).select('*').single();
        pending.delete(interaction.user.id);
        await postLog(interaction.client, 'create', interaction.user, inserted);
        await interaction.editReply({ content: `✅ Abmeldung **${isoToGerman(inserted.start_date)} – ${isoToGerman(inserted.end_date)}** eingetragen.`, components: [] });

      } else if (p.action === 'edit') {
        const { data: existing } = await sb.from('vacations').select('id').eq('id', p.id).eq('member_id', memberId).maybeSingle();
        if (!existing) { pending.delete(interaction.user.id); await interaction.editReply({ content: 'Eintrag nicht gefunden oder nicht dein Eintrag.', components: [] }); return; }
        const { data: updated } = await sb.from('vacations').update({ start_date: p.isoStart, end_date: p.isoEnd, note: p.note, is_preliminary: p.is_preliminary }).eq('id', p.id).select('*').single();
        pending.delete(interaction.user.id);
        await postLog(interaction.client, 'edit', interaction.user, updated);
        await interaction.editReply({ content: `✅ Abmeldung aktualisiert: **${isoToGerman(updated.start_date)} – ${isoToGerman(updated.end_date)}**.`, components: [] });
      }

    } else if (action === 'cancel') {
      pending.delete(interaction.user.id);
      await interaction.reply({ content: 'Abgebrochen.', ephemeral: true });
    }
  },

  async selectionHandler(interaction: StringSelectMenuInteraction) {
    const entryId = interaction.values[0];
    await interaction.deferReply({ ephemeral: true });
    const { data: entry } = await sb.from('vacations').select('id, start_date, end_date, note, is_preliminary').eq('id', entryId).single();
    if (!entry) { await interaction.editReply({ content: 'Eintrag nicht gefunden.', components: [] }); return; }
    const note = entry.note ? ` · ${entry.note}` : '';
    const prelim = entry.is_preliminary ? ' · _vorläufig_' : '';
    const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder().setCustomId(`abmeldungen-edit-${entry.id}`).setLabel('✏️ Ändern').setStyle(ButtonStyle.Primary),
      new ButtonBuilder().setCustomId(`abmeldungen-del-${entry.id}`).setLabel('🗑️ Löschen').setStyle(ButtonStyle.Danger),
    );
    await interaction.editReply({ content: `**${isoToGerman(entry.start_date)} – ${isoToGerman(entry.end_date)}**${note}${prelim}`, components: [row] });
  },

  async modalHandler(interaction: ModalSubmitInteraction) {
    const parts = interaction.customId.split('-');
    const modalAction = parts[1];
    const entryId = parts.slice(2).join('-');

    const rawStart = interaction.fields.getTextInputValue('start');
    const rawEnd = interaction.fields.getTextInputValue('end');
    const rawNote = interaction.fields.getTextInputValue('note');
    const rawPrelim = interaction.fields.getTextInputValue('prelim');

    let isoStart: string | undefined, isoEnd: string | undefined, parseError: string | undefined;
    try {
      isoStart = parseGermanDate(rawStart);
      isoEnd = parseGermanDate(rawEnd);
      if (isoStart > isoEnd) throw new Error('Das Startdatum muss vor oder gleich dem Enddatum liegen.');
    } catch (e) {
      parseError = (e as Error).message;
    }

    pending.set(interaction.user.id, {
      action: modalAction === 'new' ? 'create' : 'edit',
      id: entryId || null,
      rawStart, rawEnd, rawNote, rawPrelim,
      note: rawNote.trim() || null,
      is_preliminary: parsePrelim(rawPrelim),
      isoStart, isoEnd,
    });

    if (parseError) {
      const retryId = modalAction === 'new' ? 'abmeldungen-retrynew' : `abmeldungen-retryedit-${entryId}`;
      await interaction.reply({
        content: `⚠️ ${parseError}`,
        components: [new ActionRowBuilder<ButtonBuilder>().addComponents(
          new ButtonBuilder().setCustomId(retryId).setLabel('✏️ Erneut eingeben').setStyle(ButtonStyle.Primary),
        )],
        ephemeral: true,
      });
      return;
    }

    const note = rawNote.trim() ? ` · ${rawNote.trim()}` : '';
    const prelim = parsePrelim(rawPrelim) ? ' · _vorläufig_' : '';
    await interaction.reply({
      content: `Abmeldung bestätigen?\n**${isoToGerman(isoStart!)} – ${isoToGerman(isoEnd!)}**${note}${prelim}`,
      components: [confirmRow()],
      ephemeral: true,
    });
  },
};
