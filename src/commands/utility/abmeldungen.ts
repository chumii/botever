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
  MessageFlags,
  RepliableInteraction,
} from 'discord.js';
import { sb } from '../../lib/supabase';
import * as wowutils from '../../lib/wowutils';

const pending = new Map<string, Record<string, unknown>>();

// --- Ephemere Nachrichten aufräumen ---

// Jeder Schritt des Dialogs erzeugt eine eigene ephemere Nachricht; Discord
// blendet die vorherigen nicht aus, sodass sich der Channel mit veralteten
// Panels füllt. Deshalb merken wir uns pro Nutzer die Interaktion, die die
// aktuell sichtbare Nachricht erzeugt hat, und löschen sie, sobald die nächste
// entsteht. Nur die neueste bleibt stehen.
const activePanel = new Map<string, RepliableInteraction>();

interface PanelPayload {
  content: string;
  components?: ActionRowBuilder<ButtonBuilder>[] | ActionRowBuilder<StringSelectMenuBuilder>[];
}

async function replacePanel(interaction: RepliableInteraction, payload: PanelPayload): Promise<void> {
  const previous = activePanel.get(interaction.user.id);
  activePanel.set(interaction.user.id, interaction);

  // Erst die neue Nachricht senden, dann die alte entfernen — andersherum
  // flackert der Dialog kurz weg.
  if (interaction.deferred || interaction.replied) {
    await interaction.editReply({ components: [], ...payload });
  } else {
    await interaction.reply({ ...payload, flags: MessageFlags.Ephemeral });
  }

  if (!previous || previous.id === interaction.id) return;
  try {
    await previous.deleteReply();
  } catch (e) {
    // Interaction-Tokens leben 15 Minuten; danach ist die alte Nachricht nicht
    // mehr löschbar und bleibt einfach stehen. Auch schon manuell entfernte
    // Nachrichten landen hier.
    console.debug('[abmeldungen] altes Panel nicht löschbar:', (e as Error).message);
  }
}

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

function todayIso(): string {
  const now = new Date();
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
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

interface Member {
  id: string;
  wowutils_member_id: string | null;
}

// Sucht primär über die unveränderliche Discord-User-ID. Ältere Datensätze
// haben noch keine discord_id; die werden über den Namen gefunden und dabei
// nachgetragen.
async function findOrCreateMember(user: { id: string; username: string }): Promise<Member> {
  const columns = 'id, wowutils_member_id';

  const { data: byId, error: idErr } = await sb.from('members').select(columns).eq('discord_id', user.id).maybeSingle();
  if (idErr) { console.error('[abmeldungen] members select by discord_id error:', idErr); throw idErr; }
  if (byId) return byId;

  const { data: byName, error: nameErr } = await sb.from('members').select(columns).eq('discord_name', user.username).is('discord_id', null).maybeSingle();
  if (nameErr) { console.error('[abmeldungen] members select by discord_name error:', nameErr); throw nameErr; }
  if (byName) {
    const { error: backfillErr } = await sb.from('members').update({ discord_id: user.id }).eq('id', byName.id);
    if (backfillErr) console.error('[abmeldungen] members discord_id backfill error:', backfillErr);
    return byName;
  }

  const { data: created, error: insertErr } = await sb.from('members').insert({ name: user.username, discord_name: user.username, discord_id: user.id }).select(columns).single();
  if (insertErr) { console.error('[abmeldungen] members insert error:', insertErr); throw insertErr; }
  return created;
}

// --- WoWUtils-Kalender ---

// Der Abgleich ist Beiwerk: schlägt er fehl, ist die Abmeldung trotzdem
// gespeichert. Deshalb wird hier nie geworfen, sondern eine Zeile zurückgegeben,
// die unter die Bestätigung gehängt wird. Leerer String heisst "nichts zu sagen".
async function syncCalendar(member: Member, jobs: { action: 'apply' | 'clear'; start: string; end: string }[]): Promise<string> {
  if (!wowutils.isConfigured() || jobs.length === 0) return '';
  if (!member.wowutils_member_id) {
    return '\n📅 _Nicht mit WoWUtils verknüpft — der Kalender wurde nicht angepasst. Über `/abmeldungen` → „WoWUtils verknüpfen" nachholen._';
  }

  let changed = 0, failed = 0;
  try {
    for (const job of jobs) {
      const run = job.action === 'apply' ? wowutils.applyAbsence : wowutils.clearAbsence;
      const result = await run(member.wowutils_member_id, job.start, job.end);
      changed += result.changed;
      failed += result.failed;
    }
  } catch (e) {
    console.error('[abmeldungen] WoWUtils-Abgleich fehlgeschlagen:', e);
    return `\n📅 ⚠️ _Kalender-Abgleich fehlgeschlagen: ${(e as Error).message}_`;
  }

  if (changed === 0 && failed === 0) return '\n📅 _Keine Kalender-Termine im Zeitraum betroffen._';
  const parts = [`${changed} Termin${changed === 1 ? '' : 'e'} im WoWUtils-Kalender angepasst`];
  if (failed) parts.push(`${failed} fehlgeschlagen`);
  return `\n📅 _${parts.join(', ')}._`;
}

// Zwei Zeiträume überlappen, wenn jeder vor dem Ende des anderen beginnt.
// Beide Grenzen sind inklusiv. exceptId klammert beim Bearbeiten den Eintrag
// aus, der gerade geändert wird — sonst kollidiert er mit sich selbst.
async function findOverlap(memberId: string, isoStart: string, isoEnd: string, exceptId?: string) {
  // Endgültige Einträge zuerst: sie blockieren, vorläufige lösen nur eine
  // Warnung aus. Bei mehreren Treffern soll also der strengere gewinnen.
  let query = sb.from('vacations').select('id, start_date, end_date, note, is_preliminary').eq('member_id', memberId).lte('start_date', isoEnd).gte('end_date', isoStart);
  if (exceptId) query = query.neq('id', exceptId);
  const { data, error } = await query.order('is_preliminary').order('start_date').limit(1);
  if (error) { console.error('[abmeldungen] overlap check error:', error); throw error; }
  return data?.[0] ?? null;
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
    const buttons = [
      new ButtonBuilder().setCustomId('abmeldungen-new').setLabel('➕ Neue Abmeldung').setStyle(ButtonStyle.Primary),
      new ButtonBuilder().setCustomId('abmeldungen-manage').setLabel('📋 Meine Abmeldungen').setStyle(ButtonStyle.Secondary),
    ];

    // Nur anbieten, wenn noch keine Verknüpfung besteht — wer bereits verknüpft
    // ist, sieht den Button nicht mehr. Eine falsche Verknüpfung lässt sich
    // dadurch aktuell nur über Supabase korrigieren, nicht mehr per Button.
    if (wowutils.isConfigured()) {
      const member = await findOrCreateMember(interaction.user);
      if (!member.wowutils_member_id) {
        buttons.push(new ButtonBuilder().setCustomId('abmeldungen-link').setLabel('🔗 WoWUtils verknüpfen').setStyle(ButtonStyle.Secondary));
      }
    }

    const row = new ActionRowBuilder<ButtonBuilder>().addComponents(buttons);
    await replacePanel(interaction, { content: 'Was möchtest du tun?', components: [row] });
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
      await interaction.deferReply({ flags: MessageFlags.Ephemeral });
      const member = await findOrCreateMember(interaction.user);
      // Nur laufende und kommende Abmeldungen — abgelaufene würden das auf 25
      // Optionen begrenzte Select-Menü mit der Zeit vollständig zulaufen lassen.
      const { data: entries } = await sb.from('vacations').select('id, start_date, end_date, note, is_preliminary').eq('member_id', member.id).gte('end_date', todayIso()).order('start_date');
      if (!entries || entries.length === 0) {
        await replacePanel(interaction, { content: 'Du hast keine laufenden oder kommenden Abmeldungen eingetragen.' });
        return;
      }
      const options = entries.slice(0, 25).map((e: { id: string; start_date: string; end_date: string; note?: string | null }) => ({
        label: `${isoToGerman(e.start_date)} – ${isoToGerman(e.end_date)}${e.note ? ' · ' + e.note : ''}`.slice(0, 100),
        value: e.id,
      }));
      const select = new StringSelectMenuBuilder().setCustomId('abmeldungen-pick').setPlaceholder('Abmeldung auswählen…').addOptions(options);
      const overflow = entries.length > 25 ? `\n_Nur die ersten 25 von ${entries.length} Einträgen._` : '';
      await replacePanel(interaction, { content: `Deine Abmeldungen:${overflow}`, components: [new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(select)] });

    } else if (action === 'edit' && entryId) {
      const { data: entry } = await sb.from('vacations').select('start_date, end_date, note, is_preliminary').eq('id', entryId).single();
      if (!entry) { await replacePanel(interaction, { content: 'Eintrag nicht gefunden.' }); return; }
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
      await replacePanel(interaction, { content: 'Diese Abmeldung wirklich löschen?', components: [row] });

    } else if (action === 'delyes' && entryId) {
      await interaction.deferReply({ flags: MessageFlags.Ephemeral });
      const member = await findOrCreateMember(interaction.user);
      const { data: entry } = await sb.from('vacations').select('*').eq('id', entryId).eq('member_id', member.id).maybeSingle();
      if (!entry) { await replacePanel(interaction, { content: 'Eintrag nicht gefunden oder nicht dein Eintrag.' }); return; }
      await sb.from('vacations').delete().eq('id', entryId);
      await postLog(interaction.client, 'delete', interaction.user, entry);
      const cleared = await syncCalendar(member, entry.is_preliminary ? [] : [{ action: 'clear', start: entry.start_date, end: entry.end_date }]);
      await replacePanel(interaction, { content: `🗑️ Abmeldung **${isoToGerman(entry.start_date)} – ${isoToGerman(entry.end_date)}** gelöscht.${cleared}` });

    } else if (action === 'link') {
      await interaction.deferReply({ flags: MessageFlags.Ephemeral });
      if (!wowutils.isConfigured()) {
        await replacePanel(interaction, { content: 'Die WoWUtils-Anbindung ist nicht konfiguriert.' });
        return;
      }
      const member = await findOrCreateMember(interaction.user);
      const roster = await wowutils.getRoster();

      // Ein Select-Menü fasst 25 Optionen, der Roster ist grösser. Discord
      // erlaubt bis zu fünf Zeilen, also den Roster darauf verteilen.
      const chunks: wowutils.RosterMember[][] = [];
      for (let i = 0; i < roster.length && chunks.length < 5; i += 25) chunks.push(roster.slice(i, i + 25));

      const rows = chunks.map((chunk, index) => new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(
        new StringSelectMenuBuilder()
          .setCustomId(`abmeldungen-linkpick-${index}`)
          .setPlaceholder(`${chunk[0].displayName} – ${chunk[chunk.length - 1].displayName}`)
          .addOptions(chunk.map(m => ({
            label: m.displayName.slice(0, 100),
            description: (m.characters[0] ? m.characters[0].name : m.battletag ?? '').slice(0, 100) || undefined,
            value: m.memberId,
            default: m.memberId === member.wowutils_member_id,
          }))),
      ));

      const current = member.wowutils_member_id
        ? roster.find(m => m.memberId === member.wowutils_member_id)?.displayName ?? member.wowutils_member_id
        : null;
      const intro = current ? `Aktuell verknüpft mit **${current}**. Auswahl ändern:` : 'Wer bist du im WoWUtils-Roster?';
      await replacePanel(interaction, { content: intro, components: rows });

    } else if (action === 'delno') {
      await replacePanel(interaction, { content: 'Abgebrochen.' });

    // 'force' überspringt die Überschneidungsprüfung — erreichbar nur über den
    // Button, den die Warnung bei einer vorläufigen Kollision anbietet.
    } else if (action === 'confirm' || action === 'force') {
      const p = pending.get(interaction.user.id);
      if (!p) { await replacePanel(interaction, { content: 'Nichts zum Bestätigen — bitte `/abmeldungen` neu starten.' }); return; }
      await interaction.deferReply({ flags: MessageFlags.Ephemeral });
      const member = await findOrCreateMember(interaction.user);

      if (action === 'confirm') {
        const clash = await findOverlap(member.id, p.isoStart as string, p.isoEnd as string, (p.id as string | null) ?? undefined);
        if (clash) {
          const retryId = p.action === 'create' ? 'abmeldungen-retrynew' : `abmeldungen-retryedit-${p.id}`;
          const retryButton = new ButtonBuilder().setCustomId(retryId).setLabel('✏️ Erneut eingeben').setStyle(ButtonStyle.Primary);
          const clashLabel = `**${isoToGerman(clash.start_date)} – ${isoToGerman(clash.end_date)}**${clash.note ? ` · ${clash.note}` : ''}`;

          if (clash.is_preliminary) {
            await replacePanel(interaction, {
              content: `⚠️ Überschneidet sich mit deiner _vorläufigen_ Abmeldung ${clashLabel}.\nDu kannst trotzdem speichern.`,
              components: [new ActionRowBuilder<ButtonBuilder>().addComponents(
                new ButtonBuilder().setCustomId('abmeldungen-force').setLabel('✅ Trotzdem speichern').setStyle(ButtonStyle.Success),
                retryButton,
              )],
            });
            return;
          }

          await replacePanel(interaction, {
            content: `⚠️ Überschneidet sich mit deiner Abmeldung ${clashLabel}.\nBitte den Zeitraum anpassen oder die bestehende Abmeldung bearbeiten.`,
            components: [new ActionRowBuilder<ButtonBuilder>().addComponents(retryButton)],
          });
          return;
        }
      }

      if (p.action === 'create') {
        const { data: inserted } = await sb.from('vacations').insert({ member_id: member.id, start_date: p.isoStart, end_date: p.isoEnd, note: p.note, is_preliminary: p.is_preliminary }).select('*').single();
        pending.delete(interaction.user.id);
        await postLog(interaction.client, 'create', interaction.user, inserted);
        const applied = await syncCalendar(member, inserted.is_preliminary ? [] : [{ action: 'apply', start: inserted.start_date, end: inserted.end_date }]);
        await replacePanel(interaction, { content: `✅ Abmeldung **${isoToGerman(inserted.start_date)} – ${isoToGerman(inserted.end_date)}** eingetragen.${applied}` });

      } else if (p.action === 'edit') {
        const { data: previous } = await sb.from('vacations').select('*').eq('id', p.id).eq('member_id', member.id).maybeSingle();
        if (!previous) { pending.delete(interaction.user.id); await replacePanel(interaction, { content: 'Eintrag nicht gefunden oder nicht dein Eintrag.' }); return; }
        const { data: updated } = await sb.from('vacations').update({ start_date: p.isoStart, end_date: p.isoEnd, note: p.note, is_preliminary: p.is_preliminary }).eq('id', p.id).select('*').single();
        pending.delete(interaction.user.id);
        await postLog(interaction.client, 'edit', interaction.user, updated);

        // Erst den alten Zeitraum räumen, dann den neuen setzen. Das deckt auch
        // den Wechsel zwischen vorläufig und endgültig ab, ohne Sonderfälle.
        const jobs: { action: 'apply' | 'clear'; start: string; end: string }[] = [];
        if (!previous.is_preliminary) jobs.push({ action: 'clear', start: previous.start_date, end: previous.end_date });
        if (!updated.is_preliminary) jobs.push({ action: 'apply', start: updated.start_date, end: updated.end_date });
        const synced = await syncCalendar(member, jobs);

        await replacePanel(interaction, { content: `✅ Abmeldung aktualisiert: **${isoToGerman(updated.start_date)} – ${isoToGerman(updated.end_date)}**.${synced}` });
      }

    } else if (action === 'cancel') {
      pending.delete(interaction.user.id);
      await replacePanel(interaction, { content: 'Abgebrochen.' });
    }
  },

  async selectionHandler(interaction: StringSelectMenuInteraction) {
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });

    if (interaction.customId.startsWith('abmeldungen-linkpick')) {
      const wowutilsMemberId = interaction.values[0];
      const member = await findOrCreateMember(interaction.user);
      const { error } = await sb.from('members').update({ wowutils_member_id: wowutilsMemberId }).eq('id', member.id);

      if (error) {
        // 23505 ist die Unique-Verletzung: der Roster-Eintrag hängt schon an
        // einem anderen Discord-Konto.
        const taken = error.code === '23505';
        if (!taken) console.error('[abmeldungen] wowutils_member_id update error:', error);
        await replacePanel(interaction, {
          content: taken
            ? '⚠️ Dieser Roster-Eintrag ist bereits mit einem anderen Discord-Konto verknüpft. Melde dich bei einem Officer.'
            : '⚠️ Verknüpfen fehlgeschlagen.',
        });
        return;
      }

      const roster = await wowutils.getRoster();
      const name = roster.find(m => m.memberId === wowutilsMemberId)?.displayName ?? wowutilsMemberId;
      await replacePanel(interaction, { content: `🔗 Verknüpft mit **${name}**. Künftige Abmeldungen tragen sich im WoWUtils-Kalender ein.` });
      return;
    }

    const entryId = interaction.values[0];
    const { data: entry } = await sb.from('vacations').select('id, start_date, end_date, note, is_preliminary').eq('id', entryId).single();
    if (!entry) { await replacePanel(interaction, { content: 'Eintrag nicht gefunden.' }); return; }
    const note = entry.note ? ` · ${entry.note}` : '';
    const prelim = entry.is_preliminary ? ' · _vorläufig_' : '';
    const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder().setCustomId(`abmeldungen-edit-${entry.id}`).setLabel('✏️ Ändern').setStyle(ButtonStyle.Primary),
      new ButtonBuilder().setCustomId(`abmeldungen-del-${entry.id}`).setLabel('🗑️ Löschen').setStyle(ButtonStyle.Danger),
    );
    await replacePanel(interaction, { content: `**${isoToGerman(entry.start_date)} – ${isoToGerman(entry.end_date)}**${note}${prelim}`, components: [row] });
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
      await replacePanel(interaction, {
        content: `⚠️ ${parseError}`,
        components: [new ActionRowBuilder<ButtonBuilder>().addComponents(
          new ButtonBuilder().setCustomId(retryId).setLabel('✏️ Erneut eingeben').setStyle(ButtonStyle.Primary),
        )],
      });
      return;
    }

    const note = rawNote.trim() ? ` · ${rawNote.trim()}` : '';
    const prelim = parsePrelim(rawPrelim) ? ' · _vorläufig_' : '';
    await replacePanel(interaction, {
      content: `Abmeldung bestätigen?\n**${isoToGerman(isoStart!)} – ${isoToGerman(isoEnd!)}**${note}${prelim}`,
      components: [confirmRow()],
    });
  },
};
