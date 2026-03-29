const fs = require("fs");
const path = require("path");

const dataDir = path.join(__dirname, "..", "..", "data");
const flagsPath = path.join(dataDir, "system-flags.json");

const DEFAULT_FLAGS = {
  tripsPaused: false,
  pauseMessage: "En mantenimiento, prueba mas tarde",
};

function normalizeFlags(raw) {
  return {
    tripsPaused: Boolean(raw?.tripsPaused),
    pauseMessage: String(raw?.pauseMessage || DEFAULT_FLAGS.pauseMessage),
  };
}

async function getSystemFlags() {
  await fs.promises.mkdir(dataDir, { recursive: true });

  if (!fs.existsSync(flagsPath)) {
    const initial = normalizeFlags(DEFAULT_FLAGS);
    await fs.promises.writeFile(flagsPath, JSON.stringify(initial, null, 2), "utf8");
    return initial;
  }

  try {
    const raw = await fs.promises.readFile(flagsPath, "utf8");
    const parsed = raw ? JSON.parse(raw) : {};
    return normalizeFlags(parsed);
  } catch {
    return normalizeFlags(DEFAULT_FLAGS);
  }
}

async function setSystemFlags(patch) {
  const current = await getSystemFlags();
  const next = normalizeFlags({
    ...current,
    ...(patch && typeof patch === "object" ? patch : {}),
  });

  await fs.promises.mkdir(dataDir, { recursive: true });
  await fs.promises.writeFile(flagsPath, JSON.stringify(next, null, 2), "utf8");
  return next;
}

module.exports = {
  getSystemFlags,
  setSystemFlags,
};
