const express = require('express');
const { dbAll, dbGet, dbRun } = require('../db');
const {
  splitWindowIntoDays,
  getActiveShiftWindow,
  getShiftDoctor,
  requireLogin,
  toDate,
  formatLocalDateTime,
  formatDisplay24,
  cleanupOldShiftData,
} = require('../services/helpers');

const router = express.Router();

router.get('/shift_grid', requireLogin, (req, res) => {
  cleanupOldShiftData();
  const windowId = parseInt(req.query.window_id, 10);
  let shiftWindow = null;
  if (!Number.isNaN(windowId)) {
    shiftWindow = dbGet('SELECT * FROM shift_windows WHERE id = ?', [windowId]);
  } else {
    shiftWindow = getActiveShiftWindow();
  }
  if (!shiftWindow) {
    return res.redirect('/doctors/manage');
  }
  const shiftDoctor = dbGet('SELECT * FROM doctors WHERE id = ?', [shiftWindow.doctor_id]);
  if (!shiftDoctor) {
    return res.redirect('/doctors/manage');
  }
  const activeWindow = getActiveShiftWindow();
  const isReadOnly = false;

  const start = toDate(shiftWindow.start_datetime);
  const end = toDate(shiftWindow.end_datetime);
  const segments = splitWindowIntoDays(start, end);

  const existing = {};
  const slots = dbAll(
    `SELECT * FROM shift_slots
     WHERE doctor_id = ? AND start_time >= ? AND start_time < ?`,
    [shiftDoctor.id, shiftWindow.start_datetime, shiftWindow.end_datetime]
  );
  slots.forEach((slot) => {
    const slotTime = formatLocalDateTime(toDate(slot.start_time));
    if (slotTime) {
      existing[slotTime] = slot;
    }
  });

  const activePatients = dbAll(
    'SELECT * FROM patients WHERE status = ? ORDER BY id',
    ['active']
  );

  const existingPatientIds = new Set(
    slots.filter((slot) => slot.patient_id).map((slot) => slot.patient_id)
  );

  let preservedPatients = [];
  if (existingPatientIds.size > 0) {
    const ids = Array.from(existingPatientIds);
    preservedPatients = dbAll(
      `SELECT * FROM patients WHERE id IN (${ids.map(() => '?').join(',')}) ORDER BY id`,
      ids
    );
  }

  const displayPatients = [];
  const seen = new Set();
  activePatients.concat(preservedPatients).forEach((p) => {
    if (!seen.has(p.id)) {
      displayPatients.push(p);
      seen.add(p.id);
    }
  });

  return res.render('shift', {
    session: req.session,
    shiftDoctor,
    shiftWindow,
    is_read_only: isReadOnly,
    segments,
    existing,
    active_patients: displayPatients,
    format_local: formatLocalDateTime,
    format_display_24: formatDisplay24,
  });
});

router.post('/shift_grid', requireLogin, (req, res) => {
  cleanupOldShiftData();
  const shiftDoctor = getShiftDoctor();
  const shiftWindow = getActiveShiftWindow();
  if (!shiftDoctor || !shiftWindow) {
    return res.redirect('/doctors/manage');
  }

  const existingSlots = dbAll(
    `SELECT * FROM shift_slots
     WHERE doctor_id = ? AND start_time >= ? AND start_time < ?`,
    [shiftDoctor.id, shiftWindow.start_datetime, shiftWindow.end_datetime]
  );

  const existingMap = new Map();
  existingSlots.forEach((slot) => {
    const slotKey = formatLocalDateTime(toDate(slot.start_time));
    if (slotKey) {
      existingMap.set(slotKey, slot);
    }
  });

  Object.entries(req.body).forEach(([key, val]) => {
    if (!key.startsWith('slot_patient_')) return;
    const ts = parseInt(key.split('slot_patient_')[1], 10);
    if (Number.isNaN(ts)) return;

    const slotTime = new Date(ts * 1000);
    const slotTimeStr = formatLocalDateTime(slotTime);
    if (!slotTimeStr) return;

    const windowStart = toDate(shiftWindow.start_datetime);
    const windowEnd = toDate(shiftWindow.end_datetime);
    if (!windowStart || !windowEnd || slotTime < windowStart || slotTime >= windowEnd) return;

    const existingSlot = existingMap.get(slotTimeStr);
    const existingAction = existingSlot ? (existingSlot.action || '').trim() : '';
    if (existingSlot && existingSlot.locked === 1) {
      return;
    }

    if (!val) {
      if (existingSlot) {
        dbRun('DELETE FROM shift_slots WHERE id = ?', [existingSlot.id]);
      }
      return;
    }

    const patientId = parseInt(val, 10);
    if (Number.isNaN(patientId)) return;
    if (existingSlot && existingSlot.patient_id && existingSlot.patient_id !== patientId && existingAction) {
      return;
    }

    const patient = dbGet('SELECT * FROM patients WHERE id = ?', [patientId]);
    if (!patient) return;

    const actionVal = (req.body[`slot_action_${ts}`] || '').trim().toLowerCase();
    let deliveryBy = null;
    const statusAtTime = (() => {
      const admittedAt = patient.care_admitted_at ? toDate(patient.care_admitted_at) : null;
      const deliveredAt = patient.care_delivered_at ? toDate(patient.care_delivered_at) : null;
      const dischargedAt = patient.discharge_datetime ? toDate(patient.discharge_datetime) : null;
      if (dischargedAt && slotTime >= dischargedAt) return 'Discharged';
      if (deliveredAt && slotTime >= deliveredAt) return 'Delivered';
      if (admittedAt && slotTime >= admittedAt) return 'Admitted';
      return 'Triage';
    })();
    const allowedActionsByStatus = {
      Triage: ['triage_visit', 'triage_reassessment'],
      Admitted: ['attended', 'delivery'],
    };
    const allowedActions = allowedActionsByStatus[statusAtTime] || [];

    if (!actionVal) {
      if (existingSlot) {
        dbRun('DELETE FROM shift_slots WHERE id = ?', [existingSlot.id]);
      }
      return;
    }
    if (allowedActions.length > 0 && !allowedActions.includes(actionVal)) {
      return;
    }

    if (actionVal === 'delivery') {
      deliveryBy = (req.body[`slot_delivery_${ts}`] || '').trim().toLowerCase() || null;
      const deliveryExact = (req.body[`slot_delivery_time_${ts}`] || '').trim();
      let exactDt = slotTime;
      if (deliveryExact) {
        const parsed = new Date(deliveryExact);
        exactDt = Number.isNaN(parsed.valueOf()) ? slotTime : parsed;
      }
      dbRun(
        'UPDATE patients SET care_status = ?, care_delivered_at = ? WHERE id = ?',
        ['Delivered', formatLocalDateTime(exactDt), patient.id]
      );
    }

    if (existingSlot) {
      dbRun(
        'UPDATE shift_slots SET patient_id = ?, action = ?, delivery_by = ? WHERE id = ?',
        [patient.id, actionVal, deliveryBy, existingSlot.id]
      );
      return;
    }

    if (allowedActions.length > 0) {
      dbRun(
        'INSERT INTO shift_slots (doctor_id, patient_id, start_time, action, delivery_by) VALUES (?, ?, ?, ?, ?)',
        [shiftDoctor.id, patient.id, slotTimeStr, actionVal, deliveryBy]
      );
    }
  });

  if (req.headers['x-requested-with'] === 'fetch') {
    return res.status(204).send();
  }
  return res.redirect('/shift_grid');
});

module.exports = router;
