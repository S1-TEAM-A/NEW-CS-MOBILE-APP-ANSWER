/* =========================================================
   에스원 Answer — 백엔드 API 서버
   - Express + PostgreSQL(DATABASE_URL 있으면) / 메모리(없으면) 이중 저장소
   - 부팅 시 자동 스키마 생성 + 시드(96건 VOC, 7코드 가이드)
   - Railway 배포: 이 폴더(server)를 Root Directory로 지정
   ========================================================= */
const express = require('express');
const cors = require('cors');
const fs = require('fs');
const path = require('path');

const PORT = process.env.PORT || 3000;
const DATABASE_URL = process.env.DATABASE_URL || '';

const VOCS_SEED = JSON.parse(fs.readFileSync(path.join(__dirname, 'data', 'vocs.json'), 'utf8'));
const GUIDE_SEED = JSON.parse(fs.readFileSync(path.join(__dirname, 'data', 'guide.json'), 'utf8'));
const CODES = ['010100', '010303', '030130', '030134', '030138', '030144'];

/* ---------- 저장소 인터페이스 (pg / memory 동일 시그니처) ---------- */
let store = null;

/* ----- 메모리 저장소 (DATABASE_URL 없을 때: 로컬 개발·데모 폴백) ----- */
function memoryStore() {
  const results = new Map();   // vocId -> {result, compStatus, partFlag, confirmFlag, completed, updatedAt}
  const schedules = new Map(); // vocId -> {time, state, date, updatedAt}
  return {
    kind: 'memory',
    async init() {},
    async getAllVocs() { return VOCS_SEED.map(v => ({ ...v })); },
    async getVoc(id) { const v = VOCS_SEED.find(x => x.id === id); return v ? { ...v } : null; },
    async getResults() { return new Map(results); },
    async getSchedules() { return new Map(schedules); },
    async saveResult(id, r) { results.set(id, { ...r, updatedAt: new Date().toISOString() }); },
    async saveSchedule(id, s) { schedules.set(id, { ...s, updatedAt: new Date().toISOString() }); },
  };
}

/* ----- PostgreSQL 저장소 (Railway) ----- */
function pgStore() {
  const { Pool } = require('pg');
  const pool = new Pool({
    connectionString: DATABASE_URL,
    ssl: /sslmode=require/i.test(DATABASE_URL) ? { rejectUnauthorized: false } : false,
  });
  return {
    kind: 'postgres',
    async init() {
      await pool.query(`CREATE TABLE IF NOT EXISTS vocs (
        id TEXT PRIMARY KEY, code TEXT NOT NULL, data JSONB NOT NULL)`);
      await pool.query(`CREATE TABLE IF NOT EXISTS guides (
        code TEXT PRIMARY KEY, data JSONB NOT NULL)`);
      await pool.query(`CREATE TABLE IF NOT EXISTS results (
        voc_id TEXT PRIMARY KEY, result TEXT, comp_status TEXT,
        part_flag BOOLEAN DEFAULT FALSE, confirm_flag BOOLEAN DEFAULT TRUE,
        completed BOOLEAN DEFAULT TRUE, updated_at TIMESTAMPTZ DEFAULT now())`);
      await pool.query(`CREATE TABLE IF NOT EXISTS schedules (
        voc_id TEXT PRIMARY KEY, time_label TEXT, state TEXT, visit_date TEXT,
        updated_at TIMESTAMPTZ DEFAULT now())`);
      // 시드: 비어있을 때만
      const { rows } = await pool.query('SELECT COUNT(*)::int AS n FROM vocs');
      if (rows[0].n === 0) {
        for (const v of VOCS_SEED) {
          await pool.query('INSERT INTO vocs(id, code, data) VALUES($1,$2,$3) ON CONFLICT (id) DO NOTHING',
            [v.id, v.code, JSON.stringify(v)]);
        }
        for (const code of Object.keys(GUIDE_SEED)) {
          await pool.query('INSERT INTO guides(code, data) VALUES($1,$2) ON CONFLICT (code) DO NOTHING',
            [code, JSON.stringify(GUIDE_SEED[code])]);
        }
        console.log(`[seed] vocs=${VOCS_SEED.length}, guides=${Object.keys(GUIDE_SEED).length}`);
      }
    },
    async getAllVocs() {
      const { rows } = await pool.query('SELECT data FROM vocs');
      return rows.map(r => r.data);
    },
    async getVoc(id) {
      const { rows } = await pool.query('SELECT data FROM vocs WHERE id=$1', [id]);
      return rows[0] ? rows[0].data : null;
    },
    async getResults() {
      const { rows } = await pool.query('SELECT * FROM results');
      const m = new Map();
      rows.forEach(r => m.set(r.voc_id, {
        result: r.result, compStatus: r.comp_status,
        partFlag: r.part_flag, confirmFlag: r.confirm_flag,
        completed: r.completed, updatedAt: r.updated_at,
      }));
      return m;
    },
    async getSchedules() {
      const { rows } = await pool.query('SELECT * FROM schedules');
      const m = new Map();
      rows.forEach(r => m.set(r.voc_id, {
        time: r.time_label, state: r.state, date: r.visit_date, updatedAt: r.updated_at,
      }));
      return m;
    },
    async saveResult(id, r) {
      await pool.query(`INSERT INTO results(voc_id, result, comp_status, part_flag, confirm_flag, completed, updated_at)
        VALUES($1,$2,$3,$4,$5,TRUE,now())
        ON CONFLICT (voc_id) DO UPDATE SET result=$2, comp_status=$3, part_flag=$4, confirm_flag=$5, completed=TRUE, updated_at=now()`,
        [id, r.result, r.compStatus, !!r.partFlag, !!r.confirmFlag]);
    },
    async saveSchedule(id, s) {
      await pool.query(`INSERT INTO schedules(voc_id, time_label, state, visit_date, updated_at)
        VALUES($1,$2,$3,$4,now())
        ON CONFLICT (voc_id) DO UPDATE SET time_label=$2, state=$3, visit_date=$4, updated_at=now()`,
        [id, s.time, s.state, s.date || null]);
    },
  };
}

/* ---------- 병합: 저장된 조치결과·일정을 VOC 객체에 반영 ---------- */
function mergeVoc(voc, results, schedules) {
  const out = { ...voc };
  const r = results.get(voc.id);
  if (r && r.completed) {
    out.done = true;
    out.result = r.result || out.result || '';
    out.compStatus = r.compStatus || out.compStatus || '조치 완료';
    out.partFlag = !!r.partFlag;
    out.confirmFlag = !!r.confirmFlag;
    out.resultSavedAt = r.updatedAt;
  }
  const s = schedules.get(voc.id);
  if (s) out.savedSchedule = s;
  return out;
}

/* ---------- 오늘의 12건: 6코드 × 2건 랜덤 (프론트 pickVocs와 동일 규칙) ---------- */
function pickDaily(all) {
  const shuffle = a => { a = a.slice(); for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; } return a; };
  const byCode = {};
  all.forEach(v => { (byCode[v.code] = byCode[v.code] || []).push(v); });
  let out = [];
  CODES.forEach(c => { out = out.concat(shuffle(byCode[c] || []).slice(0, 2)); });
  return shuffle(out);
}

/* ---------- Express 앱 ---------- */
const app = express();
app.use(cors()); // 프로토타입: 전체 오리진 허용 (github.io + localhost)
app.use(express.json({ limit: '100kb' }));
app.use((req, _res, next) => { console.log(`${req.method} ${req.url}`); next(); });

app.get('/', (_req, res) => res.json({ service: '에스원 Answer API', ok: true, docs: ['/api/health', '/api/vocs', '/api/vocs/all', '/api/vocs/:id', '/api/guide/:code', 'POST /api/vocs/:id/result', 'POST /api/vocs/:id/schedule', '/api/stats'] }));
app.get('/api/health', (_req, res) => res.json({ ok: true, db: store.kind, time: new Date().toISOString() }));

// 오늘의 VOC 12건 (코드별 2건 랜덤, 저장된 결과 병합)
app.get('/api/vocs', async (_req, res, next) => {
  try {
    const [all, results, schedules] = await Promise.all([store.getAllVocs(), store.getResults(), store.getSchedules()]);
    const picked = pickDaily(all).map(v => mergeVoc(v, results, schedules));
    res.json({ ok: true, db: store.kind, count: picked.length, vocs: picked });
  } catch (e) { next(e); }
});

// 전체 96건 (관리·지도 확장용)
app.get('/api/vocs/all', async (_req, res, next) => {
  try {
    const [all, results, schedules] = await Promise.all([store.getAllVocs(), store.getResults(), store.getSchedules()]);
    res.json({ ok: true, count: all.length, vocs: all.map(v => mergeVoc(v, results, schedules)) });
  } catch (e) { next(e); }
});

app.get('/api/vocs/:id', async (req, res, next) => {
  try {
    const voc = await store.getVoc(req.params.id);
    if (!voc) return res.status(404).json({ ok: false, error: 'VOC not found' });
    const [results, schedules] = await Promise.all([store.getResults(), store.getSchedules()]);
    res.json({ ok: true, voc: mergeVoc(voc, results, schedules) });
  } catch (e) { next(e); }
});

app.get('/api/guide/:code', (req, res) => {
  const g = GUIDE_SEED[req.params.code];
  if (!g) return res.status(404).json({ ok: false, error: 'guide not found' });
  res.json({ ok: true, guide: g });
});

// 조치결과 저장 (VOC 완료 처리)
app.post('/api/vocs/:id/result', async (req, res, next) => {
  try {
    const voc = await store.getVoc(req.params.id);
    if (!voc) return res.status(404).json({ ok: false, error: 'VOC not found' });
    const { result, compStatus } = req.body || {};
    if (!result || typeof result !== 'string' || !result.trim()) {
      return res.status(400).json({ ok: false, error: 'result(조치결과 텍스트)는 필수입니다' });
    }
    await store.saveResult(req.params.id, {
      result: result.trim().slice(0, 4000),
      compStatus: (compStatus || '조치 완료').slice(0, 40),
      partFlag: !!(req.body && req.body.partFlag),
      confirmFlag: !!(req.body && req.body.confirmFlag),
      completed: true,
    });
    res.json({ ok: true, saved: req.params.id });
  } catch (e) { next(e); }
});

// 방문 일정 저장
app.post('/api/vocs/:id/schedule', async (req, res, next) => {
  try {
    const voc = await store.getVoc(req.params.id);
    if (!voc) return res.status(404).json({ ok: false, error: 'VOC not found' });
    const { time, state, date } = req.body || {};
    if (!time && !state) return res.status(400).json({ ok: false, error: 'time 또는 state가 필요합니다' });
    await store.saveSchedule(req.params.id, {
      time: String(time || '').slice(0, 40),
      state: String(state || '').slice(0, 20),
      date: date ? String(date).slice(0, 20) : null,
    });
    res.json({ ok: true, saved: req.params.id });
  } catch (e) { next(e); }
});

// 통계 (완료율·코드별 건수)
app.get('/api/stats', async (_req, res, next) => {
  try {
    const [all, results] = await Promise.all([store.getAllVocs(), store.getResults()]);
    const isDone = v => { const r = results.get(v.id); return (r && r.completed) || !!v.done; };
    const byCode = {};
    all.forEach(v => {
      byCode[v.code] = byCode[v.code] || { total: 0, completed: 0, name: v.codeName };
      byCode[v.code].total++;
      if (isDone(v)) byCode[v.code].completed++;
    });
    const completed = all.filter(isDone).length;
    res.json({
      ok: true, total: all.length, completed, inProgress: all.length - completed,
      completionRate: Math.round(completed / all.length * 100),
      savedResults: results.size, byCode,
    });
  } catch (e) { next(e); }
});

app.use((_req, res) => res.status(404).json({ ok: false, error: 'not found' }));
app.use((err, _req, res, _next) => {
  console.error('[error]', err.message);
  res.status(500).json({ ok: false, error: 'server error' });
});

/* ---------- 부팅 ---------- */
(async function boot() {
  store = DATABASE_URL ? pgStore() : memoryStore();
  try {
    await store.init();
  } catch (e) {
    console.error('[db] init 실패 → 메모리 저장소로 폴백:', e.message);
    store = memoryStore();
    await store.init();
  }
  app.listen(PORT, () => console.log(`[answer-api] listening on :${PORT} (db=${store.kind})`));
})();
