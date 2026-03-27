const { createClient } = require("@supabase/supabase-js");
const { getStaffMembershipsByGroup } = require("../middleware/groupStore");

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

function uniqueStrings(values) {
  return Array.from(new Set((values || []).filter(Boolean).map((v) => String(v).trim())));
}

async function resolveAdminEmails(groupId) {
  const memberships = await getStaffMembershipsByGroup(groupId);
  const adminIds = memberships
    .filter((membership) => String(membership.role || "").toLowerCase() === "admin")
    .map((membership) => membership.userId);

  if (adminIds.length === 0) return [];

  const emails = [];
  for (const adminId of adminIds) {
    try {
      const { data, error } = await supabase.auth.admin.getUserById(adminId);
      if (!error && data?.user?.email) {
        emails.push(data.user.email);
      }
    } catch {
      // Ignore per-user lookup failures; we still notify remaining admins.
    }
  }

  return uniqueStrings(emails);
}

async function sendViaResend({ to, subject, html }) {
  const apiKey = process.env.RESEND_API_KEY;
  const from = process.env.ADMIN_ALERTS_FROM_EMAIL;

  if (!apiKey || !from) {
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

module.exports = {
  notifyAdminsReinforcementActivated,
};
