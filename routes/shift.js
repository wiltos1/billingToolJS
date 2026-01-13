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

const getTriageAction = (patientId, doctorId) => {
  if (!patientId || !doctorId) return 'triage_visit';
  const seenByOther = dbGet(
    `SELECT 1 FROM shift_slots
     WHERE patient_id = ? AND doctor_id != ? AND action IN ('triage_visit', 'triage_reassessment')
     LIMIT 1`,
    [patientId, doctorId]
  );
  return seenByOther ? 'triage_reassessment' : 'triage_visit';
};

const getStatusAtTime = (patient, slotTime) => {
  if (!patient || !slotTime) return 'Triage';
  const events = [];
  const triageAt = patient.start_datetime ? toDate(patient.start_datetime) : null;
  const admittedAt = patient.care_admitted_at ? toDate(patient.care_admitted_at) : null;
  const deliveredAt = patient.care_delivered_at ? toDate(patient.care_delivered_at) : null;
  const dischargedAt = patient.discharge_datetime ? toDate(patient.discharge_datetime) : null;
  const extraEvents = dbAll(
    'SELECT status, occurred_at, after_status FROM patient_status_events WHERE patient_id = ?',
    [patient.id]
  );

  const baseOrder = {
    Triage: 1,
    Admitted: 2,
    Delivered: 3,
    Discharged: 4,
  };

  if (triageAt) events.push({ time: triageAt, status: 'Triage', order: baseOrder.Triage });
  if (admittedAt) events.push({ time: admittedAt, status: 'Admitted', order: baseOrder.Admitted });
  if (deliveredAt) events.push({ time: deliveredAt, status: 'Delivered', order: baseOrder.Delivered });
  if (dischargedAt) events.push({ time: dischargedAt, status: 'Discharged', order: baseOrder.Discharged });
  extraEvents.forEach((event) => {
    const eventTime = toDate(event.occurred_at);
    if (!eventTime) return;
    if (!baseOrder[event.status]) return;
    const afterStatus = (event.after_status || '').trim() || 'Triage';
    const afterOrder = baseOrder[afterStatus] || baseOrder.Triage;
    events.push({ time: eventTime, status: event.status, order: afterOrder + 0.5 });
  });
  if (patient.second_triage_at) {
    const secondTriageAt = toDate(patient.second_triage_at);
    const secondTriageAfter = (patient.second_triage_after || '').trim() || 'Triage';
    if (secondTriageAt) {
      const afterOrder = baseOrder[secondTriageAfter] || baseOrder.Triage;
      events.push({ time: secondTriageAt, status: 'Triage', order: afterOrder + 0.5 });
    }
  }

  if (!events.length) return 'Triage';

  events.sort((a, b) => (a.time - b.time) || (a.order - b.order));
  let status = 'Triage';
  events.forEach((event) => {
    if (event.time <= slotTime) {
      status = event.status;
    }
  });
  return status;
};

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
      displayPatients.push({
        ...p,
        triage_action: getTriageAction(p.id, shiftDoctor.id),
      });
      seen.add(p.id);
    }
  });

  if (displayPatients.length) {
    const ids = displayPatients.map((p) => p.id);
    const placeholders = ids.map(() => '?').join(',');
    const statusEvents = dbAll(
      `SELECT * FROM patient_status_events WHERE patient_id IN (${placeholders})`,
      ids
    );
    const eventsByPatient = {};
    statusEvents.forEach((event) => {
      if (!eventsByPatient[event.patient_id]) {
        eventsByPatient[event.patient_id] = [];
      }
      eventsByPatient[event.patient_id].push({
        status: event.status,
        occurred_at: event.occurred_at,
        after_status: event.after_status,
      });
    });
    displayPatients.forEach((patient) => {
      const extra = eventsByPatient[patient.id] || [];
      if (patient.second_triage_at) {
        extra.push({
          status: 'Triage',
          occurred_at: patient.second_triage_at,
          after_status: patient.second_triage_after || 'Triage',
        });
      }
      patient.status_events = extra;
    });
  }

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
    const statusAtTime = getStatusAtTime(patient, slotTime);
    const triageAction = getTriageAction(patient.id, shiftDoctor.id);
    const allowedActionsByStatus = {
      Triage: [triageAction],
      Admitted: ['attended', 'delivery'],
    };
    const allowedActions = allowedActionsByStatus[statusAtTime] || [];

    if (!actionVal) {
      if (existingSlot) {
        dbRun('DELETE FROM shift_slots WHERE id = ?', [existingSlot.id]);
      }
      return;
    }
    if (!allowedActions.length && actionVal) {
      return;
    }
    if (allowedActions.length > 0 && !allowedActions.includes(actionVal)) {
      return;
    }

    const isTriageAction = actionVal === 'triage_visit' || actionVal === 'triage_reassessment';
    const triageNonStress = isTriageAction ? (req.body[`slot_extra_nst_${ts}`] ? 1 : 0) : 0;
    const triageSpeculum = isTriageAction ? (req.body[`slot_extra_speculum_${ts}`] ? 1 : 0) : 0;

    if (actionVal === 'delivery') {
      const deliveryCodeInput = (req.body[`slot_delivery_code_${ts}`] || '').trim();
      const deliveryCode = deliveryCodeInput || '87.98A';
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
      deliveryBy = null;
      const deliveryTime = formatLocalDateTime(exactDt);
      const postpartum = req.body[`slot_delivery_pph_${ts}`] ? 1 : 0;
      const vacuum = req.body[`slot_delivery_vacuum_${ts}`] ? 1 : 0;
      const laceration = req.body[`slot_delivery_laceration_${ts}`] ? 1 : 0;
      const dystocia = req.body[`slot_delivery_dystocia_${ts}`] ? 1 : 0;
      const placenta = req.body[`slot_delivery_placenta_${ts}`] ? 1 : 0;
      if (existingSlot) {
        dbRun(
          `UPDATE shift_slots
           SET patient_id = ?, action = ?, delivery_by = ?, delivery_code = ?, delivery_time = ?,
               delivery_postpartum_hemorrhage = ?, delivery_vacuum = ?, delivery_vaginal_laceration = ?,
               delivery_shoulder_dystocia = ?, delivery_manual_placenta = ?,
               triage_non_stress_test = 0, triage_speculum_exam = 0
           WHERE id = ?`,
          [
            patient.id,
            actionVal,
            deliveryBy,
            deliveryCode,
            deliveryTime,
            postpartum,
            vacuum,
            laceration,
            dystocia,
            placenta,
            existingSlot.id,
          ]
        );
        return;
      }
      if (allowedActions.length > 0) {
        dbRun(
          `INSERT INTO shift_slots
           (doctor_id, patient_id, start_time, action, delivery_by, delivery_code, delivery_time,
            delivery_postpartum_hemorrhage, delivery_vacuum, delivery_vaginal_laceration,
            delivery_shoulder_dystocia, delivery_manual_placenta)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [
            shiftDoctor.id,
            patient.id,
            slotTimeStr,
            actionVal,
            deliveryBy,
            deliveryCode,
            deliveryTime,
            postpartum,
            vacuum,
            laceration,
            dystocia,
            placenta,
          ]
        );
      }
      return;
    }

    if (existingSlot) {
      dbRun(
        `UPDATE shift_slots
         SET patient_id = ?, action = ?, delivery_by = ?,
             triage_non_stress_test = ?, triage_speculum_exam = ?,
             delivery_code = NULL, delivery_time = NULL,
             delivery_postpartum_hemorrhage = 0, delivery_vacuum = 0, delivery_vaginal_laceration = 0,
             delivery_shoulder_dystocia = 0, delivery_manual_placenta = 0
         WHERE id = ?`,
        [patient.id, actionVal, deliveryBy, triageNonStress, triageSpeculum, existingSlot.id]
      );
      return;
    }

    if (allowedActions.length > 0) {
      dbRun(
        `INSERT INTO shift_slots
         (doctor_id, patient_id, start_time, action, delivery_by, triage_non_stress_test, triage_speculum_exam)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
        [shiftDoctor.id, patient.id, slotTimeStr, actionVal, deliveryBy, triageNonStress, triageSpeculum]
      );
    }
  });

  if (req.headers['x-requested-with'] === 'fetch') {
    return res.status(204).send();
  }
  return res.redirect('/shift_grid');
});

module.exports = router;
