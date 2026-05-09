require('dotenv').config();

const express = require("express");
const cors = require("cors");
const cookieParser = require("cookie-parser");
const helmet = require("helmet");
const rateLimit = require("express-rate-limit");
const jwt = require("jsonwebtoken");
const bcrypt = require("bcryptjs");
const { createClient } = require('@supabase/supabase-js');
const PDFDocument = require("pdfkit");

const app = express();
app.set("trust proxy", 1);
// ===============================
// CONFIG
// ===============================
const PORT = process.env.PORT || 3000;

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

// ===============================
// MIDDLEWARE
// ===============================
app.use(helmet());

app.use(cors({
  origin: [
     "https://registrovidaley.netlify.app"
  ],
  credentials: true
}));

app.use(express.json());
app.use(cookieParser());

app.use(rateLimit({
windowMs: 15 * 60 * 1000,
max: 100
}));

// ===============================
// JWT
// ===============================
function generarToken(user){
return jwt.sign(
{ id: user.id, rol: user.rol },
process.env.JWT_SECRET,
{ expiresIn: "2h" }
);
}

function verificarToken(req, res, next){
const token = req.cookies.token;

if(!token){
return res.status(401).json({ ok:false });
}

try{
const decoded = jwt.verify(token, process.env.JWT_SECRET);
req.user = decoded;
next();
}catch{
return res.status(401).json({ ok:false });
}
}

function soloAdmin(req, res, next){
if(req.user.rol !== "admin"){
return res.status(403).json({ ok:false });
}
next();
}

// ===============================
// AUDITORIA
// ===============================
async function logAuditoria(usuario, accion, detalle){
try{
await supabase.from("logs_auditoria").insert([{
usuario,
accion,
detalle,
fecha: new Date()
}]);
}catch(e){
console.error("Error log auditoria", e);
}
}

// ===============================
// 🔐 LOGIN (CORREGIDO + DEBUG)
// ===============================
app.post("/auth/login", async (req, res) => {
try{
const { password } = req.body;

console.log("LOGIN INTENTO:", "admin");

const { data: user, error } = await supabase
  .from("usuarios")
  .select("*")
  .eq("username", "admin")
  .single();

console.log("USUARIO BD:", user);

if(error || !user){
  console.log("❌ Usuario no existe");
  return res.status(401).json({ ok:false });
}

console.log("HASH BD:", user.password);

const valido = await bcrypt.compare(password, user.password);

console.log("RESULTADO BCRYPT:", valido);

if(!valido){
  console.log("❌ Password incorrecto");
  return res.status(401).json({ ok:false });
}

const token = generarToken(user);

res.cookie("token", token, {
  httpOnly: true,
  secure: process.env.NODE_ENV === "production",
  sameSite: process.env.NODE_ENV === "production" ? "none" : "lax",
  maxAge: 1000 * 60 * 60 * 2,
});

await logAuditoria(user.username, "LOGIN", "Inicio sesión");

console.log("✅ LOGIN OK");

res.json({ ok:true });


}catch(e){
console.error("ERROR LOGIN:", e);
res.status(500).json({ ok:false });
}
});

// ===============================
app.post("/auth/logout", (req, res) => {
res.clearCookie("token", {
  httpOnly: true,
  secure: process.env.NODE_ENV === "production",
  sameSite: process.env.NODE_ENV === "production" ? "none" : "lax"
});

app.get("/auth/status", (req, res) => {

const token = req.cookies.token;

if(!token){
  return res.json({
    authenticated:false,
    authEnabled:true
  });
}

try{
  jwt.verify(token, process.env.JWT_SECRET);

  res.json({
    authenticated:true,
    authEnabled:true
  });

}catch{

  res.json({
    authenticated:false,
    authEnabled:true
  });

}
});


// ===============================
// TEST
// ===============================
app.get("/", (req, res) => {
res.send("Servidor funcionando 🚀");
});

// ===============================
// COLABORADOR
// ===============================
app.get("/colaborador/:dni", verificarToken, async (req,res)=>{
  try{

    const dni = req.params.dni;
    if(!/^\d{8}$/.test(dni)){
  return res.status(400).json({
    ok:false,
    msg:"DNI inválido"
  });
}
    console.log("BUSCANDO DNI:", dni);

    const { data, error } = await supabase
      .from("colaboradores")
      .select("*")
      .eq("dni", dni)
      .maybeSingle(); 

    console.log("DATA:", data);
    console.log("ERROR:", error);

    if(error || !data){
      return res.status(404).json({ ok:false });
    }

    res.json({ ok:true, data });

  }catch(e){
    console.error("ERROR SERVIDOR:", e);
    res.status(500).json({ ok:false });
  }
});

// ===============================
// GUARDAR BENEFICIARIO
// ===============================
app.post("/guardar-beneficiario", verificarToken, async (req, res) => {
  try{

    const data = req.body;

    console.log("GUARDANDO BENEFICIARIO:", data);

    const { data: insertado, error } = await supabase
      .from("beneficiarios")
      .insert([data])
      .select()
      .single();

    if(error){
      console.error("ERROR INSERT:", error);
      return res.status(500).json({ ok:false });
    }

    res.json({ ok:true, data: insertado });

  }catch(e){
    console.error("ERROR SERVIDOR:", e);
    res.status(500).json({ ok:false });
  }
});

// ===============================
// GENERAR PDF
// ===============================
  app.post("/generar-pdf", verificarToken, async (req, res) => {
    try{

      const { id_colaborador } = req.body;

      console.log("GENERAR PDF - ID:", id_colaborador);

      // 🔹 1. OBTENER COLABORADOR
      const { data: col, error: errorCol } = await supabase
        .from("colaboradores")
        .select("*")
        .eq("id", id_colaborador)
        .maybeSingle();

      if(errorCol || !col){
        console.error("ERROR COLABORADOR:", errorCol);
        return res.status(400).json({ ok:false, msg:"No colaborador" });
      }

      // 🔹 2. OBTENER BENEFICIARIOS
      const { data: beneficiarios, error: errorBen } = await supabase
        .from("beneficiarios")
        .select("*")
        .eq("id_colaborador", id_colaborador);

      console.log("BENEFICIARIOS:", beneficiarios);

      if(errorBen){
        console.error("ERROR BENEFICIARIOS:", errorBen);
        return res.status(500).json({ ok:false });
      }

      if(!beneficiarios || beneficiarios.length === 0){
        return res.status(400).json({ ok:false, msg:"No beneficiarios" });
      }

      // 🔹 3. CREAR PDF
      const doc = new PDFDocument();
      let buffers = [];

      doc.on("data", buffers.push.bind(buffers));

      doc.on("end", async () => {
        const pdfBuffer = Buffer.concat(buffers);
        const fileName = "vida_" + Date.now() + ".pdf";

        // 🔹 SUBIR A SUPABASE STORAGE
        const { error: uploadError } = await supabase.storage
          .from("pdfs")
          .upload(fileName, pdfBuffer, {
            contentType: "application/pdf",
            upsert: true
          });

        if(uploadError){
          console.error("ERROR UPLOAD:", uploadError);
          return res.status(500).json({ ok:false });
        }

        // 🔹 GENERAR URL TEMPORAL
        const { data } = await supabase.storage
          .from("pdfs")
          .createSignedUrl(fileName, 300);
        console.log("PDF URL:", data.signedUrl);
        res.json({ ok:true, url: data.signedUrl });
      });

      // ===============================
      // ✍️ CONTENIDO PDF
      // ===============================

      doc.fontSize(16).text("DECLARACIÓN VIDA LEY", { align: "center" });
      doc.moveDown();

      doc.fontSize(12).text(`Trabajador: ${col.nombres}`);
      doc.text(`DNI: ${col.dni}`);
      doc.text(`Apellido: ${col.apellido_paterno} ${col.apellido_materno}`);
      doc.moveDown();

      doc.text("BENEFICIARIOS:");
      doc.moveDown();

      beneficiarios.forEach((b, i) => {
        doc.text(`${i+1}. ${b.nombres}`);
        doc.text(`   DNI: ${b.dni}`);
        doc.text(`   Parentesco: ${b.parentesco || "-"}`);
        doc.text(`   Dirección: ${b.direccion || "-"}`);
        doc.moveDown();
      });

      doc.end();

    }catch(e){
      console.error("ERROR PDF:", e);
      res.status(500).json({ ok:false });
    }
  });

// ===============================
// BENEFICIARIOS
// ===============================
app.get("/beneficiarios", verificarToken, async (req, res) => {

  const id_colaborador = req.query.id_colaborador;

  const { data } = await supabase
    .from("beneficiarios")
    .select("*")
    .eq("id_colaborador", id_colaborador);

  res.json({ ok:true, data });
});

// ===============================
// ADMIN
// ===============================
app.get("/admin/colaboradores", verificarToken, soloAdmin, async (req, res) => {
const { data } = await supabase.from("colaboradores").select("*");
res.json({ ok:true, data });
});

app.delete("/eliminar-datos/:id", verificarToken, soloAdmin, async (req, res) => {

await supabase.from("beneficiarios").delete().eq("id_colaborador", req.params.id);
await supabase.from("colaboradores").delete().eq("id", req.params.id);

res.json({ ok:true });
});





// ===============================
app.listen(PORT, () => {
console.log("Servidor corriendo en " + PORT);
});
