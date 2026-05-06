const bcrypt = require("bcrypt");

async function generar(){
const passwordPlano = "Wishmaster@3103";
const hash = await bcrypt.hash(passwordPlano, 10);
console.log("HASH:", hash);
}

generar();

