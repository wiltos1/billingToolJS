const MONTHS_SHORT = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

const formatDisplay = (date) => {
  if (!date) return '';
  const month = MONTHS_SHORT[date.getMonth()];
  const day = String(date.getDate()).padStart(2, '0');
  const year = date.getFullYear();
  let hours = date.getHours();
  const minutes = String(date.getMinutes()).padStart(2, '0');
  const ampm = hours >= 12 ? 'PM' : 'AM';
  hours = hours % 12;
  if (hours === 0) hours = 12;
  const hourStr = String(hours).padStart(2, '0');
  return `${month} ${day}, ${year} ${hourStr}:${minutes} ${ampm}`;
};

const formatDisplay24 = (date) => {
  if (!date) return '';
  const month = MONTHS_SHORT[date.getMonth()];
  const day = String(date.getDate()).padStart(2, '0');
  const year = date.getFullYear();
  const hours = String(date.getHours()).padStart(2, '0');
  const minutes = String(date.getMinutes()).padStart(2, '0');
  return `${month} ${day}, ${year} ${hours}:${minutes}`;
};

const formatDate = (date) => {
  if (!date) return '';
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
};

const formatTime = (date) => {
  if (!date) return '';
  const hours = String(date.getHours()).padStart(2, '0');
  const minutes = String(date.getMinutes()).padStart(2, '0');
  return `${hours}:${minutes}`;
};

const formatLocalDateTime = (date) => {
  if (!date) return null;
  return `${formatDate(date)}T${formatTime(date)}`;
};

const parseDateTime = (dateStr, timeStr, fallbackDate) => {
  const now = new Date();
  const datePart = dateStr || fallbackDate;
  if (datePart) {
    const timePart = timeStr || formatTime(now);
    const dt = new Date(`${datePart}T${timePart}`);
    if (!Number.isNaN(dt.valueOf())) {
      return dt;
    }
    return now;
  }
  return now;
};

const toDate = (value) => {
  if (!value) return null;
  const parsed = new Date(value);
  return Number.isNaN(parsed.valueOf()) ? null : parsed;
};

const { dbGet, dbAll, dbRun } = require('../db');

const getShiftDoctor = () => {
  return dbGet('SELECT * FROM doctors WHERE is_on_shift = 1 LIMIT 1');
};

const getActiveShiftWindow = () => {
  return dbGet(
    'SELECT * FROM shift_windows WHERE is_active = 1 ORDER BY start_datetime DESC LIMIT 1'
  );
};

const splitWindowIntoDays = (startDate, endDate) => {
  const segments = [];
  let current = new Date(startDate);
  while (current < endDate) {
    const nextBoundary = new Date(current);
    nextBoundary.setHours(24, 0, 0, 0);
    const segmentEnd = nextBoundary < endDate ? nextBoundary : new Date(endDate);
    const slots = [];
    let cursor = new Date(current);
    while (cursor < segmentEnd) {
      slots.push(new Date(cursor));
      cursor = new Date(cursor.getTime() + 15 * 60 * 1000);
    }
    segments.push({ date: new Date(current), slots });
    current = segmentEnd;
  }
  return segments;
};

const requireLogin = (req, res, next) => {
  if (!req.session.user) {
    return res.redirect('/login');
  }
  return next();
};

const optimizeBillings = (patientId) => {
  const billings = dbAll(
    'SELECT * FROM billings WHERE patient_id = ? ORDER BY timestamp',
    [patientId]
  );
  const grouped = new Map();
  billings.forEach((billing) => {
    const existing = grouped.get(billing.code);
    if (!existing || billing.amount > existing.amount) {
      grouped.set(billing.code, billing);
    }
  });

  billings.forEach((billing) => {
    const keep = grouped.get(billing.code);
    dbRun('UPDATE billings SET optimized_included = ? WHERE id = ?', [
      keep && keep.id === billing.id ? 1 : 0,
      billing.id,
    ]);
  });

  const total = Array.from(grouped.values()).reduce((sum, b) => sum + b.amount, 0);
  dbRun('UPDATE patients SET optimized_total = ?, status = ? WHERE id = ?', [
    total,
    'discharged',
    patientId,
  ]);
};

const cleanupOldShiftData = (days = 4) => {
  const cutoff = new Date(Date.now() - days * 24 * 60 * 60 * 1000);
  const cutoffStr = formatLocalDateTime(cutoff);
  dbRun('DELETE FROM shift_slots WHERE start_time < ?', [cutoffStr]);
  dbRun('DELETE FROM shift_windows WHERE end_datetime < ?', [cutoffStr]);
};

const formatCurrency = (value) => {
  if (value === null || value === undefined) return '';
  return Number(value).toFixed(2);
};

module.exports = {
  formatDisplay,
  formatDisplay24,
  formatDate,
  formatTime,
  formatLocalDateTime,
  formatCurrency,
  parseDateTime,
  toDate,
  getShiftDoctor,
  getActiveShiftWindow,
  splitWindowIntoDays,
  requireLogin,
  optimizeBillings,
  cleanupOldShiftData,
};
