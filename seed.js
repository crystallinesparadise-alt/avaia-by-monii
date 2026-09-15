require("dotenv").config();
const db = require("./db");

const products = [
  ["french-curl", "French Curl", "Strands", "Soft, defined curls with a luxurious finish.", 30000, 18000, 20],
  ["deep-wave", "Deep Wave", "Strands", "Full-bodied waves with a natural movement.", 35000, 20000, 15],
  ["body-wave", "Body Wave", "Strands", "Classic soft waves designed for effortless styling.", 38000, 22000, 10],
  ["italian-curl", "Italian Curl", "Strands", "Defined curls with a polished premium look.", 42000, 25000, 8],
  ["ponytail", "Ponytail", "Strands", "Easy statement ponytail for everyday glam.", 28000, 15000, 12],
  ["coach-teri-bag", "Coach Teri Bag", "Bags", "A structured everyday bag with a polished finish.", 45000, 30000, 7],
  ["classic-shoulder-bag", "Classic Shoulder Bag", "Bags", "Minimal shoulder bag for day-to-night styling.", 38000, 24000, 9],
  ["gold-link-belt", "Gold Link Belt", "Accessories", "A refined statement belt with gold-tone hardware.", 22000, 12000, 14]
];

const insert = db.prepare(`
  INSERT INTO products (slug,name,category,description,price,cost_price,stock)
  VALUES (?,?,?,?,?,?,?)
  ON CONFLICT(slug) DO UPDATE SET
    name=excluded.name, category=excluded.category, description=excluded.description,
    price=excluded.price, cost_price=excluded.cost_price, stock=excluded.stock,
    updated_at=CURRENT_TIMESTAMP
`);

const tx = db.transaction(() => {
  for (const p of products) insert.run(...p);
});
tx();

const adminPassword = process.env.ADMIN_PASSWORD || "change-this-password";
const bcrypt = require("bcryptjs");
const hash = bcrypt.hashSync(adminPassword, 12);
db.prepare("INSERT OR REPLACE INTO settings(key,value) VALUES('admin_password_hash',?)").run(hash);
db.prepare("INSERT OR REPLACE INTO settings(key,value) VALUES('store_name',?)").run("Avaia By Monii");
console.log("Database seeded.");
console.log("Admin email:", process.env.ADMIN_EMAIL || "admin@example.com");
console.log("If you did not change ADMIN_PASSWORD, change it before going live.");
