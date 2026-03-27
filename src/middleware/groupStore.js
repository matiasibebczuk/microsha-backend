const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { createClient } = require("@supabase/supabase-js");

const dataDir = path.join(__dirname, "..", "..", "data");
const storePath = path.join(dataDir, "groups.json");
const hasSupabaseConfig = Boolean(process.env.SUPABASE_URL && process.env.SUPABASE_SERVICE_ROLE_KEY);
const supabase = hasSupabaseConfig
  ? createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY)
  : null;

function isRecoverableDbError(error) {
  if (!error) return false;
  const text = String(error.message || error).toLowerCase();
  return text.includes("does not exist") || text.includes("relation") || text.includes("schema cache") || text.includes("timeout") || text.includes("network");
}

function ensureStoreShape(store) {
  return {
    groups: Array.isArray(store?.groups) ? store.groups : [],
    staffMemberships: Array.isArray(store?.staffMemberships)
      ? store.staffMemberships
      : [],
    tripGroups: store?.tripGroups && typeof store.tripGroups === "object"
      ? store.tripGroups
      : {},
  };
}

async function loadStore() {
  await fs.promises.mkdir(dataDir, { recursive: true });

  if (!fs.existsSync(storePath)) {
    const initial = ensureStoreShape(null);
    await fs.promises.writeFile(storePath, JSON.stringify(initial, null, 2), "utf8");
    return initial;
  }

  const raw = await fs.promises.readFile(storePath, "utf8");
  const parsed = raw ? JSON.parse(raw) : null;
  return ensureStoreShape(parsed);
}

async function saveStore(store) {
  const normalized = ensureStoreShape(store);
  await fs.promises.mkdir(dataDir, { recursive: true });
  await fs.promises.writeFile(storePath, JSON.stringify(normalized, null, 2), "utf8");
}

function hashPassword(password, salt = crypto.randomBytes(16).toString("hex")) {
  const hash = crypto.scryptSync(password, salt, 64).toString("hex");
  return `${salt}:${hash}`;
}

function verifyPassword(password, storedHash) {
  if (!storedHash || !storedHash.includes(":")) return false;
  const [salt, hash] = storedHash.split(":");
  const computed = crypto.scryptSync(password, salt, 64).toString("hex");
  const a = Buffer.from(hash, "hex");
  const b = Buffer.from(computed, "hex");
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

function normalizeName(name) {
  return String(name || "").trim().toLowerCase();
}

function upsertStaffMembership(store, userId, role, groupId) {
  const cleanUserId = String(userId);
  const cleanGroupId = String(groupId);
  const cleanRole = String(role || "");

  const idx = store.staffMemberships.findIndex((m) => m.userId === cleanUserId);
  const payload = {
    userId: cleanUserId,
    role: cleanRole,
    groupId: cleanGroupId,
    updatedAt: new Date().toISOString(),
  };

  if (idx >= 0) {
    store.staffMemberships[idx] = {
      ...store.staffMemberships[idx],
      ...payload,
    };
  } else {
    store.staffMemberships.push(payload);
  }
}

function getStaffMembership(store, userId) {
  return store.staffMemberships.find((m) => m.userId === String(userId)) || null;
}

function getGroupById(store, groupId) {
  return store.groups.find((g) => g.id === String(groupId)) || null;
}

function getGroupByName(store, groupName) {
  const target = normalizeName(groupName);
  return store.groups.find((g) => normalizeName(g.name) === target) || null;
}

async function createGroup({ name, password, createdBy, groupId }) {
  const cleanName = String(name || "").trim();
  const cleanPassword = String(password || "");
  const cleanGroupId = String(groupId || "").trim();

  if (!cleanName || !cleanPassword) {
    return { error: "Nombre y contraseña son obligatorios" };
  }

  if (!cleanGroupId) {
    return { error: "El ID de grupo es obligatorio" };
  }

  if (cleanPassword.length < 4) {
    return { error: "La contraseña del grupo debe tener al menos 4 caracteres" };
  }

  const group = {
    id: cleanGroupId,
    name: cleanName,
    passwordHash: hashPassword(cleanPassword),
    createdBy: String(createdBy),
    createdAt: new Date().toISOString(),
  };

  if (supabase) {
    try {
      const [{ data: existingById, error: existingByIdError }, { data: existingByName, error: existingByNameError }] = await Promise.all([
        supabase.from("staff_groups").select("id").eq("id", cleanGroupId).maybeSingle(),
        supabase.from("staff_groups").select("id").ilike("name", cleanName).maybeSingle(),
      ]);

      if (existingByIdError && !isRecoverableDbError(existingByIdError)) {
        return { error: existingByIdError.message };
      }
      if (existingByNameError && !isRecoverableDbError(existingByNameError)) {
        return { error: existingByNameError.message };
      }

      if (existingById?.id) {
        return { error: "Ya existe un grupo con ese ID" };
      }
      if (existingByName?.id) {
        return { error: "Ya existe un grupo con ese nombre" };
      }

      const { error: insertError } = await supabase
        .from("staff_groups")
        .insert({
          id: group.id,
          name: group.name,
          password_hash: group.passwordHash,
          created_by: group.createdBy,
        });

      if (!insertError) {
        return { group };
      }

      if (!isRecoverableDbError(insertError)) {
        return { error: insertError.message };
      }
    } catch (err) {
      if (!isRecoverableDbError(err)) {
        return { error: err.message || "No se pudo crear el grupo" };
      }
    }
  }

  const store = await loadStore();

  if (getGroupByName(store, cleanName)) {
    return { error: "Ya existe un grupo con ese nombre" };
  }

  if (getGroupById(store, cleanGroupId)) {
    return { error: "Ya existe un grupo con ese ID" };
  }

  store.groups.push(group);
  await saveStore(store);

  return { group };
}

async function joinGroupByCredentials({ name, password }) {
  const cleanName = String(name || "").trim();
  const cleanPassword = String(password || "");

  if (!cleanName || !cleanPassword) {
    return { error: "Nombre y contraseña son obligatorios" };
  }

  if (supabase) {
    try {
      const { data: groupRows, error: groupRowsError } = await supabase
        .from("staff_groups")
        .select("id, name, password_hash, created_by, created_at")
        .ilike("name", cleanName)
        .limit(1);

      if (groupRowsError && !isRecoverableDbError(groupRowsError)) {
        return { error: groupRowsError.message };
      }

      const dbGroup = Array.isArray(groupRows) && groupRows.length > 0 ? groupRows[0] : null;
      if (dbGroup) {
        const group = {
          id: String(dbGroup.id),
          name: dbGroup.name,
          passwordHash: dbGroup.password_hash,
          createdBy: dbGroup.created_by,
          createdAt: dbGroup.created_at,
        };

        if (!verifyPassword(cleanPassword, group.passwordHash)) {
          return { error: "Contraseña de grupo inválida" };
        }

        return { group };
      }
    } catch (err) {
      if (!isRecoverableDbError(err)) {
        return { error: err.message || "No se pudo unir al grupo" };
      }
    }
  }

  const store = await loadStore();
  const group = getGroupByName(store, cleanName);

  if (!group) {
    return { error: "Grupo no encontrado" };
  }

  if (!verifyPassword(cleanPassword, group.passwordHash)) {
    return { error: "Contraseña de grupo inválida" };
  }

  return { group };
}

async function assignTripToGroup(tripId, groupId) {
  if (supabase) {
    try {
      const { error } = await supabase
        .from("trip_groups")
        .upsert({
          trip_id: Number(tripId),
          group_id: String(groupId),
        }, { onConflict: "trip_id" });
      if (!error) return;
      if (!isRecoverableDbError(error)) throw error;
    } catch (err) {
      if (!isRecoverableDbError(err)) throw err;
    }
  }

  const store = await loadStore();
  store.tripGroups[String(tripId)] = String(groupId);
  await saveStore(store);
}

async function getTripGroupId(tripId) {
  if (supabase) {
    try {
      const { data, error } = await supabase
        .from("trip_groups")
        .select("group_id")
        .eq("trip_id", Number(tripId))
        .maybeSingle();
      if (!error) return data?.group_id ? String(data.group_id) : null;
      if (!isRecoverableDbError(error)) return null;
    } catch (err) {
      if (!isRecoverableDbError(err)) return null;
    }
  }

  const store = await loadStore();
  return store.tripGroups[String(tripId)] || null;
}

async function getTripIdsForGroup(groupId) {
  if (supabase) {
    try {
      const { data, error } = await supabase
        .from("trip_groups")
        .select("trip_id")
        .eq("group_id", String(groupId));

      if (!error) {
        return (data || [])
          .map((row) => Number(row.trip_id))
          .filter((id) => Number.isFinite(id));
      }
      if (!isRecoverableDbError(error)) {
        return [];
      }
    } catch (err) {
      if (!isRecoverableDbError(err)) {
        return [];
      }
    }
  }

  const store = await loadStore();
  const wanted = String(groupId);

  return Object.entries(store.tripGroups)
    .filter(([, gId]) => String(gId) === wanted)
    .map(([tripId]) => Number(tripId))
    .filter((id) => Number.isFinite(id));
}

async function getUnassignedTripIds(tripIds) {
  if (supabase) {
    try {
      const normalized = (Array.isArray(tripIds) ? tripIds : [])
        .map((tripId) => Number(tripId))
        .filter((tripId) => Number.isFinite(tripId));

      if (normalized.length === 0) return [];

      const { data, error } = await supabase
        .from("trip_groups")
        .select("trip_id")
        .in("trip_id", normalized);

      if (!error) {
        const assigned = new Set((data || []).map((row) => Number(row.trip_id)));
        return normalized.filter((tripId) => !assigned.has(tripId));
      }

      if (!isRecoverableDbError(error)) return [];
    } catch (err) {
      if (!isRecoverableDbError(err)) return [];
    }
  }

  const store = await loadStore();

  return (Array.isArray(tripIds) ? tripIds : [])
    .map((tripId) => Number(tripId))
    .filter((tripId) => Number.isFinite(tripId))
    .filter((tripId) => !store.tripGroups[String(tripId)]);
}

async function bindStaffToGroup({ userId, role, groupId }) {
  if (supabase) {
    try {
      const { error } = await supabase
        .from("staff_group_memberships")
        .upsert({
          user_id: String(userId),
          role: String(role || ""),
          group_id: String(groupId),
        }, { onConflict: "user_id" });
      if (!error) return;
      if (!isRecoverableDbError(error)) throw error;
    } catch (err) {
      if (!isRecoverableDbError(err)) throw err;
    }
  }

  const store = await loadStore();
  upsertStaffMembership(store, userId, role, groupId);
  await saveStore(store);
}

async function getStaffGroupByUserId(userId) {
  if (supabase) {
    try {
      const { data, error } = await supabase
        .from("staff_group_memberships")
        .select("group_id")
        .eq("user_id", String(userId))
        .maybeSingle();

      if (!error) return data?.group_id ? String(data.group_id) : null;
      if (!isRecoverableDbError(error)) return null;
    } catch (err) {
      if (!isRecoverableDbError(err)) return null;
    }
  }

  const store = await loadStore();
  return getStaffMembership(store, userId)?.groupId || null;
}

async function getStaffMembershipsByGroup(groupId) {
  if (supabase) {
    try {
      const { data, error } = await supabase
        .from("staff_group_memberships")
        .select("user_id, role, group_id, updated_at")
        .eq("group_id", String(groupId));

      if (!error) {
        return (data || []).map((row) => ({
          userId: String(row.user_id),
          role: String(row.role || ""),
          groupId: String(row.group_id),
          updatedAt: row.updated_at || null,
        }));
      }
      if (!isRecoverableDbError(error)) return [];
    } catch (err) {
      if (!isRecoverableDbError(err)) return [];
    }
  }

  const store = await loadStore();
  const wanted = String(groupId);
  return (store.staffMemberships || []).filter((membership) => String(membership.groupId) === wanted);
}

async function getGroupPublicById(groupId) {
  if (supabase) {
    try {
      const { data, error } = await supabase
        .from("staff_groups")
        .select("id, name, created_at")
        .eq("id", String(groupId))
        .maybeSingle();

      if (!error && data) {
        return {
          id: String(data.id),
          name: data.name,
          createdAt: data.created_at || null,
        };
      }

      if (!error) return null;
      if (!isRecoverableDbError(error)) return null;
    } catch (err) {
      if (!isRecoverableDbError(err)) return null;
    }
  }

  const store = await loadStore();
  const group = getGroupById(store, groupId);
  if (!group) return null;

  return {
    id: group.id,
    name: group.name,
    createdAt: group.createdAt,
  };
}

module.exports = {
  createGroup,
  joinGroupByCredentials,
  assignTripToGroup,
  getTripGroupId,
  getTripIdsForGroup,
  getUnassignedTripIds,
  bindStaffToGroup,
  getStaffGroupByUserId,
  getStaffMembershipsByGroup,
  getGroupPublicById,
};
