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

const babyIdentifierFor = (patient) => {
  if (!patient) return '';
  const base = (patient.identifier || '').trim();
  return base ? `${base} - [baby]` : '[baby]';
};

const getBabyForMother = (motherId) => {
  if (!motherId) return null;
  return dbGet(
    'SELECT * FROM patients WHERE parent_patient_id = ? AND patient_type = ? ORDER BY id LIMIT 1',
    [motherId, 'baby']
  );
};

const upsertBabyForDelivery = (mother, deliveredAt) => {
  if (!mother || !deliveredAt) return;
  const babyIdentifier = babyIdentifierFor(mother);
  const deliveredStr = formatLocalDateTime(deliveredAt);
  if (!deliveredStr) return;
  const existing = dbGet(
    'SELECT * FROM patients WHERE parent_patient_id = ? AND patient_type = ? ORDER BY id LIMIT 1',
    [mother.id, 'baby']
  );
  if (existing) {
    dbRun(
      `UPDATE patients
       SET initials = ?, identifier = ?, start_datetime = ?, care_status = ?,
           care_admitted_at = ?, status = ?
       WHERE id = ?`,
      [
        mother.initials,
        babyIdentifier,
        deliveredStr,
        'Admitted',
        deliveredStr,
        'active',
        existing.id,
      ]
    );
    return;
  }

  dbRun(
    `INSERT INTO patients
     (initials, identifier, start_datetime, care_status, care_admitted_at, status, patient_type, parent_patient_id)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      mother.initials,
      babyIdentifier,
      deliveredStr,
      'Admitted',
      deliveredStr,
      'active',
      'baby',
      mother.id,
    ]
  );
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
    const afterOrder = afterStatus.startsWith('event:')
      ? baseOrder[event.status]
      : (baseOrder[afterStatus] || baseOrder.Triage);
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
    const requiresStrict = event.status === 'Delivered' || event.status === 'Discharged';
    const qualifies = requiresStrict ? event.time < slotTime : event.time <= slotTime;
    if (qualifies) {
      status = event.status;
    }
  });
  return status;
};

const getLastStatus = (patient, extraEvents = []) => {
  if (!patient) return 'Triage';
  const events = [];
  const triageAt = patient.start_datetime ? toDate(patient.start_datetime) : null;
  const admittedAt = patient.care_admitted_at ? toDate(patient.care_admitted_at) : null;
  const deliveredAt = patient.care_delivered_at ? toDate(patient.care_delivered_at) : null;
  const dischargedAt = patient.discharge_datetime ? toDate(patient.discharge_datetime) : null;

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
    const afterOrder = afterStatus.startsWith('event:')
      ? baseOrder[event.status]
      : (baseOrder[afterStatus] || baseOrder.Triage);
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
  return events[events.length - 1].status || 'Triage';
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

  const ghostLocks = {};
  const ghostRows = dbAll(
    `SELECT start_time FROM ghost_ja_locks
     WHERE doctor_id = ? AND start_time >= ? AND start_time < ?`,
    [shiftDoctor.id, shiftWindow.start_datetime, shiftWindow.end_datetime]
  );
  ghostRows.forEach((row) => {
    const key = formatLocalDateTime(toDate(row.start_time));
    if (key) ghostLocks[key] = true;
  });

  const activeMothers = dbAll(
    `SELECT * FROM patients
     WHERE status = ? AND (patient_type IS NULL OR patient_type != 'baby')
     ORDER BY id`,
    ['active']
  );

  const existingPatientIds = new Set(
    slots.filter((slot) => slot.patient_id).map((slot) => slot.patient_id)
  );

  let preservedPatients = [];
  if (existingPatientIds.size > 0) {
    const ids = Array.from(existingPatientIds);
    preservedPatients = dbAll(
      `SELECT * FROM patients
       WHERE id IN (${ids.map(() => '?').join(',')})
       ORDER BY id`,
      ids
    );
  }

  const displayPatients = [];
  const seen = new Set();
  activeMothers.concat(preservedPatients).forEach((p) => {
    if (!seen.has(p.id)) {
      displayPatients.push({
        ...p,
        triage_action: getTriageAction(p.id, shiftDoctor.id),
      });
      seen.add(p.id);
    }
  });
  activeMothers.forEach((mother) => {
    if (!mother.care_delivered_at) return;
    const baby = getBabyForMother(mother.id);
    if (!baby || seen.has(baby.id)) return;
    displayPatients.push({
      ...baby,
      triage_action: getTriageAction(baby.id, shiftDoctor.id),
    });
    seen.add(baby.id);
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
      const hasContinuousMonitoring = extra.some((event) => event.status === 'Continuous Monitoring');
      if (patient.second_triage_at) {
        extra.push({
          status: 'Triage',
          occurred_at: patient.second_triage_at,
          after_status: patient.second_triage_after || 'Triage',
        });
      }
      patient.status_events = extra;
      patient.last_status = getLastStatus(patient, extra);
      patient.has_continuous_monitoring = hasContinuousMonitoring;
    });
  }

  const verificationPatients = displayPatients
    .filter((patient) => patient.status === 'active' && patient.patient_type !== 'baby')
    .map((patient) => ({
      id: patient.id,
      initials: patient.initials,
      identifier: patient.identifier,
      last_status: patient.last_status || 'Triage',
      has_continuous_monitoring: !!patient.has_continuous_monitoring,
    }));

  return res.render('shift', {
    session: req.session,
    shiftDoctor,
    shiftWindow,
    is_read_only: isReadOnly,
    segments,
    existing,
    ghost_locks: ghostLocks,
    active_patients: displayPatients,
    verification_patients: verificationPatients,
    format_local: formatLocalDateTime,
    format_display_24: formatDisplay24,
  });
});

router.post('/shift_grid/end_shift', requireLogin, (req, res) => {
  dbRun('UPDATE doctors SET is_on_shift = 0');
  dbRun('UPDATE shift_windows SET is_active = 0');
  if (req.headers['x-requested-with'] === 'fetch') {
    return res.status(204).send();
  }
  return res.redirect('/doctors/manage');
});

router.post('/shift_grid', requireLogin, (req, res) => {
  cleanupOldShiftData();
  const windowId = parseInt(req.body.window_id, 10);
  const shiftWindow = Number.isNaN(windowId)
    ? getActiveShiftWindow()
    : dbGet('SELECT * FROM shift_windows WHERE id = ?', [windowId]);
  if (!shiftWindow) {
    return res.redirect('/doctors/manage');
  }
  const shiftDoctor = dbGet('SELECT * FROM doctors WHERE id = ?', [shiftWindow.doctor_id]);
  if (!shiftDoctor) {
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

  const ghostRows = dbAll(
    `SELECT start_time FROM ghost_ja_locks
     WHERE doctor_id = ? AND start_time >= ? AND start_time < ?`,
    [shiftDoctor.id, shiftWindow.start_datetime, shiftWindow.end_datetime]
  );
  const ghostLockKeys = new Set(
    ghostRows
      .map((row) => formatLocalDateTime(toDate(row.start_time)))
      .filter((key) => key)
  );

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
    if (ghostLockKeys.has(slotTimeStr)) {
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
    const patientType = patient.patient_type || 'mother';

    const actionVal = (req.body[`slot_action_${ts}`] || '').trim().toLowerCase();
    let deliveryBy = null;
    const statusAtTime = getStatusAtTime(patient, slotTime);
    const triageAction = getTriageAction(patient.id, shiftDoctor.id);
    const allowedActionsByStatus = {
      Triage: [triageAction],
      Admitted: ['attended', 'delivery'],
      Delivered: ['rounds'],
    };
    let allowedActions = allowedActionsByStatus[statusAtTime] || [];
    if (patientType === 'baby') {
      allowedActions = statusAtTime === 'Admitted' ? ['rounds', 'tongue_tie_clip'] : [];
    }

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
      if (!deliveryCodeInput) {
        return;
      }
      const deliveryCode = deliveryCodeInput;
      const bmiproInput = (req.body[`slot_delivery_bmipro_${ts}`] || '').trim();
      if (!bmiproInput) {
        return;
      }
      const bmipro = bmiproInput === 'yes' ? 1 : 0;
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
      upsertBabyForDelivery(patient, exactDt);
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
               delivery_shoulder_dystocia = ?, delivery_manual_placenta = ?, delivery_bmipro = ?,
               rounds_care_type = NULL, rounds_supportive_care = 0,
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
            bmipro,
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
            delivery_shoulder_dystocia, delivery_manual_placenta, delivery_bmipro)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
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
            bmipro,
          ]
        );
      }
      return;
    }

    if (actionVal === 'rounds') {
      const careType = (req.body[`slot_rounds_care_${ts}`] || '').trim();
      if (!careType) {
        return;
      }
      const supportive = req.body[`slot_rounds_supportive_${ts}`] ? 1 : 0;
      if (existingSlot) {
        dbRun(
          `UPDATE shift_slots
           SET patient_id = ?, action = ?, delivery_by = NULL,
               rounds_care_type = ?, rounds_supportive_care = ?,
               tongue_tie_supportive_care = 0,
               triage_non_stress_test = 0, triage_speculum_exam = 0,
               delivery_code = NULL, delivery_time = NULL, delivery_bmipro = 0,
               delivery_postpartum_hemorrhage = 0, delivery_vacuum = 0, delivery_vaginal_laceration = 0,
               delivery_shoulder_dystocia = 0, delivery_manual_placenta = 0
           WHERE id = ?`,
          [patient.id, actionVal, careType, supportive, existingSlot.id]
        );
        return;
      }
      if (allowedActions.length > 0) {
        dbRun(
          `INSERT INTO shift_slots
           (doctor_id, patient_id, start_time, action, delivery_by, rounds_care_type, rounds_supportive_care)
           VALUES (?, ?, ?, ?, ?, ?, ?)`,
          [
            shiftDoctor.id,
            patient.id,
            slotTimeStr,
            actionVal,
            deliveryBy,
            careType,
            supportive,
          ]
        );
      }
      return;
    }

    if (actionVal === 'tongue_tie_clip') {
      const supportive = req.body[`slot_tongue_tie_supportive_${ts}`] ? 1 : 0;
      if (existingSlot) {
        dbRun(
          `UPDATE shift_slots
           SET patient_id = ?, action = ?, delivery_by = NULL,
               rounds_care_type = NULL, rounds_supportive_care = 0,
               tongue_tie_supportive_care = ?,
               triage_non_stress_test = 0, triage_speculum_exam = 0,
               delivery_code = NULL, delivery_time = NULL, delivery_bmipro = 0,
               delivery_postpartum_hemorrhage = 0, delivery_vacuum = 0, delivery_vaginal_laceration = 0,
               delivery_shoulder_dystocia = 0, delivery_manual_placenta = 0
           WHERE id = ?`,
          [patient.id, actionVal, supportive, existingSlot.id]
        );
        return;
      }
      if (allowedActions.length > 0) {
        dbRun(
          `INSERT INTO shift_slots
           (doctor_id, patient_id, start_time, action, delivery_by, rounds_care_type, rounds_supportive_care, tongue_tie_supportive_care)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
          [
            shiftDoctor.id,
            patient.id,
            slotTimeStr,
            actionVal,
            deliveryBy,
            null,
            0,
            supportive,
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
             rounds_care_type = NULL, rounds_supportive_care = 0,
             tongue_tie_supportive_care = 0,
             delivery_code = NULL, delivery_time = NULL, delivery_bmipro = 0,
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
