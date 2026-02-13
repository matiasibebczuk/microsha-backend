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

  const { error } = await supabase
    .from("route_template_stops")
    .insert({
      template_id: templateId,
      name,
      order_index,
      offset_minutes,
    });

  if (error) return res.status(500).json({ error: error.message });

  res.json({ success: true });
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
