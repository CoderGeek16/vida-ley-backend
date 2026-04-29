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

    // 🔥 SEPARAR BENEFICIARIOS
    const primeros = beneficiarios.filter(b =>
    ["Conyuge", "Hijo", "Hija", "Conviviente"].includes(b.parentesco?.nombre)
    );

  const segundos = beneficiarios.filter(b =>
  ["Padre", "Madre", "Hermano"].includes(b.parentesco?.nombre)
  );

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

    const startX = 40;
    const width = 520;

    // =========================
    // TITULO
    // =========================
    doc.fontSize(12).text("ANEXO", { align: "center" });
    doc.moveDown(0.5);

    doc.fontSize(10).text(
      "FORMATO REFERENCIAL DE DECLARACIÓN JURADA DE BENEFICIARIOS DEL SEGURO DE VIDA",
      { align: "center" }
    );

    doc.moveDown(0.5);

    doc.fontSize(9).text(
      "(Decreto Legislativo N° 688 y sus normas modificatorias, complementarias y reglamentarias)",
      { align: "center" }
    );

    doc.moveDown(1);

    doc.fontSize(8).text(
      "El/la suscrito(a), de acuerdo a lo dispuesto en el artículo 6 del Decreto Legislativo N° 688, Ley de Consolidación de Beneficios Sociales, formula la presente Declaración Jurada sobre los beneficiarios del seguro de vida en caso de fallecimiento natural o en caso de fallecimiento a consecuencia de un accidente.",
      { align: "justify" }
    );

    doc.moveDown(1);

    // =========================
    // DATOS TRABAJADOR
    // =========================
    let y = doc.y;

    doc.rect(startX, y, width, 40).stroke();

    doc.moveTo(startX + 380, y)
       .lineTo(startX + 380, y + 40)
       .stroke();

    doc.fontSize(9).text(
      `Nombres y apellidos del trabajador(a) asegurado(a): ${col.nombres} ${col.apellido_paterno} ${col.apellido_materno}`,
      startX + 5,
      y + 5,
      { width: 370 }
    );

    doc.text(`DNI: ${col.dni}`, startX + 385, y + 5);

    doc.moveDown(3);

    y = doc.y;
    doc.rect(startX, y, width, 25).stroke();
    doc.text("Nombre o razón social del empleador: Trabajos Marítimos S.A.", startX + 5, y + 7);

    doc.moveDown(2);

    // =========================
    // FUNCION TABLA
    // =========================
    function dibujarTabla(lista, yStart) {

  let y = yStart;
  const colX = [startX, 200, 280, 380, 470];

  // HEADER
  doc.rect(startX, y, width, 20).stroke();

  const headers = ["Nombre y apellidos", "DNI", "Parentesco", "Fecha de nacimiento", "Domicilio"];

  headers.forEach((h, i) => {
    doc.text(h, colX[i] + 5, y + 5, { width: 80 });
  });

  colX.slice(1).forEach(x => {
    doc.moveTo(x, y).lineTo(x, y + 20).stroke();
  });

  y += 20;

  // SI NO HAY DATOS
  if (lista.length === 0) {
    doc.rect(startX, y, width, 20).stroke();
    doc.text("SIN REGISTROS", startX + 5, y + 5);
    return y + 20;
  }

  // FILAS
  lista.forEach(b => {

    const nombre = `${b.nombres} ${b.apellido_paterno} ${b.apellido_materno}`;
    const dni = b.dni || "";
    const parentesco = b.parentesco?.nombre || "";
    const fecha = b.fecha_nacimiento || "";
    const domicilio = b.domicilio || "";

    const rowHeight = 25;

    doc.rect(startX, y, width, rowHeight).stroke();

    doc.text(nombre, startX + 5, y + 5, { width: 150 });
    doc.text(dni, colX[1] + 5, y + 5);
    doc.text(parentesco, colX[2] + 5, y + 5);
    doc.text(fecha, colX[3] + 5, y + 5);
    doc.text(domicilio, colX[4] + 5, y + 5, { width: 90 });

    colX.slice(1).forEach(x => {
      doc.moveTo(x, y).lineTo(x, y + rowHeight).stroke();
    });

    y += rowHeight;
  });

  return y;
}
    // =========================
    // PRIMEROS BENEFICIARIOS
    // =========================
    y = doc.y;

    doc.rect(startX, y, width, 20).fill("#d9d9d9");
    doc.fillColor("black").text(
      "Primeros Beneficiarios: Cónyuge o conviviente y descendientes (*) (**)",
      startX + 5,
      y + 5
    );

    doc.moveDown(1.5);

    y = dibujarTabla(primeros, doc.y);

    doc.moveDown(0.5);

    doc.fontSize(7).text(
  "(*) A falta de cónyuge, se puede nombrar como beneficiario a la persona con la cual conviva por un periodo mínimo de dos (2) años continuos, conforme al artículo 326 del Código Civil.\n(**) En el caso de los descendientes, solo a falta de hijos puede nombrarse nietos de conformidad con lo establecido en los artículos 816 y 817 del Código Civil.",
  startX,
  doc.y,
  { width: width, align: "justify" }
);

    // =========================
    // SEGUNDOS BENEFICIARIOS
    // =========================
    doc.moveDown(2);

    y = doc.y;

    doc.rect(startX, y, width, 20).fill("#d9d9d9");
    doc.fillColor("black").text(
      "Solo a falta de los Primeros Beneficiarios: Ascendientes y hermanos menores de dieciocho (18) años (***)",
      startX + 5,
      y + 5
    );

    doc.moveDown(1.5);

    y = dibujarTabla(segundos, doc.y);

    doc.moveDown(0.5);

    doc.fontSize(7).text(
      "(***) En el caso de los ascendientes, solo a falta de ambos padres puede nombrarse abuelos de conformidad con lo establecido en los artículos 816 y 817 del Código Civil.",
      { align: "center" }
    );

    // =========================
    // FIRMA
    // =========================
    doc.moveDown(3);

    doc.text("______________________________", { align: "center" });
    doc.text("Firma del trabajador(a) asegurado(a)", { align: "center" });
    doc.text("(Legalizada notarialmente, o por Juez de Paz a falta de notario)", { align: "center", fontSize: 7 });

    doc.moveDown(2);

    doc.text("Lima, " + new Date().toLocaleDateString(), { align: "right" });

    doc.end();

  } catch (err) {
    console.error(err);
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