import { createClient, SupabaseClient } from '@supabase/supabase-js';

let client: SupabaseClient | undefined;

// Lazy statt beim Laden dieser Datei verbunden: ES-imports werden vor dem
// restlichen Dateiinhalt der importierenden Datei ausgewertet — importiert
// irgendwo in der Kette (auch transitiv über mehrere Dateien) jemand diese
// Datei statisch, bevor dotenv.config() gelaufen ist (z. B. weil index.ts
// einen neuen Monitor importiert, der am Ende hier landet), würde der
// Fehlt-Check sofort greifen, obwohl .env kurz danach längst geladen wäre.
// Der eigentliche Verbindungsaufbau passiert deshalb erst beim ersten
// tatsächlichen sb.from(...)-Aufruf zur Laufzeit.
function realClient(): SupabaseClient {
  if (client) return client;
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_ANON_KEY;
  if (!url || !key) throw new Error('SUPABASE_URL oder SUPABASE_ANON_KEY fehlt in .env');
  client = createClient(url, key);
  return client;
}

export const sb: SupabaseClient = new Proxy({} as SupabaseClient, {
  get(_target, prop) {
    const value = Reflect.get(realClient(), prop);
    return typeof value === 'function' ? value.bind(realClient()) : value;
  },
});
