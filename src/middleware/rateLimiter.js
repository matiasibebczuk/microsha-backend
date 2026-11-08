const rateLimit = require("express-rate-limit");
const { verifyPassengerToken, getPassengerTokenFromRequest } = require("./passengerSession");

/**
 * Extracts a distinctive client key so that users on the same NAT / Wi-Fi
 * router have individual buckets and do NOT exhaust each other's limits.
 */
function getClientIdentifier(req) {
  // 1. Authenticated passenger session token
  const passengerToken = getPassengerTokenFromRequest(req);
  if (passengerToken) {
    const payload = verifyPassengerToken(passengerToken);
    if (payload?.userId) {
      return `passenger:${payload.userId}`;
    }
    return `passenger-token:${String(passengerToken).slice(-16)}`;
  }

  // 2. Staff authorization header (Admin / Encargado)
  const authHeader = req.headers.authorization || "";
  if (authHeader.toLowerCase().startsWith("bearer ")) {
    const token = authHeader.slice(7).trim();
    return `staff:${token.slice(-16)}`;
  }

  // 3. Fallback to client IP (derived from req.ip with trust proxy enabled)
  return `ip:${req.ip || "unknown"}`;
}

const standardLimitMessage = {
  error: "Límite de solicitudes alcanzado. Aguardá unos segundos e intentá nuevamente.",
  code: "RATE_LIMIT_EXCEEDED",
};

/**
 * Global protection shield: generous limit allowing normal multi-tab usage
 * while preventing runaway request storms or DDoS.
 * ~3000 requests per 15 minutes per client (~200 req/min).
 */
const globalLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 3000,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: getClientIdentifier,
  message: standardLimitMessage,
  skip: (req) => req.method === "OPTIONS" || req.path === "/ping",
  validate: false,
});

/**
 * Strict authentication limiter for login/registration to prevent brute force.
 * 60 attempts per 5 minutes per client.
 */
const authLimiter = rateLimit({
  windowMs: 5 * 60 * 1000,
  max: 60,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: getClientIdentifier,
  message: {
    error: "Demasiados intentos de acceso. Aguardá unos minutos antes de reintentar.",
    code: "AUTH_RATE_LIMIT_EXCEEDED",
  },
  validate: false,
});

/**
 * Reservation mutations limiter (POST/DELETE/PUT).
 * Allows rapid user interactions (up to 60/min) while preventing bot automation/spam.
 */
const reservationMutationLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 60,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: getClientIdentifier,
  message: {
    error: "Demasiadas solicitudes de reserva. Aguardá unos segundos.",
    code: "RESERVATION_RATE_LIMIT_EXCEEDED",
  },
  validate: false,
});

/**
 * High-frequency read / polling limiter (trips, notifications, mine).
 * 1500 requests per 5 minutes per client (= 300 req/min).
 * Ensures frequent background polling never triggers false 429s.
 */
const pollingLimiter = rateLimit({
  windowMs: 5 * 60 * 1000,
  max: 1500,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: getClientIdentifier,
  message: standardLimitMessage,
  skip: (req) => req.method === "OPTIONS",
  validate: false,
});

module.exports = {
  getClientIdentifier,
  globalLimiter,
  authLimiter,
  reservationMutationLimiter,
  pollingLimiter,
};
