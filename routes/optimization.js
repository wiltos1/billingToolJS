const express = require('express');
const { dbGet, dbAll, dbRun } = require('../db');
const {
  requireLogin,
  toDate,
  formatDisplay,
  formatLocalDateTime,
  getActiveShiftWindow,
  optimizeBillings,
} = require('../services/helpers');
const { buildOptimizedBillings } = require('../services/rules');

const router = express.Router();

const getSelectedPatient = (req) => {
  const sessionKey = 'last_optimization_patient';
  let patientId = parseInt(req.query.selected_patient || req.session[sessionKey], 10);
  if (!Number.isNaN(patientId)) {
    const patient = dbGet('SELECT * FROM patients WHERE id = ? AND status = ?', [patientId, 'active']);
    if (patient) {
      req.session[sessionKey] = patient.id;
      return patient;
    }
  }

  const fallback = dbGet('SELECT * FROM patients WHERE status = ? ORDER BY id LIMIT 1', ['active']);
  if (fallback) {
    req.session[sessionKey] = fallback.id;
  }
  return fallback || null;
};

router.get('/optimization', requireLogin, (req, res) => {
  const activePatients = dbAll('SELECT * FROM patients WHERE status = ? ORDER BY id', ['active']);
  const selectedPatient = getSelectedPatient(req);

  let recommendations = [];
  let optimizationError = req.query.opt_error || '';

  if (selectedPatient) {
    const admitted = toDate(selectedPatient.care_admitted_at);
    const delivered = toDate(selectedPatient.care_delivered_at);
    if (!optimizationError && (!admitted || !delivered)) {
      optimizationError = 'Set both Admitted and Delivered times to generate billing.';
    } else if (!optimizationError && admitted >= delivered) {
      optimizationError = 'Delivered time must be after Admitted time.';
    } else if (!optimizationError) {
      const startPoint = toDate(selectedPatient.start_datetime) || admitted;
      const patientSlots = dbAll(
        `SELECT * FROM shift_slots
         WHERE patient_id = ? AND start_time >= ? AND start_time <= ?
         ORDER BY start_time`,
        [selectedPatient.id, formatLocalDateTime(startPoint), formatLocalDateTime(delivered)]
      );
      recommendations = buildOptimizedBillings(
        selectedPatient,
        patientSlots,
        getActiveShiftWindow()
      );
      if (!recommendations.length) {
        optimizationError = 'No eligible billing slots found within the Admitted-to-Delivered window.';
      }
    }
  }

  return res.render('optimization', {
    session: req.session,
    active_patients: activePatients,
    selected_patient: selectedPatient,
    recommendations,
    optimization_error: optimizationError,
    format_display: formatDisplay,
  });
});

router.post('/optimization/:pid/confirm', requireLogin, (req, res) => {
  const pid = parseInt(req.params.pid, 10);
  const patient = dbGet('SELECT * FROM patients WHERE id = ? AND status = ?', [pid, 'active']);
  if (!patient) {
    return res.redirect('/optimization');
  }

  const admitted = toDate(patient.care_admitted_at);
  const delivered = toDate(patient.care_delivered_at);
  if (!admitted || !delivered) {
    return res.redirect('/optimization?selected_patient=' + pid + '&opt_error=' + encodeURIComponent('Set both Admitted and Delivered times to generate billing.'));
  }
  if (admitted >= delivered) {
    return res.redirect('/optimization?selected_patient=' + pid + '&opt_error=' + encodeURIComponent('Delivered time must be after Admitted time.'));
  }

  const startPoint = toDate(patient.start_datetime) || admitted;
  const patientSlots = dbAll(
    `SELECT * FROM shift_slots
     WHERE patient_id = ? AND start_time >= ? AND start_time <= ?
     ORDER BY start_time`,
    [pid, formatLocalDateTime(startPoint), formatLocalDateTime(delivered)]
  );
  const recommendations = buildOptimizedBillings(
    patient,
    patientSlots,
    getActiveShiftWindow()
  );
  if (!recommendations.length) {
    return res.redirect('/optimization?selected_patient=' + pid + '&opt_error=' + encodeURIComponent('No eligible billing slots found within the Admitted-to-Delivered window.'));
  }

  dbRun('DELETE FROM confirmed_billings WHERE patient_id = ?', [pid]);
  recommendations.forEach((rec) => {
    dbRun(
      'INSERT INTO confirmed_billings (patient_id, doctor_id, code, modifier, timestamp) VALUES (?, ?, ?, ?, ?)',
      [
        pid,
        rec.doctor ? rec.doctor.id : null,
        rec.code,
        rec.modifier || '',
        formatLocalDateTime(rec.time),
      ]
    );
  });

  dbRun('UPDATE shift_slots SET locked = 1 WHERE patient_id = ?', [pid]);

  const now = new Date();
  const nowStr = formatLocalDateTime(now);
  const dischargeAt = patient.discharge_datetime || nowStr;
  const note = (req.body.billing_note || '').trim();

  dbRun(
    `UPDATE patients
     SET care_status = ?, discharge_datetime = ?, care_admitted_at = ?, care_delivered_at = ?, billing_note = ?
     WHERE id = ?`,
    [
      'Discharged',
      dischargeAt,
      formatLocalDateTime(admitted),
      formatLocalDateTime(delivered),
      note || null,
      pid,
    ]
  );

  optimizeBillings(pid);

  return res.redirect('/?view=archived');
});

router.get('/optimization/:pid/optimized_pdf', requireLogin, (req, res) => {
  const pid = parseInt(req.params.pid, 10);
  return res.redirect(`/patients/${pid}/confirmed_pdf`);
});

module.exports = router;
