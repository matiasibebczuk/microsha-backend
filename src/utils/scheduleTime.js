const DEFAULT_SCHEDULE_TIMEZONE = "America/Argentina/Buenos_Aires";

const WEEKDAY_TO_NUMBER = {
  Sun: 0,
  Mon: 1,
  Tue: 2,
  Wed: 3,
  Thu: 4,
  Fri: 5,
  Sat: 6,
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

function getZonedNowParts(timeZone = DEFAULT_SCHEDULE_TIMEZONE) {
  const now = new Date();
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    weekday: "short",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(now);

  const pick = (type) => parts.find((part) => part.type === type)?.value;
  const weekdayKey = pick("weekday");
  const weekday = WEEKDAY_TO_NUMBER[weekdayKey] ?? now.getUTCDay();
  const year = Number(pick("year"));
  const month = Number(pick("month"));
  const day = Number(pick("day"));
  const hour = Number(pick("hour"));
  const minute = Number(pick("minute"));

  return {
    weekday,
    year,
    month,
    day,
    minutesOfDay: hour * 60 + minute,
  };
}

function getNextScheduleActivationIso(startDay, startTime, timeZone = DEFAULT_SCHEDULE_TIMEZONE) {
  const day = Number(startDay);
  const minutes = parseTimeToMinutes(startTime);
  if (!Number.isInteger(day) || day < 0 || day > 6 || minutes === null) {
    return null;
  }

  const nowParts = getZonedNowParts(timeZone);
  let dayDelta = (day - nowParts.weekday + 7) % 7;
  if (dayDelta === 0 && minutes <= nowParts.minutesOfDay) {
    dayDelta = 7;
  }

  const baseCivilMs = Date.UTC(nowParts.year, nowParts.month - 1, nowParts.day) + dayDelta * 24 * 60 * 60 * 1000;
  const baseCivil = new Date(baseCivilMs);

  const targetUtc = zonedDateTimeToUtcDate(
    {
      year: baseCivil.getUTCFullYear(),
      month: baseCivil.getUTCMonth() + 1,
      day: baseCivil.getUTCDate(),
      minutes,
    },
    timeZone
  );

  return targetUtc.toISOString();
}

function isWaitlistWindowActiveBySchedule(startDay, startTime, endDay, endTime, timeZone = DEFAULT_SCHEDULE_TIMEZONE) {
  const normalizedStartDay = Number(startDay);
  if (!Number.isInteger(normalizedStartDay) || normalizedStartDay < 0 || normalizedStartDay > 6) {
    return false;
  }

  const startMinutes = parseTimeToMinutes(startTime);
  if (startMinutes === null) return false;

  const normalizedEndDay = Number(endDay);
  const endMinutes = parseTimeToMinutes(endTime);

  // Without explicit end, schedule acts as "active from first activation onward".
  if (!Number.isInteger(normalizedEndDay) || normalizedEndDay < 0 || normalizedEndDay > 6 || endMinutes === null) {
    return true;
  }

  const nowParts = getZonedNowParts(timeZone);
  const nowWeekMinutes = nowParts.weekday * 1440 + nowParts.minutesOfDay;
  const startWeekMinutes = normalizedStartDay * 1440 + startMinutes;
  const endWeekMinutes = normalizedEndDay * 1440 + endMinutes;

  let windowDuration = (endWeekMinutes - startWeekMinutes + 7 * 1440) % (7 * 1440);
  if (windowDuration === 0) {
    windowDuration = 7 * 1440;
  }

  const elapsedFromStart = (nowWeekMinutes - startWeekMinutes + 7 * 1440) % (7 * 1440);
  return elapsedFromStart <= windowDuration;
}

module.exports = {
  parseTimeToMinutes,
  getNextScheduleActivationIso,
  isWaitlistWindowActiveBySchedule,
};