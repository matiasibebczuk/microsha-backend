const { createClient } = require("@supabase/supabase-js");
const { formatTripTitle } = require("../utils/format");

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

function escapeHtml(value) {
  return String(value || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/\"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

function formatTimeLabel(value) {
  if (!value) return "-";
  const asText = String(value);
  const hhmm = asText.match(/^(\d{1,2}:\d{2})/);
  if (hhmm) {
    const [h, m] = hhmm[1].split(":");
    return `${String(Number(h)).padStart(2, "0")}:${m}`;
  }
  return "-";
}

async function getStopsWithPassengers(tripId) {
  const { data, error } = await supabase
    .from("trip_stops")
    .select(`stop_id, pickup_time, order_index, stops(id, name)`)
    .eq("trip_id", tripId)
    .order("order_index");

  if (error) throw error;

  const stops = data || [];

  const { data: reservations, error: resError } = await supabase
    .from("reservations")
    .select("stop_id")
    .eq("trip_id", tripId)
    .in("status", ["confirmed", "waiting"]);

  if (resError) throw resError;

  const stopsWithPassengers = new Set(
    (reservations || []).map((r) => String(r.stop_id)).filter(Boolean)
  );

  return stops
    .filter((s) => stopsWithPassengers.has(String(s.stop_id)))
    .map((s) => ({
      stopId: s.stop_id,
      name: s.stops?.name || "Sin parada",
      time: formatTimeLabel(s.pickup_time),
      order: s.order_index,
    }));
}

async function getTripsSummary(groupId) {
  const { data: trips, error: tripsError } = await supabase
    .from("trips")
    .select(
      "id, name, type, status, departure_datetime, start_time, confirmed:reservations(count), waiting:reservations(count)"
    )
    .eq("group_id", groupId)
    .eq("status", "open");

  if (tripsError) throw tripsError;

  const tripsArray = Array.isArray(trips) ? trips : [];

  const enriched = await Promise.all(
    tripsArray.map(async (trip) => {
      const { data: confirmados } = await supabase
        .from("reservations")
        .select("id", { count: "exact" })
        .eq("trip_id", trip.id)
        .eq("status", "confirmed");

      const { data: esperando } = await supabase
        .from("reservations")
        .select("id", { count: "exact" })
        .eq("trip_id", trip.id)
        .eq("status", "waiting");

      const { data: capacidad } = await supabase
        .from("trip_buses")
        .select("buses(capacity)")
        .eq("trip_id", trip.id);

      const totalCapacity = (capacidad || []).reduce(
        (acc, bus) => acc + (Number(bus?.buses?.capacity) || 0),
        0
      );

      const stops = await getStopsWithPassengers(trip.id);

      return {
        id: trip.id,
        name: trip.name,
        type: trip.type,
        startTime: trip.start_time,
        departureTime: trip.departure_datetime,
        confirmed: confirmados?.length || 0,
        waiting: esperando?.length || 0,
        capacity: totalCapacity,
        stops,
      };
    })
  );

  return enriched;
}

function renderTripHTML(trip) {
  const titleTime = trip.startTime || "-";
  const displayTime = formatTimeLabel(titleTime);
  const title = escapeHtml(trip.name);
  const confirmed = trip.confirmed || 0;
  const waiting = trip.waiting || 0;
  const capacity = trip.capacity || 0;

  let stopsHTML = "";
  if (trip.stops && trip.stops.length > 0) {
    stopsHTML = trip.stops
      .map(
        (stop) =>
          `<li>${escapeHtml(stop.time)} — ${escapeHtml(stop.name)}</li>`
      )
      .join("");
  } else {
    stopsHTML = "<li>Sin paradas con pasajeros</li>";
  }

  const waitingHTML =
    waiting > 0 ? `<p><b>En lista de espera:</b> ${waiting}</p>` : "";

  return `
    <div style="margin-bottom: 24px; padding: 16px; background: #f9f9f9; border-radius: 8px;">
      <h4 style="margin: 0 0 12px 0; font-size: 16px; color: #333;">
        ${title} – ${displayTime}
      </h4>
      <p style="margin: 8px 0; color: #666;">
        <b>Capacidad actual:</b> ${confirmed}/${capacity}
      </p>
      ${waitingHTML}
      <h5 style="margin: 12px 0 8px 0; font-size: 14px; color: #333;">Paradas:</h5>
      <ul style="margin: 0; padding-left: 20px; color: #666;">
        ${stopsHTML}
      </ul>
    </div>
  `;
}

async function generarMailResumenTraslados({ groupId, incluirDetalles = true }) {
  try {
    const trips = await getTripsSummary(groupId);

    if (!trips || trips.length === 0) {
      return {
        html: null,
        subject: null,
        tripCount: 0,
        tripCountIda: 0,
        tripCountVuelta: 0,
        hasContent: false,
        timestamp: new Date().toISOString(),
      };
    }

    const tripsIda = trips.filter((t) => {
      const type = String(t.type || "").toLowerCase().trim();
      return type.startsWith("ida");
    });

    const tripsVuelta = trips.filter((t) => {
      const type = String(t.type || "").toLowerCase().trim();
      return type.startsWith("vuelta") || type.startsWith("regreso");
    });

    const nowLabel = new Date().toLocaleString("es-AR", {
      timeZone: "America/Argentina/Buenos_Aires",
      year: "numeric",
      month: "long",
      day: "numeric",
      weekday: "long",
    });

    const idaHTML = tripsIda.map(renderTripHTML).join("");
    const vueltaHTML = tripsVuelta.map(renderTripHTML).join("");

    const html = `
      <h2 style="color: #333; margin-bottom: 8px;">Resumen de Traslados</h2>
      <p style="color: #999; margin: 0 0 24px 0;">HebraicaJuventud • ${escapeHtml(nowLabel)}</p>
      <hr style="border: none; border-top: 1px solid #ddd; margin: 24px 0;" />

      ${
        tripsIda.length > 0
          ? `
        <h3 style="color: #333; margin: 24px 0 16px 0;">Traslados de IDA</h3>
        ${idaHTML}
      `
          : ""
      }

      ${
        tripsVuelta.length > 0
          ? `
        <h3 style="color: #333; margin: 24px 0 16px 0;">Traslados de VUELTA</h3>
        ${vueltaHTML}
      `
          : ""
      }

      ${
        trips.length === 0
          ? `<p style="color: #666; font-style: italic;">No hay traslados abiertos en este momento.</p>`
          : ""
      }

      <hr style="border: none; border-top: 1px solid #ddd; margin: 24px 0;" />
      <p style="color: #999; font-size: 12px; margin: 0;">
        Reporte automático enviado por MicroSHA
      </p>
    `;

    const subject = `MicroSHA · Resumen de Traslados ${nowLabel}`;

    return {
      html,
      subject,
      tripCount: trips.length,
      tripCountIda: tripsIda.length,
      tripCountVuelta: tripsVuelta.length,
      hasContent: trips.length > 0,
      timestamp: new Date().toISOString(),
    };
  } catch (error) {
    console.error("[resumenTraslados] Error generando mail:", error);
    throw error;
  }
}

module.exports = {
  generarMailResumenTraslados,
};
