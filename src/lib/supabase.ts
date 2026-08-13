import { createClient } from '@supabase/supabase-js';

const url = process.env.SUPABASE_URL;
const key = process.env.SUPABASE_ANON_KEY;

if (!url || !key) throw new Error('SUPABASE_URL oder SUPABASE_ANON_KEY fehlt in .env');

export const sb = createClient(url, key);
