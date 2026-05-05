import { createClient } from "@supabase/supabase-js";

export const supabaseUrl = "https://gdgsjyawleacpazvkcvo.supabase.co";
export const supabaseAnonKey = "sb_publishable_8UYslR_nlTURF1DLH4LqqA_WmZYHroE";

console.log("SUPABASE URL IN FRONTEND:", supabaseUrl);
console.log("SUPABASE ANON KEY PRESENT:", !!supabaseAnonKey);

export const supabase = createClient(supabaseUrl, supabaseAnonKey);