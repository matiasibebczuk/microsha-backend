require("dotenv").config();
const express = require("express");
const cors = require("cors");
const compression = require("compression");

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
  if (!value || value === "*" || value === true) return true;
  const values = String(value)
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
  return values.length <= 1 ? values[0] : values;
}

const corsOptions = {
  origin: resolveCorsOrigin(corsOrigin),
  credentials: true,
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'PATCH', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization', 'x-passenger-token', 'x-access-token', 'x-requested-with'],
  exposedHeaders: ['Content-Length', 'X-JSON-Response', 'x-passenger-token'],
  optionsSuccessStatus: 200,
  maxAge: 86400,
};

const missingEnv = ["SUPABASE_URL", "SUPABASE_SERVICE_ROLE_KEY", "PASSENGER_TOKEN_SECRET"].filter(
  (key) => !process.env[key]
);
if (missingEnv.length > 0) {
  console.error("[startup] Missing env variables:", missingEnv.join(", "));
}

app.use(cors(corsOptions));
app.options("*", cors(corsOptions));
app.use(express.json());
app.set("etag", "weak");
app.use(compression({ threshold: 1024 }));


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
