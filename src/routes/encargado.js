const express = require("express");
const { createClient } = require("@supabase/supabase-js");
const auth = require("../middleware/auth");
const { requireRole } = require("../middleware/roles");
const { requireStaffGroup, assertTripInGroup } = require("../middleware/groupAccess");
const fs = require("fs");
const path = require("path");
const { getNextScheduleActivationIso, normalizeClockTime } = require("../utils/scheduleTime");
const { isSanctionsEnabled } = require("../config/featureFlags");
const { getLastFriday20Iso } = require("../utils/fridayWindow");
const { notifyAdminsTripFinishedSummary } = require("../services/reinforcementNotifications");
const { setSystemFlags } = require("../services/systemFlags");

const router = express.Router();

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

const logsDir = path.join(__dirname, "..", "..", "logs");
const attendanceLogPath = path.join(logsDir, "attendance-log.jsonl");
const cancellationsLogPath = path.join(logsDir, "reservation-cancellations.jsonl");

router.use(auth, requireRole("encargado"), requireStaffGroup);

async function getActiveRun(tripId) {
  const { data, error } = await supabase
    .from("trip_runs")
    .select("id, trip_id, taken_by, finished_at, started_at")
    .eq("trip_id", tripId)
    .is("finished_at", null)
    .order("id", { ascending: false })
    .limit(1)
    .maybeSingle();

  if (error) throw error;
  return data;
}

async function getActiveRunByEncargado(encargadoId) {
  const { data, error } = await supabase
    .from("trip_runs")
    .select("id, trip_id, taken_by, finished_at, started_at")
    .eq("taken_by", encargadoId)
    .is("finished_at", null)
    .order("id", { ascending: false })
    .limit(1)
    .maybeSingle();

  if (error) throw error;
  return data;
}

async function getTripPassengers(tripId) {
  const { data, error } = await supabase
    .from("reservations")
    .select(`
      id,
      user_id,
      status,
      boarded,
      stop_id,
      users ( name, phone, description, dni, member_number ),
      stops ( name )
    `)
    .eq("trip_id", tripId)
    .in("status", ["confirmed", "waiting"])
    .order("id", { ascending: true });

  if (error) throw error;

  return data || [];
}

function toPassengerInfo(userRow) {
  return {
    name: userRow?.name || "Sin nombre",
    description: userRow?.description || "",
  };
}

function isMissingTableError(error) {
  if (!error) return false;
  if (error.code === "42P01") return true;
  const message = String(error.message || "").toLowerCase();
  return message.includes("does not exist") || message.includes("relation") || message.includes("tabla");
}

async function readLateCancellationsForTrip(tripId, finishedAtIso) {
  const cutoffIso = getLastFriday20Iso(new Date(finishedAtIso));
  const cutoffMs = cutoffIso ? new Date(cutoffIso).getTime() : Number.NaN;
  const finishMs = new Date(finishedAtIso).getTime();
  if (!Number.isFinite(cutoffMs) || !Number.isFinite(finishMs)) return [];

  try {
    const { data, error } = await supabase
      .from("trip_cancellations_log")
      .select("user_id, reservation_id, user_name, description, canceled_at")
      .eq("trip_id", Number(tripId))
      .gte("canceled_at", new Date(cutoffMs).toISOString())
      .lte("canceled_at", new Date(finishMs).toISOString())
      .order("canceled_at", { ascending: false })
      .limit(500);

    if (!error) {
      const unique = new Map();
      for (const row of Array.isArray(data) ? data : []) {
        const key = String(row?.user_id || row?.reservation_id || row?.user_name || "");
        if (!key || unique.has(key)) continue;

        unique.set(key, {
          name: row?.user_name || "Sin nombre",
          description: row?.description || "",
        });
      }

      return Array.from(unique.values());
    }

    const tableMissing = error?.code === "42P01" || String(error?.message || "").toLowerCase().includes("does not exist");
    if (!tableMissing) {
      throw error;
    }
  } catch (dbError) {
    console.warn("⚠️ CANCELLATION DB READ FAILED, USING FILE FALLBACK:", dbError?.message || dbError);
  }

  try {
    if (!fs.existsSync(cancellationsLogPath)) return [];

    const raw = await fs.promises.readFile(cancellationsLogPath, "utf8");
    const rows = String(raw || "")
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean)
      .map((line) => {
        try {
          return JSON.parse(line);
        } catch {
          return null;
        }
      })
      .filter(Boolean);

    const unique = new Map();
    for (const row of rows) {
      if (String(row?.trip_id) !== String(tripId)) continue;

      const canceledAtMs = new Date(row?.canceled_at).getTime();
      if (!Number.isFinite(canceledAtMs)) continue;
      if (canceledAtMs < cutoffMs || canceledAtMs > finishMs) continue;

      const key = String(row?.user_id || row?.reservation_id || row?.user_name || "");
      if (!key || unique.has(key)) continue;

      unique.set(key, {
        name: row?.user_name || "Sin nombre",
        description: row?.description || "",
      });
    }

    return Array.from(unique.values());
  } catch (error) {
    console.error("⚠️ CANCEL LOG READ ERROR:", error);
    return [];
  }
}

async function applyNoShowSanctions(passengers) {
  if (!isSanctionsEnabled()) return;
  const confirmedRows = (Array.isArray(passengers) ? passengers : []).filter(
    (row) => row?.status === "confirmed" && row?.user_id
  );

  if (confirmedRows.length === 0) return;

  const now = new Date();
  const oneWeekMs = 7 * 24 * 60 * 60 * 1000;

  for (const row of confirmedRows) {
    const userId = row.user_id;
    const boarded = Boolean(row.boarded);

    const { data: user, error: userError } = await supabase
      .from("users")
      .select("id, no_show_streak")
      .eq("id", userId)
      .maybeSingle();

    if (userError || !user) continue;

    if (boarded) {
      await supabase
        .from("users")
        .update({ no_show_streak: 0 })
        .eq("id", userId);
      continue;
    }

    const nextStreak = Number(user.no_show_streak || 0) + 1;
    if (nextStreak >= 2) {
      const suspendedUntil = new Date(now.getTime() + oneWeekMs).toISOString();
      await supabase
        .from("users")
        .update({
          no_show_streak: 0,
          suspended_until: suspendedUntil,
          suspension_reason: "2 ausencias consecutivas",
          suspension_origin: "auto",
          suspension_created_at: now.toISOString(),
        })
        .eq("id", userId);
    } else {
      await supabase
        .from("users")
        .update({ no_show_streak: nextStreak })
        .eq("id", userId);
    }
  }
}

async function getTripStopTimes(tripId) {
  const { data, error } = await supabase
    .from("trip_stops")
    .select("stop_id, pickup_time, order_index")
    .eq("trip_id", tripId);

  if (error) throw error;

  const result = {};
  for (const row of data || []) {
    result[row.stop_id] = {
      time: normalizeClockTime(row.pickup_time) || null,
      order: Number(row.order_index || 0) || 0,
    };
  }

  return result;
}

function groupPassengersByStop(passengers, timeMap) {
  const grouped = {};

  for (const p of passengers) {
    const stopId = p.stop_id;
    const stopInfo = timeMap[stopId] || { time: null, order: 0 };

    if (!grouped[stopId]) {
      grouped[stopId] = {
        stopId,
        stop: p.stops?.name || "Sin parada",
        time: stopInfo.time,
        order: stopInfo.order,
        passengers: [],
      };
    }

    grouped[stopId].passengers.push({
      reservationId: p.id,
      status: p.status || "confirmed",
      name: p.users?.name || "Sin nombre",
      phone: p.users?.phone || null,
      description: p.users?.description || "",
      boarded: Boolean(p.boarded),
    });
  }

  return Object.values(grouped).sort((a, b) => {
    if (a.order !== b.order) return a.order - b.order;
    if (a.time && b.time) {
      const [aH, aM] = a.time.split(":").map(Number);
      const [bH, bM] = b.time.split(":").map(Number);
      const aMinutes = (Number.isFinite(aH) ? aH : 0) * 60 + (Number.isFinite(aM) ? aM : 0);
      const bMinutes = (Number.isFinite(bH) ? bH : 0) * 60 + (Number.isFinite(bM) ? bM : 0);
      if (aMinutes !== bMinutes) return aMinutes - bMinutes;
    }
    if (a.time && !b.time) return -1;
    if (!a.time && b.time) return 1;
    return String(a.stop || "").localeCompare(String(b.stop || ""), undefined, { numeric: true, sensitivity: "base" });
  });
}

async function getTripById(tripId) {
  const { data, error } = await supabase
    .from("trips")
    .select("id, name, type, departure_datetime, status, waitlist_start_day, waitlist_start_time")
    .eq("id", tripId)
    .maybeSingle();

  if (error) throw error;
  return data;
}

async function cleanupForcedReinforcementAfterFinish(parentTripId) {
  const { data: config, error: configError } = await supabase
    .from("trip_reinforcement_configs")
    .select("parent_trip_id, active_reinforcement_trip_id, parent_stops_snapshot")
    .eq("parent_trip_id", parentTripId)
    .maybeSingle();

  if (configError) throw configError;
  if (!config?.active_reinforcement_trip_id) return;

  const reinforcementTripId = config.active_reinforcement_trip_id;
  const snapshot = (() => {
    if (Array.isArray(config.parent_stops_snapshot)) return config.parent_stops_snapshot;
    if (typeof config.parent_stops_snapshot === "string") {
      try {
        const parsed = JSON.parse(config.parent_stops_snapshot);
        return Array.isArray(parsed) ? parsed : [];
      } catch {
        return [];
      }
    }
    return [];
  })();

  if (snapshot.length > 0) {
    const { error: deleteParentStopsError } = await supabase
      .from("trip_stops")
      .delete()
      .eq("trip_id", parentTripId);

    if (deleteParentStopsError) throw deleteParentStopsError;

    const restoreRows = snapshot
      .map((row, index) => ({
        trip_id: parentTripId,
        stop_id: row.stop_id,
        pickup_time: row.pickup_time,
        order_index: Number(row.order_index || index + 1),
      }))
      .filter((row) => row.stop_id);

    if (restoreRows.length > 0) {
      const { error: restoreError } = await supabase
        .from("trip_stops")
        .insert(restoreRows);
      if (restoreError) throw restoreError;
    }
  }

  await supabase.from("reservations").delete().eq("trip_id", reinforcementTripId);

  const { error: archiveError } = await supabase
    .from("trips")
    .update({ status: "archived" })
    .eq("id", reinforcementTripId);

  if (archiveError) throw archiveError;

  const { error: clearConfigError } = await supabase
    .from("trip_reinforcement_configs")
    .update({
      active_reinforcement_trip_id: null,
      parent_stops_snapshot: null,
    })
    .eq("parent_trip_id", parentTripId);

  if (clearConfigError) throw clearConfigError;
}

async function persistTripHistorySnapshot({ run, trip, passengers, groupId, finishedAt }) {
  const tripId = Number(run?.trip_id || trip?.id || 0) || null;
  const sourceRunId = Number(run?.id || 0) || null;

  const [{ data: stopsRows, error: stopsError }, { data: busesRows, error: busesError }] = await Promise.all([
    supabase
      .from("trip_stops")
      .select("stop_id, pickup_time, order_index, stops(name)")
      .eq("trip_id", tripId)
      .order("order_index", { ascending: true }),
    supabase
      .from("trip_buses")
      .select("bus_id, buses(name, capacity)")
      .eq("trip_id", tripId),
  ]);

  if (stopsError && !isMissingTableError(stopsError)) throw stopsError;
  if (busesError && !isMissingTableError(busesError)) throw busesError;

  const stopsSnapshot = (Array.isArray(stopsRows) ? stopsRows : []).map((row) => ({
    stop_id: row?.stop_id ?? null,
    stop_name: row?.stops?.name || null,
    pickup_time: row?.pickup_time || null,
    order_index: Number(row?.order_index || 0) || null,
  }));

  const busesSnapshot = (Array.isArray(busesRows) ? busesRows : []).map((row) => ({
    bus_id: row?.bus_id ?? null,
    bus_name: row?.buses?.name || null,
    capacity: Number(row?.buses?.capacity || 0) || 0,
  }));

  const normalizedPassengers = (Array.isArray(passengers) ? passengers : []).map((p) => ({
    source_reservation_id: Number(p?.id || 0) || null,
    user_id: p?.user_id ? String(p.user_id) : null,
    user_name: p?.users?.name || "Sin nombre",
    phone: p?.users?.phone || null,
    description: p?.users?.description || "",
    dni: p?.users?.dni || null,
    member_number: p?.users?.member_number || null,
    stop_id: Number(p?.stop_id || 0) || null,
    stop_name: p?.stops?.name || "Sin parada",
    status: p?.status || "confirmed",
    boarded: Boolean(p?.boarded),
  }));

  const summarySnapshot = {
    total: normalizedPassengers.length,
    boarded: normalizedPassengers.filter((p) => p.boarded).length,
    missing: normalizedPassengers.filter((p) => !p.boarded && p.status === "confirmed").length,
    waiting: normalizedPassengers.filter((p) => p.status === "waiting").length,
  };

  const tripSnapshot = {
    trip_id: tripId,
    trip_name: trip?.name || null,
    trip_type: trip?.type || null,
    trip_departure_datetime: trip?.departure_datetime || null,
    trip_status_at_finish: trip?.status || null,
    stops: stopsSnapshot,
    buses: busesSnapshot,
  };

  const { data: historyRun, error: historyRunError } = await supabase
    .from("trip_history_runs")
    .upsert({
      source_run_id: sourceRunId,
      trip_id: tripId,
      group_id: String(groupId || ""),
      trip_name: trip?.name || null,
      trip_type: trip?.type || null,
      trip_departure_datetime: trip?.departure_datetime || null,
      trip_status_at_finish: trip?.status || null,
      taken_by: run?.taken_by ? String(run.taken_by) : null,
      started_at: run?.started_at || null,
      finished_at: finishedAt,
      trip_snapshot: tripSnapshot,
      summary_snapshot: summarySnapshot,
    }, { onConflict: "source_run_id" })
    .select("id")
    .single();

  if (historyRunError) {
    if (isMissingTableError(historyRunError)) {
      console.warn("⚠️ trip_history_runs no existe. Ejecutá sql/2026-03-31_trip_history_snapshot.sql");
      return;
    }
    throw historyRunError;
  }

  const historyRunId = Number(historyRun?.id || 0);
  if (!historyRunId) return;

  const { error: deletePassengersError } = await supabase
    .from("trip_history_passengers")
    .delete()
    .eq("history_run_id", historyRunId);

  if (deletePassengersError && !isMissingTableError(deletePassengersError)) {
    throw deletePassengersError;
  }

  if (normalizedPassengers.length === 0) return;

  const historyPassengersRows = normalizedPassengers.map((p) => ({
    history_run_id: historyRunId,
    source_run_id: sourceRunId,
    source_reservation_id: p.source_reservation_id,
    user_id: p.user_id,
    user_name: p.user_name,
    phone: p.phone,
    description: p.description,
    dni: p.dni,
    member_number: p.member_number,
    stop_id: p.stop_id,
    stop_name: p.stop_name,
    status: p.status,
    boarded: p.boarded,
  }));

  const { error: historyPassengersError } = await supabase
    .from("trip_history_passengers")
    .insert(historyPassengersRows);

  if (historyPassengersError) {
    if (isMissingTableError(historyPassengersError)) {
      console.warn("⚠️ trip_history_passengers no existe. Ejecutá sql/2026-03-31_trip_history_snapshot.sql");
      return;
    }
    throw historyPassengersError;
  }
}

async function appendAttendanceLog(entry) {
  await fs.promises.mkdir(logsDir, { recursive: true });
  await fs.promises.appendFile(attendanceLogPath, `${JSON.stringify(entry)}\n`, "utf8");
}

async function getLocationSession(tripId) {
  const { data, error } = await supabase
    .from("trip_location_sessions")
    .select("trip_id, active, started_by, started_at, stopped_at, last_latitude, last_longitude, last_accuracy_meters, last_update_at, last_stop_id, last_stop_name, last_stop_at")
    .eq("trip_id", tripId)
    .maybeSingle();

  if (error) {
    if (isMissingTableError(error)) return null;
    throw error;
  }

  return data || null;
}

async function upsertLocationSession(tripId, payload) {
  const { error } = await supabase
    .from("trip_location_sessions")
    .upsert({
      trip_id: Number(tripId),
      updated_at: new Date().toISOString(),
      ...payload,
    }, { onConflict: "trip_id" });

  if (error) {
    if (isMissingTableError(error)) {
      const migrationPath = "microsha-backend/sql/2026-04-03_trip_location_tracking.sql";
      const migrationError = new Error(`Falta migración de ubicación en tiempo real (${migrationPath}).`);
      migrationError.status = 409;
      throw migrationError;
    }
    throw error;
  }
}

async function saveTripLocationUpdate({ tripId, userId, latitude, longitude, accuracyMeters, metadata }) {
  const nowIso = new Date().toISOString();

  await upsertLocationSession(tripId, {
    active: true,
    started_by: String(userId || ""),
    started_at: nowIso,
    stopped_at: null,
    last_latitude: Number(latitude),
    last_longitude: Number(longitude),
    last_accuracy_meters: Number.isFinite(Number(accuracyMeters)) ? Number(accuracyMeters) : null,
    last_update_at: nowIso,
  });

  const { error: insertError } = await supabase
    .from("trip_location_updates")
    .insert({
      trip_id: Number(tripId),
      latitude: Number(latitude),
      longitude: Number(longitude),
      accuracy_meters: Number.isFinite(Number(accuracyMeters)) ? Number(accuracyMeters) : null,
      recorded_at: nowIso,
      source_user_id: String(userId || ""),
      metadata: metadata && typeof metadata === "object" ? metadata : {},
    });

  if (insertError) {
    if (isMissingTableError(insertError)) {
      const migrationPath = "microsha-backend/sql/2026-04-03_trip_location_tracking.sql";
      const migrationError = new Error(`Falta migración de ubicación en tiempo real (${migrationPath}).`);
      migrationError.status = 409;
      throw migrationError;
    }
    throw insertError;
  }
}

router.post("/trips/:tripId/start", async (req, res) => {
  try {
    const { tripId } = req.params;

    const allowed = await assertTripInGroup(tripId, req.groupId);
    if (!allowed) {
      return res.status(403).json({ error: "No tenés permisos para este viaje" });
    }

    const trip = await getTripById(tripId);
    if (!trip) {
      return res.status(404).json({ error: "Trip not found" });
    }

    if (trip.status === "closed") {
      return res.status(400).json({ error: "El recorrido ya está iniciado/cerrado" });
    }

    const activeRun = await getActiveRun(tripId);
    if (activeRun) {
      return res.status(400).json({ error: "Ya hay un recorrido activo para este viaje" });
    }

    const activeRunByEncargado = await getActiveRunByEncargado(req.user.id);
    if (activeRunByEncargado) {
      return res.status(400).json({
        error: `Ya tenés un recorrido activo en el viaje ${activeRunByEncargado.trip_id}`,
      });
    }

    const { data: assignedBus, error: busError } = await supabase
      .from("trip_buses")
      .select("bus_id")
      .eq("trip_id", tripId)
      .order("id", { ascending: true })
      .limit(1)
      .maybeSingle();

    if (busError) {
      return res.status(500).json({ error: busError.message });
    }

    if (!assignedBus?.bus_id) {
      return res.status(400).json({ error: "El viaje no tiene vehículo asignado" });
    }

    const { data: run, error: runError } = await supabase
      .from("trip_runs")
      .insert({
        trip_id: tripId,
        bus_id: assignedBus.bus_id,
        taken_by: req.user.id,
        finished_at: null,
      })
      .select("id, started_at")
      .single();

    if (runError) {
      return res.status(500).json({ error: runError.message });
    }

    const { error } = await supabase
      .from("trips")
      .update({ status: "closed" })
      .eq("id", tripId);

    if (error) {
      return res.status(500).json({ error: error.message });
    }

    return res.json({
      success: true,
      tripStatus: "closed",
      runId: run.id,
      startedAt: run.started_at || new Date().toISOString(),
    });
  } catch (err) {
    console.error("🔥 START TRIP ERROR:", err);
    return res.status(500).json({ error: "Server exploded" });
  }
});

router.get("/trips/:tripId/state", async (req, res) => {
  try {
    const { tripId } = req.params;

    const allowed = await assertTripInGroup(tripId, req.groupId);
    if (!allowed) {
      return res.status(403).json({ error: "No tenés permisos para este viaje" });
    }

    const trip = await getTripById(tripId);

    if (!trip) {
      return res.status(404).json({ error: "Trip not found" });
    }

    const activeRun = await getActiveRun(tripId);
    const canManage =
      !activeRun || !activeRun.taken_by || activeRun.taken_by === req.user.id;

    const { data: lastFinishedRun } = await supabase
      .from("trip_runs")
      .select("id, finished_at")
      .eq("trip_id", tripId)
      .not("finished_at", "is", null)
      .order("id", { ascending: false })
      .limit(1)
      .maybeSingle();

    let activeController = null;
    if (activeRun?.taken_by) {
      const { data: controllerProfile } = await supabase
        .from("profiles")
        .select("id, name, lastname")
        .eq("id", activeRun.taken_by)
        .maybeSingle();

      activeController = {
        id: activeRun.taken_by,
        name:
          controllerProfile?.name ||
          controllerProfile?.lastname ||
          activeRun.taken_by,
      };
    }

    return res.json({
      tripStatus: trip.status,
      hasActiveRun: Boolean(activeRun),
      activeRunId: activeRun?.id || null,
      activeRunTakenBy: activeRun?.taken_by || null,
      activeRunStartedAt: activeRun?.started_at || null,
      lastFinishedAt: lastFinishedRun?.finished_at || null,
      activeController,
      canManage,
    });
  } catch (err) {
    console.error("🔥 ENCARGADO STATE ERROR:", err);
    return res.status(500).json({ error: "Server exploded" });
  }
});

router.get("/trips/:tripId/location/state", async (req, res) => {
  try {
    const { tripId } = req.params;

    const allowed = await assertTripInGroup(tripId, req.groupId);
    if (!allowed) {
      return res.status(403).json({ error: "No tenés permisos para este viaje" });
    }

    const session = await getLocationSession(tripId);
    return res.json({
      active: Boolean(session?.active),
      started_by: session?.started_by || null,
      started_at: session?.started_at || null,
      stopped_at: session?.stopped_at || null,
      last_update_at: session?.last_update_at || null,
      last_stop_name: session?.last_stop_name || null,
      last_stop_at: session?.last_stop_at || null,
    });
  } catch (err) {
    const status = Number(err?.status || 500);
    console.error("🔥 LOCATION STATE ERROR:", err);
    return res.status(Number.isFinite(status) ? status : 500).json({ error: err?.message || "Server exploded" });
  }
});

router.post("/trips/:tripId/location/start", async (req, res) => {
  try {
    const { tripId } = req.params;

    const allowed = await assertTripInGroup(tripId, req.groupId);
    if (!allowed) {
      return res.status(403).json({ error: "No tenés permisos para este viaje" });
    }

    const nowIso = new Date().toISOString();
    await upsertLocationSession(tripId, {
      active: true,
      started_by: String(req.user.id || ""),
      started_at: nowIso,
      stopped_at: null,
    });

    return res.json({ success: true, active: true, started_at: nowIso });
  } catch (err) {
    const status = Number(err?.status || 500);
    console.error("🔥 LOCATION START ERROR:", err);
    return res.status(Number.isFinite(status) ? status : 500).json({ error: err?.message || "Server exploded" });
  }
});

router.post("/trips/:tripId/location/stop", async (req, res) => {
  try {
    const { tripId } = req.params;

    const allowed = await assertTripInGroup(tripId, req.groupId);
    if (!allowed) {
      return res.status(403).json({ error: "No tenés permisos para este viaje" });
    }

    const nowIso = new Date().toISOString();
    await upsertLocationSession(tripId, {
      active: false,
      stopped_at: nowIso,
    });

    return res.json({ success: true, active: false, stopped_at: nowIso });
  } catch (err) {
    const status = Number(err?.status || 500);
    console.error("🔥 LOCATION STOP ERROR:", err);
    return res.status(Number.isFinite(status) ? status : 500).json({ error: err?.message || "Server exploded" });
  }
});

router.post("/trips/:tripId/location/update", async (req, res) => {
  try {
    const { tripId } = req.params;
    const latitude = Number(req.body?.latitude);
    const longitude = Number(req.body?.longitude);
    const accuracyMeters = Number(req.body?.accuracy_meters);

    if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) {
      return res.status(400).json({ error: "Coordenadas inválidas" });
    }

    const allowed = await assertTripInGroup(tripId, req.groupId);
    if (!allowed) {
      return res.status(403).json({ error: "No tenés permisos para este viaje" });
    }

    await saveTripLocationUpdate({
      tripId,
      userId: req.user.id,
      latitude,
      longitude,
      accuracyMeters,
      metadata: {
        heading: Number(req.body?.heading),
        speed: Number(req.body?.speed),
        provider: "web_geolocation",
      },
    });

    return res.json({ success: true, active: true, last_update_at: new Date().toISOString() });
  } catch (err) {
    const status = Number(err?.status || 500);
    console.error("🔥 LOCATION UPDATE ERROR:", err);
    return res.status(Number.isFinite(status) ? status : 500).json({ error: err?.message || "Server exploded" });
  }
});

router.get("/trips/:tripId/passengers", async (req, res) => {
  try {
    const { tripId } = req.params;

    const allowed = await assertTripInGroup(tripId, req.groupId);
    if (!allowed) {
      return res.status(403).json({ error: "No tenés permisos para este viaje" });
    }

    const passengers = await getTripPassengers(tripId);
    const timeMap = await getTripStopTimes(tripId);

    return res.json(groupPassengersByStop(passengers, timeMap));
  } catch (err) {
    console.error("🔥 ENCARGADO PASSENGERS ERROR:", err);
    return res.status(500).json({ error: "Server exploded" });
  }
});

router.put("/reservations/:reservationId/boarded", async (req, res) => {
  try {
    const { reservationId } = req.params;
    const boarded = Boolean(req.body?.boarded);

    const { data: reservation, error: reservationError } = await supabase
      .from("reservations")
      .select("id, trip_id, stop_id, stops(name)")
      .eq("id", reservationId)
      .maybeSingle();

    if (reservationError) {
      return res.status(500).json({ error: reservationError.message });
    }

    if (!reservation) {
      return res.status(404).json({ error: "Reserva no encontrada" });
    }

    const allowed = await assertTripInGroup(reservation.trip_id, req.groupId);
    if (!allowed) {
      return res.status(403).json({ error: "No tenés permisos para este viaje" });
    }

    const activeRun = await getActiveRun(reservation.trip_id);
    if (!activeRun) {
      return res.status(400).json({ error: "El recorrido todavía no fue iniciado" });
    }

    if (activeRun.taken_by && activeRun.taken_by !== req.user.id) {
      return res.status(403).json({ error: "Solo el encargado asignado puede tomar asistencia" });
    }

    const { error } = await supabase
      .from("reservations")
      .update({ boarded })
      .eq("id", reservationId);

    if (error) {
      return res.status(500).json({ error: error.message });
    }

    try {
      await appendAttendanceLog({
        timestamp: new Date().toISOString(),
        actor_user_id: req.user.id,
        trip_id: reservation.trip_id,
        reservation_id: reservationId,
        boarded,
      });
    } catch (logErr) {
      console.error("⚠️ ATTENDANCE LOG ERROR:", logErr);
    }

    if (boarded) {
      try {
        await upsertLocationSession(reservation.trip_id, {
          last_stop_id: reservation?.stop_id || null,
          last_stop_name: reservation?.stops?.name || "Sin parada",
          last_stop_at: new Date().toISOString(),
        });
      } catch (locationErr) {
        console.error("⚠️ LOCATION LAST STOP UPDATE ERROR:", locationErr);
      }
    }

    return res.json({ success: true, boarded });
  } catch (err) {
    console.error("🔥 BOARD UPDATE ERROR:", err);
    return res.status(500).json({ error: "Server exploded" });
  }
});

router.get("/trips/:tripId/dashboard", async (req, res) => {
  try {
    const { tripId } = req.params;

    const allowed = await assertTripInGroup(tripId, req.groupId);
    if (!allowed) {
      return res.status(403).json({ error: "No tenés permisos para este viaje" });
    }

    const { data, error } = await supabase
      .from("reservations")
        .select("boarded, status")
        .eq("trip_id", tripId)
        .in("status", ["confirmed", "waiting"]);

    if (error) {
      return res.status(500).json({ error: error.message });
    }

    const rows = Array.isArray(data) ? data : [];
    const confirmedRows = rows.filter((p) => p.status === "confirmed");
    const waitingRows = rows.filter((p) => p.status === "waiting");
    const total = confirmedRows.length;
    const boarded = confirmedRows.filter((p) => p.boarded).length;
    const missing = total - boarded;
    const waiting = waitingRows.length;

    return res.json({ total, boarded, missing, waiting });
  } catch (err) {
    console.error("🔥 ENCARGADO DASHBOARD ERROR:", err);
    return res.status(500).json({ error: "Server exploded" });
  }
});

router.post("/trips/:tripId/finish", async (req, res) => {
  try {
    const { tripId } = req.params;

    const allowed = await assertTripInGroup(tripId, req.groupId);
    if (!allowed) {
      return res.status(403).json({ error: "No tenés permisos para este viaje" });
    }

    const trip = await getTripById(tripId);
    if (!trip) {
      return res.status(404).json({ error: "Trip not found" });
    }

    if (trip.status !== "closed") {
      return res.status(400).json({ error: "El recorrido debe estar iniciado antes de finalizar" });
    }

    const activeRun = await getActiveRun(tripId);
    if (!activeRun) {
      return res.status(400).json({ error: "El recorrido ya fue finalizado o no fue iniciado" });
    }

    if (activeRun.taken_by && activeRun.taken_by !== req.user.id) {
      return res.status(403).json({ error: "Solo el encargado que inició puede finalizar" });
    }

    const runId = activeRun.id;
    const finishedAt = new Date().toISOString();

    const { error: finishRunError } = await supabase
      .from("trip_runs")
      .update({ finished_at: finishedAt })
      .eq("id", runId);

    if (finishRunError) {
      return res.status(500).json({ error: finishRunError.message });
    }

    const passengers = await getTripPassengers(tripId);

    const snapshot = passengers.map((p) => ({
      run_id: runId,
      user_name: p.users?.name || "Sin nombre",
      phone: p.users?.phone || null,
      stop_name: p.stops?.name || "Sin parada",
      boarded: Boolean(p.boarded),
    }));

    if (snapshot.length > 0) {
      const { error: insertError } = await supabase
        .from("trip_run_passengers")
        .insert(snapshot);

      if (insertError) {
        return res.status(500).json({ error: insertError.message });
      }
    }

    try {
      await persistTripHistorySnapshot({
        run: activeRun,
        trip,
        passengers,
        groupId: req.groupId,
        finishedAt,
      });
    } catch (historyErr) {
      console.error("⚠️ TRIP HISTORY SNAPSHOT ERROR:", historyErr);
    }

    await applyNoShowSanctions(passengers);

    const absentPassengers = passengers
      .filter((p) => p?.status === "confirmed" && !p?.boarded)
      .map((p) => toPassengerInfo(p?.users));
    const lateCancellations = await readLateCancellationsForTrip(tripId, finishedAt);

    try {
      const notifyResult = await notifyAdminsTripFinishedSummary({
        groupId: req.groupId,
        tripName: trip?.name || `Traslado ${tripId}`,
        absentPassengers,
        lateCancellations,
        fridayCutoffLabel: "viernes 20:00 (America/Argentina/Buenos_Aires)",
      });
      if (!notifyResult?.sent) {
        console.warn("[alerts] Trip finish summary not sent", {
          tripId,
          groupId: req.groupId,
          reason: notifyResult?.reason || "unknown",
          absentCount: absentPassengers.length,
          cancellationsCount: lateCancellations.length,
        });
      }
    } catch (notifyError) {
      console.error("⚠️ TRIP FINISH EMAIL ERROR:", notifyError);
    }

    const { error: cleanupError } = await supabase
      .from("reservations")
      .delete()
      .eq("trip_id", tripId);

    if (cleanupError) {
      return res.status(500).json({ error: cleanupError.message });
    }

    await cleanupForcedReinforcementAfterFinish(tripId);

    const hasWaitlistSchedule = trip.waitlist_start_day !== null && trip.waitlist_start_day !== undefined && trip.waitlist_start_time;
    if (hasWaitlistSchedule) {
      const suspendUntil = getNextScheduleActivationIso(trip.waitlist_start_day, trip.waitlist_start_time);
      if (suspendUntil) {
        const { error: waitlistPauseError } = await supabase
          .from("trips")
          .update({ waitlist_end_at: suspendUntil })
          .eq("id", tripId);

        if (waitlistPauseError) {
          return res.status(500).json({ error: waitlistPauseError.message });
        }
      }
    }

    try {
      await upsertLocationSession(tripId, {
        active: false,
        stopped_at: finishedAt,
      });
    } catch (locationStopError) {
      console.warn("⚠️ LOCATION AUTO-STOP AFTER FINISH ERROR:", locationStopError?.message || locationStopError);
    }

    try {
      await setSystemFlags({ stopBlockActive: false });
    } catch (flagErr) {
      console.warn("⚠️ STOP BLOCK RESET ERROR:", flagErr?.message || flagErr);
    }

    return res.json({
      success: true,
      runId,
      removedReservations: passengers.length,
      finishedAt,
    });
  } catch (err) {
    console.error("🔥 FINISH TRIP ERROR:", err);
    return res.status(500).json({ error: "Server exploded" });
  }
});

module.exports = router;
