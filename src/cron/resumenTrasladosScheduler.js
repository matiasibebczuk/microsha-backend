const cron = require("node-cron");
const fs = require("fs");
const path = require("path");
const { generarMailResumenTraslados } = require("../services/resumenTraslados");
const { sendViaResend } = require("../services/reinforcementNotifications");
const { resolveAdminEmails } = require("../services/reinforcementNotifications");

const logsDir = path.join(__dirname, "..", "..", "logs");
const resumenTrasladosLogPath = path.join(logsDir, "resumen-traslados-scheduler.jsonl");

function ensureLogsDir() {
  if (!fs.existsSync(logsDir)) {
    fs.mkdirSync(logsDir, { recursive: true });
  }
}

function appendLog(logEntry) {
  try {
    ensureLogsDir();
    fs.appendFileSync(
      resumenTrasladosLogPath,
      JSON.stringify(logEntry) + "\n",
      "utf8"
    );
  } catch (error) {
    console.error("[resumenTraslados] Error writing log:", error);
  }
}

function isJuevesOViernesAlas14ArgentinaTime() {
  const now = new Date();
  const argentinaFormatter = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/Argentina/Buenos_Aires",
    weekday: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  });

  const parts = argentinaFormatter.formatToParts(now);
  const weekday = Number(
    parts.find((p) => p.type === "weekday")?.value || 0
  );
  const hour = Number(parts.find((p) => p.type === "hour")?.value || -1);
  const minute = Number(parts.find((p) => p.type === "minute")?.value || -1);

  const isJuevesOViernes = weekday === 4 || weekday === 5;
  const is14Hs = hour === 14 && minute === 0;

  return isJuevesOViernes && is14Hs;
}

let lastExecutionDate = null;

async function enviarResumenTraslados() {
  const executionTime = new Date().toISOString();
  const today = new Date().toLocaleDateString("en-CA");

  if (lastExecutionDate === today) {
    return;
  }

  try {
    const groupId = 1926;

    const mailData = await generarMailResumenTraslados({ groupId });

    if (!mailData.hasContent) {
      const logEntry = {
        timestamp: executionTime,
        event: "resumen_traslados_no_enviado",
        groupId,
        reason: "no_open_trips",
        sent: false,
      };
      appendLog(logEntry);
      return;
    }

    const to = await resolveAdminEmails(groupId);

    if (to.length === 0) {
      const logEntry = {
        timestamp: executionTime,
        event: "resumen_traslados_no_enviado",
        groupId,
        reason: "no_recipients",
        sent: false,
      };
      appendLog(logEntry);
      return;
    }

    const result = await sendViaResend({
      to,
      subject: mailData.subject,
      html: mailData.html,
    });

    const logEntry = {
      timestamp: executionTime,
      event: "resumen_traslados_enviado",
      groupId,
      tripCount: mailData.tripCount,
      tripCountIda: mailData.tripCountIda,
      tripCountVuelta: mailData.tripCountVuelta,
      recipients: result.to || to,
      sent: result.sent === true,
      provider: result.sent ? "resend" : "failed",
      error: result.sent ? null : result.reason || "unknown_error",
    };
    appendLog(logEntry);

    console.log(
      `[resumenTraslados] Mail enviado: ${mailData.tripCount} traslados a ${result.to?.join(", ")}`
    );

    lastExecutionDate = today;
  } catch (error) {
    const logEntry = {
      timestamp: executionTime,
      event: "resumen_traslados_error",
      groupId: 1926,
      error: error?.message || String(error),
      sent: false,
    };
    appendLog(logEntry);
    console.error("[resumenTraslados] Error:", error);
  }
}

function initResumenTrasladosScheduler() {
  console.log("[resumenTraslados] Iniciando scheduler...");

  cron.schedule("* * * * *", async () => {
    if (isJuevesOViernesAlas14ArgentinaTime()) {
      console.log("[resumenTraslados] Ejecutando envío programado...");
      await enviarResumenTraslados();
    }
  });

  console.log(
    "[resumenTraslados] Scheduler activo. Enviará cada jueves y viernes a las 14:00 (America/Argentina/Buenos_Aires)"
  );
}

module.exports = {
  initResumenTrasladosScheduler,
  enviarResumenTraslados,
};
