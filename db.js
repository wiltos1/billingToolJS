const fs = require('fs');
const path = require('path');
const bcrypt = require('bcryptjs');
const initSqlJs = require('sql.js');

let SQL = null;
let db = null;

const DATA_DIR = process.env.DB_DIR || __dirname;
const dbPath = path.join(DATA_DIR, 'billing_js.db');

// Ensure the directory exists (important on fresh disks)
if (!fs.existsSync(DATA_DIR)) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
}

const assertDb = () => {
  if (!db) {
    throw new Error('Database not initialized. Call initDb() before using db helpers.');
  }
};

const persist = () => {
  const data = db.export();
  fs.writeFileSync(dbPath, Buffer.from(data));
};

const dbGet = (sql, params = []) => {
  assertDb();
  const stmt = db.prepare(sql);
  stmt.bind(params);
  let row = null;
  if (stmt.step()) {
    row = stmt.getAsObject();
  }
  stmt.free();
  return row;
};

const dbAll = (sql, params = []) => {
  assertDb();
  const stmt = db.prepare(sql);
  stmt.bind(params);
  const rows = [];
  while (stmt.step()) {
    rows.push(stmt.getAsObject());
  }
  stmt.free();
  return rows;
};

const dbRun = (sql, params = []) => {
  assertDb();
  const stmt = db.prepare(sql);
  stmt.bind(params);
  stmt.step();
  stmt.free();

  const changes = db.getRowsModified();
  let lastInsertRowid;
  if (/^\s*insert/i.test(sql)) {
    const row = dbGet('SELECT last_insert_rowid() as id');
    lastInsertRowid = row ? row.id : undefined;
  }
  persist();
  return { changes, lastInsertRowid };
};

const dbExec = (sql) => {
  assertDb();
  db.exec(sql);
  persist();
};

const ensureSchema = () => {
  db.exec(`
    CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      username TEXT UNIQUE NOT NULL,
      password_hash TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS doctors (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      is_on_shift INTEGER DEFAULT 0
    );

    CREATE TABLE IF NOT EXISTS patients (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      initials TEXT NOT NULL,
      identifier TEXT NOT NULL,
      start_datetime TEXT NOT NULL,
      discharge_datetime TEXT,
      care_status TEXT DEFAULT 'Triage',
      care_admitted_at TEXT,
      care_delivered_at TEXT,
      status TEXT DEFAULT 'active',
      optimized_total REAL DEFAULT 0,
      patient_type TEXT DEFAULT 'mother',
      parent_patient_id INTEGER
    );

    CREATE TABLE IF NOT EXISTS billings (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      patient_id INTEGER NOT NULL,
      doctor_id INTEGER NOT NULL,
      code TEXT NOT NULL,
      description TEXT,
      amount REAL NOT NULL,
      timestamp TEXT NOT NULL,
      optimized_included INTEGER DEFAULT 0,
      FOREIGN KEY (patient_id) REFERENCES patients(id) ON DELETE CASCADE,
      FOREIGN KEY (doctor_id) REFERENCES doctors(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS shift_slots (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      doctor_id INTEGER NOT NULL,
      patient_id INTEGER,
      start_time TEXT NOT NULL,
      action TEXT DEFAULT 'attended',
      delivery_by TEXT,
      delivery_bmipro INTEGER DEFAULT 0,
      rounds_care_type TEXT,
      rounds_supportive_care INTEGER DEFAULT 0,
      tongue_tie_supportive_care INTEGER DEFAULT 0,
      FOREIGN KEY (doctor_id) REFERENCES doctors(id) ON DELETE CASCADE,
      FOREIGN KEY (patient_id) REFERENCES patients(id) ON DELETE SET NULL
    );

    CREATE TABLE IF NOT EXISTS shift_windows (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      doctor_id INTEGER NOT NULL,
      start_datetime TEXT NOT NULL,
      end_datetime TEXT NOT NULL,
      is_active INTEGER DEFAULT 1,
      FOREIGN KEY (doctor_id) REFERENCES doctors(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS confirmed_billings (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      patient_id INTEGER NOT NULL,
      doctor_id INTEGER,
      code TEXT NOT NULL,
      modifier TEXT,
      timestamp TEXT NOT NULL,
      FOREIGN KEY (patient_id) REFERENCES patients(id) ON DELETE CASCADE,
      FOREIGN KEY (doctor_id) REFERENCES doctors(id) ON DELETE SET NULL
    );

    CREATE TABLE IF NOT EXISTS ghost_ja_locks (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      patient_id INTEGER NOT NULL,
      doctor_id INTEGER NOT NULL,
      start_time TEXT NOT NULL,
      FOREIGN KEY (patient_id) REFERENCES patients(id) ON DELETE CASCADE,
      FOREIGN KEY (doctor_id) REFERENCES doctors(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS patient_status_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      patient_id INTEGER NOT NULL,
      status TEXT NOT NULL,
      occurred_at TEXT NOT NULL,
      after_status TEXT,
      doctor_id INTEGER,
      induction_non_stress_test INTEGER DEFAULT 0,
      FOREIGN KEY (patient_id) REFERENCES patients(id) ON DELETE CASCADE
    );

    CREATE INDEX IF NOT EXISTS idx_shift_slots_start_time ON shift_slots(start_time);
    CREATE INDEX IF NOT EXISTS idx_billings_patient_id ON billings(patient_id);
    CREATE INDEX IF NOT EXISTS idx_confirmed_billings_patient_id ON confirmed_billings(patient_id);
    CREATE INDEX IF NOT EXISTS idx_ghost_ja_locks_doctor_time ON ghost_ja_locks(doctor_id, start_time);
    CREATE INDEX IF NOT EXISTS idx_patient_status_events_patient_id ON patient_status_events(patient_id);
  `);

  const patientColumns = dbAll('PRAGMA table_info(patients)');
  const hasBillingNote = patientColumns.some((col) => col.name === 'billing_note');
  if (!hasBillingNote) {
    db.exec('ALTER TABLE patients ADD COLUMN billing_note TEXT');
  }
  const hasSecondTriage = patientColumns.some((col) => col.name === 'second_triage_at');
  if (!hasSecondTriage) {
    db.exec('ALTER TABLE patients ADD COLUMN second_triage_at TEXT');
  }
  const hasSecondTriageAfter = patientColumns.some((col) => col.name === 'second_triage_after');
  if (!hasSecondTriageAfter) {
    db.exec('ALTER TABLE patients ADD COLUMN second_triage_after TEXT');
  }
  const hasPatientType = patientColumns.some((col) => col.name === 'patient_type');
  if (!hasPatientType) {
    db.exec('ALTER TABLE patients ADD COLUMN patient_type TEXT DEFAULT \'mother\'');
  }
  const hasParentPatientId = patientColumns.some((col) => col.name === 'parent_patient_id');
  if (!hasParentPatientId) {
    db.exec('ALTER TABLE patients ADD COLUMN parent_patient_id INTEGER');
  }
  db.exec("UPDATE patients SET patient_type = 'mother' WHERE patient_type IS NULL");

  const statusEventColumns = dbAll('PRAGMA table_info(patient_status_events)');
  if (statusEventColumns.length) {
    const hasInductionNst = statusEventColumns.some((col) => col.name === 'induction_non_stress_test');
    if (!hasInductionNst) {
      db.exec('ALTER TABLE patient_status_events ADD COLUMN induction_non_stress_test INTEGER DEFAULT 0');
    }
    const hasEventDoctor = statusEventColumns.some((col) => col.name === 'doctor_id');
    if (!hasEventDoctor) {
      db.exec('ALTER TABLE patient_status_events ADD COLUMN doctor_id INTEGER');
    }
  }

  const shiftColumns = dbAll('PRAGMA table_info(shift_slots)');
  const hasLocked = shiftColumns.some((col) => col.name === 'locked');
  if (!hasLocked) {
    db.exec('ALTER TABLE shift_slots ADD COLUMN locked INTEGER DEFAULT 0');
  }
  const hasTriageNst = shiftColumns.some((col) => col.name === 'triage_non_stress_test');
  if (!hasTriageNst) {
    db.exec('ALTER TABLE shift_slots ADD COLUMN triage_non_stress_test INTEGER DEFAULT 0');
  }
  const hasTriageSpeculum = shiftColumns.some((col) => col.name === 'triage_speculum_exam');
  if (!hasTriageSpeculum) {
    db.exec('ALTER TABLE shift_slots ADD COLUMN triage_speculum_exam INTEGER DEFAULT 0');
  }
  const hasDeliveryCode = shiftColumns.some((col) => col.name === 'delivery_code');
  if (!hasDeliveryCode) {
    db.exec('ALTER TABLE shift_slots ADD COLUMN delivery_code TEXT');
  }
  const hasDeliveryBmipro = shiftColumns.some((col) => col.name === 'delivery_bmipro');
  if (!hasDeliveryBmipro) {
    db.exec('ALTER TABLE shift_slots ADD COLUMN delivery_bmipro INTEGER DEFAULT 0');
  }
  const hasDeliveryTime = shiftColumns.some((col) => col.name === 'delivery_time');
  if (!hasDeliveryTime) {
    db.exec('ALTER TABLE shift_slots ADD COLUMN delivery_time TEXT');
  }
  const hasDeliveryHemorrhage = shiftColumns.some((col) => col.name === 'delivery_postpartum_hemorrhage');
  if (!hasDeliveryHemorrhage) {
    db.exec('ALTER TABLE shift_slots ADD COLUMN delivery_postpartum_hemorrhage INTEGER DEFAULT 0');
  }
  const hasDeliveryVacuum = shiftColumns.some((col) => col.name === 'delivery_vacuum');
  if (!hasDeliveryVacuum) {
    db.exec('ALTER TABLE shift_slots ADD COLUMN delivery_vacuum INTEGER DEFAULT 0');
  }
  const hasDeliveryLaceration = shiftColumns.some((col) => col.name === 'delivery_vaginal_laceration');
  if (!hasDeliveryLaceration) {
    db.exec('ALTER TABLE shift_slots ADD COLUMN delivery_vaginal_laceration INTEGER DEFAULT 0');
  }
  const hasDeliveryDystocia = shiftColumns.some((col) => col.name === 'delivery_shoulder_dystocia');
  if (!hasDeliveryDystocia) {
    db.exec('ALTER TABLE shift_slots ADD COLUMN delivery_shoulder_dystocia INTEGER DEFAULT 0');
  }
  const hasDeliveryPlacenta = shiftColumns.some((col) => col.name === 'delivery_manual_placenta');
  if (!hasDeliveryPlacenta) {
    db.exec('ALTER TABLE shift_slots ADD COLUMN delivery_manual_placenta INTEGER DEFAULT 0');
  }
  const hasRoundsCareType = shiftColumns.some((col) => col.name === 'rounds_care_type');
  if (!hasRoundsCareType) {
    db.exec('ALTER TABLE shift_slots ADD COLUMN rounds_care_type TEXT');
  }
  const hasRoundsSupportiveCare = shiftColumns.some((col) => col.name === 'rounds_supportive_care');
  if (!hasRoundsSupportiveCare) {
    db.exec('ALTER TABLE shift_slots ADD COLUMN rounds_supportive_care INTEGER DEFAULT 0');
  }
  const hasTongueTieSupportive = shiftColumns.some((col) => col.name === 'tongue_tie_supportive_care');
  if (!hasTongueTieSupportive) {
    db.exec('ALTER TABLE shift_slots ADD COLUMN tongue_tie_supportive_care INTEGER DEFAULT 0');
  }
};

const ensureDefaults = () => {
  const user = dbGet('SELECT id FROM users WHERE username = ?', ['doctor']);
  if (!user) {
    const hash = bcrypt.hashSync('test123', 10);
    dbRun('INSERT INTO users (username, password_hash) VALUES (?, ?)', ['doctor', hash]);
  }

  const countRow = dbGet('SELECT COUNT(*) as count FROM doctors');
  if (countRow && countRow.count === 0) {
    ['A. Smith', 'B. Johnson', 'C. Patel'].forEach((name) => {
      dbRun('INSERT INTO doctors (name, is_on_shift) VALUES (?, 0)', [name]);
    });
  }
};

const initDb = async () => {
  if (db) return db;
  const wasmPath = require.resolve('sql.js/dist/sql-wasm.wasm');
  const wasmDir = path.dirname(wasmPath);
  SQL = await initSqlJs({
    locateFile: (file) => path.join(wasmDir, file),
  });

  if (fs.existsSync(dbPath)) {
    const fileBuffer = fs.readFileSync(dbPath);
    db = new SQL.Database(fileBuffer);
  } else {
    db = new SQL.Database();
  }

  ensureSchema();
  ensureDefaults();
  persist();
  return db;
};

module.exports = {
  initDb,
  dbGet,
  dbAll,
  dbRun,
  dbExec,
};
