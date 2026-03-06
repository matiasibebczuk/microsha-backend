const express = require("express");
const { createClient } = require("@supabase/supabase-js");
const { requirePassengerSession } = require("../middleware/passengerSession");
const { getPassengerGroupId } = require("../middleware/groupAccess");
const { getTripGroupId } = require("../middleware/groupStore");

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

async function getTripStatus(tripId) {
  const { data, error } = await supabase
    .from("trips")
    .select("status, waitlist_start_at, waitlist_end_at")
    .eq("id", tripId)
    .maybeSingle();

  if (error) throw error;
  return data || null;
}

function isWaitlistWindowActive(waitlistStartAt, waitlistEndAt) {
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
    return { promotedCount: 0 };
  }

  const waitlistActive = isWaitlistWindowActive(trip.waitlist_start_at, trip.waitlist_end_at);
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

    const forceWaiting = isWaitlistWindowActive(trip.waitlist_start_at, trip.waitlist_end_at);
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
    if (trip.status === "open") {
      const promotionResult = await promoteWaitingPassengersIfNeeded(tripId);
      autoPromotedCount = promotionResult.promotedCount || 0;
    }

    res.json({ status, autoPromotedCount });

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
      (tripStopsResult.data || []).map((row) => [`${row.trip_id}-${row.stop_id}`, row.pickup_time || null])
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
      (tripStopsResult.data || []).map((row) => [`${row.trip_id}-${row.stop_id}`, row.pickup_time || null])
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

module.exports = router;
