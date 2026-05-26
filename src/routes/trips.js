const express = require("express");
const { createClient } = require("@supabase/supabase-js");
const auth = require("../middleware/auth");
const { requireRole, resolveUserRole } = require("../middleware/roles");
const {
  getStaffGroupId,
  getPassengerGroupId,
  requireStaffGroup,
  assertTripInGroup,
} = require("../middleware/groupAccess");
const {
  assignTripToGroup,
  getTripIdsForGroup,
  getUnassignedTripIds,
  getGroupPublicById,
} = require("../middleware/groupStore");
const { notifyAdminsReinforcementActivated } = require("../services/reinforcementNotifications");
const { getSystemFlags } = require("../services/systemFlags");
const {
  verifyPassengerToken,
  getPassengerTokenFromRequest,
} = require("../middleware/passengerSession");
const {
  getNextScheduleActivationIso,
  isWaitlistWindowActiveBySchedule,
  normalizeClockTime,
} = require("../utils/scheduleTime");

const router = express.Router();

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

async function resolveRequestGroupId(req) {
  const authHeader = req.headers.authorization || "";

  if (authHeader.toLowerCase().startsWith("bearer ")) {
    const token = authHeader.slice(7).trim();
    const { data, error } = await supabase.auth.getUser(token);

    if (error || !data?.user) {
      return { error: "Invalid auth token", status: 401 };
    }

    const role = await resolveUserRole(data.user);
    if (!["admin", "encargado"].includes(role)) {
      return { error: "Staff role required", status: 403 };
    }

    const groupId = await getStaffGroupId(data.user);
    if (!groupId) {
      return { error: "Primero debes crear o unirte a un grupo", status: 403 };
    }

    const group = await getGroupPublicById(groupId);
    return {
      groupId: String(group?.id || groupId),
      mode: "staff",
      userId: data.user.id,
      groupValid: Boolean(group),
    };
  }

  const passengerToken = getPassengerTokenFromRequest(req);
  const passengerPayload = verifyPassengerToken(passengerToken);

  if (!passengerPayload?.userId) {
    return { error: "Group context required", status: 401 };
  }

  const passengerGroupId = await getPassengerGroupId(passengerPayload.userId);
  if (!passengerGroupId) {
    return { error: "El pasajero no pertenece a un grupo", status: 403 };
  }

  return {
    groupId: String(passengerGroupId),
    mode: "passenger",
    userId: passengerPayload.userId,
  };
}

function throwIfSupabaseError(error, context) {
  if (!error) return;
  const wrapped = new Error(`${context}: ${error.message}`);
  wrapped.status = 500;
  throw wrapped;
}


function isWaitlistTemporarilySuppressed(trip) {
  const hasSchedule = trip?.waitlist_start_day !== null && trip?.waitlist_start_day !== undefined && trip?.waitlist_start_time;
  if (!hasSchedule) return false;

  const endAt = trip?.waitlist_end_at;
  if (!endAt) return false;

  const endDt = new Date(endAt);
  if (Number.isNaN(endDt.getTime())) return false;
  return Date.now() < endDt.getTime();
}

function isWaitlistWindowActiveLegacy(waitlistStartAt, waitlistEndAt) {
  if (!waitlistStartAt) return false;
  const startDt = new Date(waitlistStartAt);
  if (Number.isNaN(startDt.getTime())) return false;

  const now = Date.now();
  if (startDt.getTime() > now) return false;

  if (!waitlistEndAt) return true;
  const endDt = new Date(waitlistEndAt);
  if (Number.isNaN(endDt.getTime())) return true;

  return now <= endDt.getTime();
}

function isWaitlistWindowActive(trip) {
  if (!trip || typeof trip !== "object") return false;

  if (isWaitlistTemporarilySuppressed(trip)) {
    return false;
  }

  if (trip.waitlist_start_day !== null && trip.waitlist_start_day !== undefined && trip.waitlist_start_time) {
    return isWaitlistWindowActiveBySchedule(
      trip.waitlist_start_day,
      trip.waitlist_start_time,
      trip.waitlist_end_day,
      trip.waitlist_end_time
    );
  }

  return isWaitlistWindowActiveLegacy(trip.waitlist_start_at, trip.waitlist_end_at);
}

function parseJsonArray(value) {
  if (Array.isArray(value)) return value;
  if (typeof value === "string") {
    try {
      const parsed = JSON.parse(value);
      return Array.isArray(parsed) ? parsed : [];
    } catch {
      return [];
    }
  }
  return [];
}

function isMissingTableError(error) {
  if (!error) return false;
  if (error.code === "42P01") return true;
  const message = String(error.message || "").toLowerCase();
  return message.includes("does not exist") || message.includes("relation") || message.includes("tabla");
}

async function getActiveLocationSessionsMap(tripIds) {
  const cleanIds = (Array.isArray(tripIds) ? tripIds : [])
    .map((id) => Number(id))
    .filter((id) => Number.isFinite(id));

  if (cleanIds.length === 0) return new Map();

  const { data, error } = await supabase
    .from("trip_location_sessions")
    .select("trip_id, active, last_latitude, last_longitude, last_update_at, last_stop_name, last_stop_at")
    .in("trip_id", cleanIds)
    .eq("active", true);

  if (error) {
    if (isMissingTableError(error)) return new Map();
    throw error;
  }

  return new Map(
    (Array.isArray(data) ? data : []).map((row) => [
      Number(row.trip_id),
      {
        active: Boolean(row.active),
        last_latitude: row.last_latitude ?? null,
        last_longitude: row.last_longitude ?? null,
        last_update_at: row.last_update_at || null,
        last_stop_name: row.last_stop_name || null,
        last_stop_at: row.last_stop_at || null,
      },
    ])
  );
}

async function backupTripHistoryBeforeDelete({ tripId, groupId }) {
  const { data: trip, error: tripError } = await supabase
    .from("trips")
    .select("id, name, type, status, departure_datetime")
    .eq("id", tripId)
    .maybeSingle();

  if (tripError) throw tripError;
  if (!trip) return;

  const { data: runs, error: runsError } = await supabase
    .from("trip_runs")
    .select("id, trip_id, taken_by, started_at, finished_at")
    .eq("trip_id", tripId)
    .not("finished_at", "is", null)
    .order("id", { ascending: true });

  if (runsError) throw runsError;

  const finishedRuns = Array.isArray(runs) ? runs : [];
  if (finishedRuns.length === 0) return;

  const runIds = finishedRuns.map((run) => Number(run.id)).filter((id) => Number.isFinite(id));

  const [stopsResult, busesResult, passengersResult] = await Promise.all([
    supabase
      .from("trip_stops")
      .select("stop_id, pickup_time, order_index, stops(name)")
      .eq("trip_id", tripId)
      .order("order_index", { ascending: true }),
    supabase
      .from("trip_buses")
      .select("bus_id, buses(name, capacity)")
      .eq("trip_id", tripId),
    supabase
      .from("trip_run_passengers")
      .select("run_id, user_name, phone, stop_name, boarded")
      .in("run_id", runIds),
  ]);

  if (stopsResult.error) throw stopsResult.error;
  if (busesResult.error) throw busesResult.error;
  if (passengersResult.error) throw passengersResult.error;

  const stopsSnapshot = (stopsResult.data || []).map((row) => ({
    stop_id: row?.stop_id ?? null,
    stop_name: row?.stops?.name || null,
    pickup_time: row?.pickup_time || null,
    order_index: Number(row?.order_index || 0) || null,
  }));

  const busesSnapshot = (busesResult.data || []).map((row) => ({
    bus_id: row?.bus_id ?? null,
    bus_name: row?.buses?.name || null,
    capacity: Number(row?.buses?.capacity || 0) || 0,
  }));

  const passengersByRun = new Map();
  for (const row of (passengersResult.data || [])) {
    const key = Number(row?.run_id || 0);
    if (!passengersByRun.has(key)) passengersByRun.set(key, []);
    passengersByRun.get(key).push(row);
  }

  for (const run of finishedRuns) {
    const runId = Number(run?.id || 0);
    if (!runId) continue;

    const runPassengers = passengersByRun.get(runId) || [];
    const summarySnapshot = {
      total: runPassengers.length,
      boarded: runPassengers.filter((p) => Boolean(p?.boarded)).length,
      missing: runPassengers.filter((p) => !Boolean(p?.boarded)).length,
      waiting: 0,
    };

    const tripSnapshot = {
      trip_id: Number(trip?.id || 0) || null,
      trip_name: trip?.name || null,
      trip_type: trip?.type || null,
      trip_departure_datetime: trip?.departure_datetime || null,
      trip_status_at_finish: trip?.status || null,
      stops: stopsSnapshot,
      buses: busesSnapshot,
    };

    const historyRunPayload = {
      source_run_id: runId,
      trip_id: Number(tripId),
      group_id: String(groupId || ""),
      trip_name: trip?.name || null,
      trip_type: trip?.type || null,
      trip_departure_datetime: trip?.departure_datetime || null,
      trip_status_at_finish: trip?.status || null,
      taken_by: run?.taken_by ? String(run.taken_by) : null,
      started_at: run?.started_at || null,
      finished_at: run?.finished_at,
      trip_snapshot: tripSnapshot,
      summary_snapshot: summarySnapshot,
    };

    const { data: existingHistoryRun, error: existingHistoryRunError } = await supabase
      .from("trip_history_runs")
      .select("id")
      .eq("source_run_id", runId)
      .order("id", { ascending: false })
      .limit(1)
      .maybeSingle();

    if (existingHistoryRunError) {
      if (isMissingTableError(existingHistoryRunError)) {
        const migrationPath = "microsha-backend/sql/2026-03-31_trip_history_snapshot.sql";
        const migrationError = new Error(`Falta migración de historial independiente (${migrationPath}). Ejecutala antes de eliminar traslados.`);
        migrationError.status = 409;
        throw migrationError;
      }
      throw existingHistoryRunError;
    }

    const historyRunQuery = existingHistoryRun?.id
      ? supabase
          .from("trip_history_runs")
          .update(historyRunPayload)
          .eq("id", existingHistoryRun.id)
      : supabase
          .from("trip_history_runs")
          .insert(historyRunPayload);

    const { data: historyRun, error: historyRunError } = await historyRunQuery
      .select("id")
      .single();

    if (historyRunError) {
      if (isMissingTableError(historyRunError)) {
        const migrationPath = "microsha-backend/sql/2026-03-31_trip_history_snapshot.sql";
        const migrationError = new Error(`Falta migración de historial independiente (${migrationPath}). Ejecutala antes de eliminar traslados.`);
        migrationError.status = 409;
        throw migrationError;
      }
      throw historyRunError;
    }

    const historyRunId = Number(historyRun?.id || 0);
    if (!historyRunId) continue;

    const { error: clearHistoryPassengersError } = await supabase
      .from("trip_history_passengers")
      .delete()
      .eq("history_run_id", historyRunId);

    if (clearHistoryPassengersError) {
      if (isMissingTableError(clearHistoryPassengersError)) {
        const migrationPath = "microsha-backend/sql/2026-03-31_trip_history_snapshot.sql";
        const migrationError = new Error(`Falta migración de historial independiente (${migrationPath}). Ejecutala antes de eliminar traslados.`);
        migrationError.status = 409;
        throw migrationError;
      }
      throw clearHistoryPassengersError;
    }

    if (runPassengers.length === 0) continue;

    const historyPassengersRows = runPassengers.map((p) => ({
      history_run_id: historyRunId,
      source_run_id: runId,
      source_reservation_id: null,
      user_id: null,
      user_name: p?.user_name || "Sin nombre",
      phone: p?.phone || null,
      description: "",
      dni: null,
      member_number: null,
      stop_id: null,
      stop_name: p?.stop_name || "Sin parada",
      status: "confirmed",
      boarded: Boolean(p?.boarded),
    }));

    const { error: historyPassengersError } = await supabase
      .from("trip_history_passengers")
      .insert(historyPassengersRows);

    if (historyPassengersError) {
      if (isMissingTableError(historyPassengersError)) {
        const migrationPath = "microsha-backend/sql/2026-03-31_trip_history_snapshot.sql";
        const migrationError = new Error(`Falta migración de historial independiente (${migrationPath}). Ejecutala antes de eliminar traslados.`);
        migrationError.status = 409;
        throw migrationError;
      }
      throw historyPassengersError;
    }
  }
}

function parseClockToMinutes(value) {
  const text = String(value || "").trim();
  const match = text.match(/^(\d{1,2}):(\d{2})/);
  if (!match) return null;

  const hours = Number(match[1]);
  const minutes = Number(match[2]);
  if (!Number.isFinite(hours) || !Number.isFinite(minutes)) return null;
  if (hours < 0 || hours > 23 || minutes < 0 || minutes > 59) return null;

  return hours * 60 + minutes;
}

function resolveTripSortMinutes(trip) {
  const fromStartTime = parseClockToMinutes(trip?.start_time);
  if (fromStartTime !== null) return fromStartTime;

  const fromFirstTime = parseClockToMinutes(trip?.first_time);
  if (fromFirstTime !== null) return fromFirstTime;

  const fromDateTime = normalizeClockTime(trip?.time || trip?.departure_datetime);
  const parsedDateTime = parseClockToMinutes(fromDateTime);
  if (parsedDateTime !== null) return parsedDateTime;

  return Number.MAX_SAFE_INTEGER;
}

function sortTrasladosByHora(trips) {
  return [...(Array.isArray(trips) ? trips : [])].sort((a, b) => {
    const diff = resolveTripSortMinutes(a) - resolveTripSortMinutes(b);
    if (diff !== 0) return diff;

    const idA = Number(a?.id);
    const idB = Number(b?.id);
    if (Number.isFinite(idA) && Number.isFinite(idB)) return idA - idB;

    return String(a?.id || "").localeCompare(String(b?.id || ""));
  });
}



// ========================
// GET /trips
// ========================
router.get("/", async (req, res) => {
  try {
    const systemFlags = await getSystemFlags();
    const context = await resolveRequestGroupId(req);
    if (!context.groupId) {
      return res.status(context.status || 401).json({ error: context.error || "No group context" });
    }

    const allowedTripIds = await getTripIdsForGroup(context.groupId);

    let mergedTripIds = [...allowedTripIds];

    if (context.mode === "staff" && context.groupValid !== false) {
      const { data: allTripsForRepair, error: allTripsError } = await supabase
        .from("trips")
        .select("id")
        .in("status", ["open", "closed"]);

      throwIfSupabaseError(allTripsError, "trip repair scan failed");

      const allIds = (Array.isArray(allTripsForRepair) ? allTripsForRepair : [])
        .map((trip) => Number(trip.id))
        .filter((id) => Number.isFinite(id));

      const unassignedTripIds = await getUnassignedTripIds(allIds);

      if (unassignedTripIds.length > 0) {
        const assignmentResults = await Promise.allSettled(
          unassignedTripIds.map((tripId) => assignTripToGroup(tripId, context.groupId))
        );
        const failedAssignments = assignmentResults.filter((result) => result.status === "rejected");
        if (failedAssignments.length > 0) {
          console.warn("⚠️ Some trip group auto-assignments failed:", failedAssignments.length);
        }
      }

      mergedTripIds = Array.from(new Set([...allowedTripIds, ...unassignedTripIds]));
    }

    if (mergedTripIds.length === 0) {
      return res.json([]);
    }

    const rpcTripIds = mergedTripIds
      .map((id) => Number(id))
      .filter((id) => Number.isFinite(id));

    // Fast path: single DB roundtrip using SQL function.
    // If function is not deployed yet, we gracefully fall back to the batched path.
    if (rpcTripIds.length > 0) {
      const { data: rpcRows, error: rpcError } = await supabase.rpc("get_trip_summaries", {
        p_trip_ids: rpcTripIds,
      });

      if (!rpcError && Array.isArray(rpcRows)) {
        const locationMap = await getActiveLocationSessionsMap(rpcTripIds);
        const rpcIds = rpcRows
          .map((row) => Number(row.id))
          .filter((id) => Number.isFinite(id));

        const { data: waitlistRows, error: waitlistError } = await supabase
          .from("trips")
          .select("id, waitlist_start_at, waitlist_end_at, waitlist_start_day, waitlist_start_time, waitlist_end_day, waitlist_end_time")
          .in("id", rpcIds);

        throwIfSupabaseError(waitlistError, "rpc waitlist lookup failed");

        const waitlistMap = new Map(
          (Array.isArray(waitlistRows) ? waitlistRows : []).map((row) => [
            Number(row.id),
            {
              start: row.waitlist_start_at || null,
              end: row.waitlist_end_at || null,
              startDay: row.waitlist_start_day ?? null,
              startTime: normalizeClockTime(row.waitlist_start_time) || null,
              endDay: row.waitlist_end_day ?? null,
              endTime: normalizeClockTime(row.waitlist_end_time) || null,
            },
          ])
        );

        const rpcResult = rpcRows.map((row) => {
          const location = locationMap.get(Number(row.id)) || null;
          const waitlistRange = waitlistMap.get(Number(row.id)) || {
            start: null,
            end: null,
            startDay: null,
            startTime: null,
            endDay: null,
            endTime: null,
          };
          const waitlistActive = isWaitlistWindowActive({
            waitlist_start_at: waitlistRange.start,
            waitlist_end_at: waitlistRange.end,
            waitlist_start_day: waitlistRange.startDay,
            waitlist_start_time: waitlistRange.startTime,
            waitlist_end_day: waitlistRange.endDay,
            waitlist_end_time: waitlistRange.endTime,
          });

          return {
            id: row.id,
            name: row.name,
            type: row.type,
            status: row.status,
            time: row.departure_datetime,
            mode:
              row.status !== "open"
                ? "closed"
                : waitlistActive
                  ? "waiting"
                  : row.mode || ((row.confirmed || 0) < (row.capacity || 0) ? "available" : "waiting"),
            confirmed: row.confirmed || 0,
            waiting: row.waiting || 0,
            capacity: row.capacity || 0,
            start_time: row.start_time ? normalizeClockTime(row.start_time) : (normalizeClockTime(row.first_time) || null),
            first_time: normalizeClockTime(row.first_time) || null,
            active_started_at: row.active_started_at || null,
            last_finished_at: row.last_finished_at || null,
            waitlist_start_at: waitlistRange.start,
            waitlist_end_at: waitlistRange.end,
            waitlist_start_day: waitlistRange.startDay,
            waitlist_start_time: waitlistRange.startTime,
            waitlist_end_day: waitlistRange.endDay,
            waitlist_end_time: waitlistRange.endTime,
            waitlist_active: waitlistActive,
            location_active: Boolean(location?.active),
            location_last_latitude: location?.last_latitude ?? null,
            location_last_longitude: location?.last_longitude ?? null,
            location_last_update_at: location?.last_update_at || null,
            location_last_stop_name: location?.last_stop_name || null,
            location_last_stop_at: location?.last_stop_at || null,
            trips_paused: Boolean(systemFlags?.tripsPaused),
            trips_pause_message: String(systemFlags?.pauseMessage || "Traslados pausados, a partir del jueves a las 18hs podras anotarte en lista de espera"),
          };
        });

        return res.json(sortTrasladosByHora(rpcResult));
      }

      if (rpcError) {
        console.warn("⚠️ get_trip_summaries RPC unavailable, using batched fallback:", rpcError.message);
      }
    }

    // Fallback plan (still set-based and fixed-roundtrip):
    // - 1 query for base trips
    // - 1 query for all reservation rows (confirmed + waiting)
    // - 1 query for all capacities via trip_buses join buses
    // - 1 query for first stops
    // - 1 query for runs (active/latest finished)
    // => Fixed number of roundtrips, no N-per-trip loops.
    const [
      tripsResult,
      reservationsResult,
      capacitiesResult,
      firstStopsResult,
      runsResult,
      locationSessionsResult,
    ] = await Promise.all([
      supabase
        .from("trips")
        .select("id, name, type, departure_datetime, start_time, status, waitlist_start_at, waitlist_end_at, waitlist_start_day, waitlist_start_time, waitlist_end_day, waitlist_end_time")
        .in("id", mergedTripIds)
        .in("status", ["open", "closed"])
        .order("departure_datetime"),
      supabase
        .from("reservations")
        .select("trip_id, status")
        .in("trip_id", mergedTripIds)
        .in("status", ["confirmed", "waiting"]),
      supabase
        .from("trip_buses")
        .select("trip_id, buses ( capacity )")
        .in("trip_id", mergedTripIds),
      supabase
        .from("trip_stops")
        .select("trip_id, pickup_time")
        .in("trip_id", mergedTripIds)
        .eq("order_index", 1),
      supabase
        .from("trip_runs")
        .select("trip_id, id, started_at, finished_at")
        .in("trip_id", mergedTripIds)
        .order("id", { ascending: false }),
      supabase
        .from("trip_location_sessions")
        .select("trip_id, active, last_latitude, last_longitude, last_update_at, last_stop_name, last_stop_at")
        .in("trip_id", mergedTripIds)
        .eq("active", true),
    ]);

    throwIfSupabaseError(tripsResult.error, "trips query failed");
    throwIfSupabaseError(reservationsResult.error, "reservations summary query failed");
    throwIfSupabaseError(capacitiesResult.error, "capacity query failed");
    throwIfSupabaseError(firstStopsResult.error, "first stop query failed");
    throwIfSupabaseError(runsResult.error, "runs query failed");
    if (locationSessionsResult.error && !isMissingTableError(locationSessionsResult.error)) {
      throw locationSessionsResult.error;
    }

    const trips = Array.isArray(tripsResult.data) ? tripsResult.data : [];
    const reservations = Array.isArray(reservationsResult.data) ? reservationsResult.data : [];
    const capacities = Array.isArray(capacitiesResult.data) ? capacitiesResult.data : [];
    const firstStops = Array.isArray(firstStopsResult.data) ? firstStopsResult.data : [];
    const runs = Array.isArray(runsResult.data) ? runsResult.data : [];
    const locationSessions = Array.isArray(locationSessionsResult.data) ? locationSessionsResult.data : [];

    const reservationMap = new Map();
    for (const row of reservations) {
      const key = String(row.trip_id);
      if (!reservationMap.has(key)) {
        reservationMap.set(key, { confirmed: 0, waiting: 0 });
      }
      const acc = reservationMap.get(key);
      if (row.status === "confirmed") acc.confirmed += 1;
      if (row.status === "waiting") acc.waiting += 1;
    }

    const capacityMap = new Map();
    const capacityOverride = systemFlags?.busCapacityOverride;
    if (capacityOverride != null && Number.isFinite(capacityOverride) && capacityOverride > 0) {
      // Cuenta micros por traslado y aplica override
      const busCountMap = new Map();
      for (const row of capacities) {
        const key = String(row.trip_id);
        busCountMap.set(key, (busCountMap.get(key) || 0) + 1);
      }
      for (const [key, count] of busCountMap) {
        capacityMap.set(key, count * capacityOverride);
      }
    } else {
      for (const row of capacities) {
        const key = String(row.trip_id);
        const current = capacityMap.get(key) || 0;
        capacityMap.set(key, current + (row.buses?.capacity || 0));
      }
    }

    const firstStopMap = new Map();
    for (const row of firstStops) {
      const key = String(row.trip_id);
      if (!firstStopMap.has(key)) {
        firstStopMap.set(key, normalizeClockTime(row.pickup_time) || null);
      }
    }

    const activeRunMap = new Map();
    const finishedRunMap = new Map();
    const locationMap = new Map();

    for (const row of runs) {
      const key = String(row.trip_id);

      if (row.finished_at === null && !activeRunMap.has(key)) {
        activeRunMap.set(key, row.started_at || null);
      }

      if (row.finished_at !== null && !finishedRunMap.has(key)) {
        finishedRunMap.set(key, row.finished_at || null);
      }
    }

    for (const row of locationSessions) {
      const key = String(row.trip_id);
      if (locationMap.has(key)) continue;
      locationMap.set(key, row);
    }

    const result = trips.map((trip) => {
      const key = String(trip.id);
      const counts = reservationMap.get(key) || { confirmed: 0, waiting: 0 };
      const capacity = capacityMap.get(key) || 0;
      const waitlistActive = isWaitlistWindowActive(trip);
      const location = locationMap.get(key) || null;

      return {
        id: trip.id,
        name: trip.name,
        type: trip.type,
        status: trip.status,
        time: trip.departure_datetime,
        mode:
          trip.status !== "open"
            ? "closed"
            : waitlistActive
              ? "waiting"
              : counts.confirmed < capacity
                ? "available"
                : "waiting",
        confirmed: counts.confirmed,
        waiting: counts.waiting,
        capacity,
        start_time: trip.start_time ? normalizeClockTime(trip.start_time) : null,
        first_time: firstStopMap.get(key) || null,
        active_started_at: activeRunMap.get(key) || null,
        last_finished_at: finishedRunMap.get(key) || null,
        waitlist_start_at: trip.waitlist_start_at || null,
        waitlist_end_at: trip.waitlist_end_at || null,
        waitlist_start_day: trip.waitlist_start_day ?? null,
        waitlist_start_time: normalizeClockTime(trip.waitlist_start_time) || null,
        waitlist_end_day: trip.waitlist_end_day ?? null,
        waitlist_end_time: normalizeClockTime(trip.waitlist_end_time) || null,
        waitlist_active: waitlistActive,
        location_active: Boolean(location?.active),
        location_last_latitude: location?.last_latitude ?? null,
        location_last_longitude: location?.last_longitude ?? null,
        location_last_update_at: location?.last_update_at || null,
        location_last_stop_name: location?.last_stop_name || null,
        location_last_stop_at: location?.last_stop_at || null,
        trips_paused: Boolean(systemFlags?.tripsPaused),
        trips_pause_message: String(systemFlags?.pauseMessage || "Traslados pausados, a partir del jueves a las 18hs podras anotarte en lista de espera"),
      };
    });

    // Recommended DB indexes for cloud scale (create in Supabase SQL editor):
    // 1) CREATE INDEX IF NOT EXISTS idx_reservations_trip_status ON reservations (trip_id, status);
    // 2) CREATE INDEX IF NOT EXISTS idx_trip_buses_trip_id ON trip_buses (trip_id);
    // 3) CREATE INDEX IF NOT EXISTS idx_trip_stops_trip_order ON trip_stops (trip_id, order_index);
    // 4) CREATE INDEX IF NOT EXISTS idx_trip_runs_trip_finished_id ON trip_runs (trip_id, finished_at, id DESC);

    return res.json(sortTrasladosByHora(result));

  } catch (err) {
    console.error("🔥 TRIPS ERROR:", err);
    const status = err?.status || 500;
    return res.status(status).json({ error: status === 500 ? "Server exploded" : err.message });
  }
});



// ========================
// GET /trips/:id/stops
// ========================
router.get("/:id/stops", async (req, res) => {
  try {
    const tripId = req.params.id;

    const context = await resolveRequestGroupId(req);
    if (!context.groupId) {
      return res.status(context.status || 401).json({ error: context.error || "No group context" });
    }

    const allowed = await assertTripInGroup(tripId, context.groupId);
    if (!allowed) {
      return res.status(403).json({ error: "No tenés permisos para ver este viaje" });
    }

    const [stopsResult, tripResult] = await Promise.all([
      supabase
        .from("trip_stops")
        .select(`stop_id, pickup_time, order_index, stops ( id, name )`)
        .eq("trip_id", tripId)
        .order("order_index"),
      supabase
        .from("trips")
        .select("type")
        .eq("id", tripId)
        .maybeSingle(),
    ]);

    if (stopsResult.error) return res.status(500).json({ error: stopsResult.error.message });

    const stops = stopsResult.data.map(s => ({
      id: s.stop_id,
      name: s.stops.name,
      time: normalizeClockTime(s.pickup_time) || null,
      order: s.order_index,
    }));

    const tripType = tripResult.data?.type || null;

    // Bloqueo de paradas: solo aplica a pasajeros en traslados de tipo "ida" cuando stopBlockActive = true
    const isPassenger = Boolean(req.headers["x-passenger-token"]);
    if (isPassenger && tripType === "ida") {
      const flags = await getSystemFlags();
      if (flags?.stopBlockActive) {
        const { data: reservations } = await supabase
          .from("reservations")
          .select("stop_id")
          .eq("trip_id", tripId)
          .in("status", ["confirmed", "waiting"]);

        const stopsWithPassengers = new Set(
          (reservations || []).map(r => String(r.stop_id)).filter(Boolean)
        );

        if (stopsWithPassengers.size > 0) {
          const sorted = [...stops].sort((a, b) => a.order - b.order);
          const firstActiveIndex = sorted.findIndex(s => stopsWithPassengers.has(String(s.id)));

          if (firstActiveIndex > 0) {
            const blockedOrders = new Set(sorted.slice(0, firstActiveIndex).map(s => s.order));
            return res.json(stops.map(s => ({
              ...s,
              blocked: blockedOrders.has(s.order),
            })));
          }
        }
      }
    }

    res.json(stops);

  } catch (err) {
    console.error("🔥 STOPS ERROR:", err);
    res.status(500).json({ error: "Server exploded" });
  }
});

router.get("/:id/location", async (req, res) => {
  try {
    const tripId = req.params.id;

    const context = await resolveRequestGroupId(req);
    if (!context.groupId) {
      return res.status(context.status || 401).json({ error: context.error || "No group context" });
    }

    const allowed = await assertTripInGroup(tripId, context.groupId);
    if (!allowed) {
      return res.status(403).json({ error: "No tenés permisos para ver este viaje" });
    }

    const { data: session, error: sessionError } = await supabase
      .from("trip_location_sessions")
      .select("trip_id, active, started_by, started_at, stopped_at, last_latitude, last_longitude, last_accuracy_meters, last_update_at, last_stop_id, last_stop_name, last_stop_at")
      .eq("trip_id", tripId)
      .maybeSingle();

    if (sessionError) {
      if (isMissingTableError(sessionError)) {
        return res.json({ active: false, updates: [] });
      }
      return res.status(500).json({ error: sessionError.message });
    }

    const { data: updates, error: updatesError } = await supabase
      .from("trip_location_updates")
      .select("latitude, longitude, accuracy_meters, recorded_at, source_user_id")
      .eq("trip_id", tripId)
      .order("recorded_at", { ascending: false })
      .limit(100);

    if (updatesError) {
      if (!isMissingTableError(updatesError)) {
        return res.status(500).json({ error: updatesError.message });
      }
      return res.json({
        active: Boolean(session?.active),
        session: session || null,
        updates: [],
      });
    }

    return res.json({
      active: Boolean(session?.active),
      session: session || null,
      updates: Array.isArray(updates) ? updates : [],
    });
  } catch (err) {
    console.error("🔥 TRIP LOCATION ERROR:", err);
    return res.status(500).json({ error: "Server exploded" });
  }
});



// ========================
// POST /trips (crear)
// ========================
router.post("/", auth, requireRole("admin"), requireStaffGroup, async (req, res) => {
  try {
    const {
      name,
      type,
      departure_datetime,
      start_time,
      waitlist_start_at,
      waitlist_end_at,
      waitlist_start_day,
      waitlist_start_time,
      waitlist_end_day,
      waitlist_end_time,
    } = req.body;

    console.log("[trips.POST] Creating trip:", { name, type, start_time });

    const payload = {
      name,
      type,
      status: "open",
      departure_datetime: departure_datetime || new Date().toISOString(),
    };

    if (start_time !== undefined) {
      payload.start_time = start_time ? normalizeClockTime(start_time) : null;
      console.log("[trips.POST] Saved start_time:", payload.start_time);
    } else {
      console.log("[trips.POST] start_time was undefined");
    }

    if (waitlist_start_at !== undefined) {
      payload.waitlist_start_at = waitlist_start_at || null;
    }
    if (waitlist_end_at !== undefined) {
      payload.waitlist_end_at = waitlist_end_at || null;
    }
    if (waitlist_start_day !== undefined) {
      payload.waitlist_start_day = waitlist_start_day === null || waitlist_start_day === "" ? null : Number(waitlist_start_day);
    }
    if (waitlist_start_time !== undefined) {
      payload.waitlist_start_time = waitlist_start_time ? normalizeClockTime(waitlist_start_time) : null;
    }
    if (waitlist_end_day !== undefined) {
      payload.waitlist_end_day = waitlist_end_day === null || waitlist_end_day === "" ? null : Number(waitlist_end_day);
    }
    if (waitlist_end_time !== undefined) {
      payload.waitlist_end_time = waitlist_end_time ? normalizeClockTime(waitlist_end_time) : null;
    }

    if (payload.waitlist_start_day !== null && payload.waitlist_start_day !== undefined && payload.waitlist_start_time) {
      payload.waitlist_end_at = getNextScheduleActivationIso(payload.waitlist_start_day, payload.waitlist_start_time);
    }

    const { data, error } = await supabase
      .from("trips")
      .insert(payload)
      .select()
      .single();

    if (error) return res.status(500).json({ error: error.message });

    await assignTripToGroup(data.id, req.groupId);

    res.json(data);

  } catch (err) {
    console.error("🔥 CREATE TRIP ERROR:", err);
    res.status(500).json({ error: "Server exploded" });
  }
});



// ========================
// PUT /trips/:id/status
// ========================
router.put("/:id/status", auth, requireRole("admin"), requireStaffGroup, async (req, res) => {
  try {
    const tripId = req.params.id;
    const { status } = req.body;

    const allowed = await assertTripInGroup(tripId, req.groupId);
    if (!allowed) {
      return res.status(403).json({ error: "No tenés permisos para este viaje" });
    }

    const { error } = await supabase
      .from("trips")
      .update({ status })
      .eq("id", tripId);

    if (error) return res.status(500).json({ error: error.message });

    res.json({ success: true });

  } catch (err) {
    console.error("🔥 STATUS ERROR:", err);
    res.status(500).json({ error: "Server exploded" });
  }
});



// ========================
// POST /trips/:id/buses
// ========================
router.post("/:id/buses", auth, requireRole("admin"), requireStaffGroup, async (req, res) => {
  try {
    const tripId = req.params.id;
    const { name, capacity } = req.body;

    const allowed = await assertTripInGroup(tripId, req.groupId);
    if (!allowed) {
      return res.status(403).json({ error: "No tenés permisos para este viaje" });
    }

    // 1️⃣ crear bus
    const { data: bus, error: busError } = await supabase
      .from("buses")
      .insert({
        name,
        capacity,
        active: true,
      })
      .select()
      .single();

    if (busError) return res.status(500).json({ error: busError.message });

    // 2️⃣ vincular
    const { error: linkError } = await supabase
      .from("trip_buses")
      .insert({
        trip_id: tripId,
        bus_id: bus.id,
      });

    if (linkError) return res.status(500).json({ error: linkError.message });

    // 3️⃣ crear ocupación inicial
    res.json(bus);

  } catch (err) {
    console.error("🔥 BUS ADD ERROR:", err);
    res.status(500).json({ error: "Server exploded" });
  }
});

// ========================
// GET /trips/:id/buses
// ========================
router.get("/:id/buses", auth, requireRole("admin"), requireStaffGroup, async (req, res) => {
  try {
    const tripId = req.params.id;

    const allowed = await assertTripInGroup(tripId, req.groupId);
    if (!allowed) {
      return res.status(403).json({ error: "No tenés permisos para este viaje" });
    }

    const { data, error } = await supabase
      .from("trip_buses")
      .select("bus_id, buses ( id, name, capacity )")
      .eq("trip_id", tripId)
      .order("bus_id", { ascending: true });

    if (error) return res.status(500).json({ error: error.message });

    const result = (data || [])
      .map((row) => row.buses)
      .filter(Boolean)
      .map((bus) => ({
        id: bus.id,
        name: bus.name,
        capacity: bus.capacity,
      }));

    return res.json(result);
  } catch (err) {
    console.error("🔥 BUSES LIST ERROR:", err);
    return res.status(500).json({ error: "Server exploded" });
  }
});

// ========================
// PUT /trips/:id/buses/sync
// body: { buses: [{ id?, name, capacity }] }
// ========================
router.put("/:id/buses/sync", auth, requireRole("admin"), requireStaffGroup, async (req, res) => {
  try {
    const tripId = req.params.id;
    const buses = Array.isArray(req.body?.buses) ? req.body.buses : null;

    if (!buses) {
      return res.status(400).json({ error: "buses must be an array" });
    }

    const allowed = await assertTripInGroup(tripId, req.groupId);
    if (!allowed) {
      return res.status(403).json({ error: "No tenés permisos para este viaje" });
    }

    const normalized = buses.map((bus) => ({
      id: bus?.id || null,
      name: String(bus?.name || "").trim(),
      capacity: Number(bus?.capacity || 0),
    }));

    if (normalized.some((bus) => !bus.name || !Number.isFinite(bus.capacity) || bus.capacity <= 0)) {
      return res.status(400).json({ error: "Cada vehículo debe tener nombre y capacidad válida" });
    }

    const { data: currentLinks, error: currentError } = await supabase
      .from("trip_buses")
      .select("bus_id")
      .eq("trip_id", tripId);

    if (currentError) return res.status(500).json({ error: currentError.message });

    const currentBusIds = (currentLinks || []).map((row) => String(row.bus_id));
    const incomingBusIds = normalized
      .filter((bus) => bus.id !== null && bus.id !== undefined)
      .map((bus) => String(bus.id));

    const toRemove = currentBusIds.filter((id) => !incomingBusIds.includes(id));

    if (toRemove.length > 0) {
      const { error: unlinkError } = await supabase
        .from("trip_buses")
        .delete()
        .eq("trip_id", tripId)
        .in("bus_id", toRemove);

      if (unlinkError) return res.status(500).json({ error: unlinkError.message });

      for (const busId of toRemove) {
        const { data: usage, error: usageError } = await supabase
          .from("trip_buses")
          .select("trip_id")
          .eq("bus_id", busId)
          .limit(1);

        if (usageError) return res.status(500).json({ error: usageError.message });

        if (!usage || usage.length === 0) {
          await supabase.from("buses").delete().eq("id", busId);
        }
      }
    }

    for (const bus of normalized) {
      if (bus.id) {
        const { error: updateError } = await supabase
          .from("buses")
          .update({
            name: bus.name,
            capacity: bus.capacity,
          })
          .eq("id", bus.id);

        if (updateError) return res.status(500).json({ error: updateError.message });
      } else {
        const { data: createdBus, error: createBusError } = await supabase
          .from("buses")
          .insert({
            name: bus.name,
            capacity: bus.capacity,
            active: true,
          })
          .select("id")
          .single();

        if (createBusError) return res.status(500).json({ error: createBusError.message });

        const { error: linkError } = await supabase
          .from("trip_buses")
          .insert({
            trip_id: tripId,
            bus_id: createdBus.id,
          });

        if (linkError) return res.status(500).json({ error: linkError.message });
      }
    }

    return res.json({ success: true });
  } catch (err) {
    console.error("🔥 BUSES SYNC ERROR:", err);
    return res.status(500).json({ error: "Server exploded" });
  }
});

// ========================
// POST /trips/:id/stops
// ========================
router.post("/:id/stops", auth, requireRole("admin"), requireStaffGroup, async (req, res) => {
  try {
    const tripId = req.params.id;
    const { name, time, order } = req.body;
    const normalizedTime = normalizeClockTime(time);

    if (!normalizedTime) {
      return res.status(400).json({ error: "Horario inválido. Usá formato HH:mm" });
    }

    const allowed = await assertTripInGroup(tripId, req.groupId);
    if (!allowed) {
      return res.status(403).json({ error: "No tenés permisos para este viaje" });
    }

    if (!name || !time || !order) {
      return res.status(400).json({ error: "Missing data" });
    }

    // 1️⃣ crear o buscar parada
    let { data: stop } = await supabase
      .from("stops")
      .select("id")
      .eq("name", name)
      .maybeSingle();

    if (!stop) {
      const { data: newStop, error: stopError } = await supabase
        .from("stops")
        .insert({
          name,
          order_index: order,
          active: true,
        })
        .select()
        .single();

      if (stopError) return res.status(500).json({ error: stopError.message });

      stop = newStop;
    }

    // 2️⃣ vincular al viaje
    const { error } = await supabase
      .from("trip_stops")
      .insert({
        trip_id: tripId,
        stop_id: stop.id,
        pickup_time: normalizedTime,
        order_index: order,
      });

    if (error) return res.status(500).json({ error: error.message });

    res.json({ success: true });

  } catch (err) {
    console.error("🔥 ADD STOP ERROR:", err);
    res.status(500).json({ error: "Server exploded" });
  }
});

// ========================
// PUT /trips/:id/stops/sync
// body: { stops: [{ id?, name, time, order }] }
// ========================
router.put("/:id/stops/sync", auth, requireRole("admin"), requireStaffGroup, async (req, res) => {
  try {
    const tripId = req.params.id;
    const stops = Array.isArray(req.body?.stops) ? req.body.stops : null;

    if (!stops) {
      return res.status(400).json({ error: "stops must be an array" });
    }

    const allowed = await assertTripInGroup(tripId, req.groupId);
    if (!allowed) {
      return res.status(403).json({ error: "No tenés permisos para este viaje" });
    }

    const normalized = stops.map((stop, index) => ({
      id: stop?.id || null,
      name: String(stop?.name || "").trim(),
      time: normalizeClockTime(stop?.time),
      order: Number(stop?.order || index + 1),
    }));

    if (normalized.some((stop) => !stop.name || !stop.time || !Number.isFinite(stop.order) || stop.order <= 0)) {
      return res.status(400).json({ error: "Cada parada debe tener nombre, horario y orden válido" });
    }

    const { data: currentRows, error: currentError } = await supabase
      .from("trip_stops")
      .select("stop_id")
      .eq("trip_id", tripId);

    if (currentError) return res.status(500).json({ error: currentError.message });

    const currentStopIds = (currentRows || []).map((row) => String(row.stop_id));
    const incomingStopIds = normalized
      .filter((stop) => stop.id !== null && stop.id !== undefined)
      .map((stop) => String(stop.id));

    const toRemove = currentStopIds.filter((id) => !incomingStopIds.includes(id));
    if (toRemove.length > 0) {
      const { error: deleteError } = await supabase
        .from("trip_stops")
        .delete()
        .eq("trip_id", tripId)
        .in("stop_id", toRemove);

      if (deleteError) return res.status(500).json({ error: deleteError.message });
    }

    for (const stop of normalized) {
      let stopId = stop.id;

      if (!stopId) {
        let { data: existingStop, error: findError } = await supabase
          .from("stops")
          .select("id")
          .eq("name", stop.name)
          .maybeSingle();

        if (findError) return res.status(500).json({ error: findError.message });

        if (!existingStop) {
          const { data: createdStop, error: createStopError } = await supabase
            .from("stops")
            .insert({
              name: stop.name,
              order_index: stop.order,
              active: true,
            })
            .select("id")
            .single();

          if (createStopError) return res.status(500).json({ error: createStopError.message });
          stopId = createdStop.id;
        } else {
          stopId = existingStop.id;
        }

        const { error: insertError } = await supabase
          .from("trip_stops")
          .insert({
            trip_id: tripId,
            stop_id: stopId,
            pickup_time: stop.time,
            order_index: stop.order,
          });

        if (insertError) return res.status(500).json({ error: insertError.message });
      } else {
        const { error: stopUpdateError } = await supabase
          .from("stops")
          .update({
            name: stop.name,
            order_index: stop.order,
          })
          .eq("id", stopId);

        if (stopUpdateError) return res.status(500).json({ error: stopUpdateError.message });

        const { error: tripStopUpdateError } = await supabase
          .from("trip_stops")
          .update({
            pickup_time: stop.time,
            order_index: stop.order,
          })
          .eq("trip_id", tripId)
          .eq("stop_id", stopId);

        if (tripStopUpdateError) return res.status(500).json({ error: tripStopUpdateError.message });
      }
    }

    return res.json({ success: true });
  } catch (err) {
    console.error("🔥 STOPS SYNC ERROR:", err);
    return res.status(500).json({ error: "Server exploded" });
  }
});

// ========================
// PUT /trips/:id (editar)
// ========================
router.put("/:id", auth, requireRole("admin"), requireStaffGroup, async (req, res) => {
  try {
    const tripId = req.params.id;
    const {
      name,
      type,
      departure_datetime,
      waitlist_start_at,
      waitlist_end_at,
      waitlist_start_day,
      waitlist_start_time,
      waitlist_end_day,
      waitlist_end_time,
    } = req.body;

    const allowed = await assertTripInGroup(tripId, req.groupId);
    if (!allowed) {
      return res.status(403).json({ error: "No tenés permisos para este viaje" });
    }

    const payload = {};
    if (name !== undefined) payload.name = name;
    if (type !== undefined) payload.type = type;
    if (departure_datetime !== undefined) payload.departure_datetime = departure_datetime;
    if (waitlist_start_at !== undefined) payload.waitlist_start_at = waitlist_start_at || null;
    if (waitlist_end_at !== undefined) payload.waitlist_end_at = waitlist_end_at || null;
    if (waitlist_start_day !== undefined) payload.waitlist_start_day = waitlist_start_day === null || waitlist_start_day === "" ? null : Number(waitlist_start_day);
    if (waitlist_start_time !== undefined) payload.waitlist_start_time = waitlist_start_time ? normalizeClockTime(waitlist_start_time) : null;
    if (waitlist_end_day !== undefined) payload.waitlist_end_day = waitlist_end_day === null || waitlist_end_day === "" ? null : Number(waitlist_end_day);
    if (waitlist_end_time !== undefined) payload.waitlist_end_time = waitlist_end_time ? normalizeClockTime(waitlist_end_time) : null;

    if (Object.keys(payload).length === 0) {
      return res.status(400).json({ error: "No data to update" });
    }

    const { data, error } = await supabase
      .from("trips")
      .update(payload)
      .eq("id", tripId)
      .select()
      .single();

    if (error) return res.status(500).json({ error: error.message });

    return res.json(data);
  } catch (err) {
    console.error("🔥 UPDATE TRIP ERROR:", err);
    return res.status(500).json({ error: "Server exploded" });
  }
});

// ========================
// GET /trips/:id/reinforcement-config
// ========================
router.get("/:id/reinforcement-config", auth, requireRole("admin"), requireStaffGroup, async (req, res) => {
  try {
    const tripId = req.params.id;

    const allowed = await assertTripInGroup(tripId, req.groupId);
    if (!allowed) {
      return res.status(403).json({ error: "No tenés permisos para este viaje" });
    }

    const { data, error } = await supabase
      .from("trip_reinforcement_configs")
      .select("parent_trip_id, active_reinforcement_trip_id, split_stop_ids, reinforcement_trip_name, reinforcement_bus_name, reinforcement_bus_capacity")
      .eq("parent_trip_id", tripId)
      .maybeSingle();

    if (error) return res.status(500).json({ error: error.message });

    if (!data) {
      return res.json({
        active: false,
        active_trip_id: null,
        split_stop_ids: [],
        reinforcement_trip_name: null,
        reinforcement_bus_name: null,
        reinforcement_bus_capacity: null,
      });
    }

    return res.json({
      active: Boolean(data.active_reinforcement_trip_id),
      active_trip_id: data.active_reinforcement_trip_id || null,
      split_stop_ids: parseJsonArray(data.split_stop_ids),
      reinforcement_trip_name: data.reinforcement_trip_name || null,
      reinforcement_bus_name: data.reinforcement_bus_name || null,
      reinforcement_bus_capacity: data.reinforcement_bus_capacity || null,
    });
  } catch (err) {
    console.error("🔥 GET REINFORCEMENT CONFIG ERROR:", err);
    return res.status(500).json({ error: "Server exploded" });
  }
});

// ========================
// PUT /trips/:id/reinforcement-config
// body: { reinforcement_trip_name, reinforcement_bus_name, reinforcement_bus_capacity, split_stop_ids: [] }
// ========================
router.put("/:id/reinforcement-config", auth, requireRole("admin"), requireStaffGroup, async (req, res) => {
  try {
    const tripId = req.params.id;
    const {
      reinforcement_trip_name,
      reinforcement_bus_name,
      reinforcement_bus_capacity,
      split_stop_ids,
      split_order_indexes,
    } = req.body || {};

    const allowed = await assertTripInGroup(tripId, req.groupId);
    if (!allowed) {
      return res.status(403).json({ error: "No tenés permisos para este viaje" });
    }

    const tripName = String(reinforcement_trip_name || "").trim();
    const busName = String(reinforcement_bus_name || "").trim();
    const busCapacity = Number(reinforcement_bus_capacity || 0);
    const splitStopIds = Array.isArray(split_stop_ids)
      ? split_stop_ids.map((id) => Number(id)).filter((id) => Number.isFinite(id))
      : [];
    const splitOrderIndexes = Array.isArray(split_order_indexes)
      ? split_order_indexes.map((idx) => Number(idx)).filter((idx) => Number.isFinite(idx) && idx > 0)
      : [];

    if (!tripName) return res.status(400).json({ error: "Nombre de refuerzo requerido" });
    if (!busName) return res.status(400).json({ error: "Nombre de vehículo requerido" });
    if (!Number.isFinite(busCapacity) || busCapacity <= 0) {
      return res.status(400).json({ error: "Capacidad de vehículo inválida" });
    }
    if (splitStopIds.length === 0 && splitOrderIndexes.length === 0) {
      return res.status(400).json({ error: "Seleccioná al menos una parada para refuerzo" });
    }

    const { data: stopsRows, error: stopsError } = await supabase
      .from("trip_stops")
      .select("stop_id, order_index")
      .eq("trip_id", tripId);

    if (stopsError) return res.status(500).json({ error: stopsError.message });

    const availableIds = new Set((stopsRows || []).map((row) => Number(row.stop_id)));
    const orderToStopId = new Map((stopsRows || []).map((row) => [Number(row.order_index), Number(row.stop_id)]));
    const splitIdsFromOrder = splitOrderIndexes
      .map((idx) => orderToStopId.get(idx))
      .filter((id) => Number.isFinite(id));

    const validSplitIds = Array.from(new Set([...splitStopIds, ...splitIdsFromOrder]))
      .filter((id) => availableIds.has(id));

    if (validSplitIds.length === 0) {
      return res.status(400).json({ error: "Paradas inválidas para este traslado" });
    }

    if (validSplitIds.length === availableIds.size) {
      return res.status(400).json({ error: "Debe quedar al menos una parada en el traslado principal" });
    }

    const { data: currentConfig, error: currentConfigError } = await supabase
      .from("trip_reinforcement_configs")
      .select("active_reinforcement_trip_id")
      .eq("parent_trip_id", tripId)
      .maybeSingle();

    if (currentConfigError) return res.status(500).json({ error: currentConfigError.message });
    if (currentConfig?.active_reinforcement_trip_id) {
      return res.status(400).json({ error: "No podés editar configuración con un refuerzo activo" });
    }

    const { error: upsertError } = await supabase
      .from("trip_reinforcement_configs")
      .upsert({
        parent_trip_id: tripId,
        active_reinforcement_trip_id: null,
        parent_stops_snapshot: null,
        split_stop_ids: JSON.stringify(validSplitIds),
        reinforcement_trip_name: tripName,
        reinforcement_bus_name: busName,
        reinforcement_bus_capacity: busCapacity,
      }, { onConflict: "parent_trip_id" });

    if (upsertError) return res.status(500).json({ error: upsertError.message });

    return res.json({ success: true });
  } catch (err) {
    console.error("🔥 SAVE REINFORCEMENT CONFIG ERROR:", err);
    return res.status(500).json({ error: "Server exploded" });
  }
});

// ========================
// POST /trips/:id/reinforcement
// body: { name, bus_name, bus_capacity, stop_ids: [] }
// ========================
router.post("/:id/reinforcement", auth, requireRole("admin"), requireStaffGroup, async (req, res) => {
  try {
    const tripId = req.params.id;
    const {
      name,
      bus_name,
      bus_capacity,
      stop_ids,
    } = req.body || {};

    const allowed = await assertTripInGroup(tripId, req.groupId);
    if (!allowed) {
      return res.status(403).json({ error: "No tenés permisos para este viaje" });
    }

    const reinforcementTripName = String(name || "").trim();
    const reinforcementBusName = String(bus_name || "").trim();
    const reinforcementBusCapacity = Number(bus_capacity || 0);
    const selectedStopIds = Array.isArray(stop_ids)
      ? stop_ids.map((id) => Number(id)).filter((id) => Number.isFinite(id))
      : [];

    if (!reinforcementTripName) {
      return res.status(400).json({ error: "Nombre de refuerzo requerido" });
    }
    if (!reinforcementBusName) {
      return res.status(400).json({ error: "Nombre de vehículo requerido" });
    }
    if (!Number.isFinite(reinforcementBusCapacity) || reinforcementBusCapacity <= 0) {
      return res.status(400).json({ error: "Capacidad de vehículo inválida" });
    }
    if (selectedStopIds.length === 0) {
      return res.status(400).json({ error: "Seleccioná al menos una parada para refuerzo" });
    }

    const { data: parentTrip, error: parentTripError } = await supabase
      .from("trips")
      .select("id, name, type, status, departure_datetime, waitlist_start_at, waitlist_end_at, waitlist_start_day, waitlist_start_time, waitlist_end_day, waitlist_end_time")
      .eq("id", tripId)
      .maybeSingle();

    if (parentTripError) return res.status(500).json({ error: parentTripError.message });
    if (!parentTrip) return res.status(404).json({ error: "Traslado no encontrado" });

    const { data: parentStopsRows, error: parentStopsError } = await supabase
      .from("trip_stops")
      .select("stop_id, pickup_time, order_index, stops ( name )")
      .eq("trip_id", tripId)
      .order("order_index", { ascending: true });

    if (parentStopsError) return res.status(500).json({ error: parentStopsError.message });

    const parentStops = Array.isArray(parentStopsRows) ? parentStopsRows : [];
    if (parentStops.length < 2) {
      return res.status(400).json({ error: "El traslado debe tener al menos dos paradas" });
    }

    const selectedSet = new Set(selectedStopIds.map((id) => String(id)));
    const selectedStops = parentStops.filter((row) => selectedSet.has(String(row.stop_id)));
    const remainingStops = parentStops.filter((row) => !selectedSet.has(String(row.stop_id)));

    if (selectedStops.length === 0) {
      return res.status(400).json({ error: "Las paradas seleccionadas no pertenecen al traslado" });
    }
    if (remainingStops.length === 0) {
      return res.status(400).json({ error: "Debe quedar al menos una parada en el traslado original" });
    }

    const [confirmedResult, waitingResult, capacityRows] = await Promise.all([
      supabase
        .from("reservations")
        .select("*", { count: "exact", head: true })
        .eq("trip_id", tripId)
        .eq("status", "confirmed"),
      supabase
        .from("reservations")
        .select("*", { count: "exact", head: true })
        .eq("trip_id", tripId)
        .eq("status", "waiting"),
      supabase
        .from("trip_buses")
        .select("buses ( capacity )")
        .eq("trip_id", tripId),
    ]);

    if (confirmedResult.error) return res.status(500).json({ error: confirmedResult.error.message });
    if (waitingResult.error) return res.status(500).json({ error: waitingResult.error.message });
    if (capacityRows.error) return res.status(500).json({ error: capacityRows.error.message });

    const parentCapacity = (capacityRows.data || []).reduce(
      (sum, row) => sum + Number(row?.buses?.capacity || 0),
      0
    );
    const confirmedCount = confirmedResult.count || 0;
    const waitingCount = waitingResult.count || 0;

    const { data: activeConfig, error: activeConfigError } = await supabase
      .from("trip_reinforcement_configs")
      .select("active_reinforcement_trip_id")
      .eq("parent_trip_id", tripId)
      .maybeSingle();

    if (activeConfigError) return res.status(500).json({ error: activeConfigError.message });
    if (activeConfig?.active_reinforcement_trip_id) {
      return res.status(400).json({ error: "Ya existe un refuerzo activo para este traslado" });
    }

    const { data: createdTrip, error: createTripError } = await supabase
      .from("trips")
      .insert({
        name: reinforcementTripName,
        type: parentTrip.type,
        status: parentTrip.status,
        departure_datetime: parentTrip.departure_datetime,
        waitlist_start_at: parentTrip.waitlist_start_at,
        waitlist_end_at: parentTrip.waitlist_end_at,
        waitlist_start_day: parentTrip.waitlist_start_day,
        waitlist_start_time: parentTrip.waitlist_start_time,
        waitlist_end_day: parentTrip.waitlist_end_day,
        waitlist_end_time: parentTrip.waitlist_end_time,
      })
      .select("id")
      .single();

    if (createTripError) return res.status(500).json({ error: createTripError.message });

    await assignTripToGroup(createdTrip.id, req.groupId);

    const { data: createdBus, error: createBusError } = await supabase
      .from("buses")
      .insert({
        name: reinforcementBusName,
        capacity: reinforcementBusCapacity,
        active: true,
      })
      .select("id")
      .single();

    if (createBusError) return res.status(500).json({ error: createBusError.message });

    const { error: linkBusError } = await supabase
      .from("trip_buses")
      .insert({
        trip_id: createdTrip.id,
        bus_id: createdBus.id,
      });

    if (linkBusError) return res.status(500).json({ error: linkBusError.message });

    const reinforcementTripStops = selectedStops.map((row, index) => ({
      trip_id: createdTrip.id,
      stop_id: row.stop_id,
      pickup_time: row.pickup_time,
      order_index: index + 1,
    }));

    const { error: insertReinforcementStopsError } = await supabase
      .from("trip_stops")
      .insert(reinforcementTripStops);

    if (insertReinforcementStopsError) return res.status(500).json({ error: insertReinforcementStopsError.message });

    const reinforcementStopIds = selectedStops.map((row) => row.stop_id);
    const { data: reservationsToMove, error: reservationsToMoveError } = await supabase
      .from("reservations")
      .select("id")
      .eq("trip_id", tripId)
      .in("stop_id", reinforcementStopIds);

    if (reservationsToMoveError) return res.status(500).json({ error: reservationsToMoveError.message });

    const reservationIdsToMove = (reservationsToMove || []).map((row) => row.id).filter(Boolean);
    if (reservationIdsToMove.length > 0) {
      const { error: moveReservationsError } = await supabase
        .from("reservations")
        .update({ trip_id: createdTrip.id })
        .in("id", reservationIdsToMove);

      if (moveReservationsError) return res.status(500).json({ error: moveReservationsError.message });
    }

    const parentStopsSnapshot = parentStops.map((row) => ({
      stop_id: row.stop_id,
      pickup_time: row.pickup_time,
      order_index: row.order_index,
      name: row.stops?.name || null,
    }));

    const { error: deleteParentStopsError } = await supabase
      .from("trip_stops")
      .delete()
      .eq("trip_id", tripId);

    if (deleteParentStopsError) return res.status(500).json({ error: deleteParentStopsError.message });

    const parentRemainingStops = remainingStops.map((row, index) => ({
      trip_id: tripId,
      stop_id: row.stop_id,
      pickup_time: row.pickup_time,
      order_index: index + 1,
    }));

    const { error: insertParentStopsError } = await supabase
      .from("trip_stops")
      .insert(parentRemainingStops);

    if (insertParentStopsError) return res.status(500).json({ error: insertParentStopsError.message });

    const { error: upsertConfigError } = await supabase
      .from("trip_reinforcement_configs")
      .upsert({
        parent_trip_id: tripId,
        active_reinforcement_trip_id: createdTrip.id,
        parent_stops_snapshot: JSON.stringify(parentStopsSnapshot),
        split_stop_ids: JSON.stringify(selectedStops.map((row) => row.stop_id)),
        reinforcement_trip_name: reinforcementTripName,
        reinforcement_bus_name: reinforcementBusName,
        reinforcement_bus_capacity: reinforcementBusCapacity,
      }, { onConflict: "parent_trip_id" });

    if (upsertConfigError) return res.status(500).json({ error: upsertConfigError.message });

    try {
      await notifyAdminsReinforcementActivated({
        groupId: req.groupId,
        tripName: parentTrip.name || `Traslado ${tripId}`,
        reinforcementTripName,
        capacity: parentCapacity,
        confirmed: confirmedCount || 0,
        waiting: waitingCount || 0,
      });
    } catch (notifyError) {
      console.error("⚠️ REINFORCEMENT EMAIL ALERT ERROR:", notifyError);
    }

    return res.json({
      success: true,
      reinforcement_trip_id: createdTrip.id,
      moved_reservations: reservationIdsToMove.length,
    });
  } catch (err) {
    console.error("🔥 CREATE REINFORCEMENT ERROR:", err);
    return res.status(500).json({ error: "Server exploded" });
  }
});

// ========================
// DELETE /trips/:id (eliminar)
// ========================
router.delete("/:id", auth, requireRole("admin"), requireStaffGroup, async (req, res) => {
  try {
    const tripId = req.params.id;

    const allowed = await assertTripInGroup(tripId, req.groupId);
    if (!allowed) {
      return res.status(403).json({ error: "No tenés permisos para este viaje" });
    }

    const { data: activeRun } = await supabase
      .from("trip_runs")
      .select("id")
      .eq("trip_id", tripId)
      .is("finished_at", null)
      .limit(1)
      .maybeSingle();

    if (activeRun) {
      return res.status(400).json({ error: "No podés eliminar un viaje con recorrido activo" });
    }

    await backupTripHistoryBeforeDelete({
      tripId,
      groupId: req.groupId,
    });

    await supabase.from("reservations").delete().eq("trip_id", tripId);
    await supabase.from("trip_stops").delete().eq("trip_id", tripId);
    await supabase.from("trip_buses").delete().eq("trip_id", tripId);

    const { error } = await supabase
      .from("trips")
      .delete()
      .eq("id", tripId);

    if (error) return res.status(500).json({ error: error.message });

    return res.json({ success: true });
  } catch (err) {
    console.error("🔥 DELETE TRIP ERROR:", err);
    const status = Number(err?.status || 500);
    const message = String(err?.message || "Server exploded");
    return res.status(Number.isFinite(status) ? status : 500).json({ error: message });
  }
});



// ========================
// EXPORT (SIEMPRE AL FINAL)
// ========================
module.exports = router;
