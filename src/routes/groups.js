const express = require("express");
const { createClient } = require("@supabase/supabase-js");
const auth = require("../middleware/auth");
const { resolveUserRole } = require("../middleware/roles");
const {
  createGroup,
  joinGroupByCredentials,
  bindStaffToGroup,
  getGroupPublicById,
} = require("../middleware/groupStore");
const { getStaffGroupId } = require("../middleware/groupAccess");

const router = express.Router();

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

router.use(auth);

async function ensureStaffRole(req, res, next) {
  try {
    const role = await resolveUserRole(req.user);

    if (!["admin", "encargado"].includes(role)) {
      return res.status(403).json({ error: "Solo staff puede usar grupos" });
    }

    req.role = role;
    return next();
  } catch (err) {
    console.error("GROUP ROLE ERROR:", err);
    return res.status(500).json({ error: "No se pudo validar rol" });
  }
}

router.use(ensureStaffRole);

async function persistUserGroupMetadata(user, role, groupId) {
  const appMetadata = {
    ...(user?.app_metadata || {}),
    role,
    group_id: String(groupId),
  };

  const userMetadata = {
    ...(user?.user_metadata || {}),
    role,
    group_id: String(groupId),
  };

  await supabase.auth.admin.updateUserById(user.id, {
    app_metadata: appMetadata,
    user_metadata: userMetadata,
  });
}

async function tryPersistUserGroupMetadata(user, role, groupId) {
  try {
    await persistUserGroupMetadata(user, role, groupId);
  } catch (err) {
    console.error("GROUP METADATA UPDATE WARNING:", err?.message || err);
  }
}

router.get("/me", async (req, res) => {
  try {
    const groupId = await getStaffGroupId(req.user);
    const group = groupId ? await getGroupPublicById(groupId) : null;

    return res.json({
      role: req.role,
      hasGroup: Boolean(groupId),
      groupId: groupId || null,
      groupName: group?.name || null,
    });
  } catch (err) {
    console.error("GROUP ME ERROR:", err);
    return res.status(500).json({ error: "No se pudo consultar el grupo" });
  }
});

router.post("/create", async (req, res) => {
  try {
    if (req.role !== "admin") {
      return res.status(403).json({ error: "Solo admin puede crear grupos" });
    }

    const { name, password, groupId } = req.body || {};
    const { group, error } = await createGroup({
      name,
      password,
      groupId,
      createdBy: req.user.id,
    });

    if (error) {
      return res.status(400).json({ error });
    }

    await bindStaffToGroup({
      userId: req.user.id,
      role: req.role,
      groupId: group.id,
    });

    await tryPersistUserGroupMetadata(req.user, req.role, group.id);

    return res.status(201).json({
      success: true,
      groupId: group.id,
      groupName: group.name,
    });
  } catch (err) {
    console.error("GROUP CREATE ERROR:", err);
    return res.status(500).json({ error: "No se pudo crear grupo" });
  }
});

router.post("/join", async (req, res) => {
  try {
    const { name, password } = req.body || {};
    const { group, error } = await joinGroupByCredentials({ name, password });

    if (error) {
      return res.status(400).json({ error });
    }

    await bindStaffToGroup({
      userId: req.user.id,
      role: req.role,
      groupId: group.id,
    });

    await tryPersistUserGroupMetadata(req.user, req.role, group.id);

    return res.json({
      success: true,
      groupId: group.id,
      groupName: group.name,
    });
  } catch (err) {
    console.error("GROUP JOIN ERROR:", err);
    return res.status(500).json({ error: "No se pudo unir al grupo" });
  }
});

module.exports = router;
