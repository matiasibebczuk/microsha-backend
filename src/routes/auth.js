const express = require("express");
const { createClient } = require("@supabase/supabase-js");
const { issuePassengerToken } = require("../middleware/passengerSession");

const router = express.Router();

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

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
      .select("id, name, role")
      .eq("dni", dni)
      .eq("member_number", memberNumber)
      .single();

    if (error || !user) {
      return res.status(401).json({ error: "Datos incorrectos" });
    }

    const passengerToken = issuePassengerToken(user.id);

    res.json({
      ...user,
      passengerToken,
    });

  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Server exploded" });
  }
});

module.exports = router;
