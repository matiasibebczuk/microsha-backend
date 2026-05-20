const jwt = require("jsonwebtoken");

module.exports = async function auth(req, res, next) {
  try {
    const header = req.headers.authorization;

    if (!header) {
      return res.status(401).json({ error: "No token" });
    }

    const token = header.replace("Bearer ", "");

    // 🔥 decodificar JWT localmente
    const decoded = jwt.decode(token);

    if (!decoded) {
      return res.status(401).json({ error: "Invalid token" });
    }

    // 🔥 compatibilidad con Supabase + roles
    req.user = {
      id: decoded.sub,
      email: decoded.email,

      app_metadata: decoded.app_metadata || {},
      user_metadata: decoded.user_metadata || {},

      raw_app_meta_data: decoded.app_metadata || {},
      raw_user_meta_data: decoded.user_metadata || {},

      ...decoded,
    };

    next();
  } catch (err) {
    console.error("AUTH ERROR:", err);

    return res.status(401).json({
      error: "Auth failed",
    });
  }
};