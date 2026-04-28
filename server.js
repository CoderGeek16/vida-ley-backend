require("dotenv").config();

const express = require("express");
const cors = require("cors");
const cookieParser = require("cookie-parser");
const { createClient } = require("@supabase/supabase-js");
const PDFDocument = require("pdfkit");

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

const GENERO_LABELS = {
  1: "Masculino",
  2: "Femenino"
};

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

  return parsed.toLocaleDateString("es-PE", {
    day: "numeric",
    month: "long",
    year: "numeric"
  });
}

function getParentescoLabel(id) {
  return PARENTESCO_LABELS[id] || cleanText(id) || "-";
}

function getGeneroLabel(id, fallback = "") {
  return GENERO_LABELS[id] || cleanText(fallback) || "-";
}

function drawTag(doc, x, y, width, height, text, palette) {
  doc
    .save()
    .roundedRect(x, y, width, height, 9)
    .fill(palette.accent);

  doc
    .fillColor("#ffffff")
    .font("Helvetica-Bold")
    .fontSize(11)
    .text(text, x, y + 8, {
      width,
      align: "center"
    })
    .restore();
}

function drawSectionTitle(doc, text, x, y, width, palette) {
  doc
    .font("Helvetica-Bold")
    .fontSize(12)
    .fillColor(palette.primary)
    .text(text, x, y, { width });

  doc
    .moveTo(x, y + 18)
    .lineTo(x + width, y + 18)
    .lineWidth(1)
    .strokeColor(palette.lineStrong)
    .stroke();
}

function drawInfoCard(doc, {
  x,
  y,
  width,
  title,
  fields,
  palette
}) {
  const padding = 14;

  doc
    .save()
    .roundedRect(x, y, width, 102, 16)
    .fillAndStroke("#ffffff", palette.line);

  doc
    .roundedRect(x, y, width, 28, 16)
    .fill(palette.soft);

  doc
    .fillColor(palette.primary)
    .font("Helvetica-Bold")
    .fontSize(10.5)
    .text(title, x + padding, y + 9, {
      width: width - (padding * 2)
    });

  let currentY = y + 38;

  fields.forEach((field) => {
    doc
      .fillColor(palette.muted)
      .font("Helvetica-Bold")
      .fontSize(7.5)
      .text(field.label.toUpperCase(), x + padding, currentY, {
        width: width - (padding * 2)
      });

    currentY += 10;

    doc
      .fillColor(palette.ink)
      .font("Helvetica")
      .fontSize(10)
      .text(field.value || "-", x + padding, currentY, {
        width: width - (padding * 2)
      });

    currentY += 18;
  });

  doc.restore();
}

function drawCallout(doc, {
  x,
  y,
  width,
  text,
  palette
}) {
  doc.font("Helvetica").fontSize(8.3);

  const height = Math.max(28, doc.heightOfString(text, {
    width: width - 26,
    align: "left"
  }) + 14);

  doc
    .save()
    .roundedRect(x, y, width, height, 10)
    .fillAndStroke("#fbfcfd", palette.line);

  doc
    .roundedRect(x, y, 6, height, 10)
    .fill(palette.accent);

  doc
    .fillColor(palette.muted)
    .font("Helvetica")
    .fontSize(8.3)
    .text(text, x + 14, y + 7, {
      width: width - 24,
      lineGap: 1.5
    })
    .restore();

  return height;
}

function getTableRowHeight(doc, row, columns, cellPadding) {
  const minHeight = 26;

  const tallest = columns.reduce((maxHeight, column) => {
    const textHeight = doc.heightOfString(row[column.key] || "-", {
      width: column.width - (cellPadding * 2),
      align: column.align || "left"
    });

    return Math.max(maxHeight, textHeight + (cellPadding * 2));
  }, minHeight);

  return Math.max(minHeight, tallest);
}

function drawTableRow(doc, {
  x,
  y,
  row,
  columns,
  height,
  palette,
  isHeader = false,
  zebra = false
}) {
  const cellPadding = 6;
  let cursorX = x;

  columns.forEach((column) => {
    const fillColor = isHeader
      ? palette.primary
      : zebra
        ? palette.zebra
        : "#ffffff";

    doc
      .save()
      .rect(cursorX, y, column.width, height)
      .fillAndStroke(fillColor, palette.line);

    doc
      .fillColor(isHeader ? "#ffffff" : palette.ink)
      .font(isHeader ? "Helvetica-Bold" : "Helvetica")
      .fontSize(isHeader ? 8.7 : 8.6)
      .text(row[column.key] || "-", cursorX + cellPadding, y + cellPadding, {
        width: column.width - (cellPadding * 2),
        align: column.align || "left"
      })
      .restore();

    cursorX += column.width;
  });
}

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

  res.json({ ok: false });
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
    const { data } = await supabase
      .from("colaboradores")
      .select("*")
      .eq("dni", req.params.dni)
      .single();

    if (!data) return res.json({ ok: false });

    res.json({ ok: true, data });
  } catch (err) {
    console.error(err);
    res.json({ ok: false });
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
      return res.json({ ok: false });
    }

    res.json({ ok: true });
  } catch (err) {
    console.error(err);
    res.json({ ok: false });
  }
});

app.post("/generar-pdf", async (req, res) => {
  try {

    const { id_colaborador, session_id } = req.body;

    if (!id_colaborador || !session_id) {
      return res.json({ ok: false, msg: "Datos incompletos" });
    }

    const { data: col } = await supabase
      .from("colaboradores")
      .select("*")
      .eq("id", id_colaborador)
      .single();

    if (!col) {
      return res.json({ ok: false, msg: "Colaborador no existe" });
    }

    const { data: beneficiarios } = await supabase
      .from("beneficiarios")
      .select("*")
      .eq("id_colaborador", id_colaborador)
      .eq("session_id", session_id);

    if (!beneficiarios || beneficiarios.length === 0) {
      return res.json({ ok: false, msg: "Sin beneficiarios" });
    }

    const doc = new PDFDocument({ margin: 40 });
    const buffers = [];

    doc.on("data", buffers.push.bind(buffers));

    doc.on("end", async () => {

      const pdfBuffer = Buffer.concat(buffers);

      // 🔥 INTENTO STORAGE (sin romper si falla)
      try {
        const fileName = `vida_${Date.now()}.pdf`;

        const { error } = await supabase.storage
          .from("pdfs")
          .upload(fileName, pdfBuffer, {
            contentType: "application/pdf",
            upsert: true
          });

        if (!error) {
          const { data } = await supabase.storage
            .from("pdfs")
            .createSignedUrl(fileName, 300);

          if (data?.signedUrl) {
            return res.json({ ok: true, url: data.signedUrl });
          }
        }

      } catch (e) {
        console.log("Storage falló, se envía directo");
      }

      // 🔥 SI FALLA STORAGE → ENVÍA PDF IGUAL
      res.setHeader("Content-Type", "application/pdf");
      res.setHeader("Content-Disposition", "inline; filename=vida_ley.pdf");
      return res.send(pdfBuffer);

    });

    // ===============================
    // PDF (tu diseño actual)
    // ===============================
    doc.fontSize(12).text("DECLARACIÓN JURADA VIDA LEY", { align: "center" });

    doc.moveDown();

    doc.text(
      `Trabajador: ${col.apellido_paterno} ${col.apellido_materno}, ${col.nombres}`
    );

    doc.text(`DNI: ${col.dni}`);

    doc.moveDown();

    doc.text("BENEFICIARIOS:");

    beneficiarios.forEach((b, i) => {
      doc.text(
        `${i + 1}. ${b.apellido_paterno} ${b.apellido_materno}, ${b.nombres} - DNI: ${b.dni}`
      );
    });

    doc.moveDown(3);

    doc.text("__________________________");
    doc.text("Firma");

    doc.end();

  } catch (err) {
    console.error(err);
    res.json({ ok: false, msg: "Error generando PDF" });
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
