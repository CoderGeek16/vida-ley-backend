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
// ===============================
// 🇵🇪 PDF SUNAFIL FIX REAL
// ===============================

doc.font("Helvetica");

const X = 40;
let Y = 40;
const W = 520;
const H = 20;

// ===============================
// TITULO
// ===============================
doc.font("Helvetica-Bold").fontSize(11);
doc.text("ANEXO", 0, Y, { align: "center" });

Y += 20;

doc.text("FORMATO REFERENCIAL DE DECLARACIÓN JURADA DE BENEFICIARIOS", {
  align: "center"
});

Y += 15;

doc.text("DEL SEGURO DE VIDA", { align: "center" });

Y += 20;

doc.font("Helvetica").fontSize(9);
doc.text("(Decreto Legislativo N° 688)", { align: "center" });

Y += 30;

// ===============================
// TEXTO
// ===============================
doc.text(
  "El/la suscrito(a), formula la presente Declaración Jurada sobre los beneficiarios del seguro de vida.",
  X,
  Y,
  { width: W }
);

Y += 40;

// ===============================
// DATOS
// ===============================
doc.rect(X, Y, W, H).stroke();
doc.text(
  `Nombres y apellidos del trabajador: ${col.apellido_paterno} ${col.apellido_materno}, ${col.nombres}     DNI: ${col.dni}`,
  X + 5,
  Y + 5
);

Y += H;

doc.rect(X, Y, W, H).stroke();
doc.text(`Empleador: ${col.empleador || ""}`, X + 5, Y + 5);

Y += 40;

// ===============================
// PRIMEROS BENEFICIARIOS
// ===============================
doc.font("Helvetica-Bold");
doc.text("Primeros Beneficiarios:", X, Y);

Y += 15;

// HEADER
doc.rect(X, Y, W, H).stroke();
doc.text("Nombre", X + 5, Y + 5);
doc.text("DNI", X + 200, Y + 5);
doc.text("Parentesco", X + 260, Y + 5);
doc.text("Fecha", X + 350, Y + 5);
doc.text("Domicilio", X + 430, Y + 5);

Y += H;

// FILAS
const primeros = (beneficiarios || []).filter(b => b.tipo === "PRIMERO");

if (primeros.length === 0) {
  for (let i = 0; i < 3; i++) {
    doc.rect(X, Y, W, H).stroke();
    Y += H;
  }
} else {
  primeros.forEach(b => {
    doc.rect(X, Y, W, H).stroke();

    doc.text(`${b.apellido_paterno} ${b.apellido_materno}, ${b.nombres}`, X + 5, Y + 5);
    doc.text(b.dni, X + 200, Y + 5);
    doc.text(b.id_parentesco || "", X + 260, Y + 5);
    doc.text(b.fecha_nacimiento || "", X + 350, Y + 5);
    doc.text(b.domicilio || "", X + 430, Y + 5);

    Y += H;
  });
}

// 👉 NOTAS FIJAS (NO dinámicas)
doc.fontSize(8);
doc.text("(*) A falta de cónyuge, se puede nombrar conviviente.", 380, 260, { width: 180 });
doc.text("(**) Descendientes según Código Civil.", 380, 280, { width: 180 });

Y += 30;

// ===============================
// SEGUNDOS BENEFICIARIOS
// ===============================
doc.font("Helvetica-Bold");
doc.text("Solo a falta de los Primeros Beneficiarios:", X, Y);

Y += 15;

// HEADER
doc.rect(X, Y, W, H).stroke();
doc.text("Nombre", X + 5, Y + 5);
doc.text("DNI", X + 200, Y + 5);
doc.text("Parentesco", X + 260, Y + 5);
doc.text("Fecha", X + 350, Y + 5);
doc.text("Domicilio", X + 430, Y + 5);

Y += H;

// FILAS
const segundos = (beneficiarios || []).filter(b => b.tipo === "SEGUNDO");

if (segundos.length === 0) {
  for (let i = 0; i < 3; i++) {
    doc.rect(X, Y, W, H).stroke();
    Y += H;
  }
} else {
  segundos.forEach(b => {
    doc.rect(X, Y, W, H).stroke();

    doc.text(`${b.apellido_paterno} ${b.apellido_materno}, ${b.nombres}`, X + 5, Y + 5);
    doc.text(b.dni, X + 200, Y + 5);
    doc.text(b.id_parentesco || "", X + 260, Y + 5);
    doc.text(b.fecha_nacimiento || "", X + 350, Y + 5);
    doc.text(b.domicilio || "", X + 430, Y + 5);

    Y += H;
  });
}

// NOTA
doc.fontSize(8);
doc.text("(***) Ascendientes según Código Civil.", 380, 420, { width: 180 });

// ===============================
// FIRMA
// ===============================
Y += 40;

doc.text("______________________________", 200, Y);
doc.text("Firma del trabajador", 210, Y + 15);

// ===============================
// FECHA
// ===============================
const fecha = new Date();

doc.text(
  `Lima, ${fecha.getDate()} de ${fecha.toLocaleString('es-ES', { month: 'long' })} del ${fecha.getFullYear()}`,
  350,
  Y + 50
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
