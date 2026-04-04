const express = require('express');
const { Pool } = require('pg');
const path = require('path');

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// ── DATABASE ──────────────────────────────────────────────
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false
});

// ── INIT DATABASE ─────────────────────────────────────────
async function initDB() {
  const client = await pool.connect();
  try {
    await client.query(`
      CREATE TABLE IF NOT EXISTS suppliers (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        name TEXT NOT NULL UNIQUE,
        created_at TIMESTAMPTZ DEFAULT NOW()
      );

      CREATE TABLE IF NOT EXISTS clients (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        name TEXT NOT NULL,
        email TEXT NOT NULL UNIQUE,
        password TEXT NOT NULL DEFAULT '1234',
        created_at TIMESTAMPTZ DEFAULT NOW()
      );

      CREATE TABLE IF NOT EXISTS client_suppliers (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        client_id UUID REFERENCES clients(id) ON DELETE CASCADE,
        supplier_id UUID REFERENCES suppliers(id) ON DELETE CASCADE,
        UNIQUE(client_id, supplier_id)
      );

      CREATE TABLE IF NOT EXISTS orders (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        client_id UUID REFERENCES clients(id) ON DELETE CASCADE,
        supplier_id UUID REFERENCES suppliers(id) ON DELETE CASCADE,
        quantity INTEGER NOT NULL DEFAULT 0,
        comment TEXT DEFAULT '',
        submitted_at TIMESTAMPTZ,
        created_at TIMESTAMPTZ DEFAULT NOW(),
        UNIQUE(client_id, supplier_id)
      );

      CREATE TABLE IF NOT EXISTS config (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );

      INSERT INTO config (key, value) VALUES ('admin_password', 'admin123')
        ON CONFLICT (key) DO NOTHING;
    `);
    console.log('✓ Database initialized');
  } finally {
    client.release();
  }
}

// ── MIDDLEWARE AUTH ───────────────────────────────────────
function requireAdmin(req, res, next) {
  const token = req.headers['x-admin-token'];
  if (token !== 'admin-authenticated') {
    return res.status(401).json({ error: 'Non autorisé' });
  }
  next();
}

// ── AUTH ROUTES ───────────────────────────────────────────
app.post('/api/auth/login', async (req, res) => {
  const { email, password } = req.body;
  try {
    if (email.toLowerCase() === 'admin') {
      const result = await pool.query("SELECT value FROM config WHERE key = 'admin_password'");
      const adminPwd = result.rows[0]?.value;
      if (password === adminPwd) {
        return res.json({ role: 'admin', name: 'Administrateur' });
      }
      return res.status(401).json({ error: 'Identifiants incorrects' });
    }
    const result = await pool.query(
      'SELECT id, name, email, password FROM clients WHERE LOWER(email) = LOWER($1)',
      [email]
    );
    const client = result.rows[0];
    if (client && client.password === password) {
      return res.json({ role: 'client', id: client.id, name: client.name, email: client.email });
    }
    return res.status(401).json({ error: 'Identifiants incorrects' });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/auth/change-password', async (req, res) => {
  const { email, oldPassword, newPassword } = req.body;
  try {
    const result = await pool.query(
      'SELECT id, password FROM clients WHERE LOWER(email) = LOWER($1)',
      [email]
    );
    const client = result.rows[0];
    if (!client || client.password !== oldPassword) {
      return res.status(401).json({ error: 'Ancien mot de passe incorrect' });
    }
    await pool.query('UPDATE clients SET password = $1 WHERE id = $2', [newPassword, client.id]);
    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── SUPPLIERS ROUTES ──────────────────────────────────────
app.get('/api/suppliers', async (req, res) => {
  try {
    const result = await pool.query('SELECT id, name FROM suppliers ORDER BY name');
    res.json(result.rows);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/suppliers', requireAdmin, async (req, res) => {
  const { name, email } = req.body;
  try {
    const result = await pool.query(
      'INSERT INTO suppliers (name, email) VALUES ($1, $2) RETURNING id, name, email',
      [name, email]
    );
    res.json(result.rows[0]);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.delete('/api/suppliers/:id', requireAdmin, async (req, res) => {
  try {
    await pool.query('DELETE FROM suppliers WHERE id = $1', [req.params.id]);
    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── CLIENTS ROUTES ────────────────────────────────────────
app.get('/api/clients', requireAdmin, async (req, res) => {
  try {
    const clients = await pool.query('SELECT id, name, email FROM clients ORDER BY name');
    const assignments = await pool.query('SELECT client_id, supplier_id FROM client_suppliers');
    const result = clients.rows.map(c => ({
      ...c,
      suppliers: assignments.rows.filter(a => a.client_id === c.id).map(a => a.supplier_id)
    }));
    res.json(result);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/clients', requireAdmin, async (req, res) => {
  const { name, email } = req.body;
  try {
    const result = await pool.query(
      "INSERT INTO clients (name, email, password) VALUES ($1, $2, '1234') RETURNING id, name, email",
      [name, email]
    );
    res.json(result.rows[0]);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.delete('/api/clients/:id', requireAdmin, async (req, res) => {
  try {
    await pool.query('DELETE FROM clients WHERE id = $1', [req.params.id]);
    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── CLIENT SUPPLIERS ──────────────────────────────────────
app.get('/api/clients/:id/suppliers', async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT s.id, s.name FROM suppliers s
       INNER JOIN client_suppliers cs ON cs.supplier_id = s.id
       WHERE cs.client_id = $1 ORDER BY s.name`,
      [req.params.id]
    );
    res.json(result.rows);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/clients/:id/suppliers', requireAdmin, async (req, res) => {
  const { supplier_id } = req.body;
  try {
    await pool.query(
      'INSERT INTO client_suppliers (client_id, supplier_id) VALUES ($1, $2) ON CONFLICT DO NOTHING',
      [req.params.id, supplier_id]
    );
    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.delete('/api/clients/:id/suppliers/:supplierId', requireAdmin, async (req, res) => {
  try {
    await pool.query(
      'DELETE FROM client_suppliers WHERE client_id = $1 AND supplier_id = $2',
      [req.params.id, req.params.supplierId]
    );
    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── ORDERS ROUTES ─────────────────────────────────────────
app.get('/api/orders', requireAdmin, async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT o.id, o.quantity, o.comment, o.submitted_at,
             c.id as client_id, c.name as client_name, c.email as client_email,
             s.id as supplier_id, s.name as supplier_name
      FROM orders o
      JOIN clients c ON c.id = o.client_id
      JOIN suppliers s ON s.id = o.supplier_id
      WHERE o.quantity > 0
      ORDER BY c.name, s.name
    `);
    res.json(result.rows);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get('/api/orders/client/:clientId', async (req, res) => {
  try {
    const result = await pool.query(
      'SELECT id, supplier_id, quantity, comment FROM orders WHERE client_id = $1',
      [req.params.clientId]
    );
    res.json(result.rows);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/orders', async (req, res) => {
  const { client_id, supplier_id, quantity, comment } = req.body;
  try {
    const result = await pool.query(`
      INSERT INTO orders (client_id, supplier_id, quantity, comment, submitted_at)
      VALUES ($1, $2, $3, $4, NOW())
      ON CONFLICT (client_id, supplier_id)
      DO UPDATE SET quantity = $3, comment = $4, submitted_at = NOW()
      RETURNING id
    `, [client_id, supplier_id, quantity, comment || '']);
    res.json(result.rows[0]);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.delete('/api/orders', requireAdmin, async (req, res) => {
  try {
    await pool.query('DELETE FROM orders WHERE quantity > 0');
    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── STATS ROUTE ───────────────────────────────────────────
app.get('/api/stats', requireAdmin, async (req, res) => {
  try {
    const [clients, suppliers, orders] = await Promise.all([
      pool.query('SELECT COUNT(*) as count FROM clients'),
      pool.query('SELECT COUNT(*) as count FROM suppliers'),
      pool.query(`
        SELECT o.quantity, c.id as client_id, s.name as supplier_name
        FROM orders o
        JOIN clients c ON c.id = o.client_id
        JOIN suppliers s ON s.id = o.supplier_id
        WHERE o.quantity > 0
      `)
    ]);
    const totalParcels = orders.rows.reduce((s, o) => s + parseInt(o.quantity), 0);
    const activeClients = new Set(orders.rows.map(o => o.client_id)).size;
    const supplierTotals = {};
    orders.rows.forEach(o => {
      supplierTotals[o.supplier_name] = (supplierTotals[o.supplier_name] || 0) + parseInt(o.quantity);
    });
    res.json({
      totalClients: parseInt(clients.rows[0].count),
      totalSuppliers: parseInt(suppliers.rows[0].count),
      totalParcels,
      activeClients,
      supplierTotals
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── ADMIN CONFIG ──────────────────────────────────────────
app.post('/api/admin/password', requireAdmin, async (req, res) => {
  const { newPassword } = req.body;
  try {
    await pool.query("UPDATE config SET value = $1 WHERE key = 'admin_password'", [newPassword]);
    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── SERVE HTML ────────────────────────────────────────────
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// ── START ─────────────────────────────────────────────────
const PORT = process.env.PORT || 3000;
initDB().then(() => {
  app.listen(PORT, () => console.log(`✓ Serveur démarré sur le port ${PORT}`));
}).catch(e => {
  console.error('Erreur démarrage:', e);
  process.exit(1);
});
