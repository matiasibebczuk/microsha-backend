const { createClient } = require("@supabase/supabase-js");

const supabaseUrl = process.env.SUPABASE_URL;
const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
const debug = String(process.env.DEBUG_AUTH || "").toLowerCase() === "true";

if (!supabaseUrl || !serviceRoleKey) {
  console.error("[supabase] Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY");
}

if (debug) {
  let host = "invalid-url";
  try {
    host = new URL(supabaseUrl).host;
  } catch {
    host = "invalid-url";
  }

  console.info("[supabase] backend client init", {
    host,
    hasServiceKey: Boolean(serviceRoleKey),
  });
}

const supabase = createClient(supabaseUrl, serviceRoleKey);

module.exports = {
  supabase,
};
