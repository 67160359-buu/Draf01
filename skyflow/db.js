const { Pool } = require('pg');

const pool = new Pool({
  host: process.env.DB_HOST || 'postgres',
  port: parseInt(process.env.DB_PORT) || 5432,
  user: process.env.DB_USER || 'postgres',
  password: process.env.DB_PASSWORD || 'skyflowpass',
  database: process.env.DB_NAME || 'skyflow_db',
});

async function initDB() {
  let retries = 10;
  while (retries > 0) {
    try {
      // 1. ตารางผู้ใช้งาน
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

      // 2. ตารางประวัติการเข้าสู่ระบบ (Login Logs)
      await pool.query(`
        CREATE TABLE IF NOT EXISTS login_logs (
          id SERIAL PRIMARY KEY,
          user_id INT REFERENCES users(id) ON DELETE CASCADE,
          username VARCHAR(50),
          ip_address VARCHAR(45),
          user_agent TEXT,
          status VARCHAR(20) NOT NULL,
          login_time TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        );
      `);

      // 3. ตารางข้อมูลการจองเที่ยวบิน (Bookings)
      await pool.query(`
        CREATE TABLE IF NOT EXISTS bookings (
          id SERIAL PRIMARY KEY,
          booking_ref VARCHAR(20) UNIQUE NOT NULL,
          user_id INT REFERENCES users(id) ON DELETE SET NULL,
          passenger_name VARCHAR(100) NOT NULL,
          passenger_email VARCHAR(100) NOT NULL,
          passenger_phone VARCHAR(20),
          airline VARCHAR(100) NOT NULL,
          flight_code VARCHAR(20) NOT NULL,
          route VARCHAR(100) NOT NULL,
          dep_time VARCHAR(10),
          arr_time VARCHAR(10),
          total_price DECIMAL(10,2) NOT NULL,
          payment_method VARCHAR(50) NOT NULL,
          status VARCHAR(20) DEFAULT 'CONFIRMED',
          created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        );
      `);

      console.log('✅ Database connected and all tables initialized');
      return true;
    } catch (err) {
      retries--;
      console.error(`⚠️ Database connection error: ${err.message}. Retrying... (${retries} left)`);
      await new Promise(res => setTimeout(res, 3000));
    }
  }
  console.error('❌ Could not initialize database');
  return false;
}

module.exports = { pool, initDB };
