const express = require("express");
const { createClient } = require("@supabase/supabase-js");
const auth = require("../middleware/auth");
const { requireRole } = require("../middleware/roles");
const { requireStaffGroup, assertTripInGroup } = require("../middleware/groupAccess");
const { getTripIdsForGroup } = require("../middleware/groupStore");
const { getSystemFlags, setSystemFlags } = require("../services/systemFlags");

const router = express.Router();

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

function buildNotificationSchedule() {
  const promotedAt = new Date();
  const notifyAfter = new Date(promotedAt.getTime() + 5 * 60 * 1000);

  return {
    waiting_promoted_at: promotedAt.toISOString(),
    confirm_notify_after: notifyAfter.toISOString(),
    confirm_notified_at: null,
  };
}

async function getTripCapacity(tripId) {
  const { data, error } = await supabase
    .from("trip_buses")
    .select("buses ( capacity )")
    .eq("trip_id", tripId);

  if (error) throw error;

  return data?.reduce((sum, row) => sum + (row.buses?.capacity || 0), 0) || 0;
}

router.use(auth, requireRole("admin"), requireStaffGroup);

function profileDisplayName(profile, fallback = null) {
  const normalizedFallback = String(fallback || "").trim();
  const fallbackLooksLikeUuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(normalizedFallback);
  const safeFallback = normalizedFallback && !fallbackLooksLikeUuid ? normalizedFallback : "Sin nombre";

  if (!profile) return safeFallback;
  const fullName = [profile.name, profile.lastname].filter(Boolean).join(" ").trim();
  return fullName || profile.name || profile.lastname || safeFallback;
}

router.get("/system/flags", async (req, res) => {
  try {
    const flags = await getSystemFlags();
    return res.json(flags);
  } catch (err) {
    console.error("🔥 ADMIN FLAGS GET ERROR:", err);
    return res.status(500).json({ error: "Server exploded" });
  }
});

router.put("/system/flags", async (req, res) => {
  try {
    const tripsPaused = req.body?.tripsPaused;
    const pauseMessage = req.body?.pauseMessage;

    const flags = await setSystemFlags({
      ...(tripsPaused !== undefined ? { tripsPaused: Boolean(tripsPaused) } : {}),
      ...(pauseMessage !== undefined ? { pauseMessage: String(pauseMessage || "").trim() || "En mantenimiento, prueba mas tarde" } : {}),
    });

    return res.json(flags);
  } catch (err) {
    console.error("🔥 ADMIN FLAGS PUT ERROR:", err);
    return res.status(500).json({ error: "Server exploded" });
  }
});

router.get("/trips/:tripId/reservations", async (req, res) => {
  try {
    const { tripId } = req.params;
    const { status } = req.query;

    const allowed = await assertTripInGroup(tripId, req.groupId);
    if (!allowed) {
      return res.status(403).json({ error: "No tenés permisos para este viaje" });
    }

    let query = supabase
      .from("reservations")
      .select(`
        id,
        status,
        waiting_promoted_at,
        user_id,
        trip_id,
        stop_id,
        users ( name, phone, description ),
        stops ( name )
      `)
      .eq("trip_id", tripId)
      .order("id", { ascending: true });

    if (status) {
      query = query.eq("status", status);
    }

    const { data, error } = await query;

    if (error) {
      return res.status(500).json({ error: error.message });
    }

    const { data: tripStops, error: tripStopsError } = await supabase
      .from("trip_stops")
      .select("stop_id, order_index")
      .eq("trip_id", tripId);

    if (tripStopsError) {
      return res.status(500).json({ error: tripStopsError.message });
    }

    const stopOrderMap = new Map(
      (tripStops || []).map((row) => [String(row.stop_id), Number(row.order_index || 0)])
    );

    const sorted = [...(data || [])].sort((a, b) => {
      const orderA = stopOrderMap.get(String(a.stop_id)) ?? Number.MAX_SAFE_INTEGER;
      const orderB = stopOrderMap.get(String(b.stop_id)) ?? Number.MAX_SAFE_INTEGER;
      if (orderA !== orderB) return orderA - orderB;
      return Number(a.id || 0) - Number(b.id || 0);
    });

    return res.json(sorted);
  } catch (err) {
    console.error("🔥 ADMIN RESERVATIONS ERROR:", err);
    return res.status(500).json({ error: "Server exploded" });
  }
});

router.post("/trips/:tripId/promote/:reservationId", async (req, res) => {
  try {
    const { tripId, reservationId } = req.params;

    const allowed = await assertTripInGroup(tripId, req.groupId);
    if (!allowed) {
      return res.status(403).json({ error: "No tenés permisos para este viaje" });
    }

    const capacity = await getTripCapacity(tripId);

    const { count: confirmed } = await supabase
      .from("reservations")
      .select("*", { count: "exact", head: true })
      .eq("trip_id", tripId)
      .eq("status", "confirmed");

    if ((confirmed || 0) >= capacity) {
      return res.status(400).json({ error: "No hay cupo disponible" });
    }

    const { data: target, error: targetError } = await supabase
      .from("reservations")
      .select("id, status")
      .eq("id", reservationId)
      .eq("trip_id", tripId)
      .maybeSingle();

    if (targetError) {
      return res.status(500).json({ error: targetError.message });
    }

    if (!target) {
      return res.status(404).json({ error: "Reserva no encontrada" });
    }

    if (target.status !== "waiting") {
      return res.status(400).json({ error: "La reserva ya no está en espera" });
    }

    const schedule = buildNotificationSchedule();

    const { error: promoteError } = await supabase
      .from("reservations")
      .update({
        status: "confirmed",
        ...schedule,
      })
      .eq("id", reservationId);

    if (promoteError) {
      return res.status(500).json({ error: promoteError.message });
    }

    return res.json({ success: true });
  } catch (err) {
    console.error("🔥 ADMIN PROMOTE ERROR:", err);
    return res.status(500).json({ error: "Server exploded" });
  }
});

/**
 * GET /admin/history
 * Lista recorridos realizados.
 */
router.get("/history", async (req, res) => {
  try {
    const allowedTripIds = await getTripIdsForGroup(req.groupId);
    if (allowedTripIds.length === 0) {
      return res.json([]);
    }

    const { data: runs, error } = await supabase
      .from("trip_runs")
      .select("*")
      .in("trip_id", allowedTripIds)
      .not("finished_at", "is", null)
      .order("id", { ascending: false });

    if (error) {
      return res.status(500).json({ error: error.message });
    }

    const tripIds = [...new Set((runs || []).map((r) => r.trip_id).filter(Boolean))];
    const profileIds = [...new Set((runs || []).map((r) => r.taken_by).filter(Boolean))];

    let tripsMap = {};
    if (tripIds.length > 0) {
      const { data: trips, error: tripError } = await supabase
        .from("trips")
        .select("id, name, departure_datetime, type")
        .in("id", tripIds);

      if (tripError) {
        return res.status(500).json({ error: tripError.message });
      }

      tripsMap = (trips || []).reduce((acc, trip) => {
        acc[trip.id] = trip;
        return acc;
      }, {});
    }

    let profilesMap = {};
    if (profileIds.length > 0) {
      const { data: profiles, error: profilesError } = await supabase
        .from("profiles")
        .select("id, name, lastname")
        .in("id", profileIds);

      if (profilesError) {
        return res.status(500).json({ error: profilesError.message });
      }

      profilesMap = (profiles || []).reduce((acc, profile) => {
        acc[profile.id] = profile;
        return acc;
      }, {});
    }

    const result = (runs || []).map((run) => ({
      ...run,
      trip_name: tripsMap[run.trip_id]?.name || null,
      trip_type: tripsMap[run.trip_id]?.type || null,
      trip_departure_datetime: tripsMap[run.trip_id]?.departure_datetime || null,
      started_by_name: profileDisplayName(profilesMap[run.taken_by], "Sin nombre"),
      finished_by_name: profileDisplayName(profilesMap[run.taken_by], "Sin nombre"),
    }));

    res.json(result);

  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Server exploded" });
  }
});

/**
 * GET /admin/history/:runId
 * Detalle del recorrido.
 */
router.get("/history/:runId", async (req, res) => {
  try {
    const { runId } = req.params;

    const { data: run, error: runError } = await supabase
      .from("trip_runs")
      .select("*")
      .eq("id", runId)
      .maybeSingle();

    if (runError) {
      return res.status(500).json({ error: runError.message });
    }

    if (!run) {
      return res.status(404).json({ error: "Run not found" });
    }

    const allowed = await assertTripInGroup(run.trip_id, req.groupId);
    if (!allowed) {
      return res.status(403).json({ error: "No tenés permisos para este recorrido" });
    }

    let trip = null;
    if (run.trip_id) {
      const { data: tripData } = await supabase
        .from("trips")
        .select("id, name, departure_datetime, type")
        .eq("id", run.trip_id)
        .maybeSingle();
      trip = tripData || null;
    }

    let runControllerName = "Sin nombre";
    if (run?.taken_by) {
      const { data: profileData, error: profileError } = await supabase
        .from("profiles")
        .select("id, name, lastname")
        .eq("id", run.taken_by)
        .maybeSingle();

      if (profileError) {
        return res.status(500).json({ error: profileError.message });
      }

      runControllerName = profileDisplayName(profileData, "Sin nombre");
    }

    const { data, error } = await supabase
      .from("trip_run_passengers")
      .select("*")
      .eq("run_id", runId);

    if (error) {
      return res.status(500).json({ error: error.message });
    }

    const passengers = data || [];
    const boarded = passengers.filter((p) => p.boarded).length;
    const missing = passengers.length - boarded;

    res.json({
      run: {
        ...run,
        trip_name: trip?.name || null,
        trip_type: trip?.type || null,
        trip_departure_datetime: trip?.departure_datetime || null,
        started_by_name: runControllerName,
        finished_by_name: runControllerName,
      },
      summary: {
        total: passengers.length,
        boarded,
        missing,
      },
      passengers,
    });

  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Server exploded" });
  }
});

const ExcelJS = require("exceljs");

/**
 * GET /admin/history/:runId/excel
 */
router.get("/history/:runId/excel", async (req, res) => {
  try {
    const { runId } = req.params;

    // info del run
    const { data: run } = await supabase
      .from("trip_runs")
      .select("*")
      .eq("id", runId)
      .single();

    const allowed = await assertTripInGroup(run?.trip_id, req.groupId);
    if (!allowed) {
      return res.status(403).json({ error: "No tenés permisos para este recorrido" });
    }

    // pasajeros
    const { data: passengers } = await supabase
      .from("trip_run_passengers")
      .select("*")
      .eq("run_id", runId);

    const total = passengers.length;
    const yes = passengers.filter(p => p.boarded).length;
    const no = total - yes;

    const workbook = new ExcelJS.Workbook();

    // hoja resumen
    const summary = workbook.addWorksheet("Resumen");

    summary.addRow(["Run", runId]);
    summary.addRow(["Trip", run.trip_id]);
    summary.addRow(["Micro", run.bus_id]);
    summary.addRow(["Fecha", run.finished_at]);
    summary.addRow([]);
    summary.addRow(["Total", total]);
    summary.addRow(["Subieron", yes]);
    summary.addRow(["No subieron", no]);

    // hoja detalle
    const detail = workbook.addWorksheet("Pasajeros");

    detail.addRow(["Nombre", "Teléfono", "Parada", "Subió"]);

    passengers.forEach(p => {
      detail.addRow([
        p.user_name,
        p.phone,
        p.stop_name,
        p.boarded ? "Sí" : "No",
      ]);
    });

    res.setHeader(
      "Content-Type",
      "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
    );

    res.setHeader(
      "Content-Disposition",
      `attachment; filename=run-${runId}.xlsx`
    );

    await workbook.xlsx.write(res);
    res.end();

  } catch (err) {
    console.error("🔥 EXCEL ERROR:", err);
    res.status(500).json({ error: "Server exploded" });
  }
});


module.exports = router;
