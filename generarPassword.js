const bcrypt = require("bcrypt");

async function generar(){
  const password = "Wishmaster3103";
  const hash = await bcrypt.hash(password, 10);
  console.log(hash);
}

generar();