require('dotenv').config();

const express = require("express");
const cors = require("cors");
const cookieParser = require("cookie-parser");
const { createClient } = require('@supabase/supabase-js');
const PDFDocument = require("pdfkit");

const app = express();

// ===============================
// 🔐 MIDDLEWARE
// ===============================
const allowedOrigins = [
  "http://127.0.0.1:5500",
  "http://localhost:5500",
  "https://registrovidaley.netlify.app"
];

app.use(cors({
  origin: function(origin, callback) {
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

// ===============================
// 🔌 SUPABASE
// ===============================
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_KEY
);

// ===============================
// 🔐 AUTH
// ===============================
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

// ===============================
// 🔐 PROTECCIÓN
// ===============================
function checkAdmin(req, res, next){
  if(req.cookies.admin !== "true"){
    return res.status(403).json({ ok:false, msg:"No autorizado" });
  }
  next();
}

// ===============================
// 🟢 TEST
// ===============================
app.get("/", (req, res) => {
  res.send("Servidor funcionando 🚀");
});

// ===============================
// 🔍 COLABORADOR
// ===============================
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

// ===============================
// 💾 GUARDAR BENEFICIARIO
// ===============================
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

// ===============================
// 📄 GENERAR PDF
// ===============================
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

    const doc = new PDFDocument({ margin: 40 });
    let buffers = [];

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

        res.json({ ok:true, url:data.signedUrl });

      } catch (err) {
        console.error(err);
        res.status(500).json({ ok:false });
      }
    });

// ===============================
// 🇵🇪 PDF FORMATO SUNAFIL REAL
// ===============================

// ANEXO
doc.font("Helvetica-Bold").fontSize(11);
doc.text("ANEXO", { align: "center" });

doc.moveDown(0.5);

// TITULO
doc.fontSize(11);
doc.text("FORMATO REFERENCIAL DE DECLARACIÓN JURADA DE BENEFICIARIOS", { align: "center" });
doc.text("DEL SEGURO DE VIDA", { align: "center" });

doc.moveDown(0.3);

doc.font("Helvetica").fontSize(9);
doc.text("(Decreto Legislativo N° 688 y sus normas modificatorias, complementarias y reglamentarias)", {
  align: "center"
});

doc.moveDown(1);

// TEXTO LEGAL
doc.text(
  "El/la suscrito(a), de acuerdo a lo dispuesto en el artículo 6 del Decreto Legislativo N° 688, Ley de Consolidación de Beneficios Sociales, formula la presente Declaración Jurada sobre los beneficiarios del seguro de vida en caso de fallecimiento natural o en caso de fallecimiento a consecuencia de un accidente.",
  { align: "justify" }
);

doc.moveDown(1);

// ===============================
// 📦 CUADRO DATOS
// ===============================
let y = doc.y;

doc.rect(40, y, 520, 20).stroke();
doc.text(
  `Nombres y apellidos del trabajador(a) asegurado(a): ${col.apellido_paterno} ${col.apellido_materno}, ${col.nombres}     DNI: ${col.dni}`,
  45,
  y + 5
);

y += 20;

doc.rect(40, y, 520, 20).stroke();
doc.text(
  `Nombre o razón social del empleador: ${col.empleador || ""}`,
  45,
  y + 5
);

y += 30;

// ===============================
// 🔵 PRIMEROS BENEFICIARIOS
// ===============================
doc.font("Helvetica-Bold").fontSize(10);
doc.text("Primeros Beneficiarios:");

doc.font("Helvetica").fontSize(9);
doc.text("Cónyuge o conviviente y descendientes (*) (**)");

doc.moveDown(0.5);

// TABLA HEADER
const startX = 40;
let rowY = doc.y;

doc.rect(startX, rowY, 520, 20).stroke();

doc.text("Nombre y apellidos", startX + 5, rowY + 5);
doc.text("DNI", startX + 200, rowY + 5);
doc.text("Parentesco", startX + 260, rowY + 5);
doc.text("Fecha Nac.", startX + 350, rowY + 5);
doc.text("Domicilio", startX + 440, rowY + 5);

rowY += 20;

// FILAS
(beneficiarios || [])
  .filter(b => b.tipo === "PRIMERO")
  .forEach(b => {

    doc.rect(startX, rowY, 520, 20).stroke();

    doc.text(`${b.apellido_paterno} ${b.apellido_materno}, ${b.nombres}`, startX + 5, rowY + 5, { width: 180 });
    doc.text(b.dni, startX + 200, rowY + 5);
    doc.text(b.id_parentesco || "", startX + 260, rowY + 5);
    doc.text(b.fecha_nacimiento || "", startX + 350, rowY + 5);
    doc.text(b.domicilio || "", startX + 440, rowY + 5, { width: 80 });

    rowY += 20;
  });

// NOTAS
doc.moveDown(0.5);
doc.fontSize(8);
doc.text("(*) A falta de cónyuge, se puede nombrar conviviente (mínimo 2 años).");
doc.text("(**) Descendientes: hijos o nietos según Código Civil.");

doc.moveDown(1);

// ===============================
// 🔵 SEGUNDOS BENEFICIARIOS
// ===============================
doc.font("Helvetica-Bold").fontSize(10);
doc.text("Solo a falta de los Primeros Beneficiarios:");

doc.font("Helvetica").fontSize(9);
doc.text("Ascendientes y hermanos menores de dieciocho (18) años (***)");

doc.moveDown(0.5);

// TABLA HEADER
rowY = doc.y;

doc.rect(startX, rowY, 520, 20).stroke();

doc.text("Nombre y apellidos", startX + 5, rowY + 5);
doc.text("DNI", startX + 200, rowY + 5);
doc.text("Parentesco", startX + 260, rowY + 5);
doc.text("Fecha Nac.", startX + 350, rowY + 5);
doc.text("Domicilio", startX + 440, rowY + 5);

rowY += 20;

// FILAS
(beneficiarios || [])
  .filter(b => b.tipo === "SEGUNDO")
  .forEach(b => {

    doc.rect(startX, rowY, 520, 20).stroke();

    doc.text(`${b.apellido_paterno} ${b.apellido_materno}, ${b.nombres}`, startX + 5, rowY + 5, { width: 180 });
    doc.text(b.dni, startX + 200, rowY + 5);
    doc.text(b.id_parentesco || "", startX + 260, rowY + 5);
    doc.text(b.fecha_nacimiento || "", startX + 350, rowY + 5);
    doc.text(b.domicilio || "", startX + 440, rowY + 5, { width: 80 });

    rowY += 20;
  });

// NOTA
doc.moveDown(0.5);
doc.fontSize(8);
doc.text("(***) Ascendientes: padres o abuelos según Código Civil.");


// ===============================
// ✍ FIRMA
// ===============================
doc.moveDown(2);

doc.fontSize(10);
doc.text("______________________________", 200);
doc.text("Firma del trabajador(a) asegurado(a)", 190);

doc.moveDown(0.5);
doc.fontSize(8);
doc.text("(Legalizada notarialmente o por Juez de Paz)", 190);

doc.moveDown(1);

// FECHA
const fecha = new Date();
doc.text(
  `Lima, ${fecha.getDate()} de ${fecha.toLocaleString('es-ES', { month: 'long' })} del ${fecha.getFullYear()}`,
  { align: "right" }
);

   doc.end();

  } catch (err) {
    console.error(err);
    res.status(500).json({ ok:false });
  }
});    

// ===============================
// 🔥 ADMIN
// ===============================
app.get("/admin/colaboradores", checkAdmin, async (req, res) => {
  const { data } = await supabase
    .from("colaboradores")
    .select("*");

  res.json({ ok:true, data });
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

  res.json({ ok:true, colaborador:col, beneficiarios:ben });
});

app.get("/admin/total-beneficiarios", checkAdmin, async (req, res) => {
  const { data } = await supabase
    .from("beneficiarios")
    .select("id");

  res.json({ ok:true, total:data.length });
});

// ===============================
const PORT = process.env.PORT || 3000;

app.listen(PORT, () => {
  console.log("Servidor corriendo en " + PORT + " 🚀");
  
});
