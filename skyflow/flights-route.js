const express = require('express');
const router = express.Router();

const FLIGHTAPI_KEY = () => process.env.FLIGHTAPI_KEY;

// สนามบินยอดนิยม (ใช้ให้หน้าเว็บทำ dropdown)
const AIRPORTS = [
  { code: 'BKK', name: 'กรุงเทพฯ (สุวรรณภูมิ)', city: 'Bangkok' },
  { code: 'DMK', name: 'กรุงเทพฯ (ดอนเมือง)', city: 'Bangkok' },
  { code: 'CNX', name: 'เชียงใหม่', city: 'Chiang Mai' },
  { code: 'HKT', name: 'ภูเก็ต', city: 'Phuket' },
  { code: 'KBV', name: 'กระบี่', city: 'Krabi' },
  { code: 'USM', name: 'เกาะสมุย', city: 'Koh Samui' },
  { code: 'HDY', name: 'หาดใหญ่', city: 'Hat Yai' },
  { code: 'CEI', name: 'เชียงราย', city: 'Chiang Rai' },
  { code: 'UTH', name: 'อุดรธานี', city: 'Udon Thani' },
  { code: 'KKC', name: 'ขอนแก่น', city: 'Khon Kaen' },
  { code: 'SIN', name: 'สิงคโปร์', city: 'Singapore' },
  { code: 'NRT', name: 'โตเกียว (นาริตะ)', city: 'Tokyo' },
  { code: 'ICN', name: 'โซล (อินชอน)', city: 'Seoul' },
  { code: 'HKG', name: 'ฮ่องกง', city: 'Hong Kong' },
];

const DEMO_AIRLINES = [
  { name: 'Thai AirAsia', code: 'FD', base: 1 },
  { name: 'Thai Lion Air', code: 'SL', base: 1.05 },
  { name: 'Nok Air', code: 'DD', base: 1.1 },
  { name: 'Thai Airways', code: 'TG', base: 1.6 },
  { name: 'Bangkok Airways', code: 'PG', base: 1.45 },
];

function hashStr(s) {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) >>> 0;
  return h;
}

function pad(n) { return String(n).padStart(2, '0'); }
function hhmm(mins) { mins = ((mins % 1440) + 1440) % 1440; return `${pad(Math.floor(mins / 60))}:${pad(mins % 60)}`; }

// ข้อมูลตัวอย่าง (ใช้เมื่อไม่มี API key หรือ API ใช้ไม่ได้) — ผลลัพธ์คงที่ตามเส้นทาง/วันที่
function demoFlights(from, to, date) {
  const seed = hashStr(`${from}-${to}`);
  const duration = 60 + (seed % 120); // นาที
  const basePrice = 1200 + (seed % 2800);
  return DEMO_AIRLINES.map((a, i) => {
    const dep = 6 * 60 + ((seed + i * 197) % (14 * 60));
    const flightNo = 100 + ((seed + i * 53) % 900);
    return {
      id: `${a.code}${flightNo}-${date}`,
      airline: a.name,
      flightCode: `${a.code}${flightNo}`,
      from, to,
      route: `${from} → ${to}`,
      depTime: hhmm(dep),
      arrTime: hhmm(dep + duration),
      durationMinutes: duration,
      price: Math.round((basePrice * a.base) / 10) * 10,
      currency: 'THB',
    };
  }).sort((x, y) => x.price - y.price);
}

function minutesBetween(a, b) {
  const d = new Date(b) - new Date(a);
  return Number.isFinite(d) && d > 0 ? Math.round(d / 60000) : null;
}

function timeOf(iso) {
  const m = /T(\d{2}:\d{2})/.exec(iso || '');
  return m ? m[1] : null;
}

// แปลงผลลัพธ์จาก FlightAPI.io (onewaytrip) ให้เป็นรูปแบบเดียวกับของระบบ
function parseFlightApi(data, from, to) {
  const itineraries = data.itineraries || [];
  const legs = new Map((data.legs || []).map(l => [l.id, l]));
  const segments = new Map((data.segments || []).map(s => [s.id, s]));
  const carriers = new Map((data.carriers || []).map(c => [c.id, c]));

  const out = [];
  for (const it of itineraries) {
    const legId = (it.leg_ids || [])[0];
    const leg = legs.get(legId);
    if (!leg) continue;

    const seg = segments.get((leg.segment_ids || [])[0]);
    const carrierId = (leg.marketing_carrier_ids || [])[0] ?? (seg && seg.marketing_carrier_id);
    const carrier = carriers.get(carrierId) || {};
    const number = seg && (seg.marketing_flight_number || seg.flight_number);
    const code = carrier.display_code || carrier.code || '';

    const opt = (it.pricing_options || [])[0];
    const price = opt && opt.price ? Number(opt.price.amount) : NaN;
    if (!Number.isFinite(price)) continue;

    out.push({
      id: it.id || `${code}${number}-${out.length}`,
      airline: carrier.name || code || 'Unknown',
      flightCode: `${code}${number || ''}`.trim() || 'N/A',
      from, to,
      route: `${from} → ${to}`,
      depTime: timeOf(leg.departure) || '--:--',
      arrTime: timeOf(leg.arrival) || '--:--',
      durationMinutes: leg.duration || minutesBetween(leg.departure, leg.arrival),
      stops: leg.stop_count,
      price: Math.round(price),
      currency: (opt.price && opt.price.currency) || data.currency || 'THB',
    });
  }
  return out.sort((a, b) => a.price - b.price);
}

router.get('/airports', (req, res) => res.json({ airports: AIRPORTS }));

// GET /api/flights?from=BKK&to=CNX&date=2026-11-01&adults=1
router.get('/flights', async (req, res) => {
  const from = String(req.query.from || '').toUpperCase().trim();
  const to = String(req.query.to || '').toUpperCase().trim();
  const date = String(req.query.date || '').trim();
  const adults = Math.max(1, Math.min(9, parseInt(req.query.adults) || 1));

  if (!/^[A-Z]{3}$/.test(from) || !/^[A-Z]{3}$/.test(to)) {
    return res.status(400).json({ message: 'กรุณาระบุรหัสสนามบินต้นทางและปลายทาง (3 ตัวอักษร)' });
  }
  if (from === to) {
    return res.status(400).json({ message: 'ต้นทางและปลายทางต้องไม่เหมือนกัน' });
  }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    return res.status(400).json({ message: 'กรุณาระบุวันที่เดินทาง (YYYY-MM-DD)' });
  }

  const key = FLIGHTAPI_KEY();
  if (key) {
    try {
      const url = `https://api.flightapi.io/onewaytrip/${encodeURIComponent(key)}/${from}/${to}/${date}/${adults}/0/0/Economy/THB`;
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), 20000);
      const r = await fetch(url, { signal: ctrl.signal });
      clearTimeout(timer);
      if (!r.ok) throw new Error(`FlightAPI responded ${r.status}`);
      const data = await r.json();
      const flights = parseFlightApi(data, from, to);
      if (flights.length) {
        return res.json({ source: 'live', count: flights.length, flights });
      }
      console.warn('FlightAPI returned no usable itineraries, using demo data');
    } catch (err) {
      console.warn('FlightAPI error, using demo data:', err.message);
    }
  }

  const flights = demoFlights(from, to, date);
  res.json({ source: 'demo', count: flights.length, flights });
});

module.exports = router;
