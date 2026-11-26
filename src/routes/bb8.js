const express = require("express");
const { authenticateClubAdmin } = require("../services/bb8/clubAccess");
const {
  interpretRequest,
  MAX_MESSAGE_LENGTH,
  normalizeMessage,
} = require("../services/bb8/intentInterpreter");
const {
  createOperationPreview,
  prepareMutation,
} = require("../services/bb8/mutationPlanner");
const { supabase } = require("../lib/supabaseClient");
const { queryReadOnly } = require("../services/bb8/readOnlyQueries");
const { CLUB_ID } = require("../services/bb8/clubAccess");
const {
  appendCancellationLog,
  invalidateReservationCaches,
  promoteWaitingPassengersIfNeeded,
} = require("../services/reservationLifecycle");

const router = express.Router();
const OPERATION_ID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

router.get("/availability", async (req, res) => {
  try {
    await authenticateClubAdmin(req);
    return res.json({ enabled: true, clubId: CLUB_ID });
  } catch (error) {
    if (Number(error?.status) === 401 || Number(error?.status) === 403) {
      return res.json({ enabled: false });
    }
    console.error("[BB8] Availability check failed", {
      code: error?.code || "AVAILABILITY_CHECK_FAILED",
      message: error?.message || "unknown",
    });
    return res.status(503).json({
      enabled: false,
      error: "No se pudo validar el acceso a BB8.",
    });
  }
});

router.post("/query", async (req, res) => {
  let operation = "authenticate";
  try {
    const user = await authenticateClubAdmin(req);

    const rawMessage = String(req.body?.message || "").trim();
    const message = normalizeMessage(rawMessage);
    if (!message || rawMessage.length > MAX_MESSAGE_LENGTH) {
      return res.status(400).json({
        error: `El mensaje debe tener entre 1 y ${MAX_MESSAGE_LENGTH} caracteres.`,
        code: "INVALID_MESSAGE",
        module: "input",
        operation: "query",
        executed: false,
      });
    }

    operation = "prepare_mutation";
    const mutation = await prepareMutation(rawMessage);
    if (mutation?.kind === "clarification" || mutation?.kind === "unsupported") {
      return res.json({
        reply: mutation.reply,
        trips: [],
      });
    }

    if (mutation?.kind === "preview") {
      const pendingOperation = await createOperationPreview(
        user.id,
        mutation.action,
        mutation.preview
      );
      return res.json({
        reply: "Revisá la vista previa. No se realizó ningún cambio.",
        trips: [],
        pendingOperation,
      });
    }

    operation = "interpret_request";
    const interpretation = await interpretRequest(message);

    if (
      interpretation.intent === "unsupported" &&
      interpretation.reason === "write_not_available"
    ) {
      return res.json({
        reply:
          "Esa modificación todavía no está habilitada y no realicé cambios. Puedo preparar cambios de horario, cierre de traslados abiertos, altas de pasajeros y bajas individuales de inscripciones; todos requieren revisar y confirmar una vista previa.",
        trips: [],
      });
    }

    if (
      interpretation.intent === "unsupported" &&
      interpretation.reason === "filtered_query_not_available"
    ) {
      return res.json({
        reply:
          "No puedo filtrar traslados por fecha o persona. Para consultar un traslado específico, indicá su nombre exacto entre comillas.",
        trips: [],
      });
    }

    if (
      interpretation.intent === "unsupported" &&
      interpretation.reason === "scope_mismatch"
    ) {
      return res.json({
        reply:
          "BB8 solo puede consultar el club 1926. No procesé la solicitud para otro alcance.",
        trips: [],
      });
    }

    if (interpretation.intent === "unsupported") {
      return res.json({
        reply:
          interpretation.mode === "rules"
            ? "No pude identificar una consulta soportada. Podés preguntar por traslados, paradas, inscriptos, ocupación o por una persona con su nombre entre comillas."
            : "Por ahora puedo consultar los próximos traslados y su cantidad. No realicé cambios.",
        trips: [],
      });
    }

    operation = interpretation.intent;
    const result = await queryReadOnly(
      interpretation.intent,
      interpretation.entityName,
      message
    );
    if (interpretation.mode === "rules") {
      return res.json({
        ...result,
        reply:
          process.env.OPENAI_API_KEY && interpretation.intent === "unsupported"
            ? result.reply
            : `${result.reply} (Consulta limitada; no se enviaron datos personales a OpenAI.)`,
        interpretation: "rules",
      });
    }

    return res.json({
      ...result,
      interpretation: "openai",
    });
  } catch (error) {
    const status = Number(error?.status) || 500;
    const code = error?.code || "BB8_QUERY_FAILED";
    const module = error?.module || "auth";

    if (status >= 500) {
      console.error("[BB8] Request failed", {
        module,
        operation,
        code,
        message: error?.message || "unknown",
        cause: error?.cause?.message || null,
      });
    }

    return res.status(status).json({
      error:
        status < 500
          ? error.message
          : error?.module === "intent"
            ? error.message
            : "No se pudo completar la consulta. No se realizaron cambios.",
      code,
      module,
      operation,
      executed: false,
    });
  }
});

router.post("/operations/:id/confirm", async (req, res) => {
  let operation = "confirm_operation";
  try {
    const user = await authenticateClubAdmin(req);
    const operationId = String(req.params.id || "");
    if (!OPERATION_ID_PATTERN.test(operationId)) {
      return res.status(400).json({
        error: "La operación de confirmación no es válida.",
        code: "INVALID_OPERATION_ID",
        module: "confirmation",
        operation,
        executed: false,
      });
    }

    const { data, error } = await supabase.rpc("bb8_execute_operation", {
      p_id: operationId,
      p_actor_id: user.id,
    });
    if (error) {
      throw error;
    }

    if (!data?.ok) {
      const messages = {
        OPERATION_EXPIRED: "La vista previa venció. Volvé a solicitar la operación.",
        OPERATION_NOT_FOUND: "La operación no existe o no pertenece a tu sesión.",
        OPERATION_ALREADY_HANDLED: "Esta operación ya fue procesada y no puede reutilizarse.",
        PREVIEW_STALE: "Los datos cambiaron desde la vista previa. Revisá la información y volvé a solicitarla.",
        TRIP_OUTSIDE_CLUB: "No se pudo validar que el traslado pertenezca al club 1926.",
        TRIP_NOT_CANCELLABLE: "El traslado ya no puede cerrarse con esta vista previa.",
        TRIP_HAS_ACTIVE_RUN: "El traslado ya tiene un recorrido activo y no se puede modificar.",
        TRIP_NOT_EDITABLE: "El traslado ya no está abierto y no se puede modificar con esta vista previa.",
        RESERVATION_NOT_FOUND: "La inscripción ya no existe o no corresponde a esa persona y traslado.",
        INVALID_RESERVATION: "La inscripción cambió desde la vista previa. Volvé a solicitar la operación.",
        DUPLICATE_DNI: "Ya existe un usuario con ese DNI. No se creó otro registro.",
        INVALID_USER: "Los datos del pasajero no cumplen los requisitos para crear el usuario.",
      };
      return res.status(409).json({
        error: messages[data?.code] || "No se pudo ejecutar esta operación.",
        code: data?.code || "OPERATION_REJECTED",
        module: "confirmation",
        operation,
        executed: data?.status === "succeeded",
        verified: false,
        status: data?.status || null,
      });
    }

    const tripId = Number(data.result?.tripId);
    const field = data.result?.field;
    let verificationError = null;
    let expectedValue;
    let actualValue;
    let verified = false;
    let verificationDetails = {};
    let promotedCount = Number(data.result?.promotedCount) || 0;
    let postExecutionError = null;
    let cancellationLogged = data.result?.cancellationLogged === true;
    let promotionCompleted = data.result?.promotionCompleted === true;

    if (field === "reservation_removed" && data.result?.verified !== true) {
      try {
        invalidateReservationCaches(tripId);
        if (!cancellationLogged) {
          await appendCancellationLog({
            canceled_at: new Date().toISOString(),
            trip_id: tripId,
            user_id: data.result?.userId,
            reservation_id: data.result?.reservationId,
            status_at_cancel: data.result?.previousValue,
            user_name: data.result?.userName,
            description: data.result?.userDescription,
          });
          cancellationLogged = true;
          const { error: logStateError } = await supabase.rpc(
            "bb8_record_verification",
            {
              p_id: operationId,
              p_actor_id: user.id,
              p_verified: false,
              p_details: {
                cancellationLogged,
                promotionCompleted,
                promotedCount,
              },
            }
          );
          if (logStateError) throw logStateError;
        }
        if (!promotionCompleted && data.result?.previousValue === "confirmed") {
          const promotion = await promoteWaitingPassengersIfNeeded(tripId);
          promotedCount = promotion.promotedCount || 0;
        }
        promotionCompleted = true;
        const { error: promotionStateError } = await supabase.rpc(
          "bb8_record_verification",
          {
            p_id: operationId,
            p_actor_id: user.id,
            p_verified: false,
            p_details: {
              cancellationLogged,
              promotionCompleted,
              promotedCount,
            },
          }
        );
        if (promotionStateError) throw promotionStateError;
      } catch (error) {
        postExecutionError = error;
        console.error("[BB8] Reservation removal follow-up failed", {
          operationId,
          code: error?.code || "RESERVATION_FOLLOW_UP_FAILED",
          message: error?.message || "unknown",
        });
      } finally {
        invalidateReservationCaches(tripId);
      }
    }

    if (field === "reservation_removed") {
      const { data: reservation, error: reservationError } = await supabase
        .from("reservations")
        .select("id")
        .eq("id", data.result?.reservationId)
        .maybeSingle();
      verificationError = reservationError || postExecutionError;
      expectedValue = "removed";
      actualValue = reservation ? "present" : "removed";
      verified = Boolean(!verificationError && !reservation);
      verificationDetails = {
        tripId,
        reservationId: data.result?.reservationId,
        expectedValue,
        actualValue,
        cancellationLogged,
        promotionCompleted,
        promotedCount,
      };
    } else if (field === "user_created") {
      expectedValue = {
        name: data.result?.name,
        dni: data.result?.dni,
        memberNumber: data.result?.memberNumber,
      };
      const { data: userRecord, error: userError } = await supabase
        .from("users")
        .select("id, name, dni, member_number, group_number, role")
        .eq("id", data.result?.userId)
        .eq("group_number", CLUB_ID)
        .eq("role", "pasajero")
        .maybeSingle();
      verificationError = userError;
      actualValue = userRecord
        ? {
            name: userRecord.name,
            dni: userRecord.dni,
            memberNumber: userRecord.member_number,
          }
        : null;
      verified = Boolean(
        !verificationError &&
          userRecord &&
          String(userRecord.group_number) === String(CLUB_ID) &&
          JSON.stringify(actualValue) === JSON.stringify(expectedValue)
      );
      verificationDetails = {
        userId: data.result?.userId,
        verifiedFields: verified ? Object.keys(expectedValue) : [],
      };
    } else {
      const [tripResult, groupResult] = await Promise.all([
        supabase
          .from("trips")
          .select("id, name, status, start_time")
          .eq("id", tripId)
          .maybeSingle(),
        supabase
          .from("trip_groups")
          .select("trip_id")
          .eq("trip_id", tripId)
          .eq("group_id", CLUB_ID)
          .maybeSingle(),
      ]);

      verificationError = tripResult.error || groupResult.error;
      expectedValue = data.result?.value;
      actualValue =
        field === "start_time"
          ? tripResult.data?.start_time
          : field === "status"
            ? tripResult.data?.status
            : null;
      verified = Boolean(
        !verificationError &&
          tripResult.data &&
          groupResult.data &&
          String(groupResult.data.trip_id) === String(tripId) &&
          actualValue === expectedValue
      );
      verificationDetails = {
        tripId,
        expectedValue,
        actualValue: actualValue ?? null,
      };
    }

    if (verificationError) {
      console.error("[BB8] Post-execution verification query failed", {
        operationId,
        code: verificationError.code || null,
      });
    }

    const { error: verificationWriteError } = await supabase.rpc(
      "bb8_record_verification",
      {
        p_id: operationId,
        p_actor_id: user.id,
        p_verified: verified,
        p_details: verificationDetails,
      }
    );
    if (verificationWriteError) {
      console.error("[BB8] Verification audit update failed", {
        operationId,
        code: verificationWriteError.code || null,
      });
    }

    const auditRecorded = !verificationWriteError;
    const retryable =
      field === "reservation_removed" &&
      (Boolean(postExecutionError) ||
        Boolean(verificationError) ||
        (verified && !auditRecorded));
    const responseResult =
      field === "reservation_removed"
        ? Object.fromEntries(
            Object.entries({
              ...(data.result || {}),
              cancellationLogged,
              promotionCompleted,
              promotedCount,
            }).filter(
              ([key]) => key !== "userDescription"
            )
          )
        : data.result;
    return res.status(verified && auditRecorded ? 200 : 502).json({
      reply:
        verified && auditRecorded
          ? field === "reservation_removed"
            ? `Inscripción de ${data.result?.userName || "la persona"} dada de baja y verificada.${promotedCount > 0 ? ` Se promovieron ${promotedCount} personas de la lista de espera.` : ""}`
            : "Operación completada y verificada."
          : verified
            ? "La operación se ejecutó y verificó, pero no se pudo guardar la verificación en la auditoría."
          : field === "reservation_removed" && retryable
              ? "La inscripción se eliminó, pero no se completó toda la auditoría o actualización de lista de espera. Reintentá la finalización antes de solicitar otra baja."
              : "La operación se ejecutó, pero no se pudo verificar el resultado. Revisá el estado antes de repetirla.",
      code: verified
        ? auditRecorded
          ? null
          : "POST_EXECUTION_AUDIT_FAILED"
        : "POST_EXECUTION_VERIFICATION_FAILED",
      module: "verification",
      operation,
      executed: true,
      verified,
      retryable,
      auditRecorded,
      result: responseResult,
    });
  } catch (error) {
    const status = Number(error?.status) || 500;
    console.error("[BB8] Confirmation failed", {
      module: error?.module || "confirmation",
      operation,
      code: error?.code || "CONFIRMATION_FAILED",
      message: error?.message || "unknown",
    });
    return res.status(status).json({
      error:
        status < 500
          ? error.message
          : "No se pudo confirmar la operación. Verificá el estado antes de reintentar.",
      code: error?.code || "CONFIRMATION_FAILED",
      module: error?.module || "confirmation",
      operation,
      executed: false,
    });
  }
});

router.post("/operations/:id/cancel", async (req, res) => {
  let operation = "cancel_operation";
  try {
    const user = await authenticateClubAdmin(req);
    const operationId = String(req.params.id || "");
    if (!OPERATION_ID_PATTERN.test(operationId)) {
      return res.status(400).json({
        error: "La operación de cancelación no es válida.",
        code: "INVALID_OPERATION_ID",
        module: "confirmation",
        operation,
        executed: false,
      });
    }

    const { data, error } = await supabase.rpc("bb8_cancel_operation", {
      p_id: operationId,
      p_actor_id: user.id,
    });
    if (error) throw error;
    if (!data?.ok) {
      return res.status(409).json({
        error:
          data?.code === "OPERATION_EXPIRED"
            ? "La vista previa ya venció."
            : "La operación ya fue procesada o no pertenece a tu sesión.",
        code: data?.code || "OPERATION_NOT_CANCELLABLE",
        module: "confirmation",
        operation,
        executed: false,
      });
    }

    return res.json({
      reply: "Operación cancelada. No se realizaron cambios.",
      status: "cancelled",
      executed: false,
    });
  } catch (error) {
    const status = Number(error?.status) || 500;
    console.error("[BB8] Operation cancellation failed", {
      operation,
      code: error?.code || "CANCEL_FAILED",
      message: error?.message || "unknown",
    });
    return res.status(status).json({
      error:
        status < 500
          ? error.message
          : "No se pudo cancelar la operación.",
      code: error?.code || "CANCEL_FAILED",
      module: "confirmation",
      operation,
      executed: false,
    });
  }
});

module.exports = router;
