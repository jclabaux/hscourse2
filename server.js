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
      CREATE TABLE IF NOT EXISTS clients (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        name TEXT NOT NULL UNIQUE,
        email TEXT NOT NULL UNIQUE,
        password TEXT NOT NULL DEFAULT '1234',
        address TEXT DEFAULT '',
        phone TEXT DEFAULT '',
        blocked BOOLEAN NOT NULL DEFAULT FALSE,
        created_at TIMESTAMPTZ DEFAULT NOW()
      );
      -- Migration: add unique constraint on name if not exists
      DO $$ BEGIN
        IF NOT EXISTS (
          SELECT 1 FROM pg_constraint WHERE conname = 'clients_name_key'
        ) THEN
          ALTER TABLE clients ADD CONSTRAINT clients_name_key UNIQUE (name);
        END IF;
      END $$;
      -- Migration: add blocked column if not exists
      DO $$ BEGIN
        IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='clients' AND column_name='blocked') THEN
          ALTER TABLE clients ADD COLUMN blocked BOOLEAN NOT NULL DEFAULT FALSE;
        END IF;
      END $$;

      CREATE TABLE IF NOT EXISTS recipients (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        name TEXT NOT NULL,
        email TEXT DEFAULT '',
        address TEXT DEFAULT '',
        phone TEXT DEFAULT '',
        added_by_client_id UUID REFERENCES clients(id) ON DELETE SET NULL,
        client_id UUID REFERENCES clients(id) ON DELETE CASCADE,
        created_at TIMESTAMPTZ DEFAULT NOW()
      );
      -- Migration: add client_id column if not exists
      DO $$ BEGIN
        IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='recipients' AND column_name='client_id') THEN
          ALTER TABLE recipients ADD COLUMN client_id UUID REFERENCES clients(id) ON DELETE CASCADE;
        END IF;
      END $$;
      -- Migration: create recipient for existing clients that don't have one
      INSERT INTO recipients (name, email, address, phone, client_id)
        SELECT c.name, c.email, c.address, c.phone, c.id
        FROM clients c
        WHERE NOT EXISTS (SELECT 1 FROM recipients r WHERE r.client_id = c.id)
      ON CONFLICT DO NOTHING;

      CREATE TABLE IF NOT EXISTS client_recipients (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        client_id UUID REFERENCES clients(id) ON DELETE CASCADE,
        recipient_id UUID REFERENCES recipients(id) ON DELETE CASCADE,
        UNIQUE(client_id, recipient_id)
      );

      CREATE TABLE IF NOT EXISTS orders (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        client_id UUID REFERENCES clients(id) ON DELETE CASCADE,
        recipient_id UUID REFERENCES recipients(id) ON DELETE CASCADE,
        quantity INTEGER NOT NULL DEFAULT 0,
        comment TEXT DEFAULT '',
        ordered_at TIMESTAMPTZ DEFAULT NOW(),
        month_label TEXT NOT NULL,
        UNIQUE(client_id, recipient_id)
      );

      CREATE TABLE IF NOT EXISTS order_history (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        client_id UUID REFERENCES clients(id) ON DELETE SET NULL,
        client_name TEXT NOT NULL,
        recipient_id UUID REFERENCES recipients(id) ON DELETE SET NULL,
        recipient_name TEXT NOT NULL,
        quantity INTEGER NOT NULL,
        comment TEXT DEFAULT '',
        ordered_at TIMESTAMPTZ,
        exported_at TIMESTAMPTZ DEFAULT NOW(),
        month_label TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS config (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );

      INSERT INTO config (key, value) VALUES
        ('admin_password', 'admin123'),
        ('start_hour', '6'),
        ('end_hour', '18')
      ON CONFLICT (key) DO NOTHING;
    `);
    console.log('✓ Base de données initialisée');
  } finally {
    client.release();
  }
}

// ── HELPERS ───────────────────────────────────────────────
function monthLabel(date) {
  const d = date || new Date();
  return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0');
}

function requireAdmin(req, res, next) {
  if (req.headers['x-admin-token'] !== 'admin-ok') {
    return res.status(401).json({ error: 'Non autorisé' });
  }
  next();
}

function frenchError(e) {
  const msg = e.message || '';
  if (msg.includes('clients_name_key') || (msg.includes('unique') && msg.includes('name'))) {
    return 'Un client avec ce nom existe déjà.';
  }
  if (msg.includes('clients_email_key') || (msg.includes('unique') && msg.includes('email'))) {
    return 'Un client avec cet e-mail existe déjà.';
  }
  if (msg.includes('recipients') && msg.includes('unique')) {
    return 'Ce destinataire existe déjà.';
  }
  if (msg.includes('violates foreign key')) {
    return 'Impossible de supprimer : des données liées existent encore.';
  }
  if (msg.includes('null value') || msg.includes('not-null')) {
    return 'Un champ obligatoire est manquant.';
  }
  return msg;
}

// ── AUTH ──────────────────────────────────────────────────
app.post('/api/auth/login', async (req, res) => {
  const { email, password } = req.body;
  try {
    if ((email || '').toLowerCase().trim() === 'admin') {
      const r = await pool.query("SELECT value FROM config WHERE key = 'admin_password'");
      if (r.rows[0]?.value === password) {
        return res.json({ role: 'admin', name: 'Administrateur' });
      }
      return res.status(401).json({ error: 'Identifiants incorrects' });
    }
    const r = await pool.query(
      'SELECT id, name, email, password, address, phone, blocked FROM clients WHERE LOWER(email) = LOWER($1)',
      [email.trim()]
    );
    const c = r.rows[0];
    if (c && c.password === password) {
      if (c.blocked) return res.status(403).json({ error: 'Compte bloqué. Contactez votre administrateur.' });
      return res.json({ role: 'client', id: c.id, name: c.name, email: c.email, address: c.address, phone: c.phone });
    }
    return res.status(401).json({ error: 'Identifiants incorrects' });
  } catch (e) {
    res.status(500).json({ error: frenchError(e) });
  }
});

app.post('/api/auth/change-password', async (req, res) => {
  const { email, oldPassword, newPassword } = req.body;
  try {
    const r = await pool.query('SELECT id, password FROM clients WHERE LOWER(email) = LOWER($1)', [email]);
    const c = r.rows[0];
    if (!c || c.password !== oldPassword) return res.status(401).json({ error: 'Ancien mot de passe incorrect' });
    await pool.query('UPDATE clients SET password = $1 WHERE id = $2', [newPassword, c.id]);
    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ error: frenchError(e) });
  }
});

// ── CONFIG ────────────────────────────────────────────────
app.get('/api/config', async (req, res) => {
  try {
    const r = await pool.query("SELECT key, value FROM config WHERE key IN ('start_hour','end_hour')");
    const cfg = {};
    r.rows.forEach(row => { cfg[row.key] = row.value; });
    res.json(cfg);
  } catch (e) {
    res.status(500).json({ error: frenchError(e) });
  }
});

app.post('/api/config', requireAdmin, async (req, res) => {
  const { start_hour, end_hour, admin_password } = req.body;
  try {
    if (start_hour !== undefined) await pool.query("UPDATE config SET value = $1 WHERE key = 'start_hour'", [String(start_hour)]);
    if (end_hour !== undefined) await pool.query("UPDATE config SET value = $1 WHERE key = 'end_hour'", [String(end_hour)]);
    if (admin_password) await pool.query("UPDATE config SET value = $1 WHERE key = 'admin_password'", [admin_password]);
    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ error: frenchError(e) });
  }
});

// ── CLIENTS ───────────────────────────────────────────────
app.get('/api/clients', requireAdmin, async (req, res) => {
  try {
    const r = await pool.query('SELECT id, name, email, address, phone, blocked, created_at FROM clients ORDER BY name');
    res.json(r.rows);
  } catch (e) {
    res.status(500).json({ error: frenchError(e) });
  }
});

app.post('/api/clients', requireAdmin, async (req, res) => {
  const { name, email, address, phone } = req.body;
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    // Create client
    const r = await client.query(
      "INSERT INTO clients (name, email, address, phone, password) VALUES ($1, $2, $3, $4, '1234') RETURNING id, name, email, address, phone",
      [name, email, address || '', phone || '']
    );
    const newClient = r.rows[0];
    // Auto-create matching recipient
    const rr = await client.query(
      'INSERT INTO recipients (name, email, address, phone, client_id) VALUES ($1,$2,$3,$4,$5) RETURNING id',
      [name, email, address || '', phone || '', newClient.id]
    );
    await client.query('COMMIT');
    res.json(newClient);
  } catch (e) {
    await client.query('ROLLBACK');
    res.status(500).json({ error: frenchError(e) });
  } finally {
    client.release();
  }
});

app.put('/api/clients/:id', requireAdmin, async (req, res) => {
  const { name, email, address, phone } = req.body;
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(
      'UPDATE clients SET name=$1, email=$2, address=$3, phone=$4 WHERE id=$5',
      [name, email, address || '', phone || '', req.params.id]
    );
    // Sync recipient
    await client.query(
      'UPDATE recipients SET name=$1, email=$2, address=$3, phone=$4 WHERE client_id=$5',
      [name, email, address || '', phone || '', req.params.id]
    );
    await client.query('COMMIT');
    res.json({ success: true });
  } catch (e) {
    await client.query('ROLLBACK');
    res.status(500).json({ error: frenchError(e) });
  } finally {
    client.release();
  }
});

app.delete('/api/clients/:id', requireAdmin, async (req, res) => {
  try {
    await pool.query('DELETE FROM clients WHERE id = $1', [req.params.id]);
    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ error: frenchError(e) });
  }
});

app.post('/api/clients/:id/reset-password', requireAdmin, async (req, res) => {
  try {
    await pool.query("UPDATE clients SET password = '1234' WHERE id = $1", [req.params.id]);
    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ error: frenchError(e) });
  }
});

app.post('/api/clients/:id/block', requireAdmin, async (req, res) => {
  const { blocked } = req.body;
  try {
    await pool.query('UPDATE clients SET blocked = $1 WHERE id = $2', [blocked, req.params.id]);
    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ error: frenchError(e) });
  }
});

app.post('/api/clients/:id/change-password', requireAdmin, async (req, res) => {
  const { newPassword } = req.body;
  if (!newPassword || newPassword.length < 3) return res.status(400).json({ error: 'Mot de passe trop court' });
  try {
    await pool.query('UPDATE clients SET password = $1 WHERE id = $2', [newPassword, req.params.id]);
    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ error: frenchError(e) });
  }
});

// ── RECIPIENTS ────────────────────────────────────────────
app.get('/api/recipients', requireAdmin, async (req, res) => {
  try {
    const r = await pool.query('SELECT id, name, email, address, phone, client_id FROM recipients ORDER BY name');
    res.json(r.rows);
  } catch (e) {
    res.status(500).json({ error: frenchError(e) });
  }
});

app.post('/api/recipients', async (req, res) => {
  const { name, email, address, phone, client_id } = req.body;
  const isAdmin = req.headers['x-admin-token'] === 'admin-ok';
  try {
    const r = await pool.query(
      'INSERT INTO recipients (name, email, address, phone, added_by_client_id) VALUES ($1,$2,$3,$4,$5) RETURNING id, name, email, address, phone',
      [name, email || '', address || '', phone || '', client_id || null]
    );
    const recipient = r.rows[0];
    // Auto-assign to client if added by client
    if (client_id) {
      await pool.query(
        'INSERT INTO client_recipients (client_id, recipient_id) VALUES ($1,$2) ON CONFLICT DO NOTHING',
        [client_id, recipient.id]
      );
    }
    res.json(recipient);
  } catch (e) {
    res.status(500).json({ error: frenchError(e) });
  }
});

app.put('/api/recipients/:id', requireAdmin, async (req, res) => {
  const { name, email, address, phone } = req.body;
  try {
    await pool.query(
      'UPDATE recipients SET name=$1, email=$2, address=$3, phone=$4 WHERE id=$5',
      [name, email || '', address || '', phone || '', req.params.id]
    );
    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ error: frenchError(e) });
  }
});

app.delete('/api/recipients/:id', requireAdmin, async (req, res) => {
  try {
    await pool.query('DELETE FROM recipients WHERE id = $1', [req.params.id]);
    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ error: frenchError(e) });
  }
});

// ── CLIENT-RECIPIENTS ASSIGNMENTS ────────────────────────
app.get('/api/clients/:id/recipients', async (req, res) => {
  try {
    const r = await pool.query(
      `SELECT r.id, r.name, r.email, r.address, r.phone
       FROM recipients r
       JOIN client_recipients cr ON cr.recipient_id = r.id
       WHERE cr.client_id = $1
       ORDER BY r.name`,
      [req.params.id]
    );
    res.json(r.rows);
  } catch (e) {
    res.status(500).json({ error: frenchError(e) });
  }
});

app.get('/api/assignments', requireAdmin, async (req, res) => {
  try {
    const r = await pool.query('SELECT client_id, recipient_id FROM client_recipients');
    res.json(r.rows);
  } catch (e) {
    res.status(500).json({ error: frenchError(e) });
  }
});

app.post('/api/assignments', requireAdmin, async (req, res) => {
  const { client_id, recipient_id } = req.body;
  try {
    await pool.query(
      'INSERT INTO client_recipients (client_id, recipient_id) VALUES ($1,$2) ON CONFLICT DO NOTHING',
      [client_id, recipient_id]
    );
    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ error: frenchError(e) });
  }
});

app.delete('/api/assignments', requireAdmin, async (req, res) => {
  const { client_id, recipient_id } = req.body;
  try {
    await pool.query(
      'DELETE FROM client_recipients WHERE client_id=$1 AND recipient_id=$2',
      [client_id, recipient_id]
    );
    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ error: frenchError(e) });
  }
});

// ── ORDERS ────────────────────────────────────────────────
app.get('/api/orders/client/:clientId', async (req, res) => {
  try {
    const r = await pool.query(
      `SELECT o.id, o.recipient_id, o.quantity, o.comment, o.ordered_at,
              r.name as recipient_name
       FROM orders o
       JOIN recipients r ON r.id = o.recipient_id
       WHERE o.client_id = $1`,
      [req.params.clientId]
    );
    res.json(r.rows);
  } catch (e) {
    res.status(500).json({ error: frenchError(e) });
  }
});

app.post('/api/orders', async (req, res) => {
  const { client_id, recipient_id, comment } = req.body;
  const quantity = parseInt(req.body.quantity) || 0;
  const ml = monthLabel();
  try {
    if (quantity <= 0) {
      await pool.query('DELETE FROM orders WHERE client_id=$1 AND recipient_id=$2', [client_id, recipient_id]);
    } else {
      await pool.query(
        `INSERT INTO orders (client_id, recipient_id, quantity, comment, month_label)
         VALUES ($1,$2,$3,$4,$5)
         ON CONFLICT (client_id, recipient_id)
         DO UPDATE SET quantity=EXCLUDED.quantity, comment=EXCLUDED.comment, ordered_at=NOW(), month_label=EXCLUDED.month_label`,
        [client_id, recipient_id, quantity, comment || '', ml]
      );
    }
    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ error: frenchError(e) });
  }
});

app.get('/api/orders/all', requireAdmin, async (req, res) => {
  try {
    const r = await pool.query(
      `SELECT o.id, o.quantity, o.comment, o.ordered_at, o.month_label,
              c.id as client_id, c.name as client_name,
              rec.id as recipient_id, rec.name as recipient_name
       FROM orders o
       JOIN clients c ON c.id = o.client_id
       JOIN recipients rec ON rec.id = o.recipient_id
       WHERE o.quantity > 0
       ORDER BY c.name, rec.name`
    );
    res.json(r.rows);
  } catch (e) {
    res.status(500).json({ error: frenchError(e) });
  }
});

// ── EXPORT & RESET ────────────────────────────────────────
app.post('/api/orders/export', requireAdmin, async (req, res) => {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // Get all current orders
    const orders = await client.query(
      `SELECT o.*, c.name as client_name, r.name as recipient_name
       FROM orders o
       JOIN clients c ON c.id = o.client_id
       JOIN recipients r ON r.id = o.recipient_id
       WHERE o.quantity > 0`
    );

    if (orders.rows.length === 0) {
      await client.query('ROLLBACK');
      return res.json({ rows: [], message: 'Aucune commande' });
    }

    // Move to history
    for (const o of orders.rows) {
      await client.query(
        `INSERT INTO order_history (client_id, client_name, recipient_id, recipient_name, quantity, comment, ordered_at, month_label)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
        [o.client_id, o.client_name, o.recipient_id, o.recipient_name, o.quantity, o.comment, o.ordered_at, o.month_label]
      );
    }

    // Delete current orders
    await client.query('DELETE FROM orders WHERE quantity > 0');
    await client.query('COMMIT');

    res.json({ rows: orders.rows });
  } catch (e) {
    await client.query('ROLLBACK');
    res.status(500).json({ error: frenchError(e) });
  } finally {
    client.release();
  }
});

// ── HISTORY ───────────────────────────────────────────────
app.get('/api/history/months', requireAdmin, async (req, res) => {
  try {
    const r = await pool.query(
      'SELECT DISTINCT month_label FROM order_history ORDER BY month_label DESC'
    );
    res.json(r.rows.map(r => r.month_label));
  } catch (e) {
    res.status(500).json({ error: frenchError(e) });
  }
});

app.get('/api/history/:month', async (req, res) => {
  const isAdmin = req.headers['x-admin-token'] === 'admin-ok';
  const clientId = req.headers['x-client-id'];
  try {
    let r;
    if (isAdmin) {
      r = await pool.query(
        `SELECT id, client_name, recipient_name, quantity, comment, ordered_at, exported_at, month_label
         FROM order_history WHERE month_label = $1
         ORDER BY client_name, recipient_name`,
        [req.params.month]
      );
    } else if (clientId) {
      r = await pool.query(
        `SELECT id, client_name, recipient_name, quantity, comment, ordered_at, exported_at, month_label
         FROM order_history WHERE month_label = $1 AND client_id = $2
         ORDER BY recipient_name`,
        [req.params.month, clientId]
      );
    } else {
      return res.status(401).json({ error: 'Non autorisé' });
    }
    res.json(r.rows);
  } catch (e) {
    res.status(500).json({ error: frenchError(e) });
  }
});

app.get('/api/history/client/:clientId/:month', async (req, res) => {
  try {
    const r = await pool.query(
      `SELECT recipient_name, quantity, comment, ordered_at
       FROM order_history
       WHERE client_id = $1 AND month_label = $2
       ORDER BY recipient_name`,
      [req.params.clientId, req.params.month]
    );
    res.json(r.rows);
  } catch (e) {
    res.status(500).json({ error: frenchError(e) });
  }
});

// ── SERVE SPA ─────────────────────────────────────────────
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
