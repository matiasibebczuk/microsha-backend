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
} = require("../middleware/groupStore");
const {
  verifyPassengerToken,
  getPassengerTokenFromRequest,
} = require("../middleware/passengerSession");

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

    return { groupId: String(groupId), mode: "staff", userId: data.user.id };
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



// ========================
// GET /trips
// ========================
router.get("/", async (req, res) => {
  try {
    const context = await resolveRequestGroupId(req);
    if (!context.groupId) {
      return res.status(context.status || 401).json({ error: context.error || "No group context" });
    }

    const allowedTripIds = await getTripIdsForGroup(context.groupId);

    let mergedTripIds = [...allowedTripIds];

    if (context.mode === "staff") {
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
        await Promise.all(unassignedTripIds.map((tripId) => assignTripToGroup(tripId, context.groupId)));
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
        const rpcIds = rpcRows
          .map((row) => Number(row.id))
          .filter((id) => Number.isFinite(id));

        const { data: waitlistRows, error: waitlistError } = await supabase
          .from("trips")
          .select("id, waitlist_start_at, waitlist_end_at")
          .in("id", rpcIds);

        throwIfSupabaseError(waitlistError, "rpc waitlist lookup failed");

        const waitlistMap = new Map(
          (Array.isArray(waitlistRows) ? waitlistRows : []).map((row) => [
            Number(row.id),
            {
              start: row.waitlist_start_at || null,
              end: row.waitlist_end_at || null,
            },
          ])
        );

        const rpcResult = rpcRows.map((row) => {
          const waitlistRange = waitlistMap.get(Number(row.id)) || { start: null, end: null };
          const waitlistStartAt = waitlistRange.start;
          const waitlistEndAt = waitlistRange.end;
          const waitlistActive = isWaitlistWindowActive(waitlistStartAt, waitlistEndAt);

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
            first_time: row.first_time || null,
            active_started_at: row.active_started_at || null,
            last_finished_at: row.last_finished_at || null,
            waitlist_start_at: waitlistStartAt,
            waitlist_end_at: waitlistEndAt,
          };
        });

        return res.json(rpcResult);
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
    ] = await Promise.all([
      supabase
        .from("trips")
        .select("id, name, type, departure_datetime, status, waitlist_start_at, waitlist_end_at")
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
    ]);

    throwIfSupabaseError(tripsResult.error, "trips query failed");
    throwIfSupabaseError(reservationsResult.error, "reservations summary query failed");
    throwIfSupabaseError(capacitiesResult.error, "capacity query failed");
    throwIfSupabaseError(firstStopsResult.error, "first stop query failed");
    throwIfSupabaseError(runsResult.error, "runs query failed");

    const trips = Array.isArray(tripsResult.data) ? tripsResult.data : [];
    const reservations = Array.isArray(reservationsResult.data) ? reservationsResult.data : [];
    const capacities = Array.isArray(capacitiesResult.data) ? capacitiesResult.data : [];
    const firstStops = Array.isArray(firstStopsResult.data) ? firstStopsResult.data : [];
    const runs = Array.isArray(runsResult.data) ? runsResult.data : [];

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
    for (const row of capacities) {
      const key = String(row.trip_id);
      const current = capacityMap.get(key) || 0;
      capacityMap.set(key, current + (row.buses?.capacity || 0));
    }

    const firstStopMap = new Map();
    for (const row of firstStops) {
      const key = String(row.trip_id);
      if (!firstStopMap.has(key)) {
        firstStopMap.set(key, row.pickup_time || null);
      }
    }

    const activeRunMap = new Map();
    const finishedRunMap = new Map();

    for (const row of runs) {
      const key = String(row.trip_id);

      if (row.finished_at === null && !activeRunMap.has(key)) {
        activeRunMap.set(key, row.started_at || null);
      }

      if (row.finished_at !== null && !finishedRunMap.has(key)) {
        finishedRunMap.set(key, row.finished_at || null);
      }
    }

    const result = trips.map((trip) => {
      const key = String(trip.id);
      const counts = reservationMap.get(key) || { confirmed: 0, waiting: 0 };
      const capacity = capacityMap.get(key) || 0;
      const waitlistActive = isWaitlistWindowActive(trip.waitlist_start_at, trip.waitlist_end_at);

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
        first_time: firstStopMap.get(key) || null,
        active_started_at: activeRunMap.get(key) || null,
        last_finished_at: finishedRunMap.get(key) || null,
        waitlist_start_at: trip.waitlist_start_at || null,
        waitlist_end_at: trip.waitlist_end_at || null,
      };
    });

    // Recommended DB indexes for cloud scale (create in Supabase SQL editor):
    // 1) CREATE INDEX IF NOT EXISTS idx_reservations_trip_status ON reservations (trip_id, status);
    // 2) CREATE INDEX IF NOT EXISTS idx_trip_buses_trip_id ON trip_buses (trip_id);
    // 3) CREATE INDEX IF NOT EXISTS idx_trip_stops_trip_order ON trip_stops (trip_id, order_index);
    // 4) CREATE INDEX IF NOT EXISTS idx_trip_runs_trip_finished_id ON trip_runs (trip_id, finished_at, id DESC);

    return res.json(result);

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

    const { data, error } = await supabase
      .from("trip_stops")
      .select(`
        stop_id,
        pickup_time,
        order_index,
        stops (
          id,
          name
        )
      `)
      .eq("trip_id", tripId)
      .order("order_index");

    if (error) return res.status(500).json({ error: error.message });

    const result = data.map(s => ({
      id: s.stop_id,
      name: s.stops.name,
      time: s.pickup_time,
      order: s.order_index
    }));

    res.json(result);

  } catch (err) {
    console.error("🔥 STOPS ERROR:", err);
    res.status(500).json({ error: "Server exploded" });
  }
});



// ========================
// POST /trips (crear)
// ========================
router.post("/", auth, requireRole("admin"), requireStaffGroup, async (req, res) => {
  try {
    const { name, type, departure_datetime, waitlist_start_at, waitlist_end_at } = req.body;

    const payload = {
      name,
      type,
      status: "open",
      departure_datetime: departure_datetime || new Date().toISOString(),
    };

    if (waitlist_start_at !== undefined) {
      payload.waitlist_start_at = waitlist_start_at || null;
    }
    if (waitlist_end_at !== undefined) {
      payload.waitlist_end_at = waitlist_end_at || null;
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
        pickup_time: time,
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
      time: String(stop?.time || "").trim(),
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
    const { name, type, departure_datetime, waitlist_start_at, waitlist_end_at } = req.body;

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
    return res.status(500).json({ error: "Server exploded" });
  }
});



// ========================
// EXPORT (SIEMPRE AL FINAL)
// ========================
module.exports = router;
