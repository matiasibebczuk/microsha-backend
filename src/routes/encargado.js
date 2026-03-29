const express = require("express");
const { createClient } = require("@supabase/supabase-js");
const auth = require("../middleware/auth");
const { requireRole } = require("../middleware/roles");
const { requireStaffGroup, assertTripInGroup } = require("../middleware/groupAccess");
const fs = require("fs");
const path = require("path");
const { getNextScheduleActivationIso, normalizeClockTime } = require("../utils/scheduleTime");

const router = express.Router();

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

const logsDir = path.join(__dirname, "..", "..", "logs");
const attendanceLogPath = path.join(logsDir, "attendance-log.jsonl");

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
      status,
      boarded,
      stop_id,
      users ( name, phone, description ),
      stops ( name )
    `)
    .eq("trip_id", tripId)
    .in("status", ["confirmed", "waiting"])
    .order("id", { ascending: true });

  if (error) throw error;

  return data || [];
}

async function getTripStopTimes(tripId) {
  const { data, error } = await supabase
    .from("trip_stops")
    .select("stop_id, pickup_time")
    .eq("trip_id", tripId);

  if (error) throw error;

  const result = {};
  for (const row of data || []) {
    result[row.stop_id] = normalizeClockTime(row.pickup_time) || null;
  }

  return result;
}

function groupPassengersByStop(passengers, timeMap) {
  const grouped = {};

  for (const p of passengers) {
    const stopId = p.stop_id;

    if (!grouped[stopId]) {
      grouped[stopId] = {
        stopId,
        stop: p.stops?.name || "Sin parada",
        time: timeMap[stopId] || null,
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

  return Object.values(grouped);
}

async function getTripById(tripId) {
  const { data, error } = await supabase
    .from("trips")
    .select("id, status, waitlist_start_day, waitlist_start_time")
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

async function appendAttendanceLog(entry) {
  await fs.promises.mkdir(logsDir, { recursive: true });
  await fs.promises.appendFile(attendanceLogPath, `${JSON.stringify(entry)}\n`, "utf8");
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
      .select("id, trip_id")
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
