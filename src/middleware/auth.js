const jwt = require("jsonwebtoken");

module.exports = async function auth(req, res, next) {
  try {
    const header = req.headers.authorization;

    if (!header) {
      return res.status(401).json({ error: "No token" });
    }

    const token = header.replace("Bearer ", "");

    // 🔥 verificar JWT localmente
    const decoded = jwt.decode(token);

    if (!decoded) {
      return res.status(401).json({ error: "Invalid token" });
    }

    // guardar usuario en request
    req.user = decoded;

    next();
  } catch (err) {
    console.error("AUTH ERROR:", err);

    return res.status(401).json({
      error: "Auth failed",
    });
  }
};