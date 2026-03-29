const express = require("express");
const { createClient } = require("@supabase/supabase-js");
const { requirePassengerSession } = require("../middleware/passengerSession");
const { getPassengerGroupId } = require("../middleware/groupAccess");
const { getTripGroupId, assignTripToGroup } = require("../middleware/groupStore");
const { notifyAdminsReinforcementActivated } = require("../services/reinforcementNotifications");
const { getSystemFlags } = require("../services/systemFlags");
const { isWaitlistWindowActiveBySchedule, normalizeClockTime } = require("../utils/scheduleTime");

const router = express.Router();

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

async function getTripCapacity(tripId) {
  const { data, error } = await supabase
    .from("trip_buses")
    .select("buses ( capacity )")
    .eq("trip_id", tripId);

  if (error) throw error;

  return (
    data?.reduce((sum, row) => sum + (row.buses?.capacity || 0), 0) || 0
  );
}

async function getPauseState() {
  const flags = await getSystemFlags();
  return {
    paused: Boolean(flags?.tripsPaused),
    message: String(flags?.pauseMessage || "En mantenimiento, prueba mas tarde"),
  };
}

async function getTripStatus(tripId) {
  const { data, error } = await supabase
    .from("trips")
    .select("name, type, status, departure_datetime, waitlist_start_at, waitlist_end_at, waitlist_start_day, waitlist_start_time, waitlist_end_day, waitlist_end_time")
    .eq("id", tripId)
    .maybeSingle();

  if (error) throw error;
  return data || null;
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

function buildNotificationScheduleFromDate(baseDate) {
  const promotedAt = baseDate instanceof Date ? baseDate : new Date();
  const notifyAfter = new Date(promotedAt.getTime() + 5 * 60 * 1000);

  return {
    waiting_promoted_at: promotedAt.toISOString(),
    confirm_notify_after: notifyAfter.toISOString(),
    confirm_notified_at: null,
  };
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

async function autoActivateReinforcementIfNeeded({ tripId, trip, groupId }) {
  if (!tripId || !groupId) return null;

  const { data: config, error: configError } = await supabase
    .from("trip_reinforcement_configs")
    .select("parent_trip_id, active_reinforcement_trip_id, split_stop_ids, reinforcement_trip_name, reinforcement_bus_name, reinforcement_bus_capacity")
    .eq("parent_trip_id", tripId)
    .maybeSingle();

  if (configError) throw configError;
  if (!config) return null;
  if (config.active_reinforcement_trip_id) return config.active_reinforcement_trip_id;

  const splitStopIds = parseJsonArray(config.split_stop_ids)
    .map((id) => Number(id))
    .filter((id) => Number.isFinite(id));

  if (splitStopIds.length === 0) return null;

  const { data: parentStopsRows, error: parentStopsError } = await supabase
    .from("trip_stops")
    .select("stop_id, pickup_time, order_index")
    .eq("trip_id", tripId)
    .order("order_index", { ascending: true });

  if (parentStopsError) throw parentStopsError;

  const parentStops = Array.isArray(parentStopsRows) ? parentStopsRows : [];
  if (parentStops.length < 2) return null;

  const selectedSet = new Set(splitStopIds.map((id) => String(id)));
  const selectedStops = parentStops.filter((row) => selectedSet.has(String(row.stop_id)));
  const remainingStops = parentStops.filter((row) => !selectedSet.has(String(row.stop_id)));

  if (selectedStops.length === 0 || remainingStops.length === 0) return null;

  const reinforcementTripName = String(config.reinforcement_trip_name || "").trim() || `${trip.name || "Traslado"} Refuerzo`;
  const reinforcementBusName = String(config.reinforcement_bus_name || "").trim() || "Refuerzo 1";
  const reinforcementBusCapacity = Number(config.reinforcement_bus_capacity || 0);
  if (!reinforcementBusCapacity || reinforcementBusCapacity <= 0) return null;

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

  if (confirmedResult.error) throw confirmedResult.error;
  if (waitingResult.error) throw waitingResult.error;
  if (capacityRows.error) throw capacityRows.error;
  const parentCapacity = (capacityRows.data || []).reduce((sum, row) => sum + Number(row?.buses?.capacity || 0), 0);
  const confirmedCount = confirmedResult.count || 0;
  const waitingCount = waitingResult.count || 0;

  const { data: createdTrip, error: createTripError } = await supabase
    .from("trips")
    .insert({
      name: reinforcementTripName,
      type: trip.type,
      status: trip.status,
      departure_datetime: trip.departure_datetime || null,
      waitlist_start_at: trip.waitlist_start_at || null,
      waitlist_end_at: trip.waitlist_end_at || null,
      waitlist_start_day: trip.waitlist_start_day ?? null,
      waitlist_start_time: trip.waitlist_start_time || null,
      waitlist_end_day: trip.waitlist_end_day ?? null,
      waitlist_end_time: trip.waitlist_end_time || null,
    })
    .select("id")
    .single();

  if (createTripError) throw createTripError;
  await assignTripToGroup(createdTrip.id, groupId);

  const { data: createdBus, error: createBusError } = await supabase
    .from("buses")
    .insert({ name: reinforcementBusName, capacity: reinforcementBusCapacity, active: true })
    .select("id")
    .single();

  if (createBusError) throw createBusError;

  const { error: linkBusError } = await supabase
    .from("trip_buses")
    .insert({ trip_id: createdTrip.id, bus_id: createdBus.id });
  if (linkBusError) throw linkBusError;

  const { error: insertStopsError } = await supabase
    .from("trip_stops")
    .insert(selectedStops.map((row, index) => ({
      trip_id: createdTrip.id,
      stop_id: row.stop_id,
      pickup_time: row.pickup_time,
      order_index: index + 1,
    })));
  if (insertStopsError) throw insertStopsError;

  const { data: reservationsToMove, error: reservationsToMoveError } = await supabase
    .from("reservations")
    .select("id")
    .eq("trip_id", tripId)
    .in("stop_id", selectedStops.map((row) => row.stop_id));
  if (reservationsToMoveError) throw reservationsToMoveError;

  const reservationIdsToMove = (reservationsToMove || []).map((row) => row.id).filter(Boolean);
  if (reservationIdsToMove.length > 0) {
    const { error: moveReservationsError } = await supabase
      .from("reservations")
      .update({ trip_id: createdTrip.id })
      .in("id", reservationIdsToMove);
    if (moveReservationsError) throw moveReservationsError;
  }

  const parentStopsSnapshot = parentStops.map((row) => ({
    stop_id: row.stop_id,
    pickup_time: row.pickup_time,
    order_index: row.order_index,
  }));

  const { error: clearParentStopsError } = await supabase
    .from("trip_stops")
    .delete()
    .eq("trip_id", tripId);
  if (clearParentStopsError) throw clearParentStopsError;

  const { error: restoreParentStopsError } = await supabase
    .from("trip_stops")
    .insert(remainingStops.map((row, index) => ({
      trip_id: tripId,
      stop_id: row.stop_id,
      pickup_time: row.pickup_time,
      order_index: index + 1,
    })));
  if (restoreParentStopsError) throw restoreParentStopsError;

  const { error: activateConfigError } = await supabase
    .from("trip_reinforcement_configs")
    .update({
      active_reinforcement_trip_id: createdTrip.id,
      parent_stops_snapshot: JSON.stringify(parentStopsSnapshot),
    })
    .eq("parent_trip_id", tripId);
  if (activateConfigError) throw activateConfigError;

  try {
    await notifyAdminsReinforcementActivated({
      groupId,
      tripName: trip.name || `Traslado ${tripId}`,
      reinforcementTripName,
      capacity: parentCapacity,
      confirmed: confirmedCount || 0,
      waiting: waitingCount || 0,
    });
  } catch (notifyError) {
    console.error("⚠️ AUTO REINFORCEMENT EMAIL ALERT ERROR:", notifyError);
  }

  return createdTrip.id;
}

async function promoteWaitingPassengersIfNeeded(tripId) {
  const trip = await getTripStatus(tripId);
  if (!trip?.status || trip.status !== "open") {
    return { promotedCount: 0 };
  }

  const waitlistActive = isWaitlistWindowActive(trip);
  if (!waitlistActive) {
    return { promotedCount: 0 };
  }

  const capacity = await getTripCapacity(tripId);
  if (capacity <= 0) {
    return { promotedCount: 0 };
  }

  const { count: confirmed, error: confirmedError } = await supabase
    .from("reservations")
    .select("*", { count: "exact", head: true })
    .eq("trip_id", tripId)
    .eq("status", "confirmed");

  if (confirmedError) {
    throw confirmedError;
  }

  const availableSeats = Math.max(0, capacity - (confirmed || 0));
  if (availableSeats === 0) {
    return { promotedCount: 0 };
  }

  const { data: waitingRows, error: waitingError } = await supabase
    .from("reservations")
    .select("id")
    .eq("trip_id", tripId)
    .eq("status", "waiting")
    .order("id", { ascending: true })
    .limit(availableSeats);

  if (waitingError) {
    throw waitingError;
  }

  const reservationIds = (waitingRows || []).map((row) => row.id).filter(Boolean);
  if (reservationIds.length === 0) {
    return { promotedCount: 0 };
  }

  const schedule = buildNotificationScheduleFromDate(new Date());
  const { error: promoteError } = await supabase
    .from("reservations")
    .update({
      status: "confirmed",
      ...schedule,
    })
    .in("id", reservationIds);

  if (promoteError) {
    throw promoteError;
  }

  return {
    promotedCount: reservationIds.length,
    promotedReservationIds: reservationIds,
  };
}

// ========================
// CREAR RESERVA
// ========================
router.post("/", requirePassengerSession, async (req, res) => {
  try {
    const pauseState = await getPauseState();
    if (pauseState.paused) {
      return res.status(503).json({ error: pauseState.message, paused: true });
    }

    const { tripId, stopId } = req.body;
    const userId = req.passengerUserId;

    if (!userId || !tripId || !stopId) {
      return res.status(400).json({ error: "Missing data" });
    }

    const trip = await getTripStatus(tripId);
    if (!trip?.status) {
      return res.status(404).json({ error: "Trip not found" });
    }

    const [passengerGroupId, tripGroupId] = await Promise.all([
      getPassengerGroupId(userId),
      getTripGroupId(tripId),
    ]);

    if (!passengerGroupId || !tripGroupId || String(passengerGroupId) !== String(tripGroupId)) {
      return res.status(403).json({ error: "No tenés permisos para anotarte en este viaje" });
    }

    if (trip.status !== "open") {
      return res.status(400).json({ error: "Inscripción cerrada" });
    }

    const { data: existing, error: existingError } = await supabase
      .from("reservations")
      .select("id, status, stop_id")
      .eq("trip_id", tripId)
      .eq("user_id", userId)
      .maybeSingle();

    if (existingError) {
      return res.status(500).json({ error: existingError.message });
    }

    if (existing) {
      if (existing.stop_id === stopId) {
        return res.json({ status: existing.status, existing: true });
      }

      const { error: updateError } = await supabase
        .from("reservations")
        .update({ stop_id: stopId })
        .eq("id", existing.id);

      if (updateError) {
        return res.status(500).json({ error: updateError.message });
      }

      return res.json({ status: existing.status, updated: true });
    }

    const { count: confirmed } = await supabase
      .from("reservations")
      .select("*", { count: "exact", head: true })
      .eq("trip_id", tripId)
      .eq("status", "confirmed");

    const capacity = await getTripCapacity(tripId);
    const hasSeats = (confirmed || 0) < capacity;

    const forceWaiting = isWaitlistWindowActive(trip);
    const status = forceWaiting ? "waiting" : hasSeats ? "confirmed" : "waiting";

    const { error } = await supabase
      .from("reservations")
      .insert({
        user_id: userId,
        trip_id: tripId,
        stop_id: stopId,
        status,
      });

    if (error) return res.status(500).json({ error: error.message });

    let autoPromotedCount = 0;
    let autoReinforcementTripId = null;
    if (!forceWaiting && !hasSeats) {
      autoReinforcementTripId = await autoActivateReinforcementIfNeeded({
        tripId,
        trip,
        groupId: tripGroupId,
      });
    }

    if (trip.status === "open") {
      const promotionResult = await promoteWaitingPassengersIfNeeded(tripId);
      autoPromotedCount = promotionResult.promotedCount || 0;
    }

    res.json({ status, autoPromotedCount, autoReinforcementTripId });

  } catch (err) {
    console.error("🔥 RESERVATION ERROR:", err);
    res.status(500).json({ error: "Server exploded" });
  }
});


// ========================
// CANCELAR
// ========================
router.delete("/", requirePassengerSession, async (req, res) => {
  try {
    const { tripId } = req.body;
    const userId = req.passengerUserId;

    if (!tripId || !userId) {
      return res.status(400).json({ error: "Missing data" });
    }

    const [passengerGroupId, tripGroupId] = await Promise.all([
      getPassengerGroupId(userId),
      getTripGroupId(tripId),
    ]);

    if (!passengerGroupId || !tripGroupId || String(passengerGroupId) !== String(tripGroupId)) {
      return res.status(403).json({ error: "No tenés permisos para este viaje" });
    }

    const { data: current, error: currentError } = await supabase
      .from("reservations")
      .select("id, status")
      .eq("trip_id", tripId)
      .eq("user_id", userId)
      .maybeSingle();

    if (currentError) {
      return res.status(500).json({ error: currentError.message });
    }

    if (!current) {
      return res.status(404).json({ error: "Reservation not found" });
    }

    const wasConfirmed = current.status === "confirmed";

    const { error: deleteError } = await supabase
      .from("reservations")
      .delete()
      .eq("id", current.id);

    if (deleteError) {
      return res.status(500).json({ error: deleteError.message });
    }

    let promotedReservationId = null;
    if (wasConfirmed) {
      const { promotedReservationIds } = await promoteWaitingPassengersIfNeeded(tripId);
      promotedReservationId = Array.isArray(promotedReservationIds)
        ? promotedReservationIds[0] || null
        : null;
    }

    return res.json({ success: true, promotedReservationId });

  } catch (err) {
    console.error("🔥 CANCEL ERROR:", err);
    res.status(500).json({ error: "Server exploded" });
  }
});


// ========================
// CAMBIAR PARADA
// ========================
router.put("/change", requirePassengerSession, async (req, res) => {
  try {
    const pauseState = await getPauseState();
    if (pauseState.paused) {
      return res.status(503).json({ error: pauseState.message, paused: true });
    }

    const { tripId, stopId } = req.body;
    const userId = req.passengerUserId;

    if (!tripId || !userId || !stopId) {
      return res.status(400).json({ error: "Missing data" });
    }

    const trip = await getTripStatus(tripId);
    if (!trip?.status) {
      return res.status(404).json({ error: "Trip not found" });
    }

    const [passengerGroupId, tripGroupId] = await Promise.all([
      getPassengerGroupId(userId),
      getTripGroupId(tripId),
    ]);

    if (!passengerGroupId || !tripGroupId || String(passengerGroupId) !== String(tripGroupId)) {
      return res.status(403).json({ error: "No tenés permisos para este viaje" });
    }

    if (trip.status !== "open") {
      return res.status(400).json({ error: "Inscripción cerrada" });
    }

    const { data: current, error: currentError } = await supabase
      .from("reservations")
      .select("id, status")
      .eq("trip_id", tripId)
      .eq("user_id", userId);

    if (currentError) {
      return res.status(500).json({ error: currentError.message });
    }

    if (!current || current.length === 0) {
      return res.status(404).json({ error: "Reservation not found" });
    }

    const reservation = current[0];

    const { error: updateError } = await supabase
      .from("reservations")
      .update({ stop_id: stopId })
      .eq("id", reservation.id);

    if (updateError) return res.status(500).json({ error: updateError.message });

    return res.json({ status: reservation.status });

  } catch (err) {
    console.error("🔥 CHANGE ERROR:", err);
    res.status(500).json({ error: "Server exploded" });
  }
});


// ========================
// MIS RESERVAS (TODOS LOS VIAJES)
// ========================
router.get("/mine", requirePassengerSession, async (req, res) => {
  try {
    const userId = req.passengerUserId;

    if (!userId) {
      return res.status(400).json({ error: "Missing data" });
    }

    const { data, error } = await supabase
      .from("reservations")
      .select("trip_id, stop_id, status")
      .eq("user_id", userId);

    if (error) {
      return res.status(500).json({ error: error.message });
    }

    const reservations = Array.isArray(data) ? data : [];
    if (reservations.length === 0) {
      return res.json([]);
    }

    const tripIds = [...new Set(reservations.map((row) => row.trip_id).filter(Boolean))];
    const stopIds = [...new Set(reservations.map((row) => row.stop_id).filter(Boolean))];

    const [tripsResult, stopsResult, tripStopsResult] = await Promise.all([
      supabase
        .from("trips")
        .select("id, type")
        .in("id", tripIds),
      supabase
        .from("stops")
        .select("id, name")
        .in("id", stopIds),
      supabase
        .from("trip_stops")
        .select("trip_id, stop_id, pickup_time")
        .in("trip_id", tripIds)
        .in("stop_id", stopIds),
    ]);

    if (tripsResult.error) {
      return res.status(500).json({ error: tripsResult.error.message });
    }
    if (stopsResult.error) {
      return res.status(500).json({ error: stopsResult.error.message });
    }
    if (tripStopsResult.error) {
      return res.status(500).json({ error: tripStopsResult.error.message });
    }

    const tripsMap = new Map((tripsResult.data || []).map((trip) => [String(trip.id), trip]));
    const stopsMap = new Map((stopsResult.data || []).map((stop) => [String(stop.id), stop]));
    const tripStopTimeMap = new Map(
      (tripStopsResult.data || []).map((row) => [`${row.trip_id}-${row.stop_id}`, normalizeClockTime(row.pickup_time) || null])
    );

    const result = reservations.map((row) => {
      const trip = tripsMap.get(String(row.trip_id)) || null;
      const stop = stopsMap.get(String(row.stop_id)) || null;
      const stopTime = tripStopTimeMap.get(`${row.trip_id}-${row.stop_id}`) || null;

      return {
        trip_id: row.trip_id,
        stop_id: row.stop_id,
        status: row.status,
        trip_type: trip?.type || null,
        stop_name: stop?.name || null,
        stop_time: stopTime,
      };
    });

    return res.json(result);
  } catch (err) {
    console.error("🔥 MY RESERVATIONS ERROR:", err);
    return res.status(500).json({ error: "Server exploded" });
  }
});


// ========================
// MI RESERVA EN UN VIAJE
// ========================
router.get("/me", requirePassengerSession, async (req, res) => {
  try {
    const { tripId } = req.query;
    const userId = req.passengerUserId;

    if (!tripId || !userId) {
      return res.status(400).json({ error: "Missing data" });
    }

    const [passengerGroupId, tripGroupId] = await Promise.all([
      getPassengerGroupId(userId),
      getTripGroupId(tripId),
    ]);

    if (!passengerGroupId || !tripGroupId || String(passengerGroupId) !== String(tripGroupId)) {
      return res.status(403).json({ error: "No tenés permisos para este viaje" });
    }

    const { data, error } = await supabase
      .from("reservations")
      .select(`
        status,
        stop_id,
        stops (
          name
        )
      `)
      .eq("trip_id", tripId)
      .eq("user_id", userId)
      .maybeSingle();

    if (error) return res.status(500).json({ error: error.message });

    res.json(data);

  } catch (err) {
    console.error("🔥 MY RESERVATION ERROR:", err);
    res.status(500).json({ error: "Server exploded" });
  }
});

router.get("/notifications", requirePassengerSession, async (req, res) => {
  try {
    const userId = req.passengerUserId;

    const { data: reservations, error } = await supabase
      .from("reservations")
      .select("id, trip_id, stop_id, confirm_notify_after, status")
      .eq("user_id", userId)
      .eq("status", "confirmed")
      .is("confirm_notified_at", null)
      .not("confirm_notify_after", "is", null)
      .lte("confirm_notify_after", new Date().toISOString())
      .order("confirm_notify_after", { ascending: true })
      .limit(20);

    if (error) {
      return res.status(500).json({ error: error.message });
    }

    const pending = Array.isArray(reservations) ? reservations : [];
    if (pending.length === 0) {
      return res.json([]);
    }

    const tripIds = [...new Set(pending.map((r) => r.trip_id).filter(Boolean))];
    const stopIds = [...new Set(pending.map((r) => r.stop_id).filter(Boolean))];

    const [tripsResult, stopsResult, tripStopsResult] = await Promise.all([
      supabase
        .from("trips")
        .select("id, type, name")
        .in("id", tripIds),
      supabase
        .from("stops")
        .select("id, name")
        .in("id", stopIds),
      supabase
        .from("trip_stops")
        .select("trip_id, stop_id, pickup_time")
        .in("trip_id", tripIds)
        .in("stop_id", stopIds),
    ]);

    if (tripsResult.error) {
      return res.status(500).json({ error: tripsResult.error.message });
    }
    if (stopsResult.error) {
      return res.status(500).json({ error: stopsResult.error.message });
    }
    if (tripStopsResult.error) {
      return res.status(500).json({ error: tripStopsResult.error.message });
    }

    const tripsMap = new Map((tripsResult.data || []).map((trip) => [String(trip.id), trip]));
    const stopsMap = new Map((stopsResult.data || []).map((stop) => [String(stop.id), stop]));
    const tripStopTimeMap = new Map(
      (tripStopsResult.data || []).map((row) => [`${row.trip_id}-${row.stop_id}`, normalizeClockTime(row.pickup_time) || null])
    );

    const notifications = pending.map((reservation) => {
      const trip = tripsMap.get(String(reservation.trip_id)) || null;
      const stop = stopsMap.get(String(reservation.stop_id)) || null;
      const stopTime = tripStopTimeMap.get(`${reservation.trip_id}-${reservation.stop_id}`) || null;

      return {
        reservationId: reservation.id,
        tripId: reservation.trip_id,
        tripType: trip?.type || null,
        tripName: trip?.name || null,
        stopName: stop?.name || null,
        stopTime,
        status: reservation.status,
      };
    });

    const pendingIds = notifications.map((item) => item.reservationId);
    const { error: markError } = await supabase
      .from("reservations")
      .update({ confirm_notified_at: new Date().toISOString() })
      .in("id", pendingIds);

    if (markError) {
      return res.status(500).json({ error: markError.message });
    }

    return res.json(notifications);
  } catch (err) {
    console.error("🔥 RESERVATION NOTIFICATIONS ERROR:", err);
    return res.status(500).json({ error: "Server exploded" });
  }
});

router.get("/system-status", requirePassengerSession, async (req, res) => {
  try {
    const pauseState = await getPauseState();
    return res.json({
      tripsPaused: pauseState.paused,
      pauseMessage: pauseState.message,
    });
  } catch (err) {
    console.error("🔥 RESERVATIONS SYSTEM STATUS ERROR:", err);
    return res.status(500).json({ error: "Server exploded" });
  }
});

module.exports = router;
