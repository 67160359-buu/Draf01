require('dotenv').config();

const path = require('path');
const crypto = require('crypto');
const express = require('express');
const cors = require('cors');
const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs');
const { pool, initDB } = require('./db');

const app = express();
app.set('trust proxy', true);

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

const JWT_SECRET = process.env.JWT_SECRET || 'skyflow_secret_key_2024';

function authenticateToken(req, res, next) {
  const authHeader = req.headers['authorization'];
  const token = authHeader && authHeader.split(' ')[1];
  if (!token) return res.status(401).json({ error: 'Access token required', message: 'กรุณาเข้าสู่ระบบ' });

  jwt.verify(token, JWT_SECRET, (err, user) => {
    if (err) return res.status(403).json({ error: 'Invalid or expired token', message: 'เซสชันหมดอายุ กรุณาเข้าสู่ระบบใหม่' });
    req.user = user;
    next();
  });
}

// -------------------------------------------------------------
// Health & Pages
// -------------------------------------------------------------
app.get('/health', async (req, res) => {
  try {
    await pool.query('SELECT 1');
    res.json({ status: 'ok', db: 'connected' });
  } catch (err) {
    res.status(503).json({ status: 'error', db: 'disconnected' });
  }
});

app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// -------------------------------------------------------------
// Auth & Validation Endpoints
// -------------------------------------------------------------
const checkUsername = async (req, res) => {
  try {
    const result = await pool.query('SELECT id FROM users WHERE username = $1', [req.params.username]);
    res.json({ available: result.rows.length === 0 });
  } catch (err) {
    res.status(500).json({ error: 'Database error' });
  }
};

const checkEmail = async (req, res) => {
  try {
    const result = await pool.query('SELECT id FROM users WHERE email = $1', [req.params.email]);
    res.json({ available: result.rows.length === 0 });
  } catch (err) {
    res.status(500).json({ error: 'Database error' });
  }
};

app.get('/check-username/:username', checkUsername);
app.get('/api/auth/check-username/:username', checkUsername);
app.get('/check-email/:email', checkEmail);
app.get('/api/auth/check-email/:email', checkEmail);

const handleRegister = async (req, res) => {
  const { name, username, email, password } = req.body || {};
  const fullName = name || username || 'User';
  const uname = username || name || (email ? email.split('@')[0] : 'user');

  if (!email || !password) {
    return res.status(400).json({ message: 'กรุณากรอก Email และ Password ให้ครบถ้วน' });
  }
  if (String(password).length < 6) {
    return res.status(400).json({ message: 'Password ต้องมีอย่างน้อย 6 ตัวอักษร' });
  }

  try {
    const hash = await bcrypt.hash(String(password), 10);
    const result = await pool.query(
      'INSERT INTO users (name, username, email, password) VALUES ($1, $2, $3, $4) RETURNING id, name, username, email, role',
      [fullName, uname, email, hash]
    );
    res.status(201).json({ message: 'สมัครสมาชิกสำเร็จ', user: result.rows[0] });
  } catch (err) {
    console.error('Register error:', err);
    if (err.code === '23505') {
      return res.status(409).json({ message: 'Email หรือ Username นี้ถูกใช้งานไปแล้ว' });
    }
    res.status(500).json({ message: 'เกิดข้อผิดพลาดทางเซิร์ฟเวอร์' });
  }
};

app.post('/register', handleRegister);
app.post('/api/auth/register', handleRegister);

async function passwordMatches(plain, stored) {
  if (typeof stored === 'string' && stored.startsWith('$2')) {
    return bcrypt.compare(String(plain), stored);
  }
  // รองรับบัญชีเก่าที่เก็บรหัสผ่านแบบ plain text
  return stored === plain;
}

const handleLogin = async (req, res) => {
  const { username, email, password } = req.body || {};
  const identity = username || email;
  const clientIp = String(req.headers['x-forwarded-for'] || req.socket.remoteAddress || '').split(',')[0].trim().slice(0, 45);
  const userAgent = req.headers['user-agent'];

  if (!identity || !password) {
    return res.status(400).json({ message: 'กรุณากรอก Username/Email และ Password' });
  }

  try {
    const result = await pool.query('SELECT * FROM users WHERE email = $1 OR username = $1', [identity]);
    const user = result.rows[0];
    const ok = user && (await passwordMatches(password, user.password));

    if (!ok) {
      if (user) {
        await pool.query(
          'INSERT INTO login_logs (user_id, username, ip_address, user_agent, status) VALUES ($1, $2, $3, $4, $5)',
          [user.id, String(identity).slice(0, 50), clientIp, userAgent, 'FAILED']
        );
      }
      return res.status(401).json({ message: 'Username/Email หรือ Password ไม่ถูกต้อง' });
    }

    // อัปเกรดรหัสผ่านเก่าเป็น hash อัตโนมัติ
    if (!user.password.startsWith('$2')) {
      const hash = await bcrypt.hash(String(password), 10);
      await pool.query('UPDATE users SET password = $1 WHERE id = $2', [hash, user.id]);
    }

    await pool.query(
      'INSERT INTO login_logs (user_id, username, ip_address, user_agent, status) VALUES ($1, $2, $3, $4, $5)',
      [user.id, String(identity).slice(0, 50), clientIp, userAgent, 'SUCCESS']
    );

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

// -------------------------------------------------------------
// Booking Endpoints
// -------------------------------------------------------------
function generateBookingRef() {
  return 'SKY' + crypto.randomBytes(4).toString('hex').toUpperCase();
}

app.post('/api/bookings', async (req, res) => {
  const b = req.body || {};
  const {
    passengerName, passengerEmail, passengerPhone,
    airline, flightCode, route, depTime, arrTime, totalPrice, paymentMethod
  } = b;
  const bookingRef = b.bookingRef || generateBookingRef();

  if (!passengerName || !passengerEmail || !airline || !flightCode || !route ||
      totalPrice === undefined || totalPrice === null || !paymentMethod) {
    return res.status(400).json({ message: 'ข้อมูลการจองไม่ครบถ้วน' });
  }

  let userId = null;
  const authHeader = req.headers['authorization'];
  if (authHeader) {
    const token = authHeader.split(' ')[1];
    try {
      userId = jwt.verify(token, JWT_SECRET).id;
    } catch (e) { /* guest booking */ }
  }

  try {
    const result = await pool.query(
      `INSERT INTO bookings
      (booking_ref, user_id, passenger_name, passenger_email, passenger_phone, airline, flight_code, route, dep_time, arr_time, total_price, payment_method)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
      RETURNING *`,
      [bookingRef, userId, passengerName, passengerEmail, passengerPhone || null, airline, flightCode, route, depTime || null, arrTime || null, totalPrice, paymentMethod]
    );

    res.status(201).json({ message: 'บันทึกข้อมูลการจองสำเร็จ', booking: result.rows[0] });
  } catch (err) {
    console.error('Save booking error:', err);
    if (err.code === '23505') {
      return res.status(409).json({ message: 'รหัสการจองซ้ำ กรุณาลองใหม่' });
    }
    res.status(500).json({ message: 'เกิดข้อผิดพลาดในการบันทึกการจอง' });
  }
});

app.get('/api/my-bookings', authenticateToken, async (req, res) => {
  try {
    const result = await pool.query('SELECT * FROM bookings WHERE user_id = $1 ORDER BY created_at DESC', [req.user.id]);
    res.json({ bookings: result.rows });
  } catch (err) {
    res.status(500).json({ error: 'Database error' });
  }
});

// -------------------------------------------------------------
// Flights Search Route  (GET /api/flights)
// -------------------------------------------------------------
app.use('/api', require('./flights-route'));

// Unknown API paths -> JSON 404
app.use('/api', (req, res) => res.status(404).json({ message: 'ไม่พบ API ที่เรียก' }));

// -------------------------------------------------------------
// Start Server (เริ่มรับ request ทันที, ฐานข้อมูลเตรียมพร้อมควบคู่ไป)
// -------------------------------------------------------------
const PORT = process.env.PORT || 3000;
app.listen(PORT, '0.0.0.0', () => {
  console.log(`🚀 SkyFlow Server running on port ${PORT}`);
  initDB();
});
