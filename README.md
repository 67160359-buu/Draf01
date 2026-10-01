// flights-route.js — เรียก FlightAPI.io ฝั่ง server (คีย์อยู่ใน .env เท่านั้น)
// ใช้ใน server.js:
//   require('dotenv').config();
//   app.use('/api', require('./flights-route'));
const express = require('express');
const router = express.Router();

const cache = new Map();            // เก็บผล 10 นาที ประหยัดเครดิต (1 request = 2 credits)
const TTL = 10 * 60 * 1000;

router.get('/flights', async (req, res) => {
  const { from, to, date } = req.query;
  if (!/^[A-Z]{3}$/.test(from || '') || !/^[A-Z]{3}$/.test(to || '') || !/^\d{4}-\d{2}-\d{2}$/.test(date || '')) {
    return res.status(400).json({ error: 'พารามิเตอร์ไม่ถูกต้อง (from, to, date=YYYY-MM-DD)' });
  }
  const key = process.env.FLIGHTAPI_KEY;
  if (!key) return res.status(500).json({ error: 'server ยังไม่ได้ตั้งค่า FLIGHTAPI_KEY' });

  const ck = `${from}-${to}-${date}`;
  const hit = cache.get(ck);
  if (hit && Date.now() - hit.t < TTL) return res.json({ flights: hit.flights, cached: true });

  try {
    // /onewaytrip/<key>/<from>/<to>/<date>/<adults>/<children>/<infants>/<cabin>/<currency>
    const url = `https://api.flightapi.io/onewaytrip/${key}/${from}/${to}/${date}/1/0/0/Economy/THB?region=TH`;
    const r = await fetch(url);
    if (!r.ok) return res.status(502).json({ error: `FlightAPI ตอบกลับ ${r.status}` });
    const d = await r.json();

    const by = (arr) => Object.fromEntries((arr || []).map((x) => [x.id, x]));
    const legs = by(d.legs), segs = by(d.segments), carriers = by(d.carriers);

    const flights = (d.itineraries || []).map((it) => {
      const leg = legs[(it.leg_ids || [])[0]];
      const price = it.pricing_options && it.pricing_options[0] && it.pricing_options[0].price
        ? it.pricing_options[0].price.amount : null;
      if (!leg || price == null) return null;
      const seg = segs[(leg.segment_ids || [])[0]] || {};
      const car = carriers[(leg.marketing_carrier_ids || [])[0]] || {};
      return {
        airline: car.name || car.display_code || 'ไม่ระบุสายการบิน',
        code: `${car.display_code || ''} ${seg.marketing_flight_number || ''}`.trim(),
        dep: String(leg.departure).slice(11, 16),
        arr: String(leg.arrival).slice(11, 16),
        duration: leg.duration,
        stops: leg.stop_count,
        price: Math.round(price),
      };
    }).filter(Boolean).sort((a, b) => a.price - b.price).slice(0, 10);

    cache.set(ck, { t: Date.now(), flights });
    res.json({ flights });
  } catch (e) {
    res.status(500).json({ error: 'ดึงข้อมูลจาก FlightAPI ไม่สำเร็จ' });
  }
});

module.exports = router;
