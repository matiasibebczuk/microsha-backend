const { createClient } = require("@supabase/supabase-js");

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

async function resolveUserRole(user) {
  const tokenRole =
    user?.app_metadata?.role ||
    user?.user_metadata?.role ||
    user?.raw_app_meta_data?.role ||
    user?.raw_user_meta_data?.role ||
    null;

  if (tokenRole) {
    return tokenRole;
  }

  const userId = user?.id;
  if (!userId) return null;

  const { data: profile, error: profileError } = await supabase
    .from("profiles")
    .select("role")
    .eq("id", userId)
    .maybeSingle();

  if (!profileError && profile?.role) {
    return profile.role;
  }

  const { data: usersByAuthId, error: usersByAuthError } = await supabase
    .from("users")
    .select("role")
    .eq("auth_user_id", userId)
    .maybeSingle();

  if (!usersByAuthError && usersByAuthId?.role) {
    return usersByAuthId.role;
  }

  if (user?.email) {
    const { data: usersByEmail, error: usersByEmailError } = await supabase
      .from("users")
      .select("role")
      .eq("email", user.email)
      .maybeSingle();

    if (!usersByEmailError && usersByEmail?.role) {
      return usersByEmail.role;
    }
  }

  return null;
}

function requireRole(...allowedRoles) {
  return async (req, res, next) => {
    try {
      if (!req.user) {
        return res.status(401).json({ error: "No auth user" });
      }

      const role = await resolveUserRole(req.user);
      if (!role) {
        return res.status(403).json({ error: "Role not found" });
      }

      if (!allowedRoles.includes(role)) {
        return res.status(403).json({ error: "Insufficient permissions" });
      }

      req.role = role;
      return next();
    } catch (err) {
      console.error("ROLE MIDDLEWARE ERROR:", err);
      return res.status(500).json({ error: "Role validation failed" });
    }
  };
}

module.exports = {
  requireRole,
  resolveUserRole,
};
