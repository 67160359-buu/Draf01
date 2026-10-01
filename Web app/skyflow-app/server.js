const path = require('path');
const express = require('express');
const cors = require('cors');
const { Pool } = require('pg');
const jwt = require('jsonwebtoken');

const app = express();

app.use(express.static(path.join(__dirname, 'public')));
app.use(cors());
app.use(express.json());

const pool = new Pool({
  host: process.env.DB_HOST || 'postgres',
  port: parseInt(process.env.DB_PORT) || 5432,
  user: process.env.DB_USER || 'postgres',
  password: process.env.DB_PASSWORD || 'skyflowpass',
  database: process.env.DB_NAME || 'skyflow_db',
});

const JWT_SECRET = process.env.JWT_SECRET || 'skyflow_secret_key_2024';

function authenticateToken(req, res, next) {
  const authHeader = req.headers['authorization'];
  const token = authHeader && authHeader.split(' ')[1];
  if (!token) return res.status(401).json({ error: 'Access token required' });

  jwt.verify(token, JWT_SECRET, (err, user) => {
    if (err) return res.status(403).json({ error: 'Invalid or expired token' });
    req.user = user;
    next();
  });
}

async function initDB() {
  let retries = 5;
  while (retries > 0) {
    try {
      await pool.query(`
        CREATE TABLE IF NOT EXISTS users (
          id SERIAL PRIMARY KEY,
          name VARCHAR(100) NOT NULL,
          username VARCHAR(50) UNIQUE,
          email VARCHAR(100) UNIQUE NOT NULL,
          password VARCHAR(255) NOT NULL,
          role VARCHAR(20) DEFAULT 'user',
          created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        );
      `);
      console.log('✅ Database connected and table initialized');
      break;
    } catch (err) {
      console.error(`⚠️ Database connection error. Retrying... (${retries} left)`);
      retries--;
      await new Promise(res => setTimeout(res, 3000));
    }
  }
}

// Check Username Availability
app.get('/check-username/:username', async (req, res) => {
  try {
    const result = await pool.query('SELECT id FROM users WHERE username = $1', [req.params.username]);
    res.json({ available: result.rows.length === 0 });
  } catch (err) {
    res.status(500).json({ error: 'Database error' });
  }
});

// Check Email Availability
app.get('/check-email/:email', async (req, res) => {
  try {
    const result = await pool.query('SELECT id FROM users WHERE email = $1', [req.params.email]);
    res.json({ available: result.rows.length === 0 });
  } catch (err) {
    res.status(500).json({ error: 'Database error' });
  }
});

// Register Handlers
const handleRegister = async (req, res) => {
  const { name, username, email, password } = req.body;
  const fullName = name || username || 'User';
  const uname = username || name || (email ? email.split('@')[0] : 'user');

  if (!email || !password) {
    return res.status(400).json({ message: 'กรุณากรอก Email และ Password ให้ครบถ้วน' });
  }

  try {
    const result = await pool.query(
      'INSERT INTO users (name, username, email, password) VALUES ($1, $2, $3, $4) RETURNING id, name, username, email, role',
      [fullName, uname, email, password]
    );
    res.status(201).json({ message: 'สมัครสมาชิกสำเร็จ', user: result.rows[0] });
  } catch (err) {
    console.error('Register error:', err);
    if (err.code === '23505') {
      return res.status(409).json({ message: 'Email หรือ Username นี้ถูกใช้งานไปแล้ว' });
    }
    res.status(500).json({ message: 'เกิดข้อผิดพลาดทางเซิร์ฟเวอร์', details: err.message });
  }
};

app.post('/register', handleRegister);
app.post('/api/auth/register', handleRegister);

// Login Handlers
const handleLogin = async (req, res) => {
  const { username, email, password } = req.body;
  const identity = username || email;

  if (!identity || !password) {
    return res.status(400).json({ message: 'กรุณากรอก Username/Email และ Password' });
  }

  try {
    const result = await pool.query(
      'SELECT * FROM users WHERE email = $1 OR username = $1',
      [identity]
    );
    const user = result.rows[0];

    if (!user || user.password !== password) {
      return res.status(401).json({ message: 'Username/Email หรือ Password ไม่ถูกต้อง' });
    }

    const token = jwt.sign(
      { id: user.id, email: user.email, role: user.role },
      JWT_SECRET,
      { expiresIn: '24h' }
    );

    res.json({
      message: 'Login successful',
      token,
      user: { id: user.id, name: user.name, username: user.username, email: user.email, role: user.role }
    });
  } catch (err) {
    console.error('Login error:', err);
    res.status(500).json({ message: 'เกิดข้อผิดพลาดทางเซิร์ฟเวอร์' });
  }
};

app.post('/login', handleLogin);
app.post('/api/auth/login', handleLogin);

app.use('/api', require('./flights-route'));

const PORT = process.env.PORT || 3000;
app.listen(PORT, async () => {
  console.log(`🚀 SkyFlow Server running on port ${PORT}`);
  await initDB();
});