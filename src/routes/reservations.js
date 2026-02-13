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
    .select("status")
    .eq("id", tripId)
    .maybeSingle();

  if (error) throw error;
  return data?.status || null;
}

async function promoteWaitingPassenger(tripId) {
  const capacity = await getTripCapacity(tripId);

  if (capacity <= 0) {
    return null;
  }

  const { count: confirmed } = await supabase
    .from("reservations")
    .select("*", { count: "exact", head: true })
    .eq("trip_id", tripId)
    .eq("status", "confirmed");

  if ((confirmed || 0) >= capacity) {
    return null;
  }

  const { data: waiting, error: waitingError } = await supabase
    .from("reservations")
    .select("id")
    .eq("trip_id", tripId)
    .eq("status", "waiting")
    .order("id", { ascending: true })
    .limit(1);

  if (waitingError) throw waitingError;

  if (!waiting || waiting.length === 0) {
    return null;
  }

  const nextReservationId = waiting[0].id;

  const { error: promoteError } = await supabase
    .from("reservations")
    .update({ status: "confirmed" })
    .eq("id", nextReservationId);

  if (promoteError) throw promoteError;

  return nextReservationId;
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

    const tripStatus = await getTripStatus(tripId);
    if (!tripStatus) {
      return res.status(404).json({ error: "Trip not found" });
    }

    const [passengerGroupId, tripGroupId] = await Promise.all([
      getPassengerGroupId(userId),
      getTripGroupId(tripId),
    ]);

    if (!passengerGroupId || !tripGroupId || String(passengerGroupId) !== String(tripGroupId)) {
      return res.status(403).json({ error: "No tenés permisos para anotarte en este viaje" });
    }

    if (tripStatus !== "open") {
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

    const status = hasSeats ? "confirmed" : "waiting";

    const { error } = await supabase
      .from("reservations")
      .insert({
        user_id: userId,
        trip_id: tripId,
        stop_id: stopId,
        status,
      });

    if (error) return res.status(500).json({ error: error.message });

    res.json({ status });

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
      promotedReservationId = await promoteWaitingPassenger(tripId);
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

    const tripStatus = await getTripStatus(tripId);
    if (!tripStatus) {
      return res.status(404).json({ error: "Trip not found" });
    }

    const [passengerGroupId, tripGroupId] = await Promise.all([
      getPassengerGroupId(userId),
      getTripGroupId(tripId),
    ]);

    if (!passengerGroupId || !tripGroupId || String(passengerGroupId) !== String(tripGroupId)) {
      return res.status(403).json({ error: "No tenés permisos para este viaje" });
    }

    if (tripStatus !== "open") {
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

module.exports = router;
