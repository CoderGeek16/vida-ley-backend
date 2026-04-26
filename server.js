require('dotenv').config();

const express = require("express");
const cors = require("cors");
const { createClient } = require('@supabase/supabase-js');
const puppeteer = require("puppeteer");
const fs = require("fs");
const path = require("path");

const app = express();

app.use(cors());
app.use(express.json());

// ===============================
// 🔌 SUPABASE
// ===============================
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_KEY
);

// ===============================
// 🔐 ADMIN CONTROL
// ===============================
let isAdmin = false;

function checkAdmin(req, res, next){
  if(!isAdmin){
    return res.status(403).json({ ok:false, msg:"No autorizado" });
  }
  next();
}

// ===============================
// 🔐 AUTH
// ===============================
app.post("/auth/login", (req, res) => {
  const { password } = req.body;

  if (password === process.env.APP_ACCESS_PASSWORD) {
    isAdmin = true;
    return res.json({ ok: true });
  }

  res.json({ ok: false });
});

app.post("/auth/logout", (req, res) => {
  isAdmin = false;
  res.json({ ok: true });
});

app.get("/auth/status", (req, res) => {
  res.json({
    authenticated: isAdmin
  });
});

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

  } catch {
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
// 📄 PDF
// ===============================
const PDFDocument = require("pdfkit");

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

    const doc = new PDFDocument();
    let buffers = [];

    doc.on("data", buffers.push.bind(buffers));

    doc.on("end", async () => {
      const pdfBuffer = Buffer.concat(buffers);

      const fileName = `vida_${Date.now()}.pdf`;

      await supabase.storage
        .from("pdfs")
        .upload(fileName, pdfBuffer, {
          contentType: "application/pdf"
        });

      const { data } = await supabase.storage
        .from("pdfs")
        .createSignedUrl(fileName, 300);

      res.json({ ok:true, url:data.signedUrl });
    });

    // CONTENIDO PDF
    doc.fontSize(16).text("DECLARACIÓN VIDA LEY", { align:"center" });
    doc.moveDown();

    doc.text(`Nombre: ${col.nombres}`);
    doc.text(`DNI: ${col.dni}`);
    doc.moveDown();

    doc.text("Beneficiarios:");
    doc.moveDown();

    (beneficiarios || []).forEach((b, i) => {
      doc.text(`${i+1}. ${b.apellido_paterno} ${b.apellido_materno}, ${b.nombres}`);
    });

    doc.end();

  } catch (err) {
    console.error("ERROR PDF:", err);
    res.status(500).json({ ok:false });
  }
});

// ===============================
// 🔥 ADMIN ENDPOINTS
// ===============================

// colaboradores
app.get("/admin/colaboradores", checkAdmin, async (req, res) => {

  const { data, error } = await supabase
    .from("colaboradores")
    .select("*");

  res.json({ ok:true, data });

});

// beneficiarios por colaborador
app.get("/admin/beneficiarios/:id", checkAdmin, async (req, res) => {

  const { data } = await supabase
    .from("beneficiarios")
    .select("*")
    .eq("id_colaborador", req.params.id);

  res.json({ ok:true, data });

});

// historial
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

// total beneficiarios
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
