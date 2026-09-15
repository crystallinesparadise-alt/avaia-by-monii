require("dotenv").config();

const express = require("express");
const session = require("express-session");
const bcrypt = require("bcryptjs");
const helmet = require("helmet");
const rateLimit = require("express-rate-limit");
const cron = require("node-cron");
const nodemailer = require("nodemailer");
const crypto = require("crypto");
const db = require("./db");
const path = require("path");

const app = express();
app.set("trust proxy", 1);
const PORT = Number(process.env.PORT || 3000);
const BASE_URL = process.env.BASE_URL || (process.env.RENDER_EXTERNAL_URL ? process.env.RENDER_EXTERNAL_URL : `http://localhost:${PORT}`);
const CURRENCY = process.env.CURRENCY || "NGN";

app.use(helmet({ contentSecurityPolicy: false }));

// Paystack webhooks require the raw request body for signature verification.
app.use("/api/paystack/webhook", express.raw({ type: "application/json", limit: "100kb" }));
app.use(express.json({ limit: "100kb" }));
app.use(express.urlencoded({ extended: false }));
app.use(session({
  secret: process.env.SESSION_SECRET || "replace-me",
  resave: false,
  saveUninitialized: false,
  cookie: { httpOnly: true, sameSite: "lax", secure: process.env.NODE_ENV === "production", maxAge: 1000 * 60 * 60 * 8 }
}));

const apiLimiter = rateLimit({ windowMs: 15 * 60 * 1000, limit: 250, standardHeaders: true, legacyHeaders: false });
app.use("/api/", apiLimiter);

function money(n) {
  return `₦${Number(n || 0).toLocaleString("en-NG")}`;
}

function makeOrderNumber() {
  return `AVM-${Math.floor(100000 + Math.random() * 900000)}`;
}

function makeReference() {
  return `AVM_${Date.now()}_${crypto.randomBytes(4).toString("hex")}`;
}

function adminOnly(req, res, next) {
  if (!req.session.admin) return res.status(401).json({ error: "Admin login required." });
  next();
}

function createNotification(type, title, message, orderId = null) {
  db.prepare(`
    INSERT INTO notifications(type,title,message,order_id)
    VALUES(?,?,?,?)
  `).run(type, title, message, orderId);
}

async function sendEmail(subject, text) {
  const host = process.env.SMTP_HOST;
  const user = process.env.SMTP_USER;
  const pass = process.env.SMTP_PASS;
  const to = process.env.NOTIFICATION_EMAIL;
  if (!host || !user || !pass || !to) return false;
  const transporter = nodemailer.createTransport({
    host,
    port: Number(process.env.SMTP_PORT || 587),
    secure: Number(process.env.SMTP_PORT || 587) === 465,
    auth: { user, pass }
  });
  await transporter.sendMail({
    from: user,
    to,
    subject,
    text
  });
  return true;
}

app.use(express.static(path.join(__dirname, "public")));

app.get("/api/config", (req, res) => {
  res.json({
    storeName: "Avaia By Monii",
    strandsName: "Strands by Monii",
    tagline: "One of a kind",
    strandsTagline: "Luxury in every strand",
    currency: CURRENCY,
    paystackPublicKey: process.env.PAYSTACK_PUBLIC_KEY || ""
  });
});

app.get("/api/products", (req, res) => {
  const category = req.query.category;
  const rows = category
    ? db.prepare("SELECT * FROM products WHERE active=1 AND category=? ORDER BY id DESC").all(category)
    : db.prepare("SELECT * FROM products WHERE active=1 ORDER BY id DESC").all();
  res.json(rows);
});

app.get("/api/products/:slug", (req, res) => {
  const product = db.prepare("SELECT * FROM products WHERE slug=? AND active=1").get(req.params.slug);
  if (!product) return res.status(404).json({ error: "Product not found." });
  const variants = db.prepare("SELECT * FROM product_variants WHERE product_id=? ORDER BY id").all(product.id);
  res.json({ ...product, variants });
});

app.post("/api/orders", async (req, res) => {
  try {
    const { customer, items } = req.body;
    if (!customer || !Array.isArray(items) || !items.length) {
      return res.status(400).json({ error: "Customer details and cart items are required." });
    }

    const products = [];
    let subtotal = 0;
    let totalCost = 0;

    for (const item of items) {
      const product = db.prepare("SELECT * FROM products WHERE id=? AND active=1").get(Number(item.productId));
      const quantity = Number(item.quantity);
      if (!product || !Number.isInteger(quantity) || quantity < 1) {
        return res.status(400).json({ error: "Invalid product or quantity." });
      }
      if (quantity > product.stock) {
        return res.status(400).json({ error: `${product.name} does not have enough stock.` });
      }
      products.push({ product, quantity, variantName: String(item.variantName || "") });
      subtotal += product.price * quantity;
      totalCost += product.cost_price * quantity;
    }

    const deliveryFee = Number(customer.deliveryFee || 0);
    const total = subtotal + deliveryFee;
    const orderNumber = makeOrderNumber();
    const reference = makeReference();

    const insertOrder = db.prepare(`
      INSERT INTO orders (
        order_number, customer_name, email, phone, address, city, state,
        delivery_method, notes, subtotal, delivery_fee, total, total_cost,
        profit, status, payment_reference, payment_status
      ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?, ?,?)
    `);

    const insertItem = db.prepare(`
      INSERT INTO order_items(order_id,product_id,product_name,quantity,unit_price,unit_cost,variant_name)
      VALUES(?,?,?,?,?,?,?)
    `);

    const tx = db.transaction(() => {
      const result = insertOrder.run(
        orderNumber, String(customer.name).trim(), String(customer.email).trim(),
        String(customer.phone).trim(), String(customer.address).trim(),
        String(customer.city).trim(), String(customer.state).trim(),
        String(customer.deliveryMethod || "Delivery"), String(customer.notes || ""),
        subtotal, deliveryFee, total, totalCost, 0,
        "pending_payment", reference, "unpaid"
      );
      for (const p of products) {
        insertItem.run(result.lastInsertRowid, p.product.id, p.product.name, p.quantity,
          p.product.price, p.product.cost_price, p.variantName);
      }
      return result.lastInsertRowid;
    });

    const orderId = tx();

    if (!process.env.PAYSTACK_SECRET_KEY) {
      return res.json({
        mode: "demo",
        orderNumber,
        reference,
        message: "Order created in demo mode. Add Paystack keys to enable live payment."
      });
    }

    const response = await fetch("https://api.paystack.co/transaction/initialize", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${process.env.PAYSTACK_SECRET_KEY}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        email: customer.email,
        amount: total * 100,
        currency: CURRENCY,
        reference,
        callback_url: `${BASE_URL}/payment-callback`,
        metadata: {
          order_id: orderId,
          order_number: orderNumber,
          customer_name: customer.name
        }
      })
    });

    const data = await response.json();
    if (!response.ok || !data.status) {
      return res.status(502).json({ error: "Could not initialize payment.", details: data.message || "Paystack error" });
    }

    res.json({
      mode: "paystack",
      orderNumber,
      reference,
      authorizationUrl: data.data.authorization_url
    });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: "Could not create order." });
  }
});

async function markOrderPaid(reference, gatewayData = {}) {
  const order = db.prepare("SELECT * FROM orders WHERE payment_reference=?").get(reference);
  if (!order) return null;
  if (order.payment_status === "paid") return order;

  const items = db.prepare("SELECT * FROM order_items WHERE order_id=?").all(order.id);
  const tx = db.transaction(() => {
    for (const item of items) {
      const product = db.prepare("SELECT stock FROM products WHERE id=?").get(item.product_id);
      if (!product || product.stock < item.quantity) throw new Error(`Insufficient stock for product ${item.product_id}`);
      db.prepare("UPDATE products SET stock=stock-?, updated_at=CURRENT_TIMESTAMP WHERE id=?")
        .run(item.quantity, item.product_id);
    }
    db.prepare(`
      UPDATE orders SET payment_status='paid', status='processing',
      paid_at=CURRENT_TIMESTAMP, updated_at=CURRENT_TIMESTAMP,
      profit=total-total_cost
      WHERE id=?
    `).run(order.id);
    createNotification("payment", "Payment received", `${order.order_number} was paid: ${money(order.total)}.`, order.id);
  });
  tx();

  const updated = db.prepare("SELECT * FROM orders WHERE id=?").get(order.id);
  try {
    await sendEmail(
      `New paid order ${updated.order_number}`,
      `Payment received for ${updated.order_number}\nCustomer: ${updated.customer_name}\nAmount: ${money(updated.total)}\nProfit before expenses: ${money(updated.profit)}`
    );
  } catch (e) {
    console.error("Email notification failed:", e.message);
  }
  return updated;
}

app.get("/payment-callback", async (req, res) => {
  const reference = String(req.query.reference || "");
  if (!reference) return res.redirect("/order.html?status=missing");
  try {
    const response = await fetch(`https://api.paystack.co/transaction/verify/${encodeURIComponent(reference)}`, {
      headers: { Authorization: `Bearer ${process.env.PAYSTACK_SECRET_KEY}` }
    });
    const data = await response.json();
    if (response.ok && data.status && data.data.status === "success") {
      const order = await markOrderPaid(reference, data.data);
      return res.redirect(`/order.html?order=${encodeURIComponent(order?.order_number || "")}&status=paid`);
    }
    res.redirect(`/order.html?status=failed&reference=${encodeURIComponent(reference)}`);
  } catch {
    res.redirect(`/order.html?status=error`);
  }
});

app.post("/api/paystack/webhook", async (req, res) => {
  const signature = req.headers["x-paystack-signature"];
  const expected = crypto.createHmac("sha512", process.env.PAYSTACK_SECRET_KEY || "")
    .update(req.body).digest("hex");
  if (!signature || signature !== expected) return res.sendStatus(401);

  try {
    const event = JSON.parse(req.body.toString("utf8"));
    if (event.event === "charge.success") await markOrderPaid(event.data.reference, event.data);
    res.sendStatus(200);
  } catch (e) {
    console.error(e);
    res.sendStatus(500);
  }
});

app.get("/api/orders/track", (req, res) => {
  const number = String(req.query.order || "").trim();
  const email = String(req.query.email || "").trim().toLowerCase();
  if (!number || !email) return res.status(400).json({ error: "Order number and email are required." });
  const order = db.prepare(`
    SELECT order_number,customer_name,total,status,payment_status,delivery_method,created_at,updated_at
    FROM orders WHERE order_number=? AND lower(email)=?
  `).get(number, email);
  if (!order) return res.status(404).json({ error: "Order not found." });
  res.json(order);
});

app.post("/api/admin/login", async (req, res) => {
  const { email, password } = req.body;
  const expectedEmail = process.env.ADMIN_EMAIL || "admin@example.com";
  const row = db.prepare("SELECT value FROM settings WHERE key='admin_password_hash'").get();
  const valid = email === expectedEmail && row && await bcrypt.compare(String(password || ""), row.value);
  if (!valid) return res.status(401).json({ error: "Invalid email or password." });
  req.session.admin = { email };
  res.json({ ok: true });
});

app.post("/api/admin/logout", (req, res) => {
  req.session.destroy(() => res.json({ ok: true }));
});

app.get("/api/admin/me", adminOnly, (req, res) => res.json(req.session.admin));

app.get("/api/admin/dashboard", adminOnly, (req, res) => {
  const revenue = db.prepare("SELECT COALESCE(SUM(total),0) total FROM orders WHERE payment_status='paid'").get().total;
  const productCost = db.prepare("SELECT COALESCE(SUM(total_cost),0) total FROM orders WHERE payment_status='paid'").get().total;
  const expenses = db.prepare("SELECT COALESCE(SUM(amount),0) total FROM expenses").get().total;
  const orders = db.prepare("SELECT COUNT(*) count FROM orders").get().count;
  const pending = db.prepare("SELECT COUNT(*) count FROM orders WHERE status IN ('pending_payment','pending')").get().count;
  const processing = db.prepare("SELECT COUNT(*) count FROM orders WHERE status='processing'").get().count;
  const shipped = db.prepare("SELECT COUNT(*) count FROM orders WHERE status='shipped'").get().count;
  const delivered = db.prepare("SELECT COUNT(*) count FROM orders WHERE status='delivered'").get().count;
  const lowStock = db.prepare("SELECT COUNT(*) count FROM products WHERE active=1 AND stock<=low_stock_threshold").get().count;
  const paidProfit = revenue - productCost;
  const netProfit = paidProfit - expenses;
  const recent = db.prepare(`
    SELECT id,order_number,customer_name,total,status,payment_status,created_at
    FROM orders ORDER BY id DESC LIMIT 10
  `).all();
  const monthly = db.prepare(`
    SELECT substr(paid_at,1,7) month, SUM(total) revenue, SUM(total-total_cost) profit
    FROM orders WHERE payment_status='paid' AND paid_at IS NOT NULL
    GROUP BY substr(paid_at,1,7) ORDER BY month DESC LIMIT 6
  `).all();
  res.json({ revenue, productCost, expenses, paidProfit, netProfit, orders, pending, processing, shipped, delivered, lowStock, recent, monthly });
});

app.get("/api/admin/orders", adminOnly, (req, res) => {
  res.json(db.prepare("SELECT * FROM orders ORDER BY id DESC").all());
});

app.patch("/api/admin/orders/:id", adminOnly, (req, res) => {
  const allowed = ["pending_payment","processing","ready_for_pickup","shipped","delivered","cancelled"];
  const status = String(req.body.status || "");
  if (!allowed.includes(status)) return res.status(400).json({ error: "Invalid status." });
  db.prepare("UPDATE orders SET status=?,updated_at=CURRENT_TIMESTAMP WHERE id=?").run(status, Number(req.params.id));
  res.json({ ok: true });
});

app.get("/api/admin/products", adminOnly, (req, res) => {
  res.json(db.prepare("SELECT * FROM products ORDER BY id DESC").all());
});

app.post("/api/admin/products", adminOnly, (req, res) => {
  const p = req.body;
  if (!p.name || !p.category) return res.status(400).json({ error: "Name and category are required." });
  const slug = String(p.slug || p.name).toLowerCase().trim().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
  const result = db.prepare(`
    INSERT INTO products(slug,name,category,description,price,cost_price,stock,low_stock_threshold,image_url,active)
    VALUES(?,?,?,?,?,?,?,?,?,1)
  `).run(slug, p.name, p.category, p.description || "", Number(p.price), Number(p.cost_price), Number(p.stock), Number(p.low_stock_threshold || 3), p.image_url || "");
  res.json({ id: result.lastInsertRowid });
});

app.patch("/api/admin/products/:id", adminOnly, (req, res) => {
  const p = req.body;
  db.prepare(`
    UPDATE products SET name=?,category=?,description=?,price=?,cost_price=?,stock=?,
    low_stock_threshold=?,image_url=?,active=?,updated_at=CURRENT_TIMESTAMP WHERE id=?
  `).run(p.name, p.category, p.description || "", Number(p.price), Number(p.cost_price),
    Number(p.stock), Number(p.low_stock_threshold || 3), p.image_url || "", p.active ? 1 : 0, Number(req.params.id));
  res.json({ ok: true });
});

app.get("/api/admin/expenses", adminOnly, (req, res) => {
  res.json(db.prepare("SELECT * FROM expenses ORDER BY id DESC").all());
});

app.post("/api/admin/expenses", adminOnly, (req, res) => {
  const { title, category, amount, note } = req.body;
  if (!title || !amount) return res.status(400).json({ error: "Title and amount are required." });
  const result = db.prepare("INSERT INTO expenses(title,category,amount,note) VALUES(?,?,?,?)")
    .run(title, category || "Other", Number(amount), note || "");
  res.json({ id: result.lastInsertRowid });
});

app.get("/api/admin/notifications", adminOnly, (req, res) => {
  res.json(db.prepare("SELECT * FROM notifications ORDER BY id DESC LIMIT 50").all());
});

app.post("/api/admin/notifications/read", adminOnly, (req, res) => {
  db.prepare("UPDATE notifications SET read=1 WHERE read=0").run();
  res.json({ ok: true });
});

cron.schedule("0 20 * * *", async () => {
  const today = new Date().toISOString().slice(0, 10);
  const stats = db.prepare(`
    SELECT COALESCE(SUM(total),0) revenue, COALESCE(SUM(total-total_cost),0) profit, COUNT(*) orders
    FROM orders WHERE payment_status='paid' AND substr(paid_at,1,10)=?
  `).get(today);
  if (stats.orders > 0) {
    try {
      await sendEmail(
        `Avaia daily revenue — ${today}`,
        `Orders: ${stats.orders}\nRevenue: ${money(stats.revenue)}\nProduct profit: ${money(stats.profit)}`
      );
    } catch (e) {
      console.error("Daily summary failed:", e.message);
    }
  }
});

app.get("/health", (req, res) => res.status(200).json({ ok: true, service: "avaia-by-monii" }));

app.get("/{*splat}", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

app.listen(PORT, "0.0.0.0", () => console.log(`Avaia By Monii running at ${BASE_URL}`));
