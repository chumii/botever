import { Monitor } from '../types';
import { sb } from '../lib/supabase';

// Supabase pausiert Free-Projekte nach 7 Tagen ohne DB-Aktivität; der Bot fragt die DB sonst nur bei Nutzung ab.
const INTERVAL_MS = 6 * 60 * 60 * 1000;

async function ping() {
  try {
    const { error } = await sb.from('bot_settings').select('id').limit(1);
    if (error) console.error('keepaliveMonitor ping error:', error);
  } catch (err) {
    console.error('keepaliveMonitor ping error:', err);
  }
}

export const keepaliveMonitor: Monitor = {
  init() {
    setTimeout(ping, 30 * 1000);
    setInterval(ping, INTERVAL_MS);
  },
};
