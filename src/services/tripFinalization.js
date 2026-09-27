const { createClient } = require("@supabase/supabase-js");
const fs = require("fs");
const path = require("path");
const { getLastFriday20Iso } = require("../utils/fridayWindow");
const { getNextScheduleActivationIso } = require("../utils/scheduleTime");
const { notifyAdminsTripFinishedSummary } = require("./reinforcementNotifications");
const { getSystemFlags, setSystemFlags } = require("./systemFlags");

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

const logsDir = path.join(__dirname, "..", "..", "logs");
const cancellationsLogPath = path.join(logsDir, "reservation-cancellations.jsonl");

async function getTripById(tripId) {
  const { data, error } = await supabase
    .from("trips")
    .select("*")
    .eq("id", tripId)
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

async function upsertLocationSession(tripId, payload) {
  const { error } = await supabase
    .from("trip_location_sessions")
    .upsert({
      trip_id: Number(tripId),
      updated_at: new Date().toISOString(),
      ...payload,
    }, { onConflict: "trip_id" });

  if (error && error.code !== "42P01" && !String(error.message || "").toLowerCase().includes("does not exist")) {
    console.warn("⚠️ LOCATION SESSION UPSERT ERROR:", error.message);
  }
}

async function cleanupForcedReinforcementAfterFinish(parentTripId) {
  const { data: config, error: configError } = await supabase
    .from("trip_reinforcement_configs")
    .select("active_reinforcement_trip_id, parent_stops_snapshot")
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

async function performPostCleanup({ tripId, trip, finishedAt }) {
  // 1. Eliminar reservas del viaje
  const { error: cleanupError } = await supabase
    .from("reservations")
    .delete()
    .eq("trip_id", tripId);

  if (cleanupError) {
    console.error("⚠️ RESERVATIONS CLEANUP ERROR:", cleanupError);
  }

  // 2. Limpiar refuerzo forzado si existe
  try {
    await cleanupForcedReinforcementAfterFinish(tripId);
  } catch (reinfErr) {
    console.error("⚠️ REINFORCEMENT CLEANUP ERROR:", reinfErr);
  }

  // 3. Suspender/procesar lista de espera si corresponde
  try {
    const hasWaitlistSchedule =
      trip?.waitlist_start_day !== null &&
      trip?.waitlist_start_day !== undefined &&
      trip?.waitlist_start_time;

    if (hasWaitlistSchedule) {
      const suspendUntil = getNextScheduleActivationIso(trip.waitlist_start_day, trip.waitlist_start_time);
      if (suspendUntil) {
        await supabase
          .from("trips")
          .update({ waitlist_end_at: suspendUntil })
          .eq("id", tripId);
      }
    }
  } catch (waitlistErr) {
    console.error("⚠️ WAITLIST CLEANUP ERROR:", waitlistErr);
  }

  // 4. Detener sesión de ubicación en tiempo real
  try {
    await upsertLocationSession(tripId, {
      active: false,
      stopped_at: finishedAt || new Date().toISOString(),
    });
  } catch (locationErr) {
    console.warn("⚠️ LOCATION CLEANUP ERROR:", locationErr?.message || locationErr);
  }

  // 5. Resetear flags temporales de capacidad/bloqueo de paradas
  try {
    const currentFlags = await getSystemFlags();
    const originals = currentFlags?.busOriginalCapacities;
    if (originals && typeof originals === "object") {
      await Promise.all(
        Object.entries(originals).map(([busId, cap]) =>
          supabase.from("buses").update({ capacity: Number(cap) }).eq("id", Number(busId))
        )
      );
    }
    await setSystemFlags({ stopBlockActive: false, busCapacityOverride: null, busOriginalCapacities: null });
  } catch (flagErr) {
    console.warn("⚠️ FLAGS RESET ERROR:", flagErr?.message || flagErr);
  }
}

async function callFinalizeTripRun(runId, source) {
  let { data, error } = await supabase.rpc("finalize_trip_run", {
    p_run_id: Number(runId),
    p_source: String(source),
  });

  if (error && (error.message?.includes("parameter") || error.code === "42883")) {
    const fallback = await supabase.rpc("finalize_trip_run", {
      run_id: Number(runId),
      source: String(source),
    });
    data = fallback.data;
    error = fallback.error;
  }

  if (error) {
    console.error("⚠️ RPC finalize_trip_run error:", error);
    throw error;
  }

  return data;
}

async function callGetUserAttendanceLast5(userId) {
  if (!userId) return [];
  let { data, error } = await supabase.rpc("get_user_attendance_last5", {
    p_user_id: userId,
  });

  if (error && (error.message?.includes("parameter") || error.code === "42883")) {
    const fallback = await supabase.rpc("get_user_attendance_last5", {
      user_id: userId,
    });
    data = fallback.data;
    error = fallback.error;
  }

  if (error) {
    console.warn(`⚠️ RPC get_user_attendance_last5 error for user ${userId}:`, error.message);
    return [];
  }

  return Array.isArray(data) ? data : [];
}

function formatAttendanceSymbol(record) {
  if (record === null || record === undefined) return "—";
  if (typeof record === "string") {
    const trimmed = record.trim();
    if (trimmed === "✓" || trimmed.toLowerCase() === "presente" || trimmed.toLowerCase() === "present") return "✓";
    if (trimmed === "✗" || trimmed === "x" || trimmed.toLowerCase() === "ausente" || trimmed.toLowerCase() === "absent") return "✗";
    if (trimmed === "—" || trimmed === "-" || trimmed.toLowerCase().includes("no_tomada") || trimmed.toLowerCase().includes("no tomada")) return "—";
    return trimmed;
  }
  if (typeof record === "object") {
    if (record.symbol) return record.symbol;
    const isValid = record.attendance_valid ?? record.valid;
    if (isValid === false || record.status === "no_tomada" || record.status === "no tomada" || record.status === "lista_no_tomada") {
      return "—";
    }
    const isBoarded = record.boarded ?? (record.status === "presente" || record.status === "present" || record.present === true);
    if (isBoarded) return "✓";
    if (record.boarded === false || record.status === "ausente" || record.status === "absent") {
      return "✗";
    }
  }
  return "—";
}

async function resolveUserStreak(userId, last5Records) {
  if (Array.isArray(last5Records) && last5Records.length > 0) {
    const first = last5Records[0];
    if (first && typeof first === "object") {
      if (first.streak !== undefined && first.streak !== null) return Number(first.streak);
      if (first.racha !== undefined && first.racha !== null) return Number(first.racha);
      if (first.no_show_streak !== undefined && first.no_show_streak !== null) return Number(first.no_show_streak);
    }
  }

  try {
    const { data: user, error } = await supabase
      .from("users")
      .select("no_show_streak")
      .eq("id", userId)
      .maybeSingle();

    if (!error && user && user.no_show_streak !== undefined && user.no_show_streak !== null) {
      return Number(user.no_show_streak);
    }
  } catch (err) {
    console.warn(`⚠️ Error reading no_show_streak for user ${userId}:`, err.message);
  }

  return 0;
}

function ensureRecentTripInLast5({ last5, attendanceValid, currentTripId, wasBoarded }) {
  const formatted = (Array.isArray(last5) ? last5 : []).map(formatAttendanceSymbol);

  if (!attendanceValid) {
    // Si la lista no fue tomada (todos ausentes) y la función de Supabase la excluyó:
    const hasCurrentEntry = last5.some((r) => r && (r.trip_id === currentTripId || r.attendance_valid === false));
    if (!hasCurrentEntry) {
      formatted.unshift("—");
    }
  } else if (formatted.length === 0) {
    formatted.push(wasBoarded ? "✓" : "✗");
  }

  return formatted.slice(0, 5);
}

/**
 * Procesa la finalización manual invocada por un encargado.
 */
async function processManualFinalization({ tripId, runId, groupId, user }) {
  // 1. Obtener pasajeros anotados actuales
  const passengers = await getTripPassengers(tripId);

  // 2. Guardar trip_run_passengers incluyendo SIEMPRE user_id
  const snapshot = passengers.map((p) => ({
    run_id: Number(runId),
    user_id: p.user_id ? String(p.user_id) : null,
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
      console.error("⚠️ INSERT trip_run_passengers ERROR:", insertError);
      throw insertError;
    }
  }

  // 3. FINALIZAR: Llamar a la RPC de Supabase con source = 'manual'
  await callFinalizeTripRun(runId, "manual");

  // 4. HISTORIAL: Supabase es la única fuente responsable de generar trip_history_runs
  const { data: historyRun, error: historyError } = await supabase
    .from("trip_history_runs")
    .select("*")
    .eq("source_run_id", runId)
    .order("id", { ascending: false })
    .limit(1)
    .maybeSingle();

  if (historyError) {
    console.error("⚠️ Error consultando trip_history_runs generado:", historyError);
  }

  const attendanceValid = historyRun && historyRun.attendance_valid !== null && historyRun.attendance_valid !== undefined
    ? Boolean(historyRun.attendance_valid)
    : passengers.some((p) => p.boarded);

  // 5. RACHA Y ÚLTIMOS 5:
  const absentConfirmed = passengers.filter((p) => p?.status === "confirmed" && !p?.boarded);

  let absentWithHistory = [];
  if (attendanceValid) {
    absentWithHistory = await Promise.all(
      absentConfirmed.map(async (p) => {
        const userId = p.user_id ? String(p.user_id) : null;
        let last5 = [];
        let streak = 0;

        if (userId) {
          const rawLast5 = await callGetUserAttendanceLast5(userId);
          last5 = ensureRecentTripInLast5({
            last5: rawLast5,
            attendanceValid: true,
            currentTripId: Number(tripId),
            wasBoarded: false,
          });
          streak = await resolveUserStreak(userId, rawLast5);
        } else {
          last5 = ["✗"];
        }

        return {
          name: p.users?.name || "Sin nombre",
          description: p.users?.description || "",
          streak,
          last5,
        };
      })
    );
  }

  // 6. MAIL:
  const finishedAt = historyRun?.finished_at || new Date().toISOString();
  const lateCancellations = await readLateCancellationsForTrip(tripId, finishedAt);
  const trip = await getTripById(tripId);
  const tripName = trip?.name || historyRun?.trip_name || `Traslado ${tripId}`;

  // Control de duplicados con summary_snapshot.email_sent
  const summarySnapshot = (historyRun?.summary_snapshot && typeof historyRun.summary_snapshot === "object")
    ? historyRun.summary_snapshot
    : {};

  if (summarySnapshot.email_sent !== true) {
    try {
      const emailResult = await notifyAdminsTripFinishedSummary({
        groupId,
        tripName,
        attendanceValid,
        absentPassengers: absentWithHistory,
        lateCancellations,
        fridayCutoffLabel: "viernes 20:00 (America/Argentina/Buenos_Aires)",
      });

      if (emailResult?.sent && historyRun?.id) {
        await supabase
          .from("trip_history_runs")
          .update({
            summary_snapshot: {
              ...summarySnapshot,
              email_sent: true,
              email_sent_at: new Date().toISOString(),
            },
          })
          .eq("id", historyRun.id);
      }
    } catch (mailErr) {
      console.error("⚠️ Error enviando mail de finalización:", mailErr);
    }
  }

  // 7. CLEANUP
  await performPostCleanup({ tripId, trip, finishedAt });

  return {
    success: true,
    runId,
    attendanceValid,
    finishedAt,
  };
}

/**
 * Procesa el POST-FLUJO de una corrida auto-finalizada por Supabase.
 */
async function processAutoFinalizedRun(historyRun) {
  if (!historyRun || !historyRun.id) return;

  const summarySnapshot = (historyRun.summary_snapshot && typeof historyRun.summary_snapshot === "object")
    ? historyRun.summary_snapshot
    : {};

  if (summarySnapshot.email_sent === true) {
    return;
  }

  const runId = historyRun.source_run_id;
  const tripId = historyRun.trip_id;
  const groupId = historyRun.group_id;
  const attendanceValid = Boolean(historyRun.attendance_valid);
  const tripName = historyRun.trip_name || `Traslado ${tripId}`;
  const finishedAt = historyRun.finished_at || new Date().toISOString();

  // 1. Obtener pasajeros del historial
  const { data: historyPassengers, error: passError } = await supabase
    .from("trip_history_passengers")
    .select("*")
    .eq("history_run_id", historyRun.id);

  if (passError) {
    console.error("⚠️ Error consultando pasajeros del historial para auto_12h:", passError);
  }

  const passengers = Array.isArray(historyPassengers) ? historyPassengers : [];
  const absentConfirmed = passengers.filter((p) => p.status === "confirmed" && !p.boarded);

  // 2. RACHA Y ÚLTIMOS 5
  let absentWithHistory = [];
  if (attendanceValid) {
    absentWithHistory = await Promise.all(
      absentConfirmed.map(async (p) => {
        const userId = p.user_id ? String(p.user_id) : null;
        let last5 = [];
        let streak = 0;

        if (userId) {
          const rawLast5 = await callGetUserAttendanceLast5(userId);
          last5 = ensureRecentTripInLast5({
            last5: rawLast5,
            attendanceValid: true,
            currentTripId: Number(tripId),
            wasBoarded: false,
          });
          streak = await resolveUserStreak(userId, rawLast5);
        } else {
          last5 = ["✗"];
        }

        return {
          name: p.user_name || "Sin nombre",
          description: p.description || "",
          streak,
          last5,
        };
      })
    );
  }

  // 3. Cancelaciones tardías
  const lateCancellations = await readLateCancellationsForTrip(tripId, finishedAt);

  // 4. Enviar mail
  try {
    const emailResult = await notifyAdminsTripFinishedSummary({
      groupId,
      tripName,
      attendanceValid,
      absentPassengers: absentWithHistory,
      lateCancellations,
      fridayCutoffLabel: "viernes 20:00 (America/Argentina/Buenos_Aires)",
    });

    if (emailResult?.sent) {
      await supabase
        .from("trip_history_runs")
        .update({
          summary_snapshot: {
            ...summarySnapshot,
            email_sent: true,
            email_sent_at: new Date().toISOString(),
          },
        })
        .eq("id", historyRun.id);
    }
  } catch (mailErr) {
    console.error("⚠️ Error enviando mail de auto-finalización:", mailErr);
  }

  // 5. Cleanup
  const trip = await getTripById(tripId);
  await performPostCleanup({ tripId, trip, finishedAt });
}

module.exports = {
  processManualFinalization,
  processAutoFinalizedRun,
  callFinalizeTripRun,
  callGetUserAttendanceLast5,
  formatAttendanceSymbol,
};
