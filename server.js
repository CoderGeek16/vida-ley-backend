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
// 🔐 AUTH (LOGIN REAL)
// ===============================
app.post("/auth/login", (req, res) => {
  const { password } = req.body;

  if (password === process.env.APP_ACCESS_PASSWORD) {
    res.cookie("admin", "true", {
    httpOnly: true,
    sameSite: "none", // 🔥 CAMBIO CLAVE
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
// 🔐 PROTECCIÓN ADMIN
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
      console.error("ERROR INSERT:", error);
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
    .select(`
      *,
      parentesco:parentescos(nombre)
    `)
    .eq("id_colaborador", id_colaborador)
    .eq("session_id", session_id);

    const doc = new PDFDocument({ margin: 40 });
    let buffers = [];

    doc.on("data", buffers.push.bind(buffers));

    doc.on("end", async () => {
      try {
        const pdfBuffer = Buffer.concat(buffers);

        const fileName = `vida_${Date.now()}.pdf`;

        const { error: uploadError } = await supabase.storage
          .from("pdfs")
          .upload(fileName, pdfBuffer, {
            contentType: "application/pdf",
            upsert: true
          });

        if (uploadError) {
          console.error("ERROR STORAGE:", uploadError);
          return res.status(500).json({ ok:false });
        }

        const { data } = await supabase.storage
          .from("pdfs")
          .createSignedUrl(fileName, 300);

        res.json({ ok:true, url:data.signedUrl });

      } catch (err) {
        console.error("ERROR FINAL:", err);
        res.status(500).json({ ok:false });
      }
    });

    doc.font("Helvetica");

// TITULO
doc.fontSize(12).text("ANEXO", { align: "center" });
doc.moveDown(0.5);

doc.fontSize(10).text(
  "FORMATO REFERENCIAL DE DECLARACIÓN JURADA DE BENEFICIARIOS\nDEL SEGURO DE VIDA",
  { align: "center" }
);

doc.moveDown(1);

// DATOS TRABAJADOR
doc.rect(40, doc.y, 520, 25).stroke();
doc.text(
  `Nombres y apellidos del trabajador: ${col.nombres} ${col.apellido_paterno} ${col.apellido_materno}`,
  45,
  doc.y + 5
);

doc.moveDown(2);

doc.rect(40, doc.y, 520, 25).stroke();
doc.text(`DNI: ${col.dni}`, 45, doc.y + 5);

doc.moveDown(2);

// SECCION 1
doc.rect(40, doc.y, 520, 20).fillAndStroke("#eeeeee", "#000");
doc.fillColor("#000").text("PRIMEROS BENEFICIARIOS", 45, doc.y + 5);

doc.moveDown(1);

// TABLA HEADER
let y = doc.y;

doc.rect(40, y, 520, 20).stroke();
doc.text("Nombres y apellidos", 45, y + 5);
doc.text("DNI", 250, y + 5);
doc.text("Parentesco", 320, y + 5);
doc.text("F. Nac", 420, y + 5);

y += 20;

// FILAS
beneficiarios.forEach(b => {
  doc.rect(40, y, 520, 20).stroke();

  doc.text(`${b.nombres} ${b.apellido_paterno} ${b.apellido_materno}`, 45, y + 5);
  doc.text(b.dni || "", 250, y + 5);
  doc.text(b.parentesco?.nombre || "", 320, y + 5);
  doc.text(b.fecha_nacimiento || "", 420, y + 5);

  y += 20;
});

doc.moveDown(2);

// FIRMA
doc.text("______________________________", { align: "center" });
doc.text("Firma del trabajador", { align: "center" });

doc.moveDown(2);

doc.text("Lima, " + new Date().toLocaleDateString(), { align: "right" });

doc.end();

} catch (err) {
  console.error("ERROR PDF:", err);
  res.status(500).json({ ok:false });
}

});
// ===============================
// 🔥 ADMIN (PROTEGIDO)
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