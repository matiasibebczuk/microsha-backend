const { supabase } = require("../../lib/supabaseClient");
const { createBb8Error } = require("./errors");

const CLUB_ID = 1926;

function isMissingSchemaObject(error) {
  return ["42P01", "42703", "PGRST200", "PGRST204", "PGRST205"].includes(
    String(error?.code || "")
  );
}

async function hasAdminRole(user) {
  if (user?.app_metadata?.role === "admin") return true;

  const profileResult = await supabase
    .from("profiles")
    .select("role")
    .eq("id", user.id)
    .maybeSingle();

  if (!profileResult.error && profileResult.data?.role) {
    return profileResult.data.role === "admin";
  }
  if (profileResult.error && !isMissingSchemaObject(profileResult.error)) {
    throw profileResult.error;
  }

  const userResult = await supabase
    .from("users")
    .select("role")
    .eq("auth_user_id", user.id)
    .maybeSingle();

  if (userResult.error) throw userResult.error;
  return userResult.data?.role === "admin";
}

async function authenticateClubAdmin(req) {
  const authorization = String(req.headers.authorization || "");
  const match = authorization.match(/^Bearer\s+(.+)$/i);
  if (!match) {
    throw createBb8Error("Iniciá sesión para usar BB8.", 401, "AUTH_REQUIRED");
  }

  const { data: authData, error: authError } = await supabase.auth.getUser(match[1]);
  if (authError || !authData?.user) {
    throw createBb8Error("La sesión no es válida o expiró.", 401, "INVALID_SESSION");
  }

  const user = authData.user;
  if (!(await hasAdminRole(user))) {
    throw createBb8Error("BB8 está disponible solo para administradores.", 403, "ADMIN_REQUIRED");
  }

  const { data: membership, error: membershipError } = await supabase
    .from("staff_group_memberships")
    .select("group_id, role")
    .eq("user_id", user.id)
    .eq("group_id", CLUB_ID)
    .maybeSingle();

  if (membershipError) throw membershipError;
  if (
    !membership ||
    String(membership.group_id) !== String(CLUB_ID) ||
    membership.role !== "admin"
  ) {
    throw createBb8Error(
      "BB8 solo está habilitado para administradores del club 1926.",
      403,
      "CLUB_ACCESS_DENIED"
    );
  }

  const { data: group, error: groupError } = await supabase
    .from("staff_groups")
    .select("id")
    .eq("id", CLUB_ID)
    .maybeSingle();

  if (groupError) throw groupError;
  if (!group || String(group.id) !== String(CLUB_ID)) {
    throw createBb8Error("No se pudo validar el club 1926.", 403, "CLUB_NOT_FOUND");
  }

  return user;
}

module.exports = {
  CLUB_ID,
  authenticateClubAdmin,
};
