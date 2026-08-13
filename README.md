# Botever

Modularer Discord-Bot in TypeScript auf Basis von [discord.js](https://discord.js.org/) v14. Slash-Commands, Events und Monitore werden getrennt gehalten und beim Start automatisch geladen.

## Features

- **`/hello`** – einfacher Test-Command.
- **`/abmeldungen`** – Abmeldungen per Modal erfassen und in Supabase speichern; Bestätigung über Buttons und Select-Menüs.
- **Voice Monitor** – meldet in einem Text-Channel, wenn jemand einen überwachten Voice-Channel betritt oder verlässt.
- **LFG / Forum Monitor** – kündigt neue Forum-Threads an, löscht mit einem „Done"-Tag markierte Threads zeitverzögert und räumt Threads ab einem konfigurierbaren Alter auf.

## Voraussetzungen

- Node.js 20 oder neuer
- Eine Discord-Application mit Bot-User
- Ein Supabase-Projekt (für `/abmeldungen`)

## Installation

```bash
npm install
```

## Konfiguration

Der Bot lädt abhängig von `NODE_ENV` entweder `.env.dev` (Entwicklung, Standard) oder `.env.prod` (Produktion). Beide Dateien sind von der Versionsverwaltung ausgenommen.

```bash
cp .env.example .env.dev
cp .env.example .env.prod
```

Anschließend die Werte eintragen — die Bedeutung der einzelnen Variablen ist in [.env.example](.env.example) dokumentiert.

## Slash-Commands registrieren

Commands müssen bei Discord registriert werden, bevor sie im Server auftauchen. Nach jeder Änderung an einer Command-Definition erneut ausführen:

```bash
npm run deploy:dev
```

Für die Produktionsumgebung:

```bash
npm run deploy:prod
```

## Entwicklung

```bash
npm run dev
```

Startet den Bot über `tsx` mit `nodemon`, sodass Änderungen an den Quelldateien einen Neustart auslösen.

## Produktion

```bash
npm run build
npm start
```

`npm run build` kompiliert nach `dist/`, `npm start` startet den kompilierten Bot mit `NODE_ENV=production`.

## Projektstruktur

```
src/
├── index.ts              Einstiegspunkt: lädt Commands, Events und Monitore
├── deploy-commands.ts    Registriert die Slash-Commands bei Discord
├── commands/utility/     Slash-Commands (eine Datei pro Command)
├── events/               Discord-Event-Handler (ready, interactionCreate)
├── monitors/             Langlaufende Beobachter (Voice, Forum/LFG)
├── lib/                  Geteilte Clients, z. B. Supabase
└── types/                Gemeinsame TypeScript-Typen
```

### Neuen Command hinzufügen

Eine Datei in `src/commands/utility/` anlegen, die ein Objekt mit `data` (ein `SlashCommandBuilder`) und `execute` exportiert. Der Loader in `src/index.ts` findet sie beim Start automatisch. Danach `npm run deploy:dev` ausführen.

Interaktionen aus Buttons, Modals und Select-Menüs werden anhand des `customId`-Präfixes an den passenden Command geroutet: Ein Button mit der ID `abmeldungen-confirm` landet im Command `abmeldungen`.

## Lizenz

ISC
