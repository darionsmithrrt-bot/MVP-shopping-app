import { supabase } from "../supabaseClient";

export const tryInsertWithPayloads = async (tableName, payloads) => {
  for (const payload of payloads) {
    const { error, data } = await supabase
      .from(tableName)
      .insert(payload)
      .select();

    if (!error) {
      return { success: true, payloadUsed: payload, data };
    }
  }

  return { success: false };
};