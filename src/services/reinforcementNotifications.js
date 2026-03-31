const { createClient } = require("@supabase/supabase-js");
const { getStaffMembershipsByGroup } = require("../middleware/groupStore");

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

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
    return fallbackEmails;
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
      // Ignore per-user lookup failures; we still notify remaining admins.
    }
  }

  return uniqueStrings([...emails, ...fallbackEmails]);
}

async function sendViaResend({ to, subject, html }) {
  const apiKey = process.env.RESEND_API_KEY;
  const from = process.env.ADMIN_ALERTS_FROM_EMAIL;

  if (!apiKey || !from) {
    console.warn("[alerts] Resend not configured", {
      hasApiKey: Boolean(apiKey),
      hasFrom: Boolean(from),
    });
    return { sent: false, reason: "missing_env" };
  }

  const response = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      from,
      to,
      subject,
      html,
    }),
  });

  if (!response.ok) {
    const body = await response.text();
    throw new Error(`Resend error ${response.status}: ${body}`);
  }

  return { sent: true };
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

module.exports = {
  notifyAdminsReinforcementActivated,
  notifyAdminsTripFinishedSummary,
};
