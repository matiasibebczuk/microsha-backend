const { createBb8Error } = require("./errors");

const MAX_MESSAGE_LENGTH = 500;
const OPENAI_API_URL = "https://api.openai.com/v1/responses";
const DEFAULT_MODEL = "gpt-4.1-mini";
const OPENAI_TIMEOUT_MS = 15000;
const SUPPORTED_INTENTS = new Set([
  "list_upcoming_trips",
  "count_upcoming_trips",
  "unsupported",
]);
const TRIP_QUERY_PATTERN = /\b(traslado|traslados|viaje|viajes)\b/;
const SPECIFIC_DATE_PATTERN =
  /\b(hoy|manana|ayer|lunes|martes|miercoles|jueves|viernes|sabado|domingo)\b|\b\d{1,2}[/-]\d{1,2}([/-]\d{2,4})?\b/;
const CLUB_SCOPE_PATTERN =
  /\b(?:club|grupo|group|organization|organizacion)(?:[_\s]?id)?\s*(?:#|n(?:ro)?\.?)?\s*[:=]?\s*(\d+)\b|\b(?:id|group_id|club_id|organization_id)\s*[:=]?\s*(\d+)\b/g;
const CHANGE_REQUEST_PATTERN =
  /\b(cambia|cambiar|cambie|modifica|modificar|modifique|actualiza|actualizar|edita|editar|elimina|eliminar|borra|borrar|cancela|cancelar|crea|crear|agrega|agregar|quita|quitar|inscribe|inscribir|anota|anotar|marca|marcar|envia|enviar|activa|activar|desactiva|desactivar|habilita|habilitar|pausa|pausar|reactiva|reactivar)\b/;
const COUNT_QUERY_PATTERN = /\b(cuantos|cuantas|cantidad|numero|total)\b/;
const QUOTED_TARGET_PATTERN = /["“]([^"”]{1,100})["”]/;
const BASIC_QUERY_WORDS = new Set([
  "al", "cantidad", "club", "contame", "consulta", "consultame", "consultar",
  "cuanto", "cuantos", "cuantas", "de", "decime", "del", "el", "en", "estan",
  "futuro", "futuros", "hay", "la", "las", "listado", "lista", "listame", "listar",
  "los", "mas", "me", "mostra", "mostrame", "muestra", "mostrar", "numero",
  "podes", "podemos", "podrias", "por", "proxima", "proximas", "proximo",
  "proximos", "quiero", "saber", "son", "total", "traslado", "traslados", "un",
  "una", "ver", "viaje", "viajes", "favor", "1926", "cuales", "dame", "pasame",
  "que", "siguientes", "todas", "todos", "tenemos",
]);
const READ_INTENT_WORDS = {
  attendance: /\b(asistencia|asistencias|presente|presentes|ausente|ausentes|ausencia|ausencias|embarque|embarcado|embarcados)\b/,
  occupancy: /\b(ocupacion|cupo|cupos|capacidad|ocupados)\b/,
  stops: /\b(parada|paradas|recorrido|recorridos)\b/,
  passengers: /\b(inscripto|inscriptos|inscripta|inscriptas|anotado|anotados|pasajero|pasajeros)\b/,
  history: /\b(historial|historico|historia|viajes|traslados)\b/,
  peopleCount: /\b(usuario|usuarios|persona|personas|pasajero|pasajeros)\b/,
};

function normalizeMessage(message) {
  return String(message || "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .trim();
}

function deterministicIntent(message) {
  if (hasUnsupportedClubScope(message)) {
    return { intent: "unsupported", reason: "scope_mismatch" };
  }
  if (CHANGE_REQUEST_PATTERN.test(message)) {
    return { intent: "unsupported", reason: "write_not_available" };
  }
  if (SPECIFIC_DATE_PATTERN.test(message)) {
    return { intent: "unsupported", reason: "filtered_query_not_available" };
  }
  const quotedTarget = message.match(QUOTED_TARGET_PATTERN)?.[1]?.trim() || null;
  const isTripQuery = TRIP_QUERY_PATTERN.test(message);
  if (
    quotedTarget &&
    /\b(busca|buscar|buscame|informacion|datos|contacto|telefono)\b/.test(message)
  ) {
    return { intent: "search_person", entityName: quotedTarget, reason: null };
  }
  if (quotedTarget && READ_INTENT_WORDS.history.test(message) && !isTripQuery) {
    return { intent: "person_history", entityName: quotedTarget, reason: null };
  }
  if (READ_INTENT_WORDS.peopleCount.test(message) && !isTripQuery) {
    if (READ_INTENT_WORDS.history.test(message)) {
      return {
        intent: "person_history",
        entityName: quotedTarget,
        reason: null,
      };
    }
    if (COUNT_QUERY_PATTERN.test(message)) {
      return { intent: "count_people", reason: null };
    }
    if (
      quotedTarget &&
      /\b(busca|buscar|buscame|informacion|datos|contacto|telefono)\b/.test(message)
    ) {
      return { intent: "search_person", entityName: quotedTarget, reason: null };
    }
  }
  if (isTripQuery) {
    if (READ_INTENT_WORDS.attendance.test(message)) {
      return { intent: "read_trip_attendance", entityName: quotedTarget, reason: null };
    }
    if (READ_INTENT_WORDS.occupancy.test(message)) {
      return { intent: "read_trip_occupancy", entityName: quotedTarget, reason: null };
    }
    if (READ_INTENT_WORDS.stops.test(message)) {
      return { intent: "list_trip_stops", entityName: quotedTarget, reason: null };
    }
    if (READ_INTENT_WORDS.passengers.test(message)) {
      return { intent: "list_trip_passengers", entityName: quotedTarget, reason: null };
    }
  }
  if (!TRIP_QUERY_PATTERN.test(message)) {
    return { intent: "unsupported", reason: "unsupported_query" };
  }
  const words = message.match(/[a-z0-9]+/g) || [];
  if (words.some((word) => !BASIC_QUERY_WORDS.has(word))) {
    return { intent: "unsupported", reason: "unsupported_query" };
  }
  return {
    intent: COUNT_QUERY_PATTERN.test(message)
      ? "count_upcoming_trips"
      : "list_upcoming_trips",
    reason: null,
  };
}

function hasUnsupportedClubScope(message) {
  return [...message.matchAll(CLUB_SCOPE_PATTERN)].some((match) => {
    const requestedClubId = match[1] || match[2];
    return Number(requestedClubId) !== 1926;
  });
}

function validateIntentArguments(argumentsText) {
  let parsed;
  try {
    parsed = JSON.parse(argumentsText);
  } catch {
    throw createBb8Error(
      "No se pudo interpretar la respuesta del proveedor de IA.",
      502,
      "INVALID_AI_RESPONSE",
      "intent"
    );
  }

  if (!SUPPORTED_INTENTS.has(parsed?.intent)) {
    return "unsupported";
  }
  return parsed.intent;
}

async function interpretRequest(message) {
  const apiKey = String(process.env.OPENAI_API_KEY || "").trim();
  if (hasUnsupportedClubScope(message)) {
    return {
      intent: "unsupported",
      mode: "rules",
      reason: "scope_mismatch",
    };
  }

  if (CHANGE_REQUEST_PATTERN.test(message)) {
    return { intent: "unsupported", mode: "rules", reason: "write_not_available" };
  }

  if (SPECIFIC_DATE_PATTERN.test(message)) {
    return {
      intent: "unsupported",
      mode: apiKey ? "openai" : "rules",
      reason: "filtered_query_not_available",
    };
  }

  const localIntent = deterministicIntent(message);
  if (
    localIntent.intent !== "unsupported" &&
    !["list_upcoming_trips", "count_upcoming_trips"].includes(localIntent.intent)
  ) {
    return {
      ...localIntent,
      mode: "rules",
    };
  }

  const words = message.match(/[a-z0-9]+/g) || [];
  if (words.some((word) => !BASIC_QUERY_WORDS.has(word))) {
    return {
      ...localIntent,
      mode: "rules",
    };
  }

  if (!apiKey) {
    return {
      ...localIntent,
      mode: "rules",
    };
  }

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), OPENAI_TIMEOUT_MS);

  try {
    const response = await fetch(OPENAI_API_URL, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      signal: controller.signal,
      body: JSON.stringify({
        model: process.env.OPENAI_MODEL || DEFAULT_MODEL,
        instructions:
          "Clasificá el pedido del administrador usando exclusivamente la herramienta disponible. Solo podés elegir listar próximos traslados, contar próximos traslados o unsupported. Elegí unsupported si pide una modificación, filtrar por persona/fecha u otro detalle que la herramienta no soporte, o si no es claramente una consulta de traslados. No solicites ni incluyas IDs de club. No propongas ni ejecutes modificaciones.",
        input: message,
        tools: [
          {
            type: "function",
            name: "classify_bb8_request",
            description: "Clasifica una consulta de solo lectura admitida por BB8.",
            strict: true,
            parameters: {
              type: "object",
              properties: {
                intent: {
                  type: "string",
                  enum: [
                    "list_upcoming_trips",
                    "count_upcoming_trips",
                    "unsupported",
                  ],
                },
              },
              required: ["intent"],
              additionalProperties: false,
            },
          },
        ],
        tool_choice: {
          type: "function",
          name: "classify_bb8_request",
        },
        parallel_tool_calls: false,
        max_output_tokens: 100,
        store: false,
      }),
    });

    if (!response.ok) {
      throw createBb8Error(
        "El proveedor de IA no pudo interpretar la solicitud.",
        502,
        "AI_PROVIDER_ERROR",
        "intent"
      );
    }

    const payload = await response.json();
    const functionCall = Array.isArray(payload?.output)
      ? payload.output.find(
          (item) =>
            item?.type === "function_call" &&
            item?.name === "classify_bb8_request"
        )
      : null;

    if (!functionCall) {
      throw createBb8Error(
        "El proveedor de IA no devolvió una clasificación válida.",
        502,
        "INVALID_AI_RESPONSE",
        "intent"
      );
    }

    return {
      intent: validateIntentArguments(functionCall.arguments),
      mode: "openai",
      reason: null,
      entityName: null,
    };
  } catch (error) {
    if (error?.name === "AbortError") {
      throw createBb8Error(
        "La interpretación de la solicitud agotó el tiempo de espera.",
        504,
        "AI_PROVIDER_TIMEOUT",
        "intent"
      );
    }
    if (error?.status) throw error;

    throw createBb8Error(
      "No se pudo conectar con el proveedor de IA.",
      502,
      "AI_PROVIDER_UNAVAILABLE",
      "intent"
    );
  } finally {
    clearTimeout(timeoutId);
  }
}

module.exports = {
  MAX_MESSAGE_LENGTH,
  interpretRequest,
  normalizeMessage,
};
