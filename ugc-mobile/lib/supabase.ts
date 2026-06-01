import 'react-native-url-polyfill/auto';

import AsyncStorage from '@react-native-async-storage/async-storage';
import { createClient } from '@supabase/supabase-js';

import { env, isMobileEnvConfigured } from './env';

export const isSupabaseConfigured = isMobileEnvConfigured();

const serverAuthStorage = {
  getItem: async () => null,
  setItem: async () => undefined,
  removeItem: async () => undefined,
};

export const supabase = createClient(
  isSupabaseConfigured ? env.supabaseUrl : 'https://missing-mobile-env.supabase.co',
  isSupabaseConfigured ? env.supabasePublishableKey : 'missing-mobile-env',
  {
    auth: {
      storage: typeof window === 'undefined' ? serverAuthStorage : AsyncStorage,
      autoRefreshToken: true,
      persistSession: true,
      detectSessionInUrl: false,
    },
  },
);
