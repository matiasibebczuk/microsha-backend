const { createClient } = require("@supabase/supabase-js");
const { getStaffMembershipsByGroup } = require("../middleware/groupStore");

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);
const FORCED_ALERT_RECIPIENTS = ["advorkin@hebraica.org.ar"];

function uniqueStrings(values) {
  return Array.from(new Set((values || []).filter(Boolean).map((v) => String(v).trim())));
}

function parseEmailList(value) {
  return uniqueStrings(
    String(value || "")
      .split(",")
      .map((item) => item.trim())
      .filter(Boolean)
  );
}

async function resolveAdminEmails(groupId) {
  const fallbackEmails = parseEmailList(process.env.ADMIN_ALERTS_FALLBACK_TO);

  let memberships = [];
  try {
    memberships = await getStaffMembershipsByGroup(groupId);
  } catch (error) {
    console.error("[alerts] Could not resolve staff memberships", {
      groupId,
      message: error?.message || "unknown",
    });
  }

  const adminIds = (Array.isArray(memberships) ? memberships : [])
    .filter((membership) => String(membership.role || "").toLowerCase() === "admin")
    .map((membership) => membership.userId)
    .filter(Boolean);

  if (adminIds.length === 0) {
    return uniqueStrings([...fallbackEmails, ...FORCED_ALERT_RECIPIENTS]);
  }

  const emails = [];
  for (const adminId of adminIds) {
    try {
      const { data, error } = await supabase.auth.admin.getUserById(adminId);
      if (!error && data?.user?.email) {
        emails.push(data.user.email);
      }
      if (error) {
        console.warn("[alerts] Failed resolving admin email", {
          adminId,
          message: error?.message || "unknown",
        });
      }
    } catch (error) {
      console.warn("[alerts] Failed resolving admin email", {
        adminId,
        message: error?.message || "unknown",
      });
    }
  }

  // Si no se resolvieron emails de admins, usa fallback + forced
  if (emails.length === 0) {
    return uniqueStrings([...fallbackEmails, ...FORCED_ALERT_RECIPIENTS]);
  }

  return uniqueStrings([...emails, ...fallbackEmails, ...FORCED_ALERT_RECIPIENTS]);
}

async function sendViaBrevo({ to, subject, html }) {
  const apiKey = process.env.BREVO_API_KEY;
  if (!apiKey) return { sent: false, reason: "missing_brevo_api_key" };

  const toList = uniqueStrings(Array.isArray(to) ? to : []);
  if (toList.length === 0) return { sent: false, reason: "no_recipients" };

  const response = await fetch("https://api.brevo.com/v3/smtp/email", {
    method: "POST",
    headers: {
      "api-key": apiKey,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      sender: { email: "matiasbeck07@gmail.com", name: "MicroSHA Alerts" },
      to: toList.map((email) => ({ email })),
      subject,
      htmlContent: html,
    }),
  });

  if (!response.ok) {
    const body = await response.text();
    throw new Error(`Brevo error ${response.status}: ${body}`);
  }

  return { sent: true, to: toList };
}

async function sendViaResend({ to, subject, html }) {
  const apiKey = process.env.RESEND_API_KEY;
  const from = process.env.ADMIN_ALERTS_FROM_EMAIL;

  if (!apiKey || !from) {
    console.warn("[alerts] Resend not configured, trying Brevo");
    return sendViaBrevo({ to, subject, html });
  }

  const sender = String(from || "").trim().toLowerCase();
  const isTestingSender = sender.endsWith("@resend.dev");
  const toList = uniqueStrings(Array.isArray(to) ? to : []);
  const effectiveTo = isTestingSender ? [] : toList;

  if (effectiveTo.length === 0) {
    console.warn("[alerts] Resend in testing mode or no recipients, falling back to Brevo");
    return sendViaBrevo({ to, subject, html });
  }

  const response = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ from, to: effectiveTo, subject, html }),
  });

  if (!response.ok) {
    const body = await response.text();
    throw new Error(`Resend error ${response.status}: ${body}`);
  }

  return { sent: true, to: effectiveTo };
}

async function notifyAdminsReinforcementActivated({
  groupId,
  tripName,
  reinforcementTripName,
  capacity,
  confirmed,
  waiting,
}) {
  const to = await resolveAdminEmails(groupId);
  if (to.length === 0) {
    return { sent: false, reason: "no_admin_emails" };
  }

  const subject = `Refuerzo activado: ${tripName}`;
  const html = [
    `<h2>Refuerzo activado por sobredemanda</h2>`,
    `<p><b>Traslado:</b> ${tripName}</p>`,
    `<p><b>Nuevo refuerzo:</b> ${reinforcementTripName}</p>`,
    `<p><b>Capacidad original:</b> ${capacity}</p>`,
    `<p><b>Confirmados:</b> ${confirmed}</p>`,
    `<p><b>En espera:</b> ${waiting}</p>`,
    `<p>Se activó un refuerzo porque la demanda superó la disponibilidad del traslado original.</p>`,
  ].join("");

  return sendViaResend({ to, subject, html });
}

function escapeHtml(value) {
  return String(value || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/\"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

function renderPeopleList(items) {
  if (!Array.isArray(items) || items.length === 0) {
    return "<p>Sin registros.</p>";
  }

  const rows = items.map((item) => {
    const name = escapeHtml(item?.name || "Sin nombre");
    const description = escapeHtml(item?.description || "-");
    return `<li><b>${name}</b> · Description: ${description}</li>`;
  });

  return `<ul>${rows.join("")}</ul>`;
}

async function notifyAdminsTripFinishedSummary({
  groupId,
  tripName,
  absentPassengers,
  lateCancellations,
  fridayCutoffLabel,
}) {
  const to = await resolveAdminEmails(groupId);
  if (to.length === 0) {
    console.warn("[alerts] No admin recipients for trip finish summary", { groupId });
    return { sent: false, reason: "no_admin_emails" };
  }

  const safeTripName = escapeHtml(tripName || "Traslado");
  const safeCutoff = escapeHtml(fridayCutoffLabel || "viernes 20:00");
  const subject = `Resumen de finalización: ${tripName || "Traslado"}`;
  const html = [
    `<h2>Finalización de traslado</h2>`,
    `<p><b>Traslado:</b> ${safeTripName}</p>`,
    `<hr />`,
    `<h3>1) Personas ausentes</h3>`,
    `<p>Anotados confirmados que no asistieron.</p>`,
    renderPeopleList(absentPassengers),
    `<hr />`,
    `<h3>2) Personas dadas de baja / desanotadas</h3>`,
    `<p>Solo se incluyen bajas desde ${safeCutoff}.</p>`,
    renderPeopleList(lateCancellations),
  ].join("");

  return sendViaResend({ to, subject, html });
}

async function sendAdminTestEmail({ groupId, label }) {
  const to = await resolveAdminEmails(groupId);
  if (to.length === 0) {
    return { sent: false, reason: "no_admin_emails", to: [] };
  }

  const safeLabel = escapeHtml(label || "Test manual desde panel admin");
  const nowLabel = new Date().toLocaleString("es-AR", {
    timeZone: "America/Argentina/Buenos_Aires",
  });
  const subject = "MicroSHA · Test de envío de email";
  const html = [
    `<h2>Test de envío</h2>`,
    `<p>Este es un correo de prueba enviado desde el panel de administración.</p>`,
    `<p><b>Detalle:</b> ${safeLabel}</p>`,
    `<p><b>Fecha:</b> ${escapeHtml(nowLabel)}</p>`,
  ].join("");

  const result = await sendViaResend({ to, subject, html });
  return {
    ...result,
    to,
  };
}

module.exports = {
  notifyAdminsReinforcementActivated,
  notifyAdminsTripFinishedSummary,
  sendAdminTestEmail,
};
