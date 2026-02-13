const { createClient } = require("@supabase/supabase-js");
const {
  getStaffGroupByUserId,
  getTripGroupId,
} = require("./groupStore");

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

async function getStaffGroupId(user) {
  const userId = user?.id;
  if (!userId) return null;

  const fromStore = await getStaffGroupByUserId(userId);
  if (fromStore) return String(fromStore);

  const fromToken =
    user?.app_metadata?.group_id ||
    user?.user_metadata?.group_id ||
    user?.raw_app_meta_data?.group_id ||
    user?.raw_user_meta_data?.group_id ||
    null;

  if (fromToken) return String(fromToken);

  return null;
}

async function getPassengerGroupId(userId) {
  if (!userId) return null;

  const { data, error } = await supabase
    .from("users")
    .select("group_number, organization_id")
    .eq("id", userId)
    .maybeSingle();

  if (error || !data) return null;

  const groupId = data.group_number ?? data.organization_id ?? null;
  return groupId ? String(groupId) : null;
}

async function requireStaffGroup(req, res, next) {
  try {
    const groupId = await getStaffGroupId(req.user);
    if (!groupId) {
      return res.status(403).json({
        error: "Primero debes crear o unirte a un grupo",
      });
    }

    req.groupId = String(groupId);
    return next();
  } catch (err) {
    console.error("GROUP STAFF RESOLVE ERROR:", err);
    return res.status(500).json({ error: "No se pudo validar grupo" });
  }
}

async function assertTripInGroup(tripId, groupId) {
  const tripGroupId = await getTripGroupId(tripId);
  if (!tripGroupId) {
    return false;
  }

  return String(tripGroupId) === String(groupId);
}

module.exports = {
  getStaffGroupId,
  getPassengerGroupId,
  requireStaffGroup,
  assertTripInGroup,
};
