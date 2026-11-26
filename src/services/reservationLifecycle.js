const fs = require("node:fs");
const path = require("node:path");
const { supabase } = require("../lib/supabaseClient");
const { memoryCache } = require("../utils/cache");
const { getSystemFlags } = require("./systemFlags");
const { isWaitlistWindowActiveBySchedule } = require("../utils/scheduleTime");

const logsDir = path.join(__dirname, "..", "..", "logs");
const cancellationsLogPath = path.join(logsDir, "reservation-cancellations.jsonl");

async function getTripCapacity(tripId) {
  return memoryCache.getOrSet(
    `trip_capacity:${tripId}`,
    async () => {
      const flags = await getSystemFlags();
      if (
        flags?.busCapacityOverride != null &&
        Number.isFinite(flags.busCapacityOverride) &&
        flags.busCapacityOverride > 0
      ) {
        const { data, error } = await supabase
          .from("trip_buses")
          .select("bus_id")
          .eq("trip_id", tripId);
        if (error) throw error;
        return (data?.length || 1) * flags.busCapacityOverride;
      }

      const { data, error } = await supabase
        .from("trip_buses")
        .select("buses ( capacity )")
        .eq("trip_id", tripId);

      if (error) throw error;

      return (
        data?.reduce((sum, row) => sum + (row.buses?.capacity || 0), 0) || 0
      );
    },
    15000
  );
}

async function appendCancellationLog(entry) {
  try {
    const { error } = await supabase.from("trip_cancellations_log").insert({
      canceled_at: entry.canceled_at,
      trip_id: Number(entry.trip_id),
      user_id: entry.user_id || null,
      reservation_id: entry.reservation_id ? Number(entry.reservation_id) : null,
      status_at_cancel: entry.status_at_cancel || null,
      user_name: entry.user_name || "Sin nombre",
      description: entry.description || "",
    });

    if (!error) return;
    const tableMissing =
      error?.code === "42P01" ||
      String(error?.message || "").toLowerCase().includes("does not exist");
    if (!tableMissing) throw error;
  } catch (error) {
    console.warn(
      "⚠️ CANCELLATION DB LOG FAILED, USING FILE FALLBACK:",
      error?.message || error
    );
  }

  await fs.promises.mkdir(logsDir, { recursive: true });
  await fs.promises.appendFile(
    cancellationsLogPath,
    `${JSON.stringify(entry)}\n`,
    "utf8"
  );
}

async function getTripStatus(tripId) {
  return memoryCache.getOrSet(
    `trip_status:${tripId}`,
    async () => {
      const [{ data, error }, { data: activeRun, error: runError }] =
        await Promise.all([
          supabase
            .from("trips")
            .select(
              "name, type, status, departure_datetime, waitlist_start_at, waitlist_end_at, waitlist_start_day, waitlist_start_time, waitlist_end_day, waitlist_end_time"
            )
            .eq("id", tripId)
            .maybeSingle(),
          supabase
            .from("trip_runs")
            .select("id")
            .eq("trip_id", tripId)
            .is("finished_at", null)
            .limit(1)
            .maybeSingle(),
        ]);

      if (error) throw error;
      if (runError && runError.code !== "42P01") throw runError;
      if (!data) return null;

      return {
        ...data,
        hasActiveRun: Boolean(activeRun),
      };
    },
    2000
  );
}

function isWaitlistTemporarilySuppressed(trip) {
  const hasSchedule =
    trip?.waitlist_start_day !== null &&
    trip?.waitlist_start_day !== undefined &&
    trip?.waitlist_start_time;
  if (!hasSchedule || !trip?.waitlist_end_at) return false;

  const endDate = new Date(trip.waitlist_end_at);
  if (Number.isNaN(endDate.getTime())) return false;
  return Date.now() < endDate.getTime();
}

function isWaitlistWindowActiveLegacy(waitlistStartAt, waitlistEndAt) {
  if (!waitlistStartAt) return false;
  const startDate = new Date(waitlistStartAt);
  if (Number.isNaN(startDate.getTime())) return false;

  const now = Date.now();
  if (startDate.getTime() > now) return false;
  if (!waitlistEndAt) return true;

  const endDate = new Date(waitlistEndAt);
  if (Number.isNaN(endDate.getTime())) return true;
  return now <= endDate.getTime();
}

function isWaitlistWindowActive(trip) {
  if (!trip || typeof trip !== "object") return false;
  if (isWaitlistTemporarilySuppressed(trip)) return false;

  if (
    trip.waitlist_start_day !== null &&
    trip.waitlist_start_day !== undefined &&
    trip.waitlist_start_time
  ) {
    return isWaitlistWindowActiveBySchedule(
      trip.waitlist_start_day,
      trip.waitlist_start_time,
      trip.waitlist_end_day,
      trip.waitlist_end_time
    );
  }

  return isWaitlistWindowActiveLegacy(
    trip.waitlist_start_at,
    trip.waitlist_end_at
  );
}

function buildNotificationScheduleFromDate(baseDate) {
  const promotedAt = baseDate instanceof Date ? baseDate : new Date();
  const notifyAfter = new Date(promotedAt.getTime() + 5 * 60 * 1000);
  return {
    waiting_promoted_at: promotedAt.toISOString(),
    confirm_notify_after: notifyAfter.toISOString(),
    confirm_notified_at: null,
  };
}

async function promoteWaitingPassengersIfNeeded(tripId) {
  const trip = await getTripStatus(tripId);
  if (!trip?.status || trip.status !== "open") {
    return { promotedCount: 0, promotedReservationIds: [] };
  }

  if (!isWaitlistWindowActive(trip)) {
    return { promotedCount: 0, promotedReservationIds: [] };
  }

  const capacity = await getTripCapacity(tripId);
  if (capacity <= 0) {
    return { promotedCount: 0, promotedReservationIds: [] };
  }

  const { count: confirmed, error: confirmedError } = await supabase
    .from("reservations")
    .select("*", { count: "exact", head: true })
    .eq("trip_id", tripId)
    .eq("status", "confirmed");
  if (confirmedError) throw confirmedError;

  const availableSeats = Math.max(0, capacity - (confirmed || 0));
  if (availableSeats === 0) {
    return { promotedCount: 0, promotedReservationIds: [] };
  }

  const { data: waitingRows, error: waitingError } = await supabase
    .from("reservations")
    .select("id")
    .eq("trip_id", tripId)
    .eq("status", "waiting")
    .order("id", { ascending: true })
    .limit(availableSeats);
  if (waitingError) throw waitingError;

  const reservationIds = (waitingRows || [])
    .map((row) => row.id)
    .filter(Boolean);
  if (reservationIds.length === 0) {
    return { promotedCount: 0, promotedReservationIds: [] };
  }

  const { error: promoteError } = await supabase
    .from("reservations")
    .update({
      status: "confirmed",
      ...buildNotificationScheduleFromDate(new Date()),
    })
    .in("id", reservationIds);
  if (promoteError) throw promoteError;

  invalidateReservationCaches(tripId);
  return {
    promotedCount: reservationIds.length,
    promotedReservationIds: reservationIds,
  };
}

function invalidateReservationCaches(tripId) {
  memoryCache.del(`trip_status:${tripId}`);
  memoryCache.delPrefix("trips_list:");
}

module.exports = {
  appendCancellationLog,
  getTripCapacity,
  getTripStatus,
  invalidateReservationCaches,
  isWaitlistWindowActive,
  promoteWaitingPassengersIfNeeded,
};
