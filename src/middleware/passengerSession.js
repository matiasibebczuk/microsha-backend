const crypto = require("crypto");

const SECRET =
  process.env.PASSENGER_SESSION_SECRET ||
  process.env.SUPABASE_SERVICE_ROLE_KEY ||
  "microsha-passenger-fallback-secret";

function base64urlEncode(input) {
  return Buffer.from(input)
    .toString("base64")
    .replace(/=/g, "")
    .replace(/\+/g, "-")
    .replace(/\//g, "_");
}

function base64urlDecode(input) {
  const normalized = input.replace(/-/g, "+").replace(/_/g, "/");
  const padded = normalized + "=".repeat((4 - (normalized.length % 4)) % 4);
  return Buffer.from(padded, "base64").toString("utf8");
}

function signPayload(payloadJson) {
  return crypto
    .createHmac("sha256", SECRET)
    .update(payloadJson)
    .digest("hex");
}

function issuePassengerToken(userId, ttlSeconds = 60 * 60 * 12) {
  const exp = Math.floor(Date.now() / 1000) + ttlSeconds;
  const payload = JSON.stringify({ userId, exp });
  const encodedPayload = base64urlEncode(payload);
  const signature = signPayload(payload);
  return `${encodedPayload}.${signature}`;
}

function verifyPassengerToken(token) {
  if (!token || typeof token !== "string" || !token.includes(".")) {
    return null;
  }

  const [encodedPayload, receivedSignature] = token.split(".");
  if (!encodedPayload || !receivedSignature) {
    return null;
  }

  let payload;
  try {
    payload = base64urlDecode(encodedPayload);
  } catch {
    return null;
  }

  const expectedSignature = signPayload(payload);
  const receivedBuf = Buffer.from(receivedSignature, "utf8");
  const expectedBuf = Buffer.from(expectedSignature, "utf8");

  if (
    receivedBuf.length !== expectedBuf.length ||
    !crypto.timingSafeEqual(receivedBuf, expectedBuf)
  ) {
    return null;
  }

  let parsed;
  try {
    parsed = JSON.parse(payload);
  } catch {
    return null;
  }

  const now = Math.floor(Date.now() / 1000);
  if (!parsed?.userId || !parsed?.exp || parsed.exp < now) {
    return null;
  }

  return parsed;
}

function getPassengerTokenFromRequest(req) {
  const headerToken = req.headers["x-passenger-token"];
  if (headerToken) return headerToken;

  const authHeader = req.headers.authorization || "";
  if (authHeader.toLowerCase().startsWith("bearer ")) {
    return authHeader.slice(7).trim();
  }

  return null;
}

function requirePassengerSession(req, res, next) {
  const token = getPassengerTokenFromRequest(req);
  const payload = verifyPassengerToken(token);

  if (!payload?.userId) {
    return res.status(401).json({ error: "Passenger session required" });
  }

  req.passengerUserId = payload.userId;
  return next();
}

module.exports = {
  issuePassengerToken,
  verifyPassengerToken,
  getPassengerTokenFromRequest,
  requirePassengerSession,
};
