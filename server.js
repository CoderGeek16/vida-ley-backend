require("dotenv").config();

const express = require("express");
const cors = require("cors");
const cookieParser = require("cookie-parser");
const { createClient } = require("@supabase/supabase-js");
const PDFDocument = require("pdfkit");

const app = express();

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

  if (password === process.env.APP_ACCESS_PASSWORD) {
    res.cookie("admin", "true", {
      httpOnly: true,
      sameSite: "none",
      secure: true
    });

    return res.json({ ok: true });
  }

  res.json({ ok: false });
});

app.post("/auth/logout", (req, res) => {
  res.clearCookie("admin");
  res.json({ ok: true });
});

app.get("/auth/status", (req, res) => {
  res.json({
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
  res.send("Servidor funcionando");
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

    const { data: col } = await supabase
      .from("colaboradores")
      .select("*")
      .eq("id", id_colaborador)
      .single();

    const { data: beneficiarios } = await supabase
      .from("beneficiarios")
      .select("*")
      .eq("id_colaborador", id_colaborador)
      .eq("session_id", session_id);

    const doc = new PDFDocument({
      size: "A4",
      margins: { top: 32, right: 42, bottom: 38, left: 42 }
    });
    const buffers = [];

    doc.on("data", buffers.push.bind(buffers));

    doc.on("end", async () => {
      try {
        const pdfBuffer = Buffer.concat(buffers);
        const fileName = `vida_${Date.now()}.pdf`;

        await supabase.storage
          .from("pdfs")
          .upload(fileName, pdfBuffer, {
            contentType: "application/pdf",
            upsert: true
          });

        const { data } = await supabase.storage
          .from("pdfs")
          .createSignedUrl(fileName, 300);

        res.json({ ok: true, url: data.signedUrl });
      } catch (err) {
        console.error(err);
        res.status(500).json({ ok: false });
      }
    });

    const palette = {
      ink: "#18323d",
      muted: "#61717c",
      primary: "#0a6772",
      accent: "#d98a3b",
      soft: "#eef5f6",
      line: "#c9d4db",
      lineStrong: "#8fa7b4",
      zebra: "#f8fbfc"
    };

    const marginX = 42;
    const contentWidth = doc.page.width - (marginX * 2);
    const leftCardWidth = 318;
    const gap = 14;
    const rightCardWidth = contentWidth - leftCardWidth - gap;
    const cardY = 172;

    const primeros = (beneficiarios || []).filter((b) => b.tipo === "PRIMERO");
    const segundos = (beneficiarios || []).filter((b) => b.tipo === "SEGUNDO");

    const toTableRows = (items) => items.map((b) => ({
      nombre: buildFullName(b) || "-",
      dni: cleanText(b.dni) || "-",
      parentesco: getParentescoLabel(b.id_parentesco),
      nacimiento: formatShortDate(b.fecha_nacimiento) || "-",
      domicilio: cleanText(b.domicilio) || "-"
    }));

    const drawBeneficiarySection = ({ title, subtitle, rows, y, note }) => {
      drawSectionTitle(doc, title, marginX, y, contentWidth, palette);

      doc
        .fillColor(palette.muted)
        .font("Helvetica")
        .fontSize(8.8)
        .text(subtitle, marginX, y + 24, {
          width: contentWidth
        });

      let cursorY = y + 42;

      const columns = [
        { key: "nombre", width: 154 },
        { key: "dni", width: 66, align: "center" },
        { key: "parentesco", width: 90, align: "center" },
        { key: "nacimiento", width: 80, align: "center" },
        { key: "domicilio", width: 121 }
      ];

      drawTableRow(doc, {
        x: marginX,
        y: cursorY,
        row: {
          nombre: "Beneficiario",
          dni: "DNI",
          parentesco: "Parentesco",
          nacimiento: "Nacimiento",
          domicilio: "Domicilio"
        },
        columns,
        height: 24,
        palette,
        isHeader: true
      });

      cursorY += 24;

      const tableRows = rows.length > 0
        ? rows
        : Array.from({ length: 3 }, () => ({
            nombre: "",
            dni: "",
            parentesco: "",
            nacimiento: "",
            domicilio: ""
          }));

      tableRows.forEach((row, index) => {
        doc.font("Helvetica").fontSize(8.6);

        const rowHeight = getTableRowHeight(doc, row, columns, 6);

        drawTableRow(doc, {
          x: marginX,
          y: cursorY,
          row,
          columns,
          height: rowHeight,
          palette,
          zebra: index % 2 === 1
        });

        cursorY += rowHeight;
      });

      const noteHeight = drawCallout(doc, {
        x: marginX,
        y: cursorY + 10,
        width: contentWidth,
        text: note,
        palette
      });

      return cursorY + noteHeight + 10;
    };

    doc.info = {
      Title: "Declaracion Jurada de Beneficiarios - Seguro de Vida Ley",
      Author: "Registro Vida Ley",
      Subject: "Beneficiarios del Seguro de Vida Ley"
    };

    doc
      .rect(0, 0, doc.page.width, 16)
      .fill(palette.primary);

    drawTag(doc, marginX, 32, 102, 28, "ANEXO", palette);

    doc
      .fillColor(palette.ink)
      .font("Helvetica-Bold")
      .fontSize(15.5)
      .text("DECLARACION JURADA DE BENEFICIARIOS", marginX, 72, {
        width: contentWidth,
        align: "center"
      });

    doc
      .font("Helvetica-Bold")
      .fontSize(13)
      .text("DEL SEGURO DE VIDA LEY", marginX, 92, {
        width: contentWidth,
        align: "center"
      });

    doc
      .fillColor(palette.muted)
      .font("Helvetica")
      .fontSize(9)
      .text("(Decreto Legislativo N° 688)", marginX, 114, {
        width: contentWidth,
        align: "center"
      });

    doc
      .save()
      .roundedRect(marginX, 136, contentWidth, 52, 16)
      .fillAndStroke("#fbfcfd", palette.line)
      .restore();

    doc
      .fillColor(palette.ink)
      .font("Helvetica")
      .fontSize(9.3)
      .text(
        "El/la suscrito(a) formula la presente declaracion jurada sobre los beneficiarios del Seguro de Vida Ley, dejando constancia de la informacion consignada para fines de registro interno y respaldo documentario.",
        marginX + 16,
        151,
        {
          width: contentWidth - 32,
          lineGap: 2,
          align: "justify"
        }
      );

    drawInfoCard(doc, {
      x: marginX,
      y: cardY,
      width: leftCardWidth,
      title: "Datos del trabajador",
      fields: [
        {
          label: "Nombres y apellidos",
          value: buildFullName(col)
        },
        {
          label: "DNI",
          value: cleanText(col.dni)
        },
        {
          label: "Genero",
          value: getGeneroLabel(col.id_genero, col.genero)
        }
      ],
      palette
    });

    drawInfoCard(doc, {
      x: marginX + leftCardWidth + gap,
      y: cardY,
      width: rightCardWidth,
      title: "Datos complementarios",
      fields: [
        {
          label: "Empleador",
          value: cleanText(col.empleador) || "No consignado"
        },
        {
          label: "Fecha de emision",
          value: formatLongDate(new Date())
        },
        {
          label: "Documento",
          value: "Registro referencial de beneficiarios"
        }
      ],
      palette
    });

    let currentY = 292;

    currentY = drawBeneficiarySection({
      title: "Primeros beneficiarios",
      subtitle: "Se consigna conyuge, conviviente o descendientes declarados por el trabajador.",
      rows: toTableRows(primeros),
      y: currentY,
      note: "(*) A falta de conyuge, puede designarse conviviente. (**) Los descendientes se consideran conforme a lo previsto por el Codigo Civil."
    });

    currentY += 16;

    currentY = drawBeneficiarySection({
      title: "Segundos beneficiarios",
      subtitle: "Se registran solo a falta de los primeros beneficiarios declarados.",
      rows: toTableRows(segundos),
      y: currentY,
      note: "(***) Los ascendientes u otros familiares consignados deben responder a la declaracion expresa del trabajador y al sustento normativo aplicable."
    });

    const signatureTop = Math.max(currentY + 24, 708);

    doc
      .moveTo(marginX, signatureTop)
      .lineTo(doc.page.width - marginX, signatureTop)
      .lineWidth(1)
      .strokeColor(palette.line)
      .stroke();

    doc
      .moveTo(marginX + 148, signatureTop + 48)
      .lineTo(marginX + 356, signatureTop + 48)
      .lineWidth(1)
      .strokeColor(palette.lineStrong)
      .stroke();

    doc
      .fillColor(palette.ink)
      .font("Helvetica-Bold")
      .fontSize(9.5)
      .text("Firma del trabajador", marginX + 176, signatureTop + 56, {
        width: 150,
        align: "center"
      });

    doc
      .fillColor(palette.muted)
      .font("Helvetica")
      .fontSize(9)
      .text(`Fecha: ${formatLongDate(new Date())}`, doc.page.width - marginX - 170, signatureTop + 12, {
        width: 170,
        align: "right"
      });

    doc
      .fillColor(palette.muted)
      .font("Helvetica-Oblique")
      .fontSize(7.8)
      .text(
        "Documento generado automaticamente por el sistema de Registro Vida Ley.",
        marginX,
        doc.page.height - 38,
        {
          width: contentWidth,
          align: "center"
        }
      );

    doc.end();
  } catch (err) {
    console.error(err);
    res.status(500).json({ ok: false });
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
