process.env.SUPABASE_URL ||= "https://example.supabase.co";
process.env.SUPABASE_SERVICE_ROLE_KEY ||= "test-service-role-key";

const assert = require("node:assert/strict");
const { afterEach, test } = require("node:test");
const {
  interpretRequest,
  normalizeMessage,
} = require("../src/services/bb8/intentInterpreter");
const {
  createOperationPreview,
  prepareMutation,
} = require("../src/services/bb8/mutationPlanner");
const { queryReadOnly } = require("../src/services/bb8/readOnlyQueries");
const { supabase } = require("../src/lib/supabaseClient");

const originalFetch = global.fetch;
const originalApiKey = process.env.OPENAI_API_KEY;
const originalFrom = supabase.from;
const originalRpc = supabase.rpc;

afterEach(() => {
  global.fetch = originalFetch;
  if (originalApiKey === undefined) {
    delete process.env.OPENAI_API_KEY;
  } else {
    process.env.OPENAI_API_KEY = originalApiKey;
  }
  supabase.from = originalFrom;
  supabase.rpc = originalRpc;
});

test("generic upcoming-trip requests can be classified by the provider", async () => {
  process.env.OPENAI_API_KEY = "test-key";
  let requestBody;
  global.fetch = async (_url, options) => {
    requestBody = JSON.parse(options.body);
    return {
      ok: true,
      json: async () => ({
        output: [
          {
            type: "function_call",
            name: "classify_bb8_request",
            arguments: JSON.stringify({ intent: "list_upcoming_trips" }),
          },
        ],
      }),
    };
  };

  const result = await interpretRequest("mostrame los traslados");

  assert.equal(result.intent, "list_upcoming_trips");
  assert.equal(requestBody.input, "mostrame los traslados");
  assert.equal(requestBody.store, false);
});

test("person-identifying and unsupported-scope requests never reach the provider", async () => {
  process.env.OPENAI_API_KEY = "test-key";
  let providerCalls = 0;
  global.fetch = async () => {
    providerCalls += 1;
    throw new Error("Provider must not receive this request");
  };

  const personSearch = await interpretRequest('busca a "juan perez"');
  const scopedRequest = await interpretRequest("mostrame los traslados del grupo 123");

  assert.equal(personSearch.intent, "search_person");
  assert.equal(scopedRequest.reason, "scope_mismatch");
  assert.equal(providerCalls, 0);
});

test("person history is recognized locally", async () => {
  process.env.OPENAI_API_KEY = "test-key";
  let providerCalls = 0;
  global.fetch = async () => {
    providerCalls += 1;
    throw new Error("Provider must not receive this request");
  };

  const result = await interpretRequest(
    normalizeMessage('historial de "Gómez José"')
  );

  assert.equal(result.intent, "person_history");
  assert.equal(result.entityName, "gomez jose");
  assert.equal(providerCalls, 0);
});

test("mutation requests never reach the provider", async () => {
  process.env.OPENAI_API_KEY = "test-key";
  let providerCalls = 0;
  global.fetch = async () => {
    providerCalls += 1;
    throw new Error("Provider must not receive this request");
  };

  const result = await interpretRequest(
    'crear usuario "Gómez José" dni 12345678 socio 123456'
  );

  assert.equal(result.reason, "write_not_available");
  assert.equal(providerCalls, 0);
});

test("passenger creation previews preserve and normalize the supplied name", async () => {
  const result = await prepareMutation(
    'Crear usuario "Gómez José" DNI 12345678 socio 123456'
  );

  assert.equal(result.kind, "preview");
  assert.deepEqual(result.action, {
    type: "user_create",
    name: "GÓMEZ JOSÉ",
    dni: "12345678",
    member_number: "123456",
    group_number: 1926,
    role: "pasajero",
  });
  assert.match(result.preview.action, /DNI: 12345678/);
});

test("incomplete passenger creation is rejected without creating a preview", async () => {
  const result = await prepareMutation('Crear usuario "Gómez José" DNI 12345678');

  assert.equal(result.kind, "unsupported");
  assert.match(result.reply, /No realicé cambios/);
});

test("passenger creation requires both surname and given name", async () => {
  const result = await prepareMutation(
    'Crear usuario "Gómez" DNI 12345678 socio 123456'
  );

  assert.equal(result.kind, "clarification");
  assert.match(result.reply, /apellido y nombre/);
});

test("read-only trip queries resolve targets only from club 1926 links", async () => {
  const queryLog = [];
  supabase.from = (table) => {
    const query = {
      select: (selection) => {
        queryLog.push({ table, method: "select", selection });
        return query;
      },
      eq: (field, value) => {
        queryLog.push({ table, method: "eq", field, value });
        return query;
      },
      in: (field, values) => {
        queryLog.push({ table, method: "in", field, values });
        return query;
      },
      order: () => query,
      limit: () => query,
      then: (resolve, reject) => {
        const result =
          table === "trip_groups"
            ? { data: [{ trip_id: 7 }], error: null }
            : table === "trips"
              ? {
                  data: [
                    {
                      id: 7,
                      name: "Ruta norte",
                      type: "ida",
                      status: "open",
                      departure_datetime: "2026-12-01T10:00:00Z",
                      start_time: "10:00",
                    },
                  ],
                  error: null,
                }
              : {
                  data: [
                    {
                      stop_id: 12,
                      pickup_time: "09:30",
                      order_index: 1,
                      stops: { name: "Centro" },
                    },
                  ],
                  error: null,
                };
        return Promise.resolve(result).then(resolve, reject);
      },
    };
    return query;
  };

  const result = await queryReadOnly(
    "list_trip_stops",
    "Ruta norte",
    'paradas del traslado "Ruta norte"'
  );

  assert.match(result.reply, /Paradas de Ruta norte/);
  assert.equal(result.records[0].title, "Centro");
  assert.ok(
    queryLog.some(
      (entry) =>
        entry.table === "trip_groups" &&
        entry.method === "eq" &&
        entry.field === "group_id" &&
        entry.value === 1926
    )
  );
  assert.ok(
    queryLog.some(
      (entry) =>
        entry.table === "trips" &&
        entry.method === "in" &&
        entry.field === "id" &&
        entry.values.length === 1 &&
        entry.values[0] === 7
    )
  );
});

test("stored previews use the persistent RPC and expire within five minutes", async () => {
  let rpcCall;
  supabase.rpc = async (functionName, parameters) => {
    rpcCall = { functionName, parameters };
    return { data: { ok: true, status: "pending" }, error: null };
  };
  const preview = { title: "Test", action: "Create passenger" };

  const result = await createOperationPreview(
    "admin-user-id",
    { type: "user_create", group_number: 1926 },
    preview
  );

  assert.equal(rpcCall.functionName, "bb8_create_operation");
  assert.equal(rpcCall.parameters.p_actor_id, "admin-user-id");
  assert.equal(rpcCall.parameters.p_action.type, "user_create");
  assert.ok(result.id);
  const ttl = Date.parse(result.expiresAt) - Date.now();
  assert.ok(ttl > 0 && ttl <= 5 * 60 * 1000);
});
