import { createClient } from "@supabase/supabase-js";

const supabaseUrl = "https://gdgsjyawleacpazvkcvo.supabase.co";
const supabaseAnonKey = "sb_publishable_8UYslR_nlTURF1DLH4LqqA_WmZYHroE";

console.log("SUPABASE URL:", supabaseUrl);
console.log("SUPABASE ANON KEY PRESENT:", !!supabaseAnonKey);

export const supabase = createClient(supabaseUrl, supabaseAnonKey);