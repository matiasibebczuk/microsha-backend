const { supabase } = require("../../lib/supabaseClient");
const { CLUB_ID } = require("./clubAccess");
const { createBb8Error } = require("./errors");

function createQueryError(message, code, cause) {
  const error = createBb8Error(message, 502, code, "trips");
  error.cause = cause;
  return error;
}

async function queryTrips(intent) {
  const { data: tripGroupRows, error: tripGroupsError } = await supabase
    .from("trip_groups")
    .select("trip_id")
    .eq("group_id", CLUB_ID);

  if (tripGroupsError) {
    throw createQueryError(
      "No se pudieron consultar los traslados del club 1926.",
      "TRIP_SCOPE_QUERY_FAILED",
      tripGroupsError
    );
  }

  const tripIds = [
    ...new Set(
      (tripGroupRows || [])
        .map((row) => Number(row.trip_id))
        .filter((id) => Number.isSafeInteger(id) && id > 0)
    ),
  ];

  if (tripIds.length === 0) {
    return {
      reply: "No hay traslados asociados al club 1926.",
      trips: [],
    };
  }

  const now = new Date().toISOString();
  if (intent === "count_upcoming_trips") {
    const { count, error } = await supabase
      .from("trips")
      .select("id", { count: "exact", head: true })
      .in("id", tripIds)
      .gte("departure_datetime", now);

    if (error) {
      throw createQueryError(
        "No se pudo calcular la cantidad de traslados del club 1926.",
        "TRIP_QUERY_FAILED",
        error
      );
    }

    return {
      reply: `Hay ${count || 0} traslados futuros asociados al club 1926.`,
      trips: [],
    };
  }

  const { data, error } = await supabase
    .from("trips")
    .select("id, name, type, status, departure_datetime, start_time")
    .in("id", tripIds)
    .gte("departure_datetime", now)
    .order("departure_datetime", { ascending: true })
    .limit(20);

  if (error) {
    throw createQueryError(
      "No se pudieron cargar los traslados del club 1926.",
      "TRIP_QUERY_FAILED",
      error
    );
  }

  const trips = Array.isArray(data) ? data : [];
  return {
    reply: trips.length
      ? `Estos son los próximos ${trips.length} traslados del club 1926:`
      : "No hay traslados futuros asociados al club 1926.",
    trips,
  };
}

module.exports = {
  queryTrips,
};
