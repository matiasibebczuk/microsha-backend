const express = require("express");
const auth = require("../middleware/auth");
const { createClient } = require("@supabase/supabase-js");

const router = express.Router();

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

async function ensureProfile({ userId, name, role, email }) {
  if (!userId || !role) return null;

  const payload = {
    id: userId,
    name: name || "Usuario",
    role,
  };

  const { data, error } = await supabase
    .from("profiles")
    .upsert(payload, { onConflict: "id" })
    .select("id, name, lastname, role")
    .single();

  if (error || !data) {
    return {
      id: userId,
      name: payload.name,
      role,
      email: email || null,
    };
  }

  return {
    ...data,
    email: email || null,
  };
}

router.get("/", auth, async (req, res) => {
  try {
    const userId = req.user.id;
    const authRole =
      req.user?.app_metadata?.role ||
      req.user?.user_metadata?.role ||
      req.user?.raw_app_meta_data?.role ||
      req.user?.raw_user_meta_data?.role ||
      null;
    const authName =
      req.user?.user_metadata?.name ||
      req.user?.raw_user_meta_data?.name ||
      req.user?.email ||
      "Usuario";

    const { data: profileData, error: profileError } = await supabase
      .from("profiles")
      .select("id, name, lastname, role")
      .eq("id", userId)
      .single();

    if (!profileError && profileData) {
      return res.json({
        ...profileData,
        email: req.user.email || null,
      });
    }

    const { data: usersByAuthId, error: usersByAuthIdError } = await supabase
      .from("users")
      .select("id, name, role")
      .eq("auth_user_id", userId)
      .maybeSingle();

    if (!usersByAuthIdError && usersByAuthId) {
      return res.json(
        await ensureProfile({
          userId,
          name: usersByAuthId.name,
          role: usersByAuthId.role,
          email: req.user.email,
        })
      );
    }

    const { data: usersById, error: usersByIdError } = await supabase
      .from("users")
      .select("id, name, role")
      .eq("id", userId)
      .maybeSingle();

    if (!usersByIdError && usersById) {
      return res.json(
        await ensureProfile({
          userId,
          name: usersById.name,
          role: usersById.role,
          email: req.user.email,
        })
      );
    }

    if (req.user.email) {
      const { data: usersByEmail, error: usersByEmailError } = await supabase
        .from("users")
        .select("id, name, role")
        .eq("email", req.user.email)
        .maybeSingle();

      if (!usersByEmailError && usersByEmail) {
        return res.json(
          await ensureProfile({
            userId,
            name: usersByEmail.name,
            role: usersByEmail.role,
            email: req.user.email,
          })
        );
      }
    }

    const { data: authUserData, error: authUserError } =
      await supabase.auth.admin.getUserById(userId);

    const adminUser = authUserData?.user;
    const roleFromAdminUser =
      adminUser?.app_metadata?.role ||
      adminUser?.user_metadata?.role ||
      adminUser?.raw_app_meta_data?.role ||
      adminUser?.raw_user_meta_data?.role ||
      null;

    if (!authUserError && roleFromAdminUser) {
      return res.json(
        await ensureProfile({
          userId,
          name: adminUser?.user_metadata?.name || adminUser?.email || authName,
          role: roleFromAdminUser,
          email: adminUser?.email || req.user.email || null,
        })
      );
    }

    if (authRole) {
      return res.json(
        await ensureProfile({
          userId,
          name: authName,
          role: authRole,
          email: req.user.email || null,
        })
      );
    }

    return res.status(404).json({ error: "Profile not found" });

  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Server exploded" });
  }
});


module.exports = router;
