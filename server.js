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
        email TEXT NOT NULL,
        login_id TEXT UNIQUE,
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
      -- Migration: drop unique constraint on email if exists
      DO $$ BEGIN
        IF EXISTS (
          SELECT 1 FROM pg_constraint WHERE conname = 'clients_email_key'
        ) THEN
          ALTER TABLE clients DROP CONSTRAINT clients_email_key;
        END IF;
      END $$;
      -- Migration: add login_id column if not exists
      DO $$ BEGIN
        IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='clients' AND column_name='login_id') THEN
          ALTER TABLE clients ADD COLUMN login_id TEXT UNIQUE;
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
        paiement_course BOOLEAN NOT NULL DEFAULT FALSE,
        UNIQUE(client_id, recipient_id)
      );
      -- Migration: add paiement_course to client_recipients if not exists
      DO $$ BEGIN
        IF NOT EXISTS (SELECT 1 FROM information_schema.columns
          WHERE table_name='client_recipients' AND column_name='paiement_course') THEN
          ALTER TABLE client_recipients ADD COLUMN paiement_course BOOLEAN NOT NULL DEFAULT FALSE;
        END IF;
      END $$;

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
        client_address TEXT DEFAULT '',
        recipient_id UUID REFERENCES recipients(id) ON DELETE SET NULL,
        recipient_name TEXT NOT NULL,
        quantity INTEGER NOT NULL,
        comment TEXT DEFAULT '',
        ordered_at TIMESTAMPTZ,
        exported_at TIMESTAMPTZ DEFAULT NOW(),
        month_label TEXT NOT NULL
      );
      -- Migration: add client_address to history if not exists
      DO $$ BEGIN
        IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='order_history' AND column_name='client_address') THEN
          ALTER TABLE order_history ADD COLUMN client_address TEXT DEFAULT '';
        END IF;
      END $$;

      CREATE TABLE IF NOT EXISTS config (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS route_sheets (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        name TEXT NOT NULL UNIQUE,
        position INTEGER NOT NULL DEFAULT 0,
        created_at TIMESTAMPTZ DEFAULT NOW()
      );

      CREATE TABLE IF NOT EXISTS route_sheet_clients (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        route_sheet_id UUID REFERENCES route_sheets(id) ON DELETE CASCADE,
        client_id UUID REFERENCES clients(id) ON DELETE CASCADE,
        UNIQUE(route_sheet_id, client_id)
      );

      CREATE TABLE IF NOT EXISTS route_sheet_client_recipients (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        route_sheet_id UUID REFERENCES route_sheets(id) ON DELETE CASCADE,
        client_id UUID REFERENCES clients(id) ON DELETE CASCADE,
        recipient_id UUID REFERENCES recipients(id) ON DELETE CASCADE,
        UNIQUE(route_sheet_id, client_id, recipient_id)
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
  if (msg.includes('clients_login_id_key') || (msg.includes('unique') && msg.includes('login_id'))) {
    return 'Cet identifiant personnalisé est déjà utilisé.';
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
    // Accept login_id (unique) or email as identifier
    const identifier = email.trim();
    // Try login_id first (unique), then email
    let r = await pool.query(
      'SELECT id, name, email, login_id, password, address, phone, blocked FROM clients WHERE LOWER(login_id) = LOWER($1) LIMIT 1',
      [identifier]
    );
    if (r.rows.length === 0) {
      r = await pool.query(
        'SELECT id, name, email, login_id, password, address, phone, blocked FROM clients WHERE LOWER(email) = LOWER($1) LIMIT 1',
        [identifier]
      );
    }
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
    let r = await pool.query(
      'SELECT id, password FROM clients WHERE LOWER(login_id) = LOWER($1) LIMIT 1', [email]
    );
    if (r.rows.length === 0) {
      r = await pool.query(
        'SELECT id, password FROM clients WHERE LOWER(email) = LOWER($1) LIMIT 1', [email]
      );
    }
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
    const r = await pool.query('SELECT id, name, email, login_id, address, phone, blocked, created_at FROM clients ORDER BY name');
    res.json(r.rows);
  } catch (e) {
    res.status(500).json({ error: frenchError(e) });
  }
});

app.post('/api/clients', requireAdmin, async (req, res) => {
  const { name, email, login_id, address, phone } = req.body;
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    // Create client
    const r = await client.query(
      "INSERT INTO clients (name, email, login_id, address, phone, password) VALUES ($1, $2, $3, $4, $5, '1234') RETURNING id, name, email, login_id, address, phone",
      [name, email, login_id || null, address || '', phone || '']
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
  const { name, email, login_id, address, phone } = req.body;
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(
      'UPDATE clients SET name=$1, email=$2, login_id=$3, address=$4, phone=$5 WHERE id=$6',
      [name, email, login_id || null, address || '', phone || '', req.params.id]
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
    const r = await pool.query('SELECT client_id, recipient_id, paiement_course FROM client_recipients');
    res.json(r.rows);
  } catch (e) {
    res.status(500).json({ error: frenchError(e) });
  }
});

app.post('/api/assignments', requireAdmin, async (req, res) => {
  const { client_id, recipient_id, paiement_course } = req.body;
  try {
    await pool.query(
      `INSERT INTO client_recipients (client_id, recipient_id, paiement_course)
       VALUES ($1,$2,$3)
       ON CONFLICT (client_id, recipient_id)
       DO UPDATE SET paiement_course = EXCLUDED.paiement_course`,
      [client_id, recipient_id, paiement_course || false]
    );
    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ error: frenchError(e) });
  }
});

app.patch('/api/assignments', requireAdmin, async (req, res) => {
  const { client_id, recipient_id, paiement_course } = req.body;
  try {
    await pool.query(
      'UPDATE client_recipients SET paiement_course=$1 WHERE client_id=$2 AND recipient_id=$3',
      [paiement_course, client_id, recipient_id]
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
              c.id as client_id, c.name as client_name, c.address as client_address,
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

    // Get all current orders with client address and recipient info
    const orders = await client.query(
      `SELECT o.client_id, o.recipient_id, o.quantity, o.comment, o.ordered_at, o.month_label,
              c.name as client_name, c.address as client_address,
              r.name as recipient_name
       FROM orders o
       JOIN clients c ON c.id = o.client_id
       JOIN recipients r ON r.id = o.recipient_id
       WHERE o.quantity > 0
       ORDER BY c.name, r.name`
    );

    if (orders.rows.length === 0) {
      await client.query('ROLLBACK');
      return res.json({ rows: [], allRecipients: [], message: 'Aucune commande' });
    }

    // Get all recipients that appear in orders (for column headers)
    const allRecipients = [...new Set(orders.rows.map(o => o.recipient_name))].sort();

    // Move to history
    for (const o of orders.rows) {
      await client.query(
        `INSERT INTO order_history (client_id, client_name, client_address, recipient_id, recipient_name, quantity, comment, ordered_at, month_label)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
        [o.client_id, o.client_name, o.client_address || '', o.recipient_id, o.recipient_name, o.quantity, o.comment, o.ordered_at, o.month_label]
      );
    }

    // Delete current orders
    await client.query('DELETE FROM orders WHERE quantity > 0');
    await client.query('COMMIT');

    // Explicitly map to ensure field names are correct
    const mappedRows = orders.rows.map(o => ({
      client_id: o.client_id,
      client_name: o.client_name,
      client_address: o.client_address || '',
      recipient_id: o.recipient_id,
      recipient_name: o.recipient_name,
      quantity: o.quantity,
      comment: o.comment,
      ordered_at: o.ordered_at,
      month_label: o.month_label
    }));
    res.json({ rows: mappedRows, allRecipients });
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
        `SELECT id, client_name, client_address, recipient_name, quantity, comment, ordered_at, exported_at, month_label
         FROM order_history WHERE month_label = $1
         ORDER BY client_name, recipient_name`,
        [req.params.month]
      );
    } else if (clientId) {
      r = await pool.query(
        `SELECT id, client_name, client_address, recipient_name, quantity, comment, ordered_at, exported_at, month_label
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

// ── BULK IMPORT CLIENTS ──────────────────────────────────
app.post('/api/clients/import', requireAdmin, async (req, res) => {
  const { clients } = req.body;
  if (!Array.isArray(clients) || clients.length === 0) {
    return res.status(400).json({ error: 'Aucune donnée à importer' });
  }

  const dbClient = await pool.connect();
  try {
    await dbClient.query('BEGIN');

    // Delete all existing orders, history links, assignments, recipients and clients
    await dbClient.query('DELETE FROM orders');
    await dbClient.query('DELETE FROM order_history');
    await dbClient.query('DELETE FROM route_sheet_client_recipients');
    await dbClient.query('DELETE FROM route_sheet_clients');
    await dbClient.query('DELETE FROM client_recipients');
    await dbClient.query('DELETE FROM recipients');
    await dbClient.query('DELETE FROM clients');

    const created = [];
    const errors = [];

    for (const row of clients) {
      const name = (row.name || '').trim();
      const email = (row.email || '').trim().toLowerCase();
      if (!name || !email) { errors.push(`Ligne ignorée : nom ou email manquant (${name || '?'})`); continue; }
      try {
        const r = await dbClient.query(
          "INSERT INTO clients (name, email, password) VALUES ($1, $2, '1234') RETURNING id, name, email",
          [name, email]
        );
        const newClient = r.rows[0];
        // Auto-create matching recipient
        await dbClient.query(
          'INSERT INTO recipients (name, email, client_id) VALUES ($1,$2,$3)',
          [name, email, newClient.id]
        );
        created.push(newClient);
      } catch(e) {
        errors.push(`${name} (${email}) : ${frenchError(e)}`);
      }
    }

    await dbClient.query('COMMIT');
    res.json({ created: created.length, errors });
  } catch(e) {
    await dbClient.query('ROLLBACK');
    res.status(500).json({ error: frenchError(e) });
  } finally {
    dbClient.release();
  }
});

// ── ROUTE SHEETS ─────────────────────────────────────────
app.get('/api/route-sheets', requireAdmin, async (req, res) => {
  try {
    const sheets = await pool.query('SELECT id, name, position FROM route_sheets ORDER BY position, name');
    const assignments = await pool.query(
      `SELECT rsc.route_sheet_id, rsc.client_id, c.name as client_name
       FROM route_sheet_clients rsc
       JOIN clients c ON c.id = rsc.client_id
       ORDER BY c.name`
    );
    const recipientAssignments = await pool.query(
      `SELECT rscr.route_sheet_id, rscr.client_id, rscr.recipient_id, r.name as recipient_name
       FROM route_sheet_client_recipients rscr
       JOIN recipients r ON r.id = rscr.recipient_id
       ORDER BY r.name`
    );
    const result = sheets.rows.map(s => ({
      ...s,
      clients: assignments.rows
        .filter(a => a.route_sheet_id === s.id)
        .map(a => ({
          id: a.client_id,
          name: a.client_name,
          recipients: recipientAssignments.rows
            .filter(r => r.route_sheet_id === s.id && r.client_id === a.client_id)
            .map(r => ({ id: r.recipient_id, name: r.recipient_name }))
        }))
    }));
    res.json(result);
  } catch(e) { res.status(500).json({ error: frenchError(e) }); }
});

app.post('/api/route-sheets', requireAdmin, async (req, res) => {
  const { name } = req.body;
  if (!name) return res.status(400).json({ error: 'Le nom est obligatoire' });
  try {
    const maxPos = await pool.query('SELECT COALESCE(MAX(position),0)+1 as pos FROM route_sheets');
    const r = await pool.query(
      'INSERT INTO route_sheets (name, position) VALUES ($1,$2) RETURNING id, name, position',
      [name, maxPos.rows[0].pos]
    );
    res.json({ ...r.rows[0], clients: [] });
  } catch(e) { res.status(500).json({ error: frenchError(e) }); }
});

app.put('/api/route-sheets/:id', requireAdmin, async (req, res) => {
  const { name } = req.body;
  try {
    await pool.query('UPDATE route_sheets SET name=$1 WHERE id=$2', [name, req.params.id]);
    res.json({ success: true });
  } catch(e) { res.status(500).json({ error: frenchError(e) }); }
});

app.delete('/api/route-sheets/:id', requireAdmin, async (req, res) => {
  try {
    await pool.query('DELETE FROM route_sheets WHERE id=$1', [req.params.id]);
    res.json({ success: true });
  } catch(e) { res.status(500).json({ error: frenchError(e) }); }
});

app.post('/api/route-sheets/:id/clients', requireAdmin, async (req, res) => {
  const { client_id } = req.body;
  try {
    await pool.query(
      'INSERT INTO route_sheet_clients (route_sheet_id, client_id) VALUES ($1,$2) ON CONFLICT DO NOTHING',
      [req.params.id, client_id]
    );
    res.json({ success: true });
  } catch(e) { res.status(500).json({ error: frenchError(e) }); }
});

app.delete('/api/route-sheets/:id/clients/:clientId', requireAdmin, async (req, res) => {
  try {
    // Also remove all recipient assignments for this client in this sheet
    await pool.query(
      'DELETE FROM route_sheet_client_recipients WHERE route_sheet_id=$1 AND client_id=$2',
      [req.params.id, req.params.clientId]
    );
    await pool.query(
      'DELETE FROM route_sheet_clients WHERE route_sheet_id=$1 AND client_id=$2',
      [req.params.id, req.params.clientId]
    );
    res.json({ success: true });
  } catch(e) { res.status(500).json({ error: frenchError(e) }); }
});

app.post('/api/route-sheets/:id/clients/:clientId/recipients', requireAdmin, async (req, res) => {
  const { recipient_id } = req.body;
  try {
    await pool.query(
      'INSERT INTO route_sheet_client_recipients (route_sheet_id, client_id, recipient_id) VALUES ($1,$2,$3) ON CONFLICT DO NOTHING',
      [req.params.id, req.params.clientId, recipient_id]
    );
    res.json({ success: true });
  } catch(e) { res.status(500).json({ error: frenchError(e) }); }
});

app.delete('/api/route-sheets/:id/clients/:clientId/recipients/:recipientId', requireAdmin, async (req, res) => {
  try {
    await pool.query(
      'DELETE FROM route_sheet_client_recipients WHERE route_sheet_id=$1 AND client_id=$2 AND recipient_id=$3',
      [req.params.id, req.params.clientId, req.params.recipientId]
    );
    res.json({ success: true });
  } catch(e) { res.status(500).json({ error: frenchError(e) }); }
});

// ── EXPORT BY ROUTE SHEET ─────────────────────────────────
app.post('/api/orders/export-by-route', requireAdmin, async (req, res) => {
  const dbClient = await pool.connect();
  try {
    await dbClient.query('BEGIN');

    // Get all orders
    const orders = await dbClient.query(
      `SELECT o.client_id, o.recipient_id, o.quantity, o.comment, o.ordered_at, o.month_label,
              c.name as client_name, c.address as client_address,
              r.name as recipient_name
       FROM orders o
       JOIN clients c ON c.id = o.client_id
       JOIN recipients r ON r.id = o.recipient_id
       WHERE o.quantity > 0
       ORDER BY c.name, r.name`
    );

    if (orders.rows.length === 0) {
      await dbClient.query('ROLLBACK');
      return res.json({ sheets: [], message: 'Aucune commande' });
    }

    // Get route sheets with their clients
    const sheets = await dbClient.query('SELECT id, name FROM route_sheets ORDER BY position, name');
    const assignments = await dbClient.query('SELECT route_sheet_id, client_id FROM route_sheet_clients');

    // Build sheet -> client_ids map
    const sheetClients = {};
    sheets.rows.forEach(s => { sheetClients[s.id] = { name: s.name, clientIds: new Set() }; });
    assignments.rows.forEach(a => { if (sheetClients[a.route_sheet_id]) sheetClients[a.route_sheet_id].clientIds.add(a.client_id); });

    // Assigned client IDs
    const assignedClientIds = new Set(assignments.rows.map(a => a.client_id));

    // Get per-client recipient filters
    const recipientFilters = await dbClient.query(
      'SELECT route_sheet_id, client_id, recipient_id FROM route_sheet_client_recipients'
    );

    // Group orders by sheet, filtered by configured recipients per client
    const result = [];
    for (const [sheetId, sheet] of Object.entries(sheetClients)) {
      const sheetOrders = orders.rows.filter(o => {
        if (!sheet.clientIds.has(o.client_id)) return false;
        // Check if this sheet has recipient filters for this client
        const filters = recipientFilters.rows.filter(
          r => r.route_sheet_id === sheetId && r.client_id === o.client_id
        );
        // If no recipients configured for this client in this sheet: include all orders
        if (filters.length === 0) return true;
        // Otherwise only include orders for configured recipients
        return filters.some(f => f.recipient_id === o.recipient_id);
      });
      result.push({ name: sheet.name, rows: sheetOrders });
    }

    // "Autres" — clients with orders but not in any sheet
    const othersOrders = orders.rows.filter(o => !assignedClientIds.has(o.client_id));
    if (othersOrders.length > 0) {
      result.push({ name: 'Autres', rows: othersOrders });
    }

    // Move all to history & delete
    for (const o of orders.rows) {
      await dbClient.query(
        `INSERT INTO order_history (client_id, client_name, client_address, recipient_id, recipient_name, quantity, comment, ordered_at, month_label)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
        [o.client_id, o.client_name, o.client_address || '', o.recipient_id, o.recipient_name, o.quantity, o.comment, o.ordered_at, o.month_label]
      );
    }
    await dbClient.query('DELETE FROM orders WHERE quantity > 0');
    await dbClient.query('COMMIT');

    res.json({ sheets: result });
  } catch(e) {
    await dbClient.query('ROLLBACK');
    res.status(500).json({ error: frenchError(e) });
  } finally {
    dbClient.release();
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
