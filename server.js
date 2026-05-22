require("dotenv").config();

const express = require("express");
const cors = require("cors");
const cookieParser = require("cookie-parser");
const helmet = require("helmet");
const rateLimit = require("express-rate-limit");
const jwt = require("jsonwebtoken");
const bcrypt = require("bcryptjs");
const { createClient } = require('@supabase/supabase-js');
const PDFDocument = require("pdfkit");

const JWT_SECRET = process.env.JWT_SECRET;

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
    "http://127.0.0.1:5500",
    "http://localhost:5500",
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

  console.log("TOKEN:", token);

  if(!token){
    return res.status(401).json({
      ok:false,
      msg:"Sin token"
    });
  }

  try{

    const decoded = jwt.verify(token, JWT_SECRET);

    console.log("DECODED:", decoded);

    req.user = decoded;

    next();

  }catch(err){

    console.log("ERROR TOKEN:", err);

    return res.status(401).json({
      ok:false,
      msg:"Token inválido"
    });

  }

}

function soloAdmin(req, res, next){

  console.log("ROL:", req.user?.rol);

  if(req.user?.rol !== "admin"){

    return res.status(403).json({
      ok:false,
      msg:"No autorizado"
    });

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

const { dni, password } = req.body;

console.log("BODY:", req.body);

const { data: user, error } = await supabase
.from("usuarios")
.select("*")
.eq("username", dni)
.single();

console.log("USUARIO:", user);
console.log("ERROR SQL:", error);

if(error || !user){
return res.status(401).json({
ok:false,
msg:"Usuario no encontrado"
});
}

const valido = await bcrypt.compare(password, user.password);


if(!valido){
return res.status(401).json({
ok:false,
msg:"Clave incorrecta"
});
}

const token = jwt.sign(
{
id: user.id,
rol: user.rol
},
JWT_SECRET,
{
expiresIn:"2h"
}
);

res.cookie("token", token, {
  httpOnly: true,
  secure: true,
  sameSite: "none",
  maxAge: 1000 * 60 * 60 * 2
});

res.json({
ok:true
});

}catch(err){

console.log("ERROR LOGIN:", err);

res.status(500).json({
ok:false
});

}

});

// ===============================
app.post("/auth/logout", (req, res) => {

res.clearCookie("token", {
  httpOnly: true,
  secure: true,
  sameSite: "none"
});
res.json({ ok:true });

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
app.get("/colaborador/:dni", async (req,res)=>{
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
  .select(`
    *,
    sedes (
      sede
    )
  `)
  .eq("dni", dni)
  .maybeSingle();

if(error || !data){
  return res.status(404).json({ ok:false });
}

// BUSCAR GENERO
const { data: generoData } = await supabase
  .from("genero")
  .select("genero")
  .eq("id_genero", data.id_genero)
  .maybeSingle();

// AGREGAR TEXTO GENERO
data.genero_texto = generoData?.genero || "";
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
app.post("/guardar-beneficiario", async (req, res) => {
  try{

    const data = req.body;

    const { data: colaborador } = await supabase
.from("colaboradores")
.select("dni")
.eq("id", data.id_colaborador)
.single();

if(colaborador?.dni === data.dni){

  return res.status(400).json({
    ok:false,
    msg:"El DNI pertenece al titular"
  });

}

    console.log("GUARDANDO BENEFICIARIO:", data);


      const { data: insertado, error } = await supabase
      .from("beneficiarios")
      .upsert([data], {
        onConflict: "dni"
      })
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
    app.post("/generar-pdf", async (req, res) => {

      try {

    const { id_colaborador, session_id } = req.body;

    console.log("ID COLABORADOR PDF:", id_colaborador);

        const { data: col, error: colError } = await supabase
      .from("colaboradores")
      .select("*")
      .eq("id", id_colaborador)
      .single();

    if (colError || !col) {
  console.log("ERROR COLABORADOR:", colError);

  return res.status(404).json({
    ok: false,
    msg: "No se encontró colaborador"
  });
}

    const { data: beneficiarios } = await supabase
  .from("beneficiarios")
  .select(`
    *,
    parentesco:parentescos(nombre)
  `)
  .eq("id_colaborador", id_colaborador)
  .eq("session_id", session_id);

if (!beneficiarios || beneficiarios.length === 0) {
  return res.status(404).json({
    ok: false,
    msg: "No hay beneficiarios"
  });
}
     

    // =========================
    // SEPARAR BENEFICIARIOS
    // =========================

    const primeros = beneficiarios.filter(b => {

      const p = (b.parentesco?.nombre || "").toLowerCase();

      return (
        p.includes("conyuge") ||
        p.includes("cónyuge") ||
        p.includes("hijo") ||
        p.includes("conviviente")
      );

    });

    const segundos = beneficiarios.filter(b => {

      const p = (b.parentesco?.nombre || "").toLowerCase();

      return (
        p.includes("padre") ||
        p.includes("madre") ||
        p.includes("hermano")
      );

    });

    // =========================
    // PDF
    // =========================

    const doc = new PDFDocument({
      margin: 40,
      size: "A4"
    });

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

        res.json({
          ok: true,
          url: data.signedUrl
        });

      } catch (err) {

        console.error(err);

        res.status(500).json({
          ok: false
        });

      }

    });

    // =========================
    // VARIABLES
    // =========================

    const left = 52;
    const usableWidth = doc.page.width - left * 2;

    const tableColumns = [155, 60, 85, 75, 145];

    const rowHeight = 55;

    const tableHeaderHeight = 38;

    const strokeColor = "#222222";
    const sectionGray = "#d9d9d9";

    const trabajador = `
      ${col.apellido_paterno || ""}
      ${col.apellido_materno || ""},
      ${col.nombres || ""}
    `
    .replace(/\s+/g, " ")
    .trim();

    // =========================
    // HELPERS
    // =========================

    function formatDate(value) {

      if (!value) return "";

      return new Date(value).toLocaleDateString("es-PE");

    }

    function fitText(value, max = 90) {

      const text = String(value || "")
        .replace(/\s+/g, " ")
        .trim();

      if (!text) return "";

      return text.length > max
        ? `${text.slice(0, max - 3)}...`
        : text;

    }

    function drawCell(
  x,
  y,
  width,
  height,
  text,
  options = {}
) {

  const {
    align = "left",
    valign = "top",
    bold = false,
    fill = null,
    fontSize = 9,
    padding = 6
  } = options;

  if (fill) {

    doc.save();

    doc.rect(x, y, width, height)
      .fill(fill);

    doc.restore();

  }

  doc.rect(x, y, width, height)
    .stroke(strokeColor);

  doc.font(
    bold
      ? "Helvetica-Bold"
      : "Helvetica"
  );

  doc.fontSize(fontSize)
    .fillColor("#000");

  const textHeight = doc.heightOfString(text || "", {
  width: width - padding * 2
});

const textY = y + ((height - textHeight) / 2);

  doc.text(
    text || "",
    x + padding,
    textY,
    {
      width: width - padding * 2,
      align
    }
  );

}

    function drawInfoRow(
      y,
      leftLabel,
      leftValue,
      rightLabel,
      rightValue
    ) {

      const leftWidth = 320;

      const rightWidth = usableWidth - leftWidth;

      drawCell(
        left,
        y,
        leftWidth,
        32,
        `${leftLabel}: ${leftValue || ""}`,
        {
          fontSize: 9.5
        }
      );

      drawCell(
        left + leftWidth,
        y,
        rightWidth,
        32,
        `${rightLabel}: ${rightValue || ""}`,
        {
          fontSize: 9.5
        }
      );

      return y + 32;

    }

    function drawFullRow(y, label, value) {

      drawCell(
        left,
        y,
        usableWidth,
        32,
        `${label}: ${value || ""}`,
        {
          fontSize: 9.5
        }
      );

      return y + 32;

    }

    function drawBeneficiariosTable(
      y,
      title,
      subtitle,
      rows,
      notes
    ) {

      drawCell(
        left,
        y,
        usableWidth,
        28,
        `${title}\n${subtitle}`,
        {
          fill: sectionGray,
          bold: true,
          fontSize: 9,
          padding: 4
        }
      );

      y += 40;

      const headers = [
        "Nombre y apellidos",
        "DNI",
        "Parentesco",
        "Fecha de nacimiento",
        "Domicilio"
      ];

      let currentX = left;

      headers.forEach((header, index) => {

        drawCell(
          currentX,
          y,
          tableColumns[index],
          tableHeaderHeight,
          header,
          {
            bold: true,
            align: "center",
            fontSize: 8.5,
            padding: 5
          }
        );

        currentX += tableColumns[index];

      });

      y += tableHeaderHeight;

      const printableRows = rows.length
        ? rows
        : [{}];

      const totalRows = Math.max(
        printableRows.length,
        3
      );

      for (let i = 0; i < totalRows; i++) {

        const row = printableRows[i] || {};

        const nombreCompleto = `
          ${row.apellido_paterno || ""}
          ${row.apellido_materno || ""},
          ${row.nombres || ""}
        `
        .replace(/^,\s*/, "")
        .replace(/\s+/g, " ")
        .trim();

        const values = [

          fitText(nombreCompleto, 55),

          fitText(row.dni || "", 12),

          fitText(row.parentesco?.nombre || "", 18),

          fitText(
            formatDate(row.fecha_nacimiento),
            18
          ),

          row.domicilio || ""

        ];

        currentX = left;

        values.forEach((value, index) => {

          drawCell(
            currentX,
            y,
            tableColumns[index],
            rowHeight,
            value,
            {
              fontSize: 8.5,
              padding: 4
            }
          );

          currentX += tableColumns[index];

        });

        y += rowHeight;

      }

      doc.font("Helvetica")
        .fontSize(8.5)
        .fillColor("#000");

      notes.forEach(note => {

        doc.text(
          note,
          left,
          y + 4,
          {
            width: usableWidth,
            align: "left"
          }
        );

        y = doc.y + 2;

      });

      return y + 10;

    }

    function drawFirma(y) {

      const boxHeight = 110;

      drawCell(
        left,
        y,
        usableWidth,
        boxHeight,
        "",
        {}
      );

      doc.moveTo(left + 40, y + 52)
        .lineTo(left + 250, y + 52)
        .stroke(strokeColor);

      doc.font("Helvetica")
        .fontSize(8.5);

      doc.text(
        "Firma del trabajador(a) asegurado(a)",
        left + 38,
        y + 56,
        {
          width: 220,
          align: "center"
        }
      );

      doc.fontSize(7.5);

      doc.text(
        "(Legalizada notarialmente, o por\nJuez de Paz a falta de notario)",
        left + 46,
        y + 70,
        {
          width: 200,
          align: "center"
        }
      );

      doc.fontSize(10);

      doc.text(
        "..........., ...... de ........................ del 20......",
        left + 272,
        y + 80,
        {
          width: 210,
          align: "left"
        }
      );

    }

    // =========================
    // CONTENIDO PDF
    // =========================

    let y = 46;

    doc.font("Helvetica-Bold")
      .fontSize(12)
      .text(
        "ANEXO",
        left,
        y,
        {
          width: usableWidth,
          align: "center"
        }
      );

    y = doc.y + 10;

    doc.fontSize(11.5)
      .text(
        "FORMATO REFERENCIAL DE DECLARACION JURADA DE BENEFICIARIOS",
        left,
        y,
        {
          width: usableWidth,
          align: "center"
        }
      );

    y = doc.y + 1;

    doc.text(
      "DEL SEGURO DE VIDA",
      left,
      y,
      {
        width: usableWidth,
        align: "center"
      }
    );

    y = doc.y + 1;

    doc.fontSize(8.5)
      .text(
        "(Decreto Legislativo N 688 y sus normas modificatorias, complementarias y reglamentarias)",
        left,
        y,
        {
          width: usableWidth,
          align: "center"
        }
      );

    y = doc.y + 14;

    doc.font("Helvetica")
      .fontSize(9);

    doc.text(
      "El/la suscrito(a), de acuerdo a lo dispuesto en el articulo 6 del Decreto Legislativo N 688, Ley de Consolidacion de Beneficios Sociales, formula la presente Declaracion Jurada sobre los beneficiarios del seguro de vida en caso de fallecimiento natural o en caso de fallecimiento a consecuencia de un accidente.",
      left,
      y,
      {
        width: usableWidth,
        align: "justify"
      }
    );

    y = doc.y + 16;

    y = drawInfoRow(
      y,
      "Nombres y apellidos del trabajador(a) asegurado(a)",
      trabajador,
      "DNI",
      col.dni
    );

    y = drawFullRow(
      y,
      "Nombre y apellidos o razon social del empleador",
      "Trabajos Maritimos S.A."
    );

    y += 18;

    y = drawBeneficiariosTable(
      y,
      "Primeros Beneficiarios:",
      "Conyuge o conviviente y descendientes (*) (**)",
      primeros,
      [
        "(*) A falta de conyuge, se puede nombrar como beneficiario a la persona con la cual conviva por un periodo minimo de dos (2) años continuos, conforme al articulo 326 del Codigo Civil.",
        "(**) En el caso de los descendientes, solo a falta de hijos puede nombrarse nietos de conformidad con lo establecido en los articulos 816 y 817 del Codigo Civil."
      ]
    );

    if (segundos.length > 0) {

  y = drawBeneficiariosTable(
    y,
    "Solo a falta de los Primeros Beneficiarios:",
    "Ascendientes y hermanos menores de dieciocho (18) años (***)",
    segundos,
    [
      "(***) En el caso de los ascendientes, solo a falta de ambos padres puede nombrarse abuelos de conformidad con lo establecido en los articulos 816 y 817 del Codigo Civil."
    ]
  );

}

    drawFirma(y + 8);

    doc.end();

  } catch (err) {

    console.error(err);

    res.status(500).json({
      ok: false
    });

  }

});

// ===============================
// BENEFICIARIOS
// ===============================
app.get("/beneficiarios", async (req, res) => {

  const id_colaborador = req.query.id_colaborador;
  const session_id = req.query.session_id;

  const { data } = await supabase
    .from("beneficiarios")
    .select("*")
    .eq("id_colaborador", id_colaborador)
    .eq("session_id", session_id);
  res.json({ ok:true, data });
});

// ===============================
// ADMIN
// ===============================
    app.get("/admin/colaboradores", verificarToken, soloAdmin, async (req, res) => {

      const { data, error } = await supabase
        .from("colaboradores")
    .select(`
      *,
      sedes (
        sede
      ),
      beneficiarios (
        nombres,
        apellido_paterno
      )
    `);

      if(error){
        console.log(error);

        return res.status(500).json({
          ok:false
        });
      }

      const colaboradores = data.map(c => ({

        ...c,

        sede_nombre:
          c.sedes?.sede || "Sin sede",

        tiene_beneficiarios:
          c.beneficiarios &&
          c.beneficiarios.length > 0

      }));

      res.json({
        ok:true,
        data: colaboradores
      });

    });

app.get("/admin/historial/:id", verificarToken, soloAdmin, async (req, res) => {

  const { data } = await supabase
    .from("beneficiarios")
    .select("*")
    .eq("id_colaborador", req.params.id);

  res.json({
    ok:true,
    beneficiarios:data
  });

});

app.delete("/eliminar-datos/:id", verificarToken, soloAdmin, async (req, res) => {

  await supabase
    .from("beneficiarios")
    .delete()
    .eq("id_colaborador", req.params.id);


  await supabase
    .from("colaboradores")
    .delete()
    .eq("id", req.params.id);

  res.json({ ok:true });

});

app.get(
  "/admin/dashboard",
  verificarToken,
  soloAdmin,
  async (req, res) => {

    const { data: colaboradores } = await supabase
      .from("colaboradores")
      .select(`
        id,
        idsede,
        sedes (
          sede
        ),
        beneficiarios (
          id
        )
      `);

    const resumen = {};

    colaboradores.forEach(c => {

      const sede =
        c.sedes?.sede || "SIN SEDE";

      if(!resumen[sede]){
        resumen[sede] = {
          sede,
          total:0,
          registrados:0
        };
      }

      resumen[sede].total++;

      if(
        c.beneficiarios &&
        c.beneficiarios.length > 0
      ){
        resumen[sede].registrados++;
      }

    });

    const resultado = Object.values(resumen)
      .map(x => ({
        ...x,
        falta:
          x.total - x.registrados,
        avance:
          Math.round(
            (x.registrados * 100) /
            x.total
          )
      }));

    res.json({
      ok:true,
      data: resultado
    });

});


// ===================================
// 🗑️ ELIMINAR TODO
// ===================================
app.delete(
"/admin/eliminar-todos",
verificarToken,
soloAdmin,
async (req,res)=>{

  try{

    await supabase
      .from("beneficiarios")
      .delete()
      .neq("id", 0);

    await supabase
      .from("colaboradores")
      .delete()
      .neq("id", 0);

    res.json({
      ok:true
    });

  }catch(err){

    console.error(err);

    res.status(500).json({
      ok:false
    });

  }

});


app.post("/admin/colaborador",verificarToken,soloAdmin,async (req,res)=>{

const {
dni,
apellido_paterno,
apellido_materno,
nombres,
fecha_nacimiento,
id_genero,
idsede
} = req.body;

if(!/^\d{8}$/.test(dni)){

  return res.status(400).json({
    ok:false,
    msg:"DNI inválido"
  });

}

const { data: existe } = await supabase
.from("colaboradores")
.select("id")
.eq("dni", dni)
.maybeSingle();

if(existe){

  return res.status(400).json({
    ok:false,
    msg:"El DNI ya existe"
  });

}

const { error } = await supabase
.from("colaboradores")
.insert([{
dni,
apellido_paterno,
apellido_materno,
nombres,
fecha_nacimiento,
id_genero,
idsede,
cod_verificacion:"0"
}]);

if(error){

console.log(error);

return res.status(500).json({
ok:false
});

}

res.json({
ok:true
});

});

app.post("/admin/carga-masiva",verificarToken,soloAdmin,async (req,res)=>{

try{

const filas = req.body;
console.log("FILAS RECIBIDAS:", filas.length);

const registros = [];

for(const x of filas){

   const dni = String(x.DNI || "").trim();

   if(!/^\d{8}$/.test(dni)){
      continue;
   }

   const { data: existe } = await supabase
      .from("colaboradores")
      .select("id")
      .eq("dni", dni)
      .maybeSingle();

   if(!existe){

      let fechaNac = x.FECHA_NAC;

      console.log("FECHA ORIGINAL:", fechaNac);

      if(typeof fechaNac === "number"){

         const fechaExcel = new Date(
            (fechaNac - 25569) * 86400 * 1000
         );

         fechaNac =
            fechaExcel.getFullYear() + "-" +
            String(fechaExcel.getMonth()+1).padStart(2,"0") + "-" +
            String(fechaExcel.getDate()).padStart(2,"0");
      }

      else if(typeof fechaNac === "string"){

         const partes = String(fechaNac).trim().split("/");

         if(partes.length === 3){

            fechaNac =
               partes[2] + "-" +
               partes[1].padStart(2,"0") + "-" +
               partes[0].padStart(2,"0");
         }
      }

      if(!fechaNac){
        console.log("Fecha inválida:", x);
        continue;
      }

      console.log("FECHA CONVERTIDA:", fechaNac);

      registros.push({

         dni,

         apellido_paterno:
            String(x.AP_PATERNO || "").trim(),

         apellido_materno:
            String(x.AP_MATERNO || "").trim(),

         nombres:
            String(x.NOMBRES || "").trim(),

         fecha_nacimiento:
            fechaNac,

         id_genero:
            parseInt(x.GENERO),

         idsede:
            String(x.SEDE || "").padStart(4,"0"),

         cod_verificacion:"0"

      });

   }

}

if(registros.length === 0){

  return res.json({
    ok:true,
    cantidad:0,
    mensaje:"Todos los DNI ya existen"
  });

}

console.log("REGISTROS A INSERTAR:", registros.length);

const { error } = await supabase
  .from("colaboradores")
  .insert(registros);

if(error){

  console.log(error);

  return res.status(500).json({
    ok:false,
    error:error.message
  });

}

res.json({
  ok:true,
  cantidad:registros.length
});

}catch(error){

  console.log(error);

  res.status(500).json({
    ok:false
  });

}

});

// ===============================
// START SERVER
// ===============================
app.listen(PORT, () => {
console.log("Servidor corriendo en " + PORT);
});