const fs = require("fs");
const path = require("path");

const dataDir = path.join(__dirname, "..", "..", "data");
const flagsPath = path.join(dataDir, "system-flags.json");
const ARGENTINA_TIMEZONE = "America/Argentina/Buenos_Aires";
const DAY_MS = 24 * 60 * 60 * 1000;

const DEFAULT_FLAGS = {
  tripsPaused: false,
  pauseMessage: "En mantenimiento, prueba mas tarde",
  scheduledPauseEnabled: false,
  scheduledPauseDay: null,
  scheduledPauseTime: null,
  scheduledPauseLastTriggerWeek: null,
};

function parseTimeToMinutes(value) {
  const text = String(value || "").trim();
  const match = text.match(/^(\d{1,2}):(\d{2})/);
  if (!match) return null;

  const hh = Number(match[1]);
  const mm = Number(match[2]);
  if (!Number.isFinite(hh) || !Number.isFinite(mm) || hh < 0 || hh > 23 || mm < 0 || mm > 59) {
    return null;
  }

  return hh * 60 + mm;
}

function normalizeClockTime(value) {
  const mins = parseTimeToMinutes(value);
  if (mins === null) return null;
  const hh = String(Math.floor(mins / 60)).padStart(2, "0");
  const mm = String(mins % 60).padStart(2, "0");
  return `${hh}:${mm}`;
}

function getArgentinaNowParts() {
  const now = new Date();
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: ARGENTINA_TIMEZONE,
    weekday: "short",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(now);

  const pick = (type) => parts.find((part) => part.type === type)?.value;
  const weekdayMap = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };

  const year = Number(pick("year"));
  const month = Number(pick("month"));
  const day = Number(pick("day"));
  const hour = Number(pick("hour"));
  const minute = Number(pick("minute"));
  const weekday = weekdayMap[pick("weekday")] ?? null;

  return {
    year,
    month,
    day,
    weekday,
    minutesOfDay: hour * 60 + minute,
    weekMinutes: (weekday ?? 0) * 1440 + (hour * 60 + minute),
  };
}

function getCurrentArgentinaWeekKey() {
  const now = getArgentinaNowParts();
  if (!Number.isFinite(now.year) || !Number.isFinite(now.month) || !Number.isFinite(now.day) || now.weekday === null) {
    return null;
  }

  const todayUtcMs = Date.UTC(now.year, now.month - 1, now.day);
  const sundayUtcMs = todayUtcMs - now.weekday * DAY_MS;
  const sunday = new Date(sundayUtcMs);
  const y = sunday.getUTCFullYear();
  const m = String(sunday.getUTCMonth() + 1).padStart(2, "0");
  const d = String(sunday.getUTCDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

function normalizeFlags(raw) {
  const day = raw?.scheduledPauseDay;
  const normalizedDay = day === null || day === undefined || day === "" ? null : Number(day);
  const validDay = Number.isInteger(normalizedDay) && normalizedDay >= 0 && normalizedDay <= 6 ? normalizedDay : null;
  const normalizedTime = normalizeClockTime(raw?.scheduledPauseTime);

  return {
    tripsPaused: Boolean(raw?.tripsPaused),
    pauseMessage: String(raw?.pauseMessage || DEFAULT_FLAGS.pauseMessage),
    scheduledPauseEnabled: Boolean(raw?.scheduledPauseEnabled) && validDay !== null && Boolean(normalizedTime),
    scheduledPauseDay: validDay,
    scheduledPauseTime: normalizedTime,
    scheduledPauseLastTriggerWeek: raw?.scheduledPauseLastTriggerWeek ? String(raw.scheduledPauseLastTriggerWeek) : null,
  };
}

async function applyScheduledPauseIfDue(flags) {
  if (!flags?.scheduledPauseEnabled) return { flags, changed: false };
  if (flags.scheduledPauseDay === null || !flags.scheduledPauseTime) return { flags, changed: false };

  const now = getArgentinaNowParts();
  if (now.weekday === null) return { flags, changed: false };

  const targetMinutes = parseTimeToMinutes(flags.scheduledPauseTime);
  if (targetMinutes === null) return { flags, changed: false };

  const currentWeekKey = getCurrentArgentinaWeekKey();
  if (!currentWeekKey) return { flags, changed: false };

  const targetWeekMinutes = flags.scheduledPauseDay * 1440 + targetMinutes;
  const dueThisWeek = now.weekMinutes >= targetWeekMinutes;
  const alreadyTriggeredThisWeek = flags.scheduledPauseLastTriggerWeek === currentWeekKey;

  if (!dueThisWeek || alreadyTriggeredThisWeek) {
    return { flags, changed: false };
  }

  const next = {
    ...flags,
    tripsPaused: true,
    scheduledPauseLastTriggerWeek: currentWeekKey,
  };

  await fs.promises.mkdir(dataDir, { recursive: true });
  await fs.promises.writeFile(flagsPath, JSON.stringify(next, null, 2), "utf8");
  return { flags: next, changed: true };
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
    const normalized = normalizeFlags(parsed);
    const { flags } = await applyScheduledPauseIfDue(normalized);
    return flags;
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
