const cron = require("node-cron");
const { createClient } = require("@supabase/supabase-js");
const { processAutoFinalizedRun } = require("../services/tripFinalization");

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

let isProcessing = false;

async function checkAndProcessAutoFinalizedRuns() {
  if (isProcessing) {
    console.log("[autoFinalizeScheduler] Ejecución previa en curso, omitiendo ciclo");
    return;
  }

  isProcessing = true;
  try {
    // Buscar corridas auto-finalizadas por Supabase (auto_12h)
    const { data: runs, error } = await supabase
      .from("trip_history_runs")
      .select("*")
      .in("finalization_source", ["auto_12h", "auto"])
      .order("id", { ascending: false })
      .limit(50);

    if (error) {
      // Si la tabla o la columna aún no está lista, ignorar silenciosamente
      if (error.code !== "42P01" && !String(error.message || "").toLowerCase().includes("does not exist")) {
        console.warn("[autoFinalizeScheduler] Error consultando trip_history_runs:", error.message);
      }
      return;
    }

    const pendingRuns = (runs || []).filter((run) => {
      const snapshot = run.summary_snapshot;
      if (!snapshot || typeof snapshot !== "object") return true;
      return snapshot.email_sent !== true;
    });

    if (pendingRuns.length > 0) {
      console.log(`[autoFinalizeScheduler] Se encontraron ${pendingRuns.length} corrida(s) auto-finalizada(s) pendientes de post-flujo`);
      for (const run of pendingRuns) {
        try {
          console.log(`[autoFinalizeScheduler] Procesando post-flujo para corrida #${run.id} (trip #${run.trip_id})`);
          await processAutoFinalizedRun(run);
          console.log(`[autoFinalizeScheduler] Post-flujo completado para corrida #${run.id}`);
        } catch (runErr) {
          console.error(`[autoFinalizeScheduler] Error procesando corrida #${run.id}:`, runErr);
        }
      }
    }
  } catch (err) {
    console.error("[autoFinalizeScheduler] Error inesperado en ciclo:", err);
  } finally {
    isProcessing = false;
  }
}

function initAutoFinalizeScheduler() {
  console.log("[autoFinalizeScheduler] Inicializando scheduler de auto-finalización (cada 5 minutos)...");

  // Ejecución cada 5 minutos
  cron.schedule("*/5 * * * *", () => {
    checkAndProcessAutoFinalizedRuns();
  });

  // Ejecución inicial no bloqueante
  setImmediate(() => {
    checkAndProcessAutoFinalizedRuns();
  });
}

module.exports = {
  initAutoFinalizeScheduler,
  checkAndProcessAutoFinalizedRuns,
};
