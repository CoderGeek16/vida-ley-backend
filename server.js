require("dotenv").config();

const express = require("express");
const cors = require("cors");
const cookieParser = require("cookie-parser");
const { createClient } = require("@supabase/supabase-js");
const fs = require("fs");
const path = require("path");
const puppeteer = require("puppeteer");

const app = express();
const STORAGE_BUCKET = process.env.SUPABASE_STORAGE_BUCKET || "pdfs";
const AUTH_ENABLED = Boolean(process.env.APP_ACCESS_PASSWORD);
const IS_PRODUCTION = process.env.NODE_ENV === "production";

const PARENTESCO_LABELS = {
  1: "Conyuge",
  2: "Hijo(a)",
  3: "Padre",
  4: "Conviviente",
  5: "Madre",
  6: "Hermano(a)"
};

const allowedOrigins = [
  "http://127.0.0.1:5500",
  "http://localhost:5500",
  "https://registrovidaley.netlify.app"
];

app.use(cors({
  origin(origin, callback) {
    if (!origin || allowedOrigins.includes(origin)) {
      callback(null, true);
    } else {
      callback(new Error("No permitido por CORS"));
    }
  },
  credentials: true
}));

app.use(express.json());
app.use(cookieParser());

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_KEY
);

function cleanText(value) {
  return String(value || "").trim();
}

function buildFullName(person) {
  return [
    cleanText(person?.apellido_paterno),
    cleanText(person?.apellido_materno),
    cleanText(person?.nombres)
  ].filter(Boolean).join(" ");
}

function formatShortDate(value) {
  if (!value) return "";

  const parsed = new Date(`${value}T00:00:00`);

  if (Number.isNaN(parsed.getTime())) {
    return cleanText(value);
  }

  return parsed.toLocaleDateString("es-PE", {
    day: "2-digit",
    month: "2-digit",
    year: "numeric"
  });
}

function formatLongDate(value = new Date()) {
  const parsed = value instanceof Date ? value : new Date(value);

  if (Number.isNaN(parsed.getTime())) {
    return "";
  }

  return `Lima, ${parsed.toLocaleDateString("es-PE", {
    day: "numeric",
    month: "long",
    year: "numeric"
  })}`;
}

function getParentescoLabel(id) {
  return PARENTESCO_LABELS[id] || cleanText(id) || "-";
}

function getEmployerName(col) {
  return (
    cleanText(col?.empleador) ||
    cleanText(col?.razon_social_empleador) ||
    cleanText(col?.employer_name) ||
    cleanText(process.env.EMPLOYER_NAME)
  );
}

function escapeHtml(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function resolveTemplatePath() {
  const candidates = [
    path.join(__dirname, "templates", "formato-mintra.html"),
    path.join(__dirname, "template", "formato-mintra.html"),
    path.join(__dirname, "formato-mintra.html")
  ];

  return candidates.find((candidate) => fs.existsSync(candidate)) || null;
}

function buildBeneficiaryRows(beneficiarios, tipo, minRows = 4) {
  const rows = (beneficiarios || [])
    .filter((item) => cleanText(item.tipo).toUpperCase() === tipo)
    .map((item) => ({
      nombre: buildFullName(item),
      dni: cleanText(item.dni),
      parentesco: getParentescoLabel(item.id_parentesco),
      fecha: formatShortDate(item.fecha_nacimiento),
      domicilio: cleanText(item.domicilio)
    }));

  while (rows.length < minRows) {
    rows.push({
      nombre: "&nbsp;",
      dni: "&nbsp;",
      parentesco: "&nbsp;",
      fecha: "&nbsp;",
      domicilio: "&nbsp;"
    });
  }

  return rows;
}

function renderRowsHtml(rows) {
  return rows.map((row) => `
    <tr>
      <td>${row.nombre === "&nbsp;" ? row.nombre : escapeHtml(row.nombre)}</td>
      <td class="center">${row.dni === "&nbsp;" ? row.dni : escapeHtml(row.dni)}</td>
      <td class="center">${row.parentesco === "&nbsp;" ? row.parentesco : escapeHtml(row.parentesco)}</td>
      <td class="center">${row.fecha === "&nbsp;" ? row.fecha : escapeHtml(row.fecha)}</td>
      <td>${row.domicilio === "&nbsp;" ? row.domicilio : escapeHtml(row.domicilio)}</td>
    </tr>
  `).join("");
}

function replaceTokens(html, replacements) {
  let output = html;

  for (const [token, value] of Object.entries(replacements)) {
    output = output.replace(new RegExp(`{{${token}}}`, "g"), value);
  }

  return output;
}

async function launchBrowser() {
  const executablePath = process.env.PUPPETEER_EXECUTABLE_PATH || puppeteer.executablePath();

  return puppeteer.launch({
    executablePath,
    headless: true,
    args: [
      "--no-sandbox",
      "--disable-setuid-sandbox",
      "--disable-dev-shm-usage",
      "--disable-gpu",
      "--font-render-hinting=none"
    ]
  });
}

app.post("/auth/login", (req, res) => {
  const { password } = req.body;

  if (!AUTH_ENABLED) {
    return res.json({ ok: true, authEnabled: false });
  }

  if (password === process.env.APP_ACCESS_PASSWORD) {
    res.cookie("admin", "true", {
      httpOnly: true,
      sameSite: IS_PRODUCTION ? "none" : "lax",
      secure: IS_PRODUCTION
    });

    return res.json({ ok: true });
  }

  res.json({ ok: false, msg: "Clave incorrecta" });
});

app.post("/auth/logout", (req, res) => {
  res.clearCookie("admin", {
    httpOnly: true,
    sameSite: IS_PRODUCTION ? "none" : "lax",
    secure: IS_PRODUCTION
  });
  res.json({ ok: true });
});

app.get("/auth/status", (req, res) => {
  res.json({
    authEnabled: AUTH_ENABLED,
    authenticated: req.cookies.admin === "true"
  });
});

function checkAdmin(req, res, next) {
  if (req.cookies.admin !== "true") {
    return res.status(403).json({ ok: false, msg: "No autorizado" });
  }

  next();
}

app.get("/", (req, res) => {
  res.json({
    ok: true,
    service: "registro-vida-ley",
    storageBucket: STORAGE_BUCKET
  });
});

app.get("/colaborador/:dni", async (req, res) => {
  try {
    const { data, error } = await supabase
      .from("colaboradores")
      .select("*")
      .eq("dni", req.params.dni)
      .single();

    if (error || !data) {
      if (error) console.error("Error buscando colaborador:", error);
      return res.json({ ok: false });
    }

    res.json({ ok: true, data });
  } catch (err) {
    console.error(err);
    res.json({ ok: false, msg: "Error consultando colaborador" });
  }
});

app.post("/guardar-beneficiario", async (req, res) => {
  try {
    const data = {
      id_colaborador: req.body.id_colaborador,
      session_id: req.body.session_id,
      tipo: req.body.tipo,
      dni: req.body.dni,
      nombres: req.body.nombres,
      apellido_paterno: req.body.apellido_paterno,
      apellido_materno: req.body.apellido_materno,
      domicilio: req.body.domicilio,
      id_parentesco: req.body.id_parentesco,
      id_genero: req.body.id_genero,
      fecha_nacimiento: req.body.fecha_nacimiento
    };

    const { error } = await supabase
      .from("beneficiarios")
      .insert([data]);

    if (error) {
      console.error(error);
      return res.json({ ok: false, msg: error.message });
    }

    res.json({ ok: true });
  } catch (err) {
    console.error(err);
    res.json({ ok: false, msg: "Error guardando beneficiario" });
  }
});

app.post("/generar-pdf", async (req, res) => {
  let browser;

  try {
    const { id_colaborador, session_id } = req.body;

    if (!id_colaborador || !session_id) {
      return res.status(400).json({ ok: false, msg: "Datos incompletos" });
    }

    const { data: col, error: errCol } = await supabase
      .from("colaboradores")
      .select("*")
      .eq("id", id_colaborador)
      .single();

    if (errCol || !col) {
      console.error("Error obteniendo colaborador:", errCol);
      return res.status(404).json({ ok: false, msg: "Colaborador no existe" });
    }

    const { data: beneficiarios, error: errBen } = await supabase
      .from("beneficiarios")
      .select("*")
      .eq("id_colaborador", id_colaborador)
      .eq("session_id", session_id);

    if (errBen) {
      console.error("Error obteniendo beneficiarios:", errBen);
      return res.status(500).json({ ok: false, msg: "No se pudieron obtener los beneficiarios" });
    }

    if (!beneficiarios || beneficiarios.length === 0) {
      return res.status(400).json({ ok: false, msg: "Sin beneficiarios" });
    }

    const templatePath = resolveTemplatePath();

    if (!templatePath) {
      return res.status(500).json({ ok: false, msg: "No se encuentra plantilla PDF" });
    }

    let html = fs.readFileSync(templatePath, "utf8");

    html = replaceTokens(html, {
      NOMBRE: escapeHtml(buildFullName(col)),
      DNI: escapeHtml(cleanText(col.dni)),
      EMPLEADOR: escapeHtml(getEmployerName(col)),
      FECHA_LIMA: escapeHtml(formatLongDate(new Date())),
      FILAS_PRIMEROS: renderRowsHtml(buildBeneficiaryRows(beneficiarios, "PRIMERO", 4)),
      FILAS_SEGUNDOS: renderRowsHtml(buildBeneficiaryRows(beneficiarios, "SEGUNDO", 4)),
      FILAS: renderRowsHtml(buildBeneficiaryRows(beneficiarios, "PRIMERO", 4))
    });

    browser = await launchBrowser();

    const page = await browser.newPage();
    await page.setViewport({ width: 1240, height: 1754, deviceScaleFactor: 1 });
    await page.setContent(html, {
      waitUntil: ["domcontentloaded", "load", "networkidle0"]
    });
    await page.emulateMediaType("screen");

    const pdfBuffer = await page.pdf({
      format: "A4",
      printBackground: true,
      preferCSSPageSize: true,
      margin: {
        top: "0mm",
        right: "0mm",
        bottom: "0mm",
        left: "0mm"
      }
    });

    const safeDni = cleanText(col.dni).replace(/[^\dA-Za-z_-]/g, "") || "sin-dni";
    const fileName = `vida-ley/${safeDni}_${Date.now()}.pdf`;

    const { error: uploadError } = await supabase.storage
      .from(STORAGE_BUCKET)
      .upload(fileName, pdfBuffer, {
        contentType: "application/pdf",
        upsert: true
      });

    if (uploadError) {
      console.error("Error subiendo PDF:", uploadError);
      return res.status(500).json({
        ok: false,
        msg: `Error subiendo PDF a Supabase: ${uploadError.message}`
      });
    }

    const { data: signedData, error: signedError } = await supabase.storage
      .from(STORAGE_BUCKET)
      .createSignedUrl(fileName, 300);

    if (signedError || !signedData?.signedUrl) {
      console.error("Error creando signed URL:", signedError);
      return res.status(500).json({
        ok: false,
        msg: `No se pudo generar URL del PDF: ${signedError?.message || "error desconocido"}`
      });
    }

    await supabase
      .from("colaboradores")
      .update({ pdf_nombre: fileName })
      .eq("id", id_colaborador);

    return res.json({
      ok: true,
      url: signedData.signedUrl,
      fileName
    });
  } catch (err) {
    console.error("Error real generando PDF:", err);
    return res.status(500).json({
      ok: false,
      msg: err.message || "Error interno generando PDF"
    });
  } finally {
    if (browser) {
      await browser.close().catch(() => {});
    }
  }
});

app.get("/admin/colaboradores", checkAdmin, async (req, res) => {
  const { data } = await supabase
    .from("colaboradores")
    .select("*");

  res.json({ ok: true, data });
});

app.get("/admin/historial/:id", checkAdmin, async (req, res) => {
  const { data: col } = await supabase
    .from("colaboradores")
    .select("*")
    .eq("id", req.params.id)
    .single();

  const { data: ben } = await supabase
    .from("beneficiarios")
    .select("*")
    .eq("id_colaborador", req.params.id);

  res.json({ ok: true, colaborador: col, beneficiarios: ben });
});

app.get("/admin/total-beneficiarios", checkAdmin, async (req, res) => {
  const { data } = await supabase
    .from("beneficiarios")
    .select("id");

  res.json({ ok: true, total: data.length });
});

const PORT = process.env.PORT || 3000;

app.listen(PORT, () => {
  console.log("Servidor corriendo en " + PORT);
});
