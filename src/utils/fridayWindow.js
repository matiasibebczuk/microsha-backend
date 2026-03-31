const ARGENTINA_TIMEZONE = "America/Argentina/Buenos_Aires";

function getTimezoneOffsetMinutesAt(date, timeZone) {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    timeZoneName: "shortOffset",
    hour: "2-digit",
  }).formatToParts(date);

  const tzPart = parts.find((part) => part.type === "timeZoneName")?.value || "GMT";
  const match = tzPart.match(/GMT([+-])(\d{1,2})(?::?(\d{2}))?/i);
  if (!match) return 0;

  const sign = match[1] === "-" ? -1 : 1;
  const hh = Number(match[2] || 0);
  const mm = Number(match[3] || 0);
  return sign * (hh * 60 + mm);
}

function zonedDateTimeToUtcDate({ year, month, day, minutes }, timeZone) {
  const hour = Math.floor(minutes / 60);
  const minute = minutes % 60;

  const utcGuessMs = Date.UTC(year, month - 1, day, hour, minute, 0, 0);
  const utcGuessDate = new Date(utcGuessMs);
  const offsetMinutes = getTimezoneOffsetMinutesAt(utcGuessDate, timeZone);
  return new Date(utcGuessMs - offsetMinutes * 60000);
}

function getZonedDateParts(date, timeZone = ARGENTINA_TIMEZONE) {
  const safeDate = date instanceof Date ? date : new Date(date);
  if (Number.isNaN(safeDate.getTime())) return null;

  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    weekday: "short",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(safeDate);

  const pick = (type) => parts.find((part) => part.type === type)?.value;
  const weekdayMap = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };

  const weekday = weekdayMap[pick("weekday")];
  if (weekday === undefined) return null;

  return {
    weekday,
    year: Number(pick("year")),
    month: Number(pick("month")),
    day: Number(pick("day")),
    minutesOfDay: Number(pick("hour")) * 60 + Number(pick("minute")),
  };
}

function getLastFriday20Iso(referenceDate = new Date(), timeZone = ARGENTINA_TIMEZONE) {
  const referenceParts = getZonedDateParts(referenceDate, timeZone);
  if (!referenceParts) return null;

  let dayDelta = (referenceParts.weekday - 5 + 7) % 7;
  if (dayDelta === 0 && referenceParts.minutesOfDay < 20 * 60) {
    dayDelta = 7;
  }

  const baseCivilMs = Date.UTC(referenceParts.year, referenceParts.month - 1, referenceParts.day) - dayDelta * 24 * 60 * 60 * 1000;
  const baseCivil = new Date(baseCivilMs);

  const cutoffUtc = zonedDateTimeToUtcDate(
    {
      year: baseCivil.getUTCFullYear(),
      month: baseCivil.getUTCMonth() + 1,
      day: baseCivil.getUTCDate(),
      minutes: 20 * 60,
    },
    timeZone
  );

  return cutoffUtc.toISOString();
}

function isAfterFriday20(value, referenceDate = new Date(), timeZone = ARGENTINA_TIMEZONE) {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return false;

  const cutoffIso = getLastFriday20Iso(referenceDate, timeZone);
  if (!cutoffIso) return false;

  const cutoff = new Date(cutoffIso);
  if (Number.isNaN(cutoff.getTime())) return false;

  return date.getTime() >= cutoff.getTime();
}

module.exports = {
  ARGENTINA_TIMEZONE,
  getLastFriday20Iso,
  isAfterFriday20,
};
