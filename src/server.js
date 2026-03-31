require("dotenv").config();
const express = require("express");
const cors = require("cors");

const authRoutes = require("./routes/auth");
const tripRoutes = require("./routes/trips");
const reservationRoutes = require("./routes/reservations");
const encargadoRoutes = require("./routes/encargado");
const adminRoutes = require("./routes/admin");
const meRoutes = require("./routes/me");
const templatesRoutes = require("./routes/templates");
const groupsRoutes = require("./routes/groups");




const app = express();   // ✅ primero crear
const port = Number(process.env.PORT || 3000);
const corsOrigin = process.env.CORS_ORIGIN || "*";

function resolveCorsOrigin(value) {
  if (!value || value === "*") return true;
  const values = String(value)
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
  return values.length <= 1 ? values[0] : values;
}

const missingEnv = ["SUPABASE_URL", "SUPABASE_SERVICE_ROLE_KEY", "PASSENGER_TOKEN_SECRET"].filter(
  (key) => !process.env[key]
);
if (missingEnv.length > 0) {
  console.error("[startup] Missing env variables:", missingEnv.join(", "));
}

app.use(express.json());
app.use(cors({
  origin: resolveCorsOrigin(corsOrigin),
}));


app.get("/ping", (req, res) => {
  res.send("pong");
});

app.use("/auth", authRoutes);
app.use("/trips", tripRoutes);
app.use("/reservations", reservationRoutes);
app.use("/encargado", encargadoRoutes);
app.use("/admin", adminRoutes);
app.use("/me", meRoutes);
app.use("/templates", templatesRoutes);
app.use("/groups", groupsRoutes);


app.listen(port, () => {
  console.log(`🚀 MicroSHA backend running on port ${port}`);
});
