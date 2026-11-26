const { supabase } = require("../../lib/supabaseClient");
const { CLUB_ID } = require("./clubAccess");
const { createBb8Error } = require("./errors");
const { queryTrips } = require("./tripsReadOnly");

function normalizeText(value) {
  return String(value || "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .trim()
    .toLowerCase();
}

function formatStatus(status) {
  if (status === "confirmed") return "Confirmado";
  if (status === "waiting") return "En espera";
  return status || "Sin estado";
}

async function getClubTripIds() {
  const { data, error } = await supabase
    .from("trip_groups")
    .select("trip_id")
    .eq("group_id", CLUB_ID);

  if (error) {
    throw createBb8Error(
      "No se pudo validar el alcance de los traslados del club 1926.",
      502,
      "TRIP_SCOPE_QUERY_FAILED",
      "trips"
    );
  }

  return [
    ...new Set(
      (data || [])
        .map((row) => Number(row.trip_id))
        .filter((id) => Number.isSafeInteger(id) && id > 0)
    ),
  ];
}

async function resolveTripByExactName(name) {
  if (!name) return { trip: null, ambiguous: false };
  const tripIds = await getClubTripIds();
  if (tripIds.length === 0) return { trip: null, ambiguous: false };

  const { data, error } = await supabase
    .from("trips")
    .select("id, name, type, status, departure_datetime, start_time")
    .in("id", tripIds)
    .order("departure_datetime", { ascending: true })
    .limit(1000);

  if (error) {
    throw createBb8Error(
      "No se pudieron consultar los traslados del club 1926.",
      502,
      "TRIP_QUERY_FAILED",
      "trips"
    );
  }

  const expected = normalizeText(name);
  const matches = (data || []).filter(
    (trip) => normalizeText(trip.name) === expected
  );
  return {
    trip: matches.length === 1 ? matches[0] : null,
    ambiguous: matches.length > 1,
  };
}

function requireQuotedTarget(name, type) {
  if (name) return null;
  const label = type === "trip" ? "el nombre exacto del traslado" : "el nombre exacto de la persona";
  return {
    reply: `Para evitar confusiones, indicá ${label} entre comillas.`,
    records: [],
  };
}

async function loadTripTarget(name) {
  const resolved = await resolveTripByExactName(name);
  if (resolved.ambiguous) {
    return {
      error: {
        reply:
          "Hay varios traslados con ese nombre. Indicá uno con un nombre más específico o una fecha.",
        records: [],
      },
    };
  }
  if (!resolved.trip) {
    return {
      error: {
        reply: "No encontré ese traslado dentro del club 1926.",
        records: [],
      },
    };
  }
  return { trip: resolved.trip };
}

async function queryTripStops(tripName) {
  const missingTarget = requireQuotedTarget(tripName, "trip");
  if (missingTarget) return missingTarget;
  const { trip, error: targetError } = await loadTripTarget(tripName);
  if (targetError) return targetError;

  const { data, error } = await supabase
    .from("trip_stops")
    .select("stop_id, pickup_time, order_index, stops(name)")
    .eq("trip_id", trip.id)
    .order("order_index", { ascending: true });

  if (error) {
    throw createBb8Error(
      "No se pudieron consultar las paradas del traslado.",
      502,
      "TRIP_STOPS_QUERY_FAILED",
      "stops"
    );
  }

  return {
    reply: data?.length
      ? `Paradas de ${trip.name}:`
      : `El traslado ${trip.name} no tiene paradas cargadas.`,
    records: (data || []).map((row) => ({
      id: row.stop_id,
      title: row.stops?.name || "Parada sin nombre",
      details: [
        `Orden: ${row.order_index || "-"}`,
        `Horario: ${String(row.pickup_time || "").slice(0, 5) || "-"}`,
      ],
    })),
  };
}

async function queryTripPassengers(tripName, includeAttendance = false) {
  const missingTarget = requireQuotedTarget(tripName, "trip");
  if (missingTarget) return missingTarget;
  const { trip, error: targetError } = await loadTripTarget(tripName);
  if (targetError) return targetError;

  const [reservationResult, confirmedCountResult, boardedCountResult, waitingCountResult] =
    await Promise.all([
      supabase
        .from("reservations")
        .select("id, status, boarded, users(name), stops(name)")
        .eq("trip_id", trip.id)
        .in("status", ["confirmed", "waiting"])
        .order("id", { ascending: true })
        .limit(500),
      supabase
        .from("reservations")
        .select("id", { count: "exact", head: true })
        .eq("trip_id", trip.id)
        .eq("status", "confirmed"),
      supabase
        .from("reservations")
        .select("id", { count: "exact", head: true })
        .eq("trip_id", trip.id)
        .eq("status", "confirmed")
        .eq("boarded", true),
      supabase
        .from("reservations")
        .select("id", { count: "exact", head: true })
        .eq("trip_id", trip.id)
        .eq("status", "waiting"),
    ]);

  if (
    reservationResult.error ||
    confirmedCountResult.error ||
    boardedCountResult.error ||
    waitingCountResult.error
  ) {
    throw createBb8Error(
      "No se pudieron consultar las inscripciones del traslado.",
      502,
      "RESERVATIONS_QUERY_FAILED",
      includeAttendance ? "attendance" : "reservations"
    );
  }

  const rows = Array.isArray(reservationResult.data)
    ? reservationResult.data
    : [];
  const confirmedCount = confirmedCountResult.count || 0;
  const boardedCount = boardedCountResult.count || 0;
  const waitingCount = waitingCountResult.count || 0;
  const totalCount = confirmedCount + waitingCount;
  const displayedLimitMessage =
    totalCount > rows.length ? ` Se muestran ${rows.length} registros.` : "";
  if (includeAttendance) {
    const notBoardedCount = confirmedCount - boardedCount;
    return {
      reply: `Registro de embarque de ${trip.name}: ${boardedCount} marcados presentes de ${confirmedCount} inscriptos confirmados; ${notBoardedCount} sin marcar como presentes y ${waitingCount} en espera. "Sin marcar como presente" no determina por sí solo una inasistencia definitiva.${displayedLimitMessage}`,
      records: rows.map((row) => ({
        id: row.id,
        title: row.users?.name || "Sin nombre",
        details: [
          formatStatus(row.status),
          `Parada: ${row.stops?.name || "Sin parada"}`,
          row.status === "confirmed"
            ? Boolean(row.boarded)
              ? "Presente"
              : "Sin marcar como presente (no equivale a ausencia definitiva)"
            : "Asistencia no aplica a lista de espera",
        ],
      })),
    };
  }

  return {
    reply: `Inscriptos de ${trip.name}: ${totalCount}.${displayedLimitMessage}`,
    records: rows.map((row) => ({
      id: row.id,
      title: row.users?.name || "Sin nombre",
      details: [
        formatStatus(row.status),
        `Parada: ${row.stops?.name || "Sin parada"}`,
      ],
    })),
  };
}

async function queryTripOccupancy(tripName) {
  const missingTarget = requireQuotedTarget(tripName, "trip");
  if (missingTarget) return missingTarget;
  const { trip, error: targetError } = await loadTripTarget(tripName);
  if (targetError) return targetError;

  const [busesResult, confirmedResult, waitingResult] = await Promise.all([
    supabase
      .from("trip_buses")
      .select("buses(capacity)")
      .eq("trip_id", trip.id),
    supabase
      .from("reservations")
      .select("id", { count: "exact", head: true })
      .eq("trip_id", trip.id)
      .eq("status", "confirmed"),
    supabase
      .from("reservations")
      .select("id", { count: "exact", head: true })
      .eq("trip_id", trip.id)
      .eq("status", "waiting"),
  ]);

  if (busesResult.error || confirmedResult.error || waitingResult.error) {
    throw createBb8Error(
      "No se pudo calcular la ocupación del traslado.",
      502,
      "TRIP_OCCUPANCY_QUERY_FAILED",
      "reports"
    );
  }

  const capacity =
    (busesResult.data || []).reduce(
      (sum, row) => sum + Number(row.buses?.capacity || 0),
      0
    ) || 0;
  const confirmed = confirmedResult.count || 0;
  const waiting = waitingResult.count || 0;

  return {
    reply: `Ocupación de ${trip.name}: ${confirmed} confirmados de ${capacity} lugares; ${waiting} en espera.`,
    records: [
      {
        title: trip.name,
        details: [
          `Capacidad: ${capacity}`,
          `Confirmados: ${confirmed}`,
          `En espera: ${waiting}`,
        ],
      },
    ],
  };
}

async function findClubPassengers(query) {
  if (!query) return { matches: [] };
  const search = String(query).trim().replace(/[%_*]/g, "");
  if (!search) return { matches: [] };

  const selectFields = "id, name, role, phone, description, member_number, group_number, organization_id";
  const searchPattern = `%${search}%`;
  const groupResults = await Promise.all([
    supabase
      .from("users")
      .select(selectFields)
      .eq("role", "pasajero")
      .eq("group_number", CLUB_ID)
      .ilike("name", searchPattern)
      .limit(50),
    supabase
      .from("users")
      .select(selectFields)
      .eq("role", "pasajero")
      .eq("organization_id", CLUB_ID)
      .ilike("name", searchPattern)
      .limit(50),
  ]);

  const error = groupResults.find((result) => result.error)?.error;
  if (error) {
    throw createBb8Error(
      "No se pudo buscar personas del club 1926.",
      502,
      "USER_QUERY_FAILED",
      "users"
    );
  }

  const unique = new Map();
  for (const result of groupResults) {
    for (const user of result.data || []) {
      unique.set(String(user.id), user);
    }
  }
  return { matches: [...unique.values()] };
}

async function findClubPassengersByExactName(name) {
  const search = String(name || "").trim();
  if (!search) return { matches: [] };
  const pattern = search.replace(/[\\%_]/g, "\\$&");
  const selectFields = "id, name, role, group_number, organization_id";
  const groupResults = await Promise.all([
    supabase
      .from("users")
      .select(selectFields)
      .eq("role", "pasajero")
      .eq("group_number", CLUB_ID)
      .ilike("name", pattern)
      .limit(50),
    supabase
      .from("users")
      .select(selectFields)
      .eq("role", "pasajero")
      .eq("organization_id", CLUB_ID)
      .ilike("name", pattern)
      .limit(50),
  ]);

  const error = groupResults.find((result) => result.error)?.error;
  if (error) {
    throw createBb8Error(
      "No se pudo validar la identidad del pasajero del club 1926.",
      502,
      "USER_QUERY_FAILED",
      "users"
    );
  }

  const unique = new Map();
  for (const result of groupResults) {
    for (const user of result.data || []) {
      unique.set(String(user.id), user);
    }
  }
  return { matches: [...unique.values()] };
}

async function queryPerson(query, history = false) {
  const missingTarget = requireQuotedTarget(query, "person");
  if (missingTarget) return missingTarget;
  const { matches } = await findClubPassengers(query);
  const exact = matches.filter(
    (user) => normalizeText(user.name) === normalizeText(query)
  );
  const selected = exact.length ? exact : matches;
  if (selected.length === 0) {
    return { reply: "No encontré una persona con ese nombre en el club 1926.", records: [] };
  }
  if (selected.length > 1) {
    return {
      reply: "Encontré varias personas con ese nombre. Indicá nombre y apellido completos.",
      records: selected.slice(0, 10).map((user) => ({
        id: user.id,
        title: user.name || "Sin nombre",
        details: [`Socio: ${user.member_number || "Sin dato"}`],
      })),
    };
  }

  const user = selected[0];
  if (!history) {
    return {
      reply: `Información de ${user.name}:`,
      records: [
        {
          id: user.id,
          title: user.name || "Sin nombre",
          details: [
            `Teléfono: ${user.phone || "Sin dato"}`,
            `Descripción: ${user.description || "Sin dato"}`,
            `Número de socio: ${user.member_number || "Sin dato"}`,
          ],
        },
      ],
    };
  }

  const tripIds = await getClubTripIds();
  if (tripIds.length === 0) {
    return { reply: `No hay traslados asociados al club 1926 para consultar el historial de ${user.name}.`, records: [] };
  }

  const { data: reservations, error: reservationsError } = await supabase
    .from("reservations")
    .select("id, trip_id, status, boarded, stop_id, stops(name)")
    .eq("user_id", user.id)
    .in("trip_id", tripIds)
    .order("id", { ascending: false })
    .limit(100);

  if (reservationsError) {
    throw createBb8Error(
      "No se pudo consultar el historial de la persona.",
      502,
      "PERSON_HISTORY_QUERY_FAILED",
      "users"
    );
  }

  const relatedTripIds = [
    ...new Set((reservations || []).map((row) => Number(row.trip_id))),
  ];
  const { data: trips, error: tripsError } = relatedTripIds.length
    ? await supabase
        .from("trips")
        .select("id, name, type, status, departure_datetime")
        .in("id", relatedTripIds)
        .in("id", tripIds)
    : { data: [], error: null };

  if (tripsError) {
    throw createBb8Error(
      "No se pudo completar el historial de la persona.",
      502,
      "PERSON_HISTORY_QUERY_FAILED",
      "users"
    );
  }

  const tripById = new Map((trips || []).map((trip) => [Number(trip.id), trip]));
  const records = (reservations || [])
    .map((reservation) => {
      const trip = tripById.get(Number(reservation.trip_id));
      if (!trip) return null;
      return {
        id: reservation.id,
        title: trip.name || "Traslado",
        sortDate: trip.departure_datetime || "",
        details: [
          trip.departure_datetime
            ? new Intl.DateTimeFormat("es-AR", { dateStyle: "medium" }).format(new Date(trip.departure_datetime))
            : "Fecha no disponible",
          formatStatus(reservation.status),
          `Parada: ${reservation.stops?.name || "Sin parada"}`,
          reservation.status === "confirmed"
            ? Boolean(reservation.boarded)
              ? "Presente"
              : "Sin constancia de embarque"
            : "Lista de espera",
        ],
      };
    })
    .filter(Boolean)
    .sort((a, b) => String(b.sortDate).localeCompare(String(a.sortDate)))
    .slice(0, 10)
    .map(({ sortDate, ...record }) => record);

  return {
    reply: `Últimos ${records.length} traslados de ${user.name}:`,
    records,
  };
}

async function queryPeopleCount() {
  const { count, error } = await supabase
    .from("users")
    .select("id", { count: "exact", head: true })
    .eq("role", "pasajero")
    .or(`group_number.eq.${CLUB_ID},organization_id.eq.${CLUB_ID}`);
  if (error) {
    throw createBb8Error(
      "No se pudo contar las personas del club 1926.",
      502,
      "USER_COUNT_QUERY_FAILED",
      "reports"
    );
  }

  return {
    reply: `Hay ${count || 0} usuarios pasajeros registrados en el club 1926.`,
    records: [],
  };
}

async function queryReadOnly(intent, entityName, message) {
  if (intent === "list_upcoming_trips" || intent === "count_upcoming_trips") {
    const result = await queryTrips(intent);
    return {
      ...result,
      records: [],
    };
  }
  if (intent === "list_trip_stops") return queryTripStops(entityName);
  if (intent === "list_trip_passengers") return queryTripPassengers(entityName);
  if (intent === "read_trip_attendance") return queryTripPassengers(entityName, true);
  if (intent === "read_trip_occupancy") return queryTripOccupancy(entityName);
  if (intent === "search_person") return queryPerson(entityName);
  if (intent === "person_history") return queryPerson(entityName, true);
  if (intent === "count_people") return queryPeopleCount();
  if (intent === "unsupported") {
    return {
      reply: message || "No pude identificar una consulta soportada. No realicé cambios.",
      records: [],
    };
  }
  return {
    reply: "Todavía no puedo responder esa consulta con seguridad.",
    records: [],
  };
}

module.exports = {
  findClubPassengers,
  findClubPassengersByExactName,
  queryReadOnly,
};
