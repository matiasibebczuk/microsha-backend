const express = require("express");
const { createClient } = require("@supabase/supabase-js");
const { issuePassengerToken } = require("../middleware/passengerSession");
const { requirePassengerSession } = require("../middleware/passengerSession");

const router = express.Router();

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

const PHONE_REGEX = /^11\d{8}$/;

function normalizePhone(value) {
  return String(value || "").replace(/\D/g, "").trim();
}

function normalizeDescription(value) {
  return String(value || "").trim();
}

function isPassengerProfileComplete(user) {
  const phone = normalizePhone(user?.phone);
  const description = normalizeDescription(user?.description);
  return PHONE_REGEX.test(phone) && description.length > 0;
}

const withTimeout = async (promise, ms, label) => {
  let timeoutId;

  const timeoutPromise = new Promise((_, reject) => {
    timeoutId = setTimeout(() => {
      reject(new Error(`${label} timeout`));
    }, ms);
  });

  try {
    return await Promise.race([promise, timeoutPromise]);
  } finally {
    clearTimeout(timeoutId);
  }
};

router.post("/register-staff", async (req, res) => {
  try {
    const { name, lastname, email, password, role } = req.body || {};

    if (!name || !lastname || !email || !password || !role) {
      return res.status(400).json({ error: "Faltan datos" });
    }

    const normalizedRole = String(role).toLowerCase().trim();
    if (!["admin", "encargado"].includes(normalizedRole)) {
      return res.status(400).json({ error: "Rol inválido" });
    }

    if (String(password).length < 6) {
      return res.status(400).json({ error: "La contraseña debe tener al menos 6 caracteres" });
    }

    const normalizedEmail = String(email).toLowerCase().trim();

    const { data: createdUser, error: createError } = await withTimeout(
      supabase.auth.admin.createUser({
        email: normalizedEmail,
        password,
        email_confirm: true,
        user_metadata: {
          name,
          lastname,
          role: normalizedRole,
        },
        app_metadata: {
          role: normalizedRole,
        },
      }),
      10000,
      "createUser"
    );

    if (createError || !createdUser?.user) {
      const isDuplicate = createError?.message?.toLowerCase().includes("already") ||
        createError?.message?.toLowerCase().includes("exists");

      return res.status(isDuplicate ? 409 : 500).json({
        error: createError?.message || "No se pudo crear el usuario",
      });
    }

    const authUserId = createdUser.user.id;

    const { error: profileError } = await withTimeout(
      supabase
        .from("profiles")
        .upsert(
          {
            id: authUserId,
            name,
            lastname,
            role: normalizedRole,
          },
          { onConflict: "id" }
        ),
      10000,
      "profiles upsert"
    );

    if (profileError) {
      await supabase.auth.admin.deleteUser(authUserId);
      return res.status(500).json({ error: profileError.message });
    }

    return res.status(201).json({
      id: authUserId,
      name,
      lastname,
      email: normalizedEmail,
      role: normalizedRole,
    });

  } catch (err) {
    console.error("🔥 REGISTER STAFF ERROR:", err);
    return res.status(500).json({ error: "Server exploded" });
  }
});

router.post("/passenger", async (req, res) => {
  try {
    console.log("REQ BODY:", req.body);

    const { dni, memberNumber } = req.body || {};

    console.log("DNI RAW:", dni);
    console.log("SOCIO RAW:", memberNumber);

    if (!dni || !memberNumber) {
      console.log("❌ Missing data");
      return res.status(400).json({ error: "Missing data" });
    }

    const { data: user, error } = await supabase
      .from("users")
      .select("id, name, role, dni, member_number")
      .eq("dni", dni)
      .eq("member_number", memberNumber);

    console.log("USERS FOUND:", user);
    console.log("ERROR:", error);

    if (error) {
      return res.status(500).json({ error: error.message });
    }

    if (!user || user.length === 0) {
      return res.status(401).json({ error: "Invalid credentials" });
    }

    // tomamos el primero
    return res.json(user[0]);

  } catch (err) {
    console.error("🔥 SERVER ERROR:", err);
    res.status(500).json({ error: "Server exploded" });
  }
});

router.post("/passenger-login", async (req, res) => {
  try {
    const { dni, memberNumber } = req.body;

    if (!dni || !memberNumber) {
      return res.status(400).json({ error: "Missing data" });
    }

    const { data: user, error } = await supabase
      .from("users")
      .select("id, name, role, phone, description, suspended_until, suspension_reason")
      .eq("dni", dni)
      .eq("member_number", memberNumber)
      .single();

    if (error || !user) {
      return res.status(401).json({ error: "Datos incorrectos" });
    }

    if (user?.suspended_until && new Date(user.suspended_until).getTime() > Date.now()) {
      return res.status(403).json({
        error: "Cuenta suspendida temporalmente",
        suspendedUntil: user.suspended_until,
        reason: user.suspension_reason || "Sanción activa",
      });
    }

    const passengerToken = issuePassengerToken(user.id);

    const normalizedPhone = normalizePhone(user.phone);
    const normalizedDescription = normalizeDescription(user.description);
    const needsProfileCompletion = !isPassengerProfileComplete({
      phone: normalizedPhone,
      description: normalizedDescription,
    });

    res.json({
      ...user,
      phone: normalizedPhone || null,
      description: normalizedDescription || "",
      needsProfileCompletion,
      passengerToken,
    });

  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Server exploded" });
  }
});

router.put("/passenger-profile", requirePassengerSession, async (req, res) => {
  try {
    const userId = req.passengerUserId;
    const phone = normalizePhone(req.body?.phone);
    const description = normalizeDescription(req.body?.description);

    if (!PHONE_REGEX.test(phone)) {
      return res.status(400).json({
        error: "El teléfono debe empezar con 11 y tener 10 dígitos en total",
      });
    }

    if (!description) {
      return res.status(400).json({ error: "La descripción es obligatoria" });
    }

    const { data: updatedUser, error } = await supabase
      .from("users")
      .update({ phone, description })
      .eq("id", userId)
      .select("id, name, role, phone, description")
      .single();

    if (error || !updatedUser) {
      return res.status(500).json({ error: error?.message || "No se pudo actualizar el perfil" });
    }

    return res.json({
      ...updatedUser,
      needsProfileCompletion: false,
    });
  } catch (err) {
    console.error("🔥 PASSENGER PROFILE ERROR:", err);
    return res.status(500).json({ error: "Server exploded" });
  }
});

module.exports = router;
