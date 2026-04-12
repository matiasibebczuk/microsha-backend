const express = require("express");
const { createClient } = require("@supabase/supabase-js");
const auth = require("../middleware/auth");
const { requireRole } = require("../middleware/roles");
const { requireStaffGroup, assertTripInGroup } = require("../middleware/groupAccess");
const { getTripIdsForGroup } = require("../middleware/groupStore");
const { getSystemFlags, setSystemFlags } = require("../services/systemFlags");
const { isSanctionsEnabled } = require("../config/featureFlags");
const { sendAdminTestEmail } = require("../services/reinforcementNotifications");

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

function authUserDisplayName(authUser, fallback = "Sin nombre") {
  const name = String(authUser?.user_metadata?.name || authUser?.raw_user_meta_data?.name || "").trim();
  const lastname = String(authUser?.user_metadata?.lastname || authUser?.raw_user_meta_data?.lastname || "").trim();
  const email = String(authUser?.email || "").trim();
  const fullName = [name, lastname].filter(Boolean).join(" ").trim();
  if (fullName) return fullName;
  if (name) return name;
  if (email) return email;
  return fallback;
}

async function resolveControllerName(takenBy) {
  const id = String(takenBy || "").trim();
  if (!id) return "Sin nombre";

  const { data: profileData, error: profileError } = await supabase
    .from("profiles")
    .select("id, name, lastname")
    .eq("id", id)
    .maybeSingle();
  if (!profileError) {
    const profileName = profileDisplayName(profileData, "");
    if (profileName && profileName !== "Sin nombre") return profileName;
  }

  const { data: byAuthUser, error: byAuthError } = await supabase
    .from("users")
    .select("name")
    .eq("auth_user_id", id)
    .maybeSingle();
  if (!byAuthError && String(byAuthUser?.name || "").trim()) {
    return String(byAuthUser.name).trim();
  }

  const { data: authData, error: authError } = await supabase.auth.admin.getUserById(id);
  if (!authError && authData?.user) {
    return authUserDisplayName(authData.user, "Sin nombre");
  }

  return "Sin nombre";
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
    const scheduledPauseEnabled = req.body?.scheduledPauseEnabled;
    const scheduledPauseDay = req.body?.scheduledPauseDay;
    const scheduledPauseTime = req.body?.scheduledPauseTime;
    const scheduledOpenEnabled = req.body?.scheduledOpenEnabled;
    const scheduledOpenDay = req.body?.scheduledOpenDay;
    const scheduledOpenTime = req.body?.scheduledOpenTime;

    const flags = await setSystemFlags({
      ...(tripsPaused !== undefined ? { tripsPaused: Boolean(tripsPaused) } : {}),
      ...(pauseMessage !== undefined ? { pauseMessage: String(pauseMessage || "").trim() || "Traslados pausados, a partir del jueves a las 18hs podras anotarte en lista de espera" } : {}),
      ...(scheduledPauseEnabled !== undefined ? { scheduledPauseEnabled: Boolean(scheduledPauseEnabled) } : {}),
      ...(scheduledPauseDay !== undefined ? { scheduledPauseDay } : {}),
      ...(scheduledPauseTime !== undefined ? { scheduledPauseTime } : {}),
      ...(scheduledOpenEnabled !== undefined ? { scheduledOpenEnabled: Boolean(scheduledOpenEnabled) } : {}),
      ...(scheduledOpenDay !== undefined ? { scheduledOpenDay } : {}),
      ...(scheduledOpenTime !== undefined ? { scheduledOpenTime } : {}),
    });

    return res.json(flags);
  } catch (err) {
    console.error("🔥 ADMIN FLAGS PUT ERROR:", err);
    return res.status(500).json({ error: "Server exploded" });
  }
});

router.post("/test-email", async (req, res) => {
  try {
    const label = String(req.body?.label || "").trim();
    const result = await sendAdminTestEmail({
      groupId: req.groupId,
      label,
    });

    if (!result?.sent) {
      return res.status(503).json({
        success: false,
        reason: result?.reason || "send_failed",
        to: Array.isArray(result?.to) ? result.to : [],
      });
    }

    return res.json({
      success: true,
      to: Array.isArray(result?.to) ? result.to : [],
    });
  } catch (err) {
    console.error("🔥 ADMIN TEST EMAIL ERROR:", err);
    return res.status(500).json({
      error: err?.message || "Server exploded",
      reason: "test_email_failed",
    });
  }
});

router.get("/sanctions", async (req, res) => {
  try {
    if (!isSanctionsEnabled()) {
      return res.json([]);
    }

    const nowIso = new Date().toISOString();
    const expectedGroupId = String(req.groupId || "").trim();

    const { data, error } = await supabase
      .from("users")
      .select("id, name, role, dni, member_number, phone, group_number, organization_id, suspended_until, suspension_reason, suspension_origin, suspension_created_at")
      .not("suspended_until", "is", null)
      .gt("suspended_until", nowIso)
      .order("suspended_until", { ascending: true })
      .limit(500);

    if (error) return res.status(500).json({ error: error.message });

    const rows = (Array.isArray(data) ? data : []).filter((row) => {
      const role = String(row?.role || "").trim().toLowerCase();
      if (role === "admin" || role === "encargado") return false;

      const groupId = String(row?.group_number ?? row?.organization_id ?? "").trim();
      // Some legacy users have empty group fields; allow them so sanctions search remains usable.
      if (!groupId) return true;
      return groupId === expectedGroupId;
    });

    return res.json(rows);
  } catch (err) {
    console.error("🔥 ADMIN SANCTIONS LIST ERROR:", err);
    return res.status(500).json({ error: "Server exploded" });
  }
});

router.get("/sanctions/search", async (req, res) => {
  try {
    if (!isSanctionsEnabled()) {
      return res.json([]);
    }

    const q = String(req.query?.q || "").trim();
    if (!q) return res.json([]);

    const safeQ = q.replace(/[%_]/g, "");
    const expectedGroupId = String(req.groupId || "").trim();
    const nowIso = new Date().toISOString();

    const { data, error } = await supabase
      .from("users")
      .select("id, name, role, dni, member_number, phone, no_show_streak, suspended_until, suspension_reason, group_number, organization_id")
      .or(`name.ilike.%${safeQ}%,dni.ilike.%${safeQ}%,member_number.ilike.%${safeQ}%`)
      .order("name", { ascending: true })
      .limit(200);

    if (error) return res.status(500).json({ error: error.message });

    const rows = (Array.isArray(data) ? data : [])
      .filter((row) => {
        const groupId = String(row?.group_number ?? row?.organization_id ?? "").trim();
        if (groupId && groupId !== expectedGroupId) return false;
        const role = String(row?.role || "").trim().toLowerCase();
        return role !== "admin" && role !== "encargado";
      })
      .slice(0, 50)
      .map((row) => ({
        ...row,
        is_suspended: Boolean(row?.suspended_until && new Date(row.suspended_until).getTime() > Date.now()),
        suspended_now: Boolean(row?.suspended_until && new Date(row.suspended_until).getTime() > Date.now()),
        now_iso: nowIso,
      }));

    return res.json(rows);
  } catch (err) {
    console.error("🔥 ADMIN SANCTIONS SEARCH ERROR:", err);
    return res.status(500).json({ error: "Server exploded" });
  }
});

router.post("/sanctions", async (req, res) => {
  try {
    if (!isSanctionsEnabled()) {
      return res.json({ success: true, disabled: true });
    }

    const userId = String(req.body?.userId || "").trim();
    const days = Number(req.body?.days || 7);
    const reason = String(req.body?.reason || "Sanción manual").trim() || "Sanción manual";

    if (!userId) {
      return res.status(400).json({ error: "userId inválido" });
    }

    if (!Number.isFinite(days) || days <= 0 || days > 60) {
      return res.status(400).json({ error: "days inválido" });
    }

    const { data: user, error: userError } = await supabase
      .from("users")
      .select("id, role, group_number, organization_id")
      .eq("id", userId)
      .maybeSingle();

    if (userError) return res.status(500).json({ error: userError.message });
    const role = String(user?.role || "").trim().toLowerCase();
    const userGroup = String(user?.group_number ?? user?.organization_id ?? "").trim();
    const expectedGroupId = String(req.groupId || "").trim();
    if (!user || role === "admin" || role === "encargado" || (userGroup && userGroup !== expectedGroupId)) {
      return res.status(404).json({ error: "Pasajero no encontrado" });
    }

    const now = new Date();
    const until = new Date(now.getTime() + days * 24 * 60 * 60 * 1000);

    const { data: updated, error: updateError } = await supabase
      .from("users")
      .update({
        suspended_until: until.toISOString(),
        suspension_reason: reason,
        suspension_origin: "manual",
        suspension_created_at: now.toISOString(),
        no_show_streak: 0,
      })
      .eq("id", userId)
      .select("id, suspended_until, suspension_reason, suspension_origin")
      .single();

    if (updateError) return res.status(500).json({ error: updateError.message });
    return res.json(updated);
  } catch (err) {
    console.error("🔥 ADMIN SANCTIONS CREATE ERROR:", err);
    return res.status(500).json({ error: "Server exploded" });
  }
});

router.delete("/sanctions/:userId", async (req, res) => {
  try {
    if (!isSanctionsEnabled()) {
      return res.json({ success: true, disabled: true });
    }

    const userId = String(req.params.userId || "").trim();
    if (!userId) {
      return res.status(400).json({ error: "userId inválido" });
    }

    const { data: user, error: userError } = await supabase
      .from("users")
      .select("id, role, group_number, organization_id")
      .eq("id", userId)
      .maybeSingle();

    if (userError) return res.status(500).json({ error: userError.message });
    const role = String(user?.role || "").trim().toLowerCase();
    const userGroup = String(user?.group_number ?? user?.organization_id ?? "").trim();
    const expectedGroupId = String(req.groupId || "").trim();
    if (!user || role === "admin" || role === "encargado" || (userGroup && userGroup !== expectedGroupId)) {
      return res.status(404).json({ error: "Pasajero no encontrado" });
    }

    const { error: updateError } = await supabase
      .from("users")
      .update({
        suspended_until: null,
        suspension_reason: null,
        suspension_origin: null,
        suspension_created_at: null,
        no_show_streak: 0,
      })
      .eq("id", userId);

    if (updateError) return res.status(500).json({ error: updateError.message });
    return res.json({ success: true });
  } catch (err) {
    console.error("🔥 ADMIN SANCTIONS DELETE ERROR:", err);
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
function isMissingTableError(error) {
  if (!error) return false;
  if (error.code === "42P01") return true;
  const message = String(error.message || "").toLowerCase();
  return message.includes("does not exist") || message.includes("relation") || message.includes("tabla");
}

function parseHistoryRunParam(rawRunId) {
  const value = String(rawRunId || "").trim();
  if (!value) return { kind: "auto", id: null };
  if (value.startsWith("history-")) {
    const id = Number(value.slice("history-".length));
    return { kind: "history", id: Number.isFinite(id) ? id : null };
  }
  if (value.startsWith("legacy-")) {
    const id = Number(value.slice("legacy-".length));
    return { kind: "legacy", id: Number.isFinite(id) ? id : null };
  }
  const id = Number(value);
  return { kind: "auto", id: Number.isFinite(id) ? id : null };
}

async function buildControllerNameMap(runs) {
  const map = {};
  const profileIds = [...new Set((runs || []).map((r) => String(r?.taken_by || "")).filter(Boolean))];
  for (const controllerId of profileIds) {
    map[controllerId] = await resolveControllerName(controllerId);
  }
  return map;
}

async function loadNewHistoryRuns(groupId) {
  const { data, error } = await supabase
    .from("trip_history_runs")
    .select("*")
    .eq("group_id", String(groupId || ""))
    .order("finished_at", { ascending: false })
    .order("id", { ascending: false });

  if (error) {
    if (isMissingTableError(error)) return [];
    throw error;
  }

  const rows = Array.isArray(data) ? data : [];
  const nameMap = await buildControllerNameMap(rows);
  return rows.map((run) => ({
    ...run,
    id: `history-${run.id}`,
    started_by_name: nameMap[String(run.taken_by || "")] || "Sin nombre",
    finished_by_name: nameMap[String(run.taken_by || "")] || "Sin nombre",
  }));
}

async function loadLegacyHistoryRuns(groupId, skipSourceRunIds = new Set()) {
  const allowedTripIds = await getTripIdsForGroup(groupId);
  if (allowedTripIds.length === 0) return [];

  const { data: runs, error } = await supabase
    .from("trip_runs")
    .select("*")
    .in("trip_id", allowedTripIds)
    .not("finished_at", "is", null)
    .order("id", { ascending: false });

  if (error) throw error;

  const filteredRuns = (runs || []).filter((run) => !skipSourceRunIds.has(Number(run?.id || 0)));
  if (filteredRuns.length === 0) return [];

  const tripIds = [...new Set(filteredRuns.map((r) => r.trip_id).filter(Boolean))];
  let tripsMap = {};
  if (tripIds.length > 0) {
    const { data: trips, error: tripError } = await supabase
      .from("trips")
      .select("id, name, departure_datetime, type")
      .in("id", tripIds);

    if (tripError) throw tripError;

    tripsMap = (trips || []).reduce((acc, trip) => {
      acc[trip.id] = trip;
      return acc;
    }, {});
  }

  const nameMap = await buildControllerNameMap(filteredRuns);

  return filteredRuns.map((run) => ({
    ...run,
    id: `legacy-${run.id}`,
    trip_name: tripsMap[run.trip_id]?.name || null,
    trip_type: tripsMap[run.trip_id]?.type || null,
    trip_departure_datetime: tripsMap[run.trip_id]?.departure_datetime || null,
    started_by_name: nameMap[String(run.taken_by || "")] || "Sin nombre",
    finished_by_name: nameMap[String(run.taken_by || "")] || "Sin nombre",
  }));
}

router.get("/history", async (req, res) => {
  try {
    const newRuns = await loadNewHistoryRuns(req.groupId);
    const skipSourceRunIds = new Set(
      newRuns.map((run) => Number(run?.source_run_id || 0)).filter((id) => Number.isFinite(id) && id > 0)
    );
    const legacyRuns = await loadLegacyHistoryRuns(req.groupId, skipSourceRunIds);

    const result = [...newRuns, ...legacyRuns].sort((a, b) => {
      const aTime = new Date(a?.finished_at || 0).getTime();
      const bTime = new Date(b?.finished_at || 0).getTime();
      if (aTime !== bTime) return bTime - aTime;
      return String(b?.id || "").localeCompare(String(a?.id || ""));
    });

    return res.json(result);
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: "Server exploded" });
  }
});

/**
 * GET /admin/history/:runId
 * Detalle del recorrido.
 */
router.get("/history/:runId", async (req, res) => {
  try {
    const parsed = parseHistoryRunParam(req.params.runId);
    if (!parsed.id) {
      return res.status(400).json({ error: "runId inválido" });
    }

    const tryHistoryFirst = parsed.kind === "history" || parsed.kind === "auto";
    if (tryHistoryFirst) {
      const { data: historyRun, error: historyRunError } = await supabase
        .from("trip_history_runs")
        .select("*")
        .eq("id", parsed.id)
        .eq("group_id", String(req.groupId || ""))
        .maybeSingle();

      if (historyRunError && !isMissingTableError(historyRunError)) {
        return res.status(500).json({ error: historyRunError.message });
      }

      if (historyRun) {
        const runControllerName = await resolveControllerName(historyRun?.taken_by);
        const { data: historyPassengers, error: passengersError } = await supabase
          .from("trip_history_passengers")
          .select("*")
          .eq("history_run_id", historyRun.id)
          .order("id", { ascending: true });

        if (passengersError && !isMissingTableError(passengersError)) {
          return res.status(500).json({ error: passengersError.message });
        }

        const passengers = Array.isArray(historyPassengers) ? historyPassengers : [];
        const boarded = passengers.filter((p) => p.boarded).length;
        const missing = passengers.filter((p) => !p.boarded && p.status === "confirmed").length;

        return res.json({
          run: {
            ...historyRun,
            id: `history-${historyRun.id}`,
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
      }
    }

    const tryLegacy = parsed.kind === "legacy" || parsed.kind === "auto";
    if (!tryLegacy) {
      return res.status(404).json({ error: "Run not found" });
    }

    const { data: run, error: runError } = await supabase
      .from("trip_runs")
      .select("*")
      .eq("id", parsed.id)
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

    const runControllerName = await resolveControllerName(run?.taken_by);

    const { data, error } = await supabase
      .from("trip_run_passengers")
      .select("*")
      .eq("run_id", parsed.id);

    if (error) {
      return res.status(500).json({ error: error.message });
    }

    const passengers = data || [];
    const boarded = passengers.filter((p) => p.boarded).length;
    const missing = passengers.length - boarded;

    return res.json({
      run: {
        ...run,
        id: `legacy-${run.id}`,
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
    return res.status(500).json({ error: "Server exploded" });
  }
});

const ExcelJS = require("exceljs");

/**
 * GET /admin/history/:runId/excel
 */
router.get("/history/:runId/excel", async (req, res) => {
  try {
    const parsed = parseHistoryRunParam(req.params.runId);
    if (!parsed.id) {
      return res.status(400).json({ error: "runId inválido" });
    }

    let run = null;
    let passengers = [];

    const tryHistoryFirst = parsed.kind === "history" || parsed.kind === "auto";
    if (tryHistoryFirst) {
      const { data: historyRun, error: historyRunError } = await supabase
        .from("trip_history_runs")
        .select("*")
        .eq("id", parsed.id)
        .eq("group_id", String(req.groupId || ""))
        .maybeSingle();

      if (historyRunError && !isMissingTableError(historyRunError)) {
        return res.status(500).json({ error: historyRunError.message });
      }

      if (historyRun) {
        run = historyRun;
        const { data: historyPassengers, error: historyPassengersError } = await supabase
          .from("trip_history_passengers")
          .select("*")
          .eq("history_run_id", historyRun.id)
          .order("id", { ascending: true });

        if (historyPassengersError && !isMissingTableError(historyPassengersError)) {
          return res.status(500).json({ error: historyPassengersError.message });
        }
        passengers = Array.isArray(historyPassengers) ? historyPassengers : [];
      }
    }

    if (!run) {
      const { data: legacyRun, error: runError } = await supabase
        .from("trip_runs")
        .select("*")
        .eq("id", parsed.id)
        .maybeSingle();

      if (runError) {
        return res.status(500).json({ error: runError.message });
      }

      if (!legacyRun) {
        return res.status(404).json({ error: "Run not found" });
      }

      const allowed = await assertTripInGroup(legacyRun?.trip_id, req.groupId);
      if (!allowed) {
        return res.status(403).json({ error: "No tenés permisos para este recorrido" });
      }

      run = legacyRun;

      const { data: legacyPassengers, error: passengersError } = await supabase
        .from("trip_run_passengers")
        .select("*")
        .eq("run_id", parsed.id)
        .order("id", { ascending: true });

      if (passengersError) {
        return res.status(500).json({ error: passengersError.message });
      }
      passengers = Array.isArray(legacyPassengers) ? legacyPassengers : [];
    }

    const total = passengers.length;
    const yes = passengers.filter(p => p.boarded).length;
    const no = total - yes;

    const workbook = new ExcelJS.Workbook();

    // hoja resumen
    const summary = workbook.addWorksheet("Resumen");

    summary.addRow(["Run", req.params.runId]);
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
      `attachment; filename=run-${req.params.runId}.xlsx`
    );

    await workbook.xlsx.write(res);
    res.end();

  } catch (err) {
    console.error("🔥 EXCEL ERROR:", err);
    res.status(500).json({ error: "Server exploded" });
  }
});


router.post("/users", async (req, res) => {
  try {
    const lastname = String(req.body?.lastname || "").trim();
    const firstname = String(req.body?.firstname || "").trim();
    const dni = String(req.body?.dni || "").trim();
    const memberNumber = String(req.body?.memberNumber ?? "").trim();

    if (!lastname) return res.status(400).json({ error: "Apellido requerido" });
    if (!firstname) return res.status(400).json({ error: "Nombre requerido" });
    if (!dni) return res.status(400).json({ error: "DNI requerido" });

    const validMember = memberNumber === "0" || /^\d{6}$/.test(memberNumber);
    if (!validMember) return res.status(400).json({ error: "Número de socio debe ser 0 o un número de 6 dígitos" });

    const fullName = `${lastname.toUpperCase()} ${firstname.toUpperCase()}`;

    const { data: existing, error: existingError } = await supabase
      .from("users")
      .select("id")
      .eq("dni", dni)
      .maybeSingle();

    if (existingError) return res.status(500).json({ error: existingError.message });
    if (existing) return res.status(409).json({ error: "Ya existe un usuario con ese DNI" });

    const { data: created, error: createError } = await supabase
      .from("users")
      .insert({
        name: fullName,
        dni,
        role: "pasajero",
        group_number: 1926,
        member_number: memberNumber,
      })
      .select("id, name, dni, role, group_number, member_number")
      .single();

    if (createError) return res.status(500).json({ error: createError.message });
    return res.status(201).json(created);
  } catch (err) {
    console.error("🔥 ADMIN CREATE USER ERROR:", err);
    return res.status(500).json({ error: "Server exploded" });
  }
});

router.get("/users/search", async (req, res) => {
  try {
    const q = String(req.query?.q || "").trim();
    if (!q) return res.status(400).json({ error: "Parámetro de búsqueda requerido" });

    const { data, error } = await supabase
      .from("users")
      .select("id, name, dni, member_number, role, group_number")
      .or(`name.ilike.%${q}%,dni.eq.${isNaN(q) ? -1 : q},member_number.eq.${isNaN(q) ? -1 : q}`)
      .eq("role", "pasajero")
      .limit(10);

    if (error) return res.status(500).json({ error: error.message });
    return res.json(data || []);
  } catch (err) {
    console.error("🔥 ADMIN SEARCH USER ERROR:", err);
    return res.status(500).json({ error: "Server exploded" });
  }
});

router.delete("/trips/:tripId/reservations", async (req, res) => {
  try {
    const tripId = Number(req.params.tripId);
    if (!Number.isFinite(tripId)) return res.status(400).json({ error: "tripId inválido" });

    const { error } = await supabase
      .from("reservations")
      .delete()
      .eq("trip_id", tripId);

    if (error) return res.status(500).json({ error: error.message });
    return res.json({ ok: true });
  } catch (err) {
    console.error("🔥 CLEAR RESERVATIONS ERROR:", err);
    return res.status(500).json({ error: "Server exploded" });
  }
});

module.exports = router;
