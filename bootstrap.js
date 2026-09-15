require("dotenv").config();
const db = require("./db");
const bcrypt = require("bcryptjs");

const productCount = db.prepare("SELECT COUNT(*) count FROM products").get().count;
if (productCount === 0) {
  const products = [
    ["french-curl","French Curl","Strands","Soft, defined curls with a luxurious finish.",30000,18000,20],
    ["deep-wave","Deep Wave","Strands","Full-bodied waves with a natural movement.",35000,20000,15],
    ["body-wave","Body Wave","Strands","Classic soft waves designed for effortless styling.",38000,22000,10],
    ["italian-curl","Italian Curl","Strands","Defined curls with a polished premium look.",42000,25000,8],
    ["ponytail","Ponytail","Strands","Easy statement ponytail for everyday glam.",28000,15000,12],
    ["coach-teri-bag","Coach Teri Bag","Bags","A structured everyday bag with a polished finish.",45000,30000,7],
    ["classic-shoulder-bag","Classic Shoulder Bag","Bags","Minimal shoulder bag for day-to-night styling.",38000,24000,9],
    ["gold-link-belt","Gold Link Belt","Accessories","A refined statement belt with gold-tone hardware.",22000,12000,14]
  ];
  const insert = db.prepare(`INSERT INTO products (slug,name,category,description,price,cost_price,stock) VALUES (?,?,?,?,?,?,?)`);
  const tx = db.transaction(() => products.forEach(p => insert.run(...p)));
  tx();
}

if (!db.prepare("SELECT 1 FROM settings WHERE key='admin_password_hash'").get()) {
  const password = process.env.ADMIN_PASSWORD || "change-this-password";
  const hash = bcrypt.hashSync(password, 12);
  db.prepare("INSERT INTO settings(key,value) VALUES('admin_password_hash',?)").run(hash);
}
if (!db.prepare("SELECT 1 FROM settings WHERE key='store_name'").get()) {
  db.prepare("INSERT INTO settings(key,value) VALUES('store_name',?)").run("Avaia By Monii");
}
