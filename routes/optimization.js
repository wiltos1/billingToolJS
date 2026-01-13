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

const INDUCTION_DAILY_LIMIT = 2;
const INDUCTION_TOTAL_LIMIT = 4;
const INDUCTION_WINDOW_MS = 24 * 60 * 60 * 1000;
const DELIVERY_BUFFER_MINUTES = 30;

const isSameDate = (a, b) => {
  return a && b
    && a.getFullYear() === b.getFullYear()
    && a.getMonth() === b.getMonth()
    && a.getDate() === b.getDate();
};

const getTriageWindowEnd = (patient, deliveredAt) => {
  if (!patient) return deliveredAt;
  const events = dbAll(
    'SELECT status, occurred_at FROM patient_status_events WHERE patient_id = ?',
    [patient.id]
  );
  let latestTriage = null;
  events.forEach((event) => {
    if (event.status !== 'Triage') return;
    const eventTime = toDate(event.occurred_at);
    if (!eventTime) return;
    if (!latestTriage || eventTime > latestTriage) {
      latestTriage = eventTime;
    }
  });
  if (patient.second_triage_at) {
    const legacy = toDate(patient.second_triage_at);
    if (legacy && (!latestTriage || legacy > latestTriage)) {
      latestTriage = legacy;
    }
  }
  if (latestTriage && deliveredAt && latestTriage > deliveredAt) {
    return latestTriage;
  }
  return deliveredAt;
};

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
  const optimizationNotes = [];

  if (selectedPatient) {
    const admitted = toDate(selectedPatient.care_admitted_at);
    const delivered = toDate(selectedPatient.care_delivered_at);
    if (!optimizationError && (!admitted || !delivered)) {
      optimizationError = 'Set both Admitted and Delivered times to generate billing.';
    } else if (!optimizationError && admitted >= delivered) {
      optimizationError = 'Delivered time must be after Admitted time.';
    } else if (!optimizationError) {
      const startPoint = toDate(selectedPatient.start_datetime) || admitted;
      const triageWindowEnd = getTriageWindowEnd(selectedPatient, delivered);
      const patientSlots = dbAll(
        `SELECT * FROM shift_slots
         WHERE patient_id = ? AND start_time >= ? AND start_time <= ?
         ORDER BY start_time`,
        [selectedPatient.id, formatLocalDateTime(startPoint), formatLocalDateTime(triageWindowEnd)]
      );
      recommendations = buildOptimizedBillings(
        selectedPatient,
        patientSlots,
        getActiveShiftWindow()
      );
      if (recommendations.length) {
        const has1399JA = recommendations.some((rec) => rec.code === '13.99JA');
        const hasContinuousMonitoring = recommendations.some((rec) => rec.code === '87.54B');
        const has0303AR = recommendations.some((rec) => rec.code === '03.03AR');
        const cmEvents = dbAll(
          'SELECT id FROM patient_status_events WHERE patient_id = ? AND status = ?',
          [selectedPatient.id, 'Continuous Monitoring']
        );
        if (has1399JA && cmEvents.length && !hasContinuousMonitoring) {
          optimizationNotes.push('Continuous Monitoring not billed because 13.99JA is present.');
        }
        if (cmEvents.length && hasContinuousMonitoring && has0303AR) {
          optimizationNotes.push('Continuous Monitoring billed because 03.03AR is present.');
        }
        if (cmEvents.length && hasContinuousMonitoring && !has1399JA) {
          optimizationNotes.push('Continuous Monitoring billed because 13.99JA is not present.');
        }

        const triageVisits = patientSlots.filter(
          (slot) => (slot.action || '').toLowerCase() === 'triage_visit'
        );
        const hasTriageVisitBilling = recommendations.some((rec) => rec.code === '03.03BZ');
        if (triageVisits.length && !hasTriageVisitBilling) {
          const triageVisitDoctors = new Set(
            triageVisits.map((slot) => slot.doctor_id).filter((id) => id)
          );
          const firstTriageVisit = triageVisits
            .slice()
            .sort((a, b) => new Date(a.start_time) - new Date(b.start_time))[0];
          const inductionEvents = dbAll(
            'SELECT occurred_at, doctor_id FROM patient_status_events WHERE patient_id = ? AND status = ?',
            [selectedPatient.id, 'Induction']
          );
          const hasBlockingInduction = inductionEvents.some((event) => {
            const eventTime = toDate(event.occurred_at);
            if (!eventTime) return false;
            const duringTriage = admitted ? eventTime < admitted : true;
            if (!duringTriage) return false;
            const sameDay = firstTriageVisit
              ? isSameDate(eventTime, toDate(firstTriageVisit.start_time))
              : true;
            const inductionDoctor = event.doctor_id || null;
            const sameDoctor = inductionDoctor
              ? triageVisitDoctors.has(inductionDoctor)
              : triageVisitDoctors.size > 0;
            return sameDay && sameDoctor;
          });
          if (hasBlockingInduction) {
            optimizationNotes.push('Triage visit not billed because an induction was performed during triage by the same doctor on the same day.');
          }
        }
        if (triageVisits.length && hasTriageVisitBilling) {
          const triageVisitDoctors = new Set(
            triageVisits.map((slot) => slot.doctor_id).filter((id) => id)
          );
          const firstTriageVisit = triageVisits
            .slice()
            .sort((a, b) => new Date(a.start_time) - new Date(b.start_time))[0];
          const inductionEvents = dbAll(
            'SELECT occurred_at, doctor_id FROM patient_status_events WHERE patient_id = ? AND status = ?',
            [selectedPatient.id, 'Induction']
          );
          const hasInductionDuringTriage = inductionEvents.some((event) => {
            const eventTime = toDate(event.occurred_at);
            if (!eventTime) return false;
            const duringTriage = admitted ? eventTime < admitted : true;
            return duringTriage;
          });
          if (hasInductionDuringTriage) {
            const sameDaySameDoctor = inductionEvents.some((event) => {
              const eventTime = toDate(event.occurred_at);
              if (!eventTime) return false;
              const duringTriage = admitted ? eventTime < admitted : true;
              if (!duringTriage) return false;
              const sameDay = firstTriageVisit
                ? isSameDate(eventTime, toDate(firstTriageVisit.start_time))
                : true;
              const inductionDoctor = event.doctor_id || null;
              const sameDoctor = inductionDoctor
                ? triageVisitDoctors.has(inductionDoctor)
                : triageVisitDoctors.size > 0;
              return sameDay && sameDoctor;
            });
            if (!sameDaySameDoctor) {
              optimizationNotes.push('Triage visit billed because induction was by a different doctor or occurred after midnight.');
            }
          }
        }

        if (has1399JA && delivered) {
          optimizationNotes.push(`13.99JA is not billed within ${DELIVERY_BUFFER_MINUTES} minutes before delivery.`);
        }

        const inductionEvents = dbAll(
          'SELECT occurred_at, induction_non_stress_test FROM patient_status_events WHERE patient_id = ? AND status = ? ORDER BY occurred_at',
          [selectedPatient.id, 'Induction']
        );
        if (inductionEvents.length) {
          const billedInductions = [];
          let skippedByTotal = 0;
          let skippedByDaily = 0;
          let skippedNst = 0;
          let billedNst = 0;
          inductionEvents.forEach((event) => {
            const eventTime = toDate(event.occurred_at);
            if (!eventTime) return;
            if (billedInductions.length >= INDUCTION_TOTAL_LIMIT) {
              skippedByTotal += 1;
              if (event.induction_non_stress_test) skippedNst += 1;
              return;
            }
            const recentCount = billedInductions.filter(
              (t) => eventTime - t < INDUCTION_WINDOW_MS && eventTime >= t
            ).length;
            if (recentCount >= INDUCTION_DAILY_LIMIT) {
              skippedByDaily += 1;
              if (event.induction_non_stress_test) skippedNst += 1;
              return;
            }
            billedInductions.push(eventTime);
            if (event.induction_non_stress_test) billedNst += 1;
          });
          if (skippedByDaily > 0) {
            optimizationNotes.push(`Induction billed up to ${INDUCTION_DAILY_LIMIT} times per 24 hours. ${skippedByDaily} induction(s) skipped for the 24-hour cap.`);
          }
          if (skippedByTotal > 0) {
            optimizationNotes.push(`Induction billed up to ${INDUCTION_TOTAL_LIMIT} total per patient. ${skippedByTotal} induction(s) skipped for the total cap.`);
          }
          if (skippedNst > 0) {
            optimizationNotes.push(`${skippedNst} induction NST(s) not billed because the related induction was capped.`);
          }
          if (billedNst > 0) {
            optimizationNotes.push(`${billedNst} induction NST(s) billed with induction.`);
          }
        }
      }
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
    optimization_notes: optimizationNotes,
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
  const triageWindowEnd = getTriageWindowEnd(patient, delivered);
  const patientSlots = dbAll(
    `SELECT * FROM shift_slots
     WHERE patient_id = ? AND start_time >= ? AND start_time <= ?
     ORDER BY start_time`,
    [pid, formatLocalDateTime(startPoint), formatLocalDateTime(triageWindowEnd)]
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
