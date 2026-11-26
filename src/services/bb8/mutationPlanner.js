const crypto = require("node:crypto");
const { supabase } = require("../../lib/supabaseClient");
const { CLUB_ID } = require("./clubAccess");
const { createBb8Error } = require("./errors");
const { findClubPassengersByExactName } = require("./readOnlyQueries");
const { getTripStatus, invalidateReservationCaches } = require("../reservationLifecycle");

const PREVIEW_TTL_MS = 5 * 60 * 1000;
const TIME_CHANGE_PATTERN =
  /^(?:cambia|cambiar|modifica|modificar|actualiza|actualizar|edita|editar)\s+(?:el\s+)?(?:horario|hora)\s+(?:(?:del|de|al)\s+)?traslado\s+["“]([^"”]+)["”]\s+(?:a|para)\s+(?:las\s+)?(\d{1,2}:\d{2})$/i;
const CANCEL_TRIP_PATTERN =
  /^(?:cancela|cancelar|cierra|cerrar)\s+(?:el\s+)?traslado\s+["“]([^"”]+)["”]$/i;
const CREATE_PASSENGER_PATTERN =
  /^crear\s+(?:un\s+)?(?:usuario|pasajero)\s+["“]([^"”]{3,100})["”]\s+(?:dni\s*)[:#]?\s*(\d{7,9})\s+(?:socio|n[uú]mero\s+de\s+socio|nro\s+de\s+socio)\s*[:#]?\s*(0|\d{6})$/iu;
const REMOVE_PASSENGER_PATTERN =
  /^(?:elimina|eliminar|quita|quitar|da\s+de\s+baja|dar\s+de\s+baja)\s+(?:a\s+)?["“]([^"”]{3,100})["”]\s+(?:del|de\s+el)\s+traslado\s+["“]([^"”]{1,100})["”]$/i;
const MUTATION_VERB_PATTERN =
  /\b(cambia|cambiar|cambie|modifica|modificar|modifique|actualiza|actualizar|edita|editar|elimina|eliminar|borra|borrar|cancela|cancelar|crea|crear|agrega|agregar|quita|quitar|inscribe|inscribir|anota|anotar|marca|marcar|envia|enviar|activa|activar|desactiva|desactivar|habilita|habilitar|pausa|pausar|reactiva|reactivar|cierra|cerrar|da|dar|baja)\b/i;

function isValidClockTime(value) {
  const match = String(value || "").match(/^(\d{1,2}):(\d{2})$/);
  if (!match) return false;
  const hours = Number(match[1]);
  const minutes = Number(match[2]);
  return hours >= 0 && hours <= 23 && minutes >= 0 && minutes <= 59;
}

function normalizeClockTime(value) {
  const [hours, minutes] = String(value).split(":");
  return `${hours.padStart(2, "0")}:${minutes}`;
}

function normalizeName(value) {
  return String(value || "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .trim()
    .toLowerCase();
}

async function findClubTripByExactName(name) {
  const { data: links, error: linksError } = await supabase
    .from("trip_groups")
    .select("trip_id")
    .eq("group_id", CLUB_ID);

  if (linksError) {
    throw createBb8Error(
      "No se pudo validar el alcance del traslado.",
      502,
      "TRIP_SCOPE_QUERY_FAILED",
      "trips"
    );
  }

  const tripIds = [
    ...new Set(
      (links || [])
        .map((row) => Number(row.trip_id))
        .filter((id) => Number.isSafeInteger(id) && id > 0)
    ),
  ];
  if (tripIds.length === 0) return { matches: [] };

  const { data, error } = await supabase
    .from("trips")
    .select("id, name, type, status, departure_datetime, start_time")
    .in("id", tripIds)
    .order("departure_datetime", { ascending: true })
    .limit(500);

  if (error) {
    throw createBb8Error(
      "No se pudieron cargar los traslados del club 1926.",
      502,
      "TRIP_QUERY_FAILED",
      "trips"
    );
  }

  const expectedName = normalizeName(name);
  return {
    matches: (data || []).filter(
      (trip) => normalizeName(trip.name) === expectedName
    ),
  };
}
async function buildTripOperation(actionType, match) {
  const { matches } = await findClubTripByExactName(match[1]);
  if (matches.length === 0) {
    return {
      kind: "clarification",
      reply:
        "No encontré un traslado del club 1926 con ese nombre exacto. Revisá el nombre o pedime que liste los traslados.",
    };
  }
  if (matches.length > 1) {
    return {
      kind: "clarification",
      reply:
        "Hay más de un traslado con ese nombre. Indicá la fecha exacta o elegí uno de la lista.",
    };
  }

  const trip = matches[0];
  if (actionType === "trip_set_start_time") {
    const newStartTime = normalizeClockTime(match[2]);
    if (trip.status !== "open") {
      return {
        kind: "clarification",
        reply: "Solo puedo cambiar el horario de un traslado abierto.",
      };
    }

    return {
      kind: "preview",
      action: {
        type: actionType,
        trip_id: trip.id,
        expected_start_time: trip.start_time || null,
        new_start_time: newStartTime,
      },
      preview: {
        title: "Cambiar el horario de un traslado",
        tripId: trip.id,
        tripName: trip.name,
        departureDate: trip.departure_datetime,
        currentValue: trip.start_time || "Sin horario configurado",
        newValue: newStartTime,
        action: "Actualizar el horario de salida",
      },
    };
  }

  if (trip.status !== "open") {
    return {
      kind: "clarification",
      reply: "Ese traslado no está abierto y no se puede cancelar desde BB8.",
    };
  }

  return {
    kind: "preview",
    action: {
      type: actionType,
      trip_id: trip.id,
      expected_status: trip.status,
      new_status: "closed",
    },
    preview: {
      title: "Cerrar un traslado",
      tripId: trip.id,
      tripName: trip.name,
      departureDate: trip.departure_datetime,
      currentValue: "Abierto",
      newValue: "Cerrado",
      action: "Cerrar la inscripción. No se eliminarán el traslado ni sus reservas.",
    },
  };
}

async function buildPassengerRemoval(match) {
  const { matches: tripMatches } = await findClubTripByExactName(match[2]);
  if (tripMatches.length === 0) {
    return {
      kind: "clarification",
      reply: "No encontré ese traslado dentro del club 1926. Indicá el nombre exacto entre comillas.",
    };
  }
  if (tripMatches.length > 1) {
    return {
      kind: "clarification",
      reply: "Hay varios traslados con ese nombre. Necesito identificar un traslado único antes de dar de baja la inscripción.",
    };
  }

  const trip = tripMatches[0];
  if (trip.status !== "open") {
    return {
      kind: "clarification",
      reply: "Solo puedo dar de baja una inscripción mientras el traslado está abierto.",
    };
  }
  invalidateReservationCaches(trip.id);
  const tripStatus = await getTripStatus(trip.id);
  if (tripStatus?.hasActiveRun) {
    return {
      kind: "clarification",
      reply: "Ese traslado ya tiene un recorrido activo y no se puede dar de baja una inscripción.",
    };
  }

  const { matches: passengerMatches } = await findClubPassengersByExactName(
    match[1]
  );
  const expectedName = normalizeName(match[1]);
  const exactPassengers = passengerMatches.filter(
    (passenger) => normalizeName(passenger.name) === expectedName
  );
  if (exactPassengers.length === 0) {
    return {
      kind: "clarification",
      reply: "No encontré esa persona como pasajero del club 1926. Indicá el nombre y apellido tal como figuran en el registro.",
    };
  }
  if (exactPassengers.length > 1) {
    return {
      kind: "clarification",
      reply: "Hay varios pasajeros con ese nombre. Necesito un dato que los distinga antes de dar de baja una inscripción.",
    };
  }

  const passenger = exactPassengers[0];
  const { data: reservation, error } = await supabase
    .from("reservations")
    .select("id, trip_id, user_id, status, stop_id, stops(name)")
    .eq("trip_id", trip.id)
    .eq("user_id", passenger.id)
    .in("status", ["confirmed", "waiting"])
    .maybeSingle();

  if (error) {
    throw createBb8Error(
      "No se pudo validar la inscripción de esa persona.",
      502,
      "RESERVATION_QUERY_FAILED",
      "reservations"
    );
  }
  if (!reservation) {
    return {
      kind: "clarification",
      reply: `${passenger.name} no tiene una inscripción activa en ${trip.name}.`,
    };
  }

  const statusLabel =
    reservation.status === "confirmed" ? "Confirmada" : "En lista de espera";
  return {
    kind: "preview",
    action: {
      type: "reservation_cancel",
      trip_id: trip.id,
      reservation_id: reservation.id,
      user_id: passenger.id,
      expected_status: reservation.status,
    },
    preview: {
      title: "Dar de baja una inscripción",
      tripId: trip.id,
      tripName: trip.name,
      departureDate: trip.departure_datetime,
      currentValue: statusLabel,
      newValue: "Inscripción eliminada",
      action: `Dar de baja a ${passenger.name} del traslado. Si corresponde, la lista de espera se actualizará según las reglas vigentes.`,
    },
  };
}

async function prepareMutation(message) {
  const createPassengerMatch = message.match(CREATE_PASSENGER_PATTERN);
  if (createPassengerMatch) {
    const nameParts = createPassengerMatch[1]
      .trim()
      .split(/\s+/)
      .filter(Boolean);
    if (nameParts.length < 2) {
      return {
        kind: "clarification",
        reply: "Para crear el pasajero, indicá apellido y nombre entre comillas, además del DNI y número de socio.",
      };
    }
    const fullName = nameParts.map((part) => part.toUpperCase()).join(" ");
    const dni = createPassengerMatch[2];
    const memberNumber = createPassengerMatch[3];
    return {
      kind: "preview",
      action: {
        type: "user_create",
        name: fullName,
        dni,
        member_number: memberNumber,
        group_number: CLUB_ID,
        role: "pasajero",
      },
      preview: {
        title: "Crear usuario pasajero",
        tripId: null,
        tripName: null,
        departureDate: null,
        currentValue: "Usuario inexistente",
        newValue: fullName,
        action: `Crear usuario del club 1926. DNI: ${dni}. Número de socio: ${memberNumber}.`,
      },
    };
  }

  const timeMatch = message.match(TIME_CHANGE_PATTERN);
  if (timeMatch) {
    if (!isValidClockTime(timeMatch[2])) {
      return {
        kind: "clarification",
        reply: "El horario no es válido. Indicá la hora en formato HH:mm, por ejemplo 10:30.",
      };
    }
    return buildTripOperation("trip_set_start_time", timeMatch);
  }

  const cancelMatch = message.match(CANCEL_TRIP_PATTERN);
  if (cancelMatch) {
    return buildTripOperation("trip_cancel", cancelMatch);
  }

  const removePassengerMatch = message.match(REMOVE_PASSENGER_PATTERN);
  if (removePassengerMatch) {
    return buildPassengerRemoval(removePassengerMatch);
  }

  if (MUTATION_VERB_PATTERN.test(message)) {
    return {
      kind: "unsupported",
      reply:
        "Todavía no puedo preparar esa modificación con seguridad. No realicé cambios. Para horarios, usá: `Cambiar el horario del traslado \"Nombre exacto\" a 10:30`. Para cerrar: `Cancelar el traslado \"Nombre exacto\"`. Para crear un pasajero: `Crear usuario \"Apellido Nombre\" DNI 12345678 socio 123456`. Para una baja: `Dar de baja a \"Apellido Nombre\" del traslado \"Nombre exacto\"`.",
    };
  }

  return null;
}

async function createOperationPreview(actorId, action, preview) {
  const id = crypto.randomUUID();
  const expiresAt = new Date(Date.now() + PREVIEW_TTL_MS).toISOString();
  const { data, error } = await supabase.rpc("bb8_create_operation", {
    p_id: id,
    p_actor_id: actorId,
    p_action: action,
    p_preview: preview,
    p_expires_at: expiresAt,
  });

  if (error) {
    throw createBb8Error(
      "No se pudo guardar la vista previa. Verificá que la migración de BB8 esté aplicada. No se realizaron cambios.",
      503,
      "BB8_CONFIRMATION_STORAGE_UNAVAILABLE",
      "confirmation"
    );
  }
  if (!data?.ok) {
    throw createBb8Error(
      "No se pudo validar la operación para preparar la confirmación.",
      409,
      data?.code || "BB8_PREVIEW_REJECTED",
      "confirmation"
    );
  }

  return {
    id,
    ...preview,
    expiresAt,
  };
}

module.exports = {
  createOperationPreview,
  prepareMutation,
};
