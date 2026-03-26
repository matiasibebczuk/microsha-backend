const express = require("express");
const { createClient } = require("@supabase/supabase-js");
const auth = require("../middleware/auth");
const { requireRole } = require("../middleware/roles");

const router = express.Router();

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);



// ========================
// LISTAR PLANTILLAS
// ========================
router.get("/", auth, requireRole("admin"), async (req, res) => {
  const { data, error } = await supabase
    .from("route_templates")
    .select("*")
    .order("name");

  if (error) return res.status(500).json({ error: error.message });

  res.json(data);
});



// ========================
// CREAR PLANTILLA
// ========================
router.post("/", auth, requireRole("admin"), async (req, res) => {
  const { name, type } = req.body;

  const { data, error } = await supabase
    .from("route_templates")
    .insert({ name, type })
    .select()
    .single();

  if (error) return res.status(500).json({ error: error.message });

  res.json(data);
});

router.get("/:id/stops", auth, requireRole("admin"), async (req, res) => {
  const templateId = req.params.id;

  const { data, error } = await supabase
    .from("route_template_stops")
    .select("*")
    .eq("template_id", templateId)
    .order("order_index");

  if (error) return res.status(500).json({ error: error.message });

  res.json(data);
});

router.post("/:id/stops", auth, requireRole("admin"), async (req, res) => {
  const templateId = req.params.id;
  const { name, order_index, offset_minutes } = req.body;

  const { data: existing, error: existingError } = await supabase
    .from("route_template_stops")
    .select("id")
    .eq("template_id", templateId)
    .eq("order_index", order_index)
    .maybeSingle();

  if (existingError) return res.status(500).json({ error: existingError.message });

  let error;
  if (existing?.id) {
    const updateResult = await supabase
      .from("route_template_stops")
      .update({
        name,
        offset_minutes,
      })
      .eq("id", existing.id);
    error = updateResult.error;
  } else {
    const insertResult = await supabase
      .from("route_template_stops")
      .insert({
        template_id: templateId,
        name,
        order_index,
        offset_minutes,
      });
    error = insertResult.error;
  }

  if (error) return res.status(500).json({ error: error.message });

  res.json({ success: true });
});

router.put("/:id/stops", auth, requireRole("admin"), async (req, res) => {
  const templateId = req.params.id;
  const incomingStops = Array.isArray(req.body?.stops) ? req.body.stops : null;

  if (!incomingStops) {
    return res.status(400).json({ error: "stops debe ser un array" });
  }

  const normalized = incomingStops.map((stop, index) => {
    const name = String(stop?.name || "").trim();
    const offset = Number.parseInt(stop?.offset_minutes, 10);
    return {
      name,
      order_index: index + 1,
      offset_minutes: Number.isFinite(offset) ? offset : 0,
    };
  });

  const hasInvalid = normalized.some((stop) => !stop.name);
  if (hasInvalid) {
    return res.status(400).json({ error: "Todas las paradas deben tener nombre" });
  }

  const { error: deleteError } = await supabase
    .from("route_template_stops")
    .delete()
    .eq("template_id", templateId);

  if (deleteError) return res.status(500).json({ error: deleteError.message });

  if (normalized.length > 0) {
    const rows = normalized.map((stop) => ({
      template_id: templateId,
      name: stop.name,
      order_index: stop.order_index,
      offset_minutes: stop.offset_minutes,
    }));

    const { error: insertError } = await supabase
      .from("route_template_stops")
      .insert(rows);

    if (insertError) return res.status(500).json({ error: insertError.message });
  }

  return res.json({ success: true });
});

router.delete("/:id", auth, requireRole("admin"), async (req, res) => {
  const templateId = req.params.id;

  const { error } = await supabase
    .from("route_templates")
    .delete()
    .eq("id", templateId);

  if (error) return res.status(500).json({ error: error.message });

  res.json({ success: true });
});


module.exports = router;
