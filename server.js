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
// 📄 PDF FORMATO PROFESIONAL MINTRA
// ===============================

// ENCABEZADO
doc.font("Helvetica-Bold").fontSize(13);
doc.text("DECLARACIÓN JURADA DE BENEFICIARIOS DEL SEGURO DE VIDA", {
  align: "center"
});

doc.moveDown(0.3);

doc.font("Helvetica").fontSize(10);
doc.text("(Decreto Legislativo N° 688)", { align: "center" });

doc.moveDown(1.5);

// DATOS TRABAJADOR
doc.font("Helvetica-Bold").fontSize(11);
doc.text("1. DATOS DEL TRABAJADOR");

doc.moveDown(0.5);

doc.font("Helvetica").fontSize(10);
doc.text(`Apellidos y Nombres: ${col.apellido_paterno} ${col.apellido_materno}, ${col.nombres}`);
doc.text(`DNI: ${col.dni}`);

doc.moveDown(1);

// ===============================
// 🟦 TABLA BENEFICIARIOS
// ===============================
doc.font("Helvetica-Bold");
doc.text("2. BENEFICIARIOS");

doc.moveDown(0.5);

// TABLA HEADER
const startX = 40;
let y = doc.y;

doc.rect(startX, y, 520, 20).stroke();

doc.fontSize(9).text("N°", startX + 5, y + 5);
doc.text("APELLIDOS Y NOMBRES", startX + 30, y + 5);
doc.text("DNI", startX + 300, y + 5);
doc.text("TIPO", startX + 380, y + 5);

y += 20;

// FILAS
let i = 1;

(beneficiarios || []).forEach(b => {

  doc.rect(startX, y, 520, 20).stroke();

  doc.text(i, startX + 5, y + 5);

  doc.text(
    `${b.apellido_paterno} ${b.apellido_materno}, ${b.nombres}`,
    startX + 30,
    y + 5,
    { width: 250 }
  );

  doc.text(b.dni, startX + 300, y + 5);

  doc.text(
    b.tipo === "PRIMERO" ? "PRIMERO" : "SECUNDARIO",
    startX + 380,
    y + 5
  );

  y += 20;
  i++;
});

// ===============================
// ✍ DECLARACIÓN
// ===============================
doc.moveDown(2);

doc.font("Helvetica").fontSize(10);
doc.text(
  "Declaro bajo juramento que la información proporcionada es veraz y autorizo su uso para los fines del seguro de vida ley.",
  {
    align: "justify"
  }
);

// ===============================
// ✍ FIRMA
// ===============================
doc.moveDown(3);

doc.text("______________________________", 200);
doc.text("Firma del trabajador", 210);

doc.moveDown();

const fecha = new Date();
doc.text(`Fecha: ${fecha.toLocaleDateString()}`, {
  align: "right"
});

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
