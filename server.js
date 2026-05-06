require('dotenv').config();

const express = require("express");
const cors = require("cors");
const cookieParser = require("cookie-parser");
const helmet = require("helmet");
const rateLimit = require("express-rate-limit");
const jwt = require("jsonwebtoken");
const bcrypt = require("bcryptjs"); // ✔ más estable en Windows
const { createClient } = require('@supabase/supabase-js');
const PDFDocument = require("pdfkit");

const app = express();

// ===============================
// 🔐 CONFIGURACIÓN
// ===============================
const PORT = process.env.PORT || 3000;

const supabase = createClient(
process.env.SUPABASE_URL,
process.env.SUPABASE_SERVICE_ROLE_KEY
);

// ===============================
// 🛡️ MIDDLEWARE
// ===============================
app.use(helmet());

app.use(cors({
origin: ["http://127.0.0.1:5500", "http://localhost:5500", "https://registrovidaley.netlify.app"],
credentials: true
}));

app.use(express.json({ limit: "10kb" }));
app.use(cookieParser());

const limiter = rateLimit({
windowMs: 15 * 60 * 1000,
max: 100
});
app.use(limiter);

// ===============================
// 🔑 JWT
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
return res.status(401).json({ ok:false, msg:"No autenticado" });
}

try{
const decoded = jwt.verify(token, process.env.JWT_SECRET);
req.user = decoded;
next();
}catch(e){
return res.status(401).json({ ok:false, msg:"Token inválido" });
}
}

function soloAdmin(req, res, next){
if(req.user.rol !== "admin"){
return res.status(403).json({ ok:false, msg:"Acceso restringido" });
}
next();
}

// ===============================
// 🧾 LOG AUDITORÍA
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
// 🔐 AUTH
// ===============================
app.post("/auth/login", async (req, res) => {
try{
const { username, password } = req.body;


const { data: user } = await supabase
  .from("usuarios")
  .select("*")
  .eq("username", username)
  .single();

if(!user) return res.status(401).json({ ok:false });

const valido = await bcrypt.compare(password, user.password);

if(!valido) return res.status(401).json({ ok:false });

const token = generarToken(user);

res.cookie("token", token, {
  httpOnly: true,
  secure: false, // ⚠️ en local debe ser false
  sameSite: "lax"
});

await logAuditoria(user.username, "LOGIN", "Inicio sesión");

res.json({ ok:true });


}catch(e){
console.error(e);
res.status(500).json({ ok:false });
}
});

app.post("/auth/logout", (req, res) => {
res.clearCookie("token");
res.json({ ok:true });
});

app.get("/auth/status", (req, res) => {
const token = req.cookies.token;

if(!token) return res.json({ authenticated:false });

try{
jwt.verify(token, process.env.JWT_SECRET);
res.json({ authenticated:true });
}catch{
res.json({ authenticated:false });
}
});

// ===============================
// TEST
// ===============================
app.get("/", (req, res) => {
res.send("Servidor funcionando 🚀");
});

// ===============================
// 👤 COLABORADOR
// ===============================
app.get("/colaborador/:dni", verificarToken, async (req, res) => {

if(!/^\d{8}$/.test(req.params.dni)){
return res.status(400).json({ ok:false, msg:"DNI inválido" });
}

const { data, error } = await supabase
.from("colaboradores")
.select('*, genero:genero(genero)')
.eq("dni", req.params.dni)
.single();

if(error || !data) return res.json({ ok:false });

await logAuditoria(req.user.id, "CONSULTA_DNI", req.params.dni);

res.json({ ok:true, data });
});

// ===============================
// 👨‍👩‍👧 GUARDAR BENEFICIARIO
// ===============================
app.post("/guardar-beneficiario", verificarToken, async (req, res) => {

const data = req.body;

if(!data.id_colaborador || !data.dni){
return res.status(400).json({ ok:false });
}

const { error } = await supabase
.from("beneficiarios")
.insert([data]);

if(error){
console.error(error);
return res.json({ ok:false });
}

await logAuditoria(req.user.id, "REGISTRO_BENEFICIARIO", data.dni);

res.json({ ok:true });
});

// ===============================
// 📄 GENERAR PDF
// ===============================
app.post("/generar-pdf", verificarToken, async (req, res) => {
try{

const { id_colaborador, session_id } = req.body;

const { data: col } = await supabase
  .from("colaboradores")
  .select("*")
  .eq("id", id_colaborador)
  .single();

const { data: beneficiarios } = await supabase
  .from("beneficiarios")
  .select('*, parentesco:parentescos(nombre)')
  .eq("id_colaborador", id_colaborador)
  .eq("session_id", session_id);

const primeros = beneficiarios.filter(b => {
  const p = (b.parentesco?.nombre || "").toLowerCase();
  return p.includes("conyuge") || p.includes("cónyuge") || p.includes("hijo") || p.includes("conviviente");
});

const segundos = beneficiarios.filter(b => {
  const p = (b.parentesco?.nombre || "").toLowerCase();
  return p.includes("padre") || p.includes("madre") || p.includes("hermano");
});

const doc = new PDFDocument({ margin: 40 });
let buffers = [];

doc.on("data", buffers.push.bind(buffers));

doc.on("end", async () => {

  const pdfBuffer = Buffer.concat(buffers);
  const fileName = "vida_" + Date.now() + ".pdf";

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
});

// CONTENIDO PDF
doc.fontSize(12).text("ANEXO", { align: "center" });
doc.moveDown(0.5);

doc.fontSize(10).text(
  "FORMATO REFERENCIAL DE DECLARACIÓN JURADA DE BENEFICIARIOS DEL SEGURO DE VIDA",
  { align: "center" }
);

doc.moveDown(1);

doc.text(`Trabajador: ${col.nombres} ${col.apellido_paterno} ${col.apellido_materno}`);
doc.text(`DNI: ${col.dni}`);

doc.moveDown(1);

doc.text("PRIMEROS BENEFICIARIOS:");
primeros.forEach(b => {
  doc.text(`- ${b.nombres} ${b.apellido_paterno}`);
});

doc.moveDown(1);

doc.text("SEGUNDOS BENEFICIARIOS:");
segundos.forEach(b => {
  doc.text(`- ${b.nombres} ${b.apellido_paterno}`);
});

doc.end();

await logAuditoria(req.user.id, "GENERAR_PDF", id_colaborador);


}catch(err){
console.error(err);
res.status(500).json({ ok:false });
}
});

// ===============================
// 👁️ CONSULTAR BENEFICIARIOS
// ===============================
app.get("/beneficiarios", verificarToken, async (req, res) => {

const { session_id } = req.query;

const { data } = await supabase
.from("beneficiarios")
.select("nombres, apellido_paterno")
.eq("session_id", session_id);

res.json({ ok:true, data });
});

// ===============================
// 🛠️ ADMIN
// ===============================
app.get("/admin/colaboradores", verificarToken, soloAdmin, async (req, res) => {
const { data } = await supabase.from("colaboradores").select("*");
res.json({ ok:true, data });
});

app.get("/admin/historial/:id", verificarToken, soloAdmin, async (req, res) => {

const { data: col } = await supabase.from("colaboradores").select("*").eq("id", req.params.id).single();

const { data: ben } = await supabase.from("beneficiarios").select("*").eq("id_colaborador", req.params.id);

res.json({ ok:true, colaborador:col, beneficiarios:ben });
});

// ===============================
// 🗑️ ELIMINAR DATOS
// ===============================
app.delete("/eliminar-datos/:id", verificarToken, soloAdmin, async (req, res) => {

await supabase.from("beneficiarios").delete().eq("id_colaborador", req.params.id);
await supabase.from("colaboradores").delete().eq("id", req.params.id);

await logAuditoria(req.user.id, "ELIMINACION_DATOS", req.params.id);

res.json({ ok:true });
});

// ===============================
app.listen(PORT, () => {
console.log("Servidor seguro corriendo en " + PORT);
});
