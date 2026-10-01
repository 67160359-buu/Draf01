const express = require('express');
const { Pool } = require('pg');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const cors = require('cors');
const path = require('path');

const app = express();
app.use(express.json());
app.use(cors());
app.use(express.static(path.join(__dirname, 'public')));

const JWT_SECRET = process.env.JWT_SECRET || 'skyflow_super_secret_key';

const pool = new Pool({
  host: process.env.DB_HOST || 'localhost',
  user: process.env.DB_USER || 'postgres',
  password: process.env.DB_PASSWORD || 'skyflowpass',
  database: process.env.DB_NAME || 'skyflow_db',
  port: 5432,
});

// สร้างตาราง Database และอัปเดตคอลัมน์ email
const initDB = async (retries = 10) => {
  const createTableQuery = `
    CREATE TABLE IF NOT EXISTS users (
      id SERIAL PRIMARY KEY,
      username VARCHAR(50) UNIQUE NOT NULL,
      email VARCHAR(100) UNIQUE NOT NULL,
      password VARCHAR(255) NOT NULL,
      name VARCHAR(100) NOT NULL,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    );
  `;

  const addEmailColumnQuery = `
    ALTER TABLE users 
    ADD COLUMN IF NOT EXISTS email VARCHAR(100);
  `;

  while (retries) {
    try {
      await pool.query(createTableQuery);
      await pool.query(addEmailColumnQuery);
      console.log('Database initialized successfully.');
      break;
    } catch (err) {
      console.log(`Database not ready, retrying in 3 seconds... (${retries} left)`);
      retries -= 1;
      await new Promise(res => setTimeout(res, 3000));
    }
  }
};
initDB();

const authenticateToken = (req, res, next) => {
  const authHeader = req.headers['authorization'];
  const token = authHeader && authHeader.split(' ')[1];
  if (!token) return res.status(401).json({ message: 'Access Token Required' });

  jwt.verify(token, JWT_SECRET, (err, user) => {
    if (err) return res.status(403).json({ message: 'Invalid or Expired Token' });
    req.user = user;
    next();
  });
};

// ==================== 1. AUTHENTICATION ====================

// [POST] /register - สมัครสมาชิก
app.post('/register', async (req, res) => {
  const { username, email, password, name } = req.body;
  if (!username || !email || !password || !name) {
    return res.status(400).json({ message: 'All fields are required' });
  }

  try {
    const hashedPassword = await bcrypt.hash(password, 10);
    const normalizedEmail = email.toLowerCase().trim();
    const result = await pool.query(
      'INSERT INTO users (username, email, password, name) VALUES ($1, $2, $3, $4) RETURNING id, username, email, name',
      [username.trim(), normalizedEmail, hashedPassword, name.trim()]
    );
    res.status(201).json({ message: 'User registered successfully', user: result.rows[0] });
  } catch (err) {
    if (err.code === '23505') {
      return res.status(400).json({ message: 'Username or Email already exists' });
    }
    res.status(500).json({ message: err.message });
  }
});

// [POST] /login - เข้าสู่ระบบ (Username หรือ Email)
app.post('/login', async (req, res) => {
  const { username, password } = req.body;
  try {
    const input = username.toLowerCase().trim();
    const result = await pool.query(
      'SELECT * FROM users WHERE LOWER(username) = $1 OR LOWER(email) = $1',
      [input]
    );
    if (result.rows.length === 0) {
      return res.status(400).json({ message: 'Invalid username or password' });
    }

    const user = result.rows[0];
    const validPassword = await bcrypt.compare(password, user.password);
    if (!validPassword) {
      return res.status(400).json({ message: 'Invalid username or password' });
    }

    const token = jwt.sign(
      { id: user.id, username: user.username, email: user.email },
      JWT_SECRET,
      { expiresIn: '2h' }
    );
    res.json({
      message: 'Login successful',
      token,
      user: { id: user.id, username: user.username, email: user.email, name: user.name }
    });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

// [POST] /logout - ออกจากระบบ
app.post('/logout', authenticateToken, (req, res) => {
  res.json({ message: 'Logout successful' });
});

// [POST] /change-password - เปลี่ยนรหัสผ่าน
app.post('/change-password', authenticateToken, async (req, res) => {
  const { oldPassword, newPassword } = req.body;
  try {
    const result = await pool.query('SELECT * FROM users WHERE id = $1', [req.user.id]);
    const user = result.rows[0];

    const validPassword = await bcrypt.compare(oldPassword, user.password);
    if (!validPassword) {
      return res.status(400).json({ message: 'Incorrect old password' });
    }

    const hashedNewPassword = await bcrypt.hash(newPassword, 10);
    await pool.query('UPDATE users SET password = $1 WHERE id = $2', [hashedNewPassword, req.user.id]);
    res.json({ message: 'Password changed successfully' });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

// ==================== 2. USER MANAGEMENT ====================

// [GET] /me - ดึงข้อมูลตัวเอง
app.get('/me', authenticateToken, async (req, res) => {
  try {
    const result = await pool.query('SELECT id, username, email, name, created_at FROM users WHERE id = $1', [req.user.id]);
    res.json(result.rows[0]);
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

// [GET] /check-username - ตรวจสอบ username (รองรับทั้ง /check-username/:name และ /check-username?name=...)
app.get(['/check-username/:name', '/check-username'], async (req, res) => {
  try {
    const nameParam = req.params.name || req.query.name;
    if (!nameParam) return res.json({ available: true });

    const username = nameParam.toLowerCase().trim();
    const result = await pool.query('SELECT id FROM users WHERE LOWER(username) = $1', [username]);
    res.json({ available: result.rows.length === 0 });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

// [GET] /check-email - ตรวจสอบ email (รองรับทั้ง /check-email/:email และ /check-email?email=...)
app.get(['/check-email/:email', '/check-email'], async (req, res) => {
  try {
    const rawEmail = req.params.email || req.query.email;
    if (!rawEmail) return res.json({ available: true });

    const email = decodeURIComponent(rawEmail).toLowerCase().trim();
    const result = await pool.query(
      'SELECT id FROM users WHERE email IS NOT NULL AND LOWER(email) = $1', 
      [email]
    );
    res.json({ available: result.rows.length === 0 });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

// [GET] /users - ดึงข้อมูล user ทั้งหมด (pagination)
app.get('/users', authenticateToken, async (req, res) => {
  const page = parseInt(req.query.page) || 1;
  const limit = parseInt(req.query.limit) || 10;
  const offset = (page - 1) * limit;

  try {
    const users = await pool.query(
      'SELECT id, username, email, name, created_at FROM users ORDER BY id ASC LIMIT $1 OFFSET $2',
      [limit, offset]
    );
    const total = await pool.query('SELECT COUNT(*) FROM users');

    res.json({
      page,
      limit,
      totalUsers: parseInt(total.rows[0].count),
      totalPages: Math.ceil(parseInt(total.rows[0].count) / limit),
      data: users.rows
    });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

// [GET] /users/{id} - ดึงข้อมูล user ตาม ID
app.get('/users/:id', authenticateToken, async (req, res) => {
  try {
    const result = await pool.query('SELECT id, username, email, name, created_at FROM users WHERE id = $1', [req.params.id]);
    if (result.rows.length === 0) return res.status(404).json({ message: 'User not found' });
    res.json(result.rows[0]);
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

// [PUT] /users/{id} - แก้ไขข้อมูล user
app.put('/users/:id', authenticateToken, async (req, res) => {
  const { name, email } = req.body;
  try {
    const normalizedEmail = email ? email.toLowerCase().trim() : null;
    const result = await pool.query(
      'UPDATE users SET name = $1, email = COALESCE($2, email) WHERE id = $3 RETURNING id, username, email, name',
      [name, normalizedEmail, req.params.id]
    );
    if (result.rows.length === 0) return res.status(404).json({ message: 'User not found' });
    res.json({ message: 'User updated successfully', user: result.rows[0] });
  } catch (err) {
    if (err.code === '23505') {
      return res.status(400).json({ message: 'Email already exists' });
    }
    res.status(500).json({ message: err.message });
  }
});

// [DELETE] /users/{id} - ลบ user
app.delete('/users/:id', authenticateToken, async (req, res) => {
  try {
    const result = await pool.query('DELETE FROM users WHERE id = $1 RETURNING id', [req.params.id]);
    if (result.rows.length === 0) return res.status(404).json({ message: 'User not found' });
    res.json({ message: 'User deleted successfully' });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
