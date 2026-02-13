const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const dataDir = path.join(__dirname, "..", "..", "data");
const storePath = path.join(dataDir, "groups.json");

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

  const store = await loadStore();

  if (getGroupByName(store, cleanName)) {
    return { error: "Ya existe un grupo con ese nombre" };
  }

  if (getGroupById(store, cleanGroupId)) {
    return { error: "Ya existe un grupo con ese ID" };
  }

  const group = {
    id: cleanGroupId,
    name: cleanName,
    passwordHash: hashPassword(cleanPassword),
    createdBy: String(createdBy),
    createdAt: new Date().toISOString(),
  };

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
  const store = await loadStore();
  store.tripGroups[String(tripId)] = String(groupId);
  await saveStore(store);
}

async function getTripGroupId(tripId) {
  const store = await loadStore();
  return store.tripGroups[String(tripId)] || null;
}

async function getTripIdsForGroup(groupId) {
  const store = await loadStore();
  const wanted = String(groupId);

  return Object.entries(store.tripGroups)
    .filter(([, gId]) => String(gId) === wanted)
    .map(([tripId]) => Number(tripId))
    .filter((id) => Number.isFinite(id));
}

async function bindStaffToGroup({ userId, role, groupId }) {
  const store = await loadStore();
  upsertStaffMembership(store, userId, role, groupId);
  await saveStore(store);
}

async function getStaffGroupByUserId(userId) {
  const store = await loadStore();
  return getStaffMembership(store, userId)?.groupId || null;
}

async function getGroupPublicById(groupId) {
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
  bindStaffToGroup,
  getStaffGroupByUserId,
  getGroupPublicById,
};
