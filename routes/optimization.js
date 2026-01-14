const express = require('express');
const { dbGet, dbAll, dbRun } = require('../db');
const {
  requireLogin,
  toDate,
  formatDisplay,
  formatLocalDateTime,
  getShiftWindowsForRange,
  optimizeBillings,
} = require('../services/helpers');
const { buildOptimizedBillings } = require('../services/rules');

const router = express.Router();

const INDUCTION_DAILY_LIMIT = 2;
const INDUCTION_TOTAL_LIMIT = 4;
const INDUCTION_WINDOW_MS = 24 * 60 * 60 * 1000;
const DELIVERY_BUFFER_MINUTES = 30;
const JA_VALUE = 55;

const callbackCodeForTriage = (date) => {
  const weekday = date.getDay();
  const hour = date.getHours() + date.getMinutes() / 60;
  const isWeekend = weekday === 0 || weekday === 6;

  if (hour < 7) return '03.03MD';
  if (hour >= 22) return '03.03MC';
  if (isWeekend) return '03.03LA';
  if (hour < 17) return '03.03KA';
  return '03.03LA';
};

const callbackCodeForInpatient = (date) => {
  const hour = date.getHours() + date.getMinutes() / 60;
  if (hour < 7) return '03.05QB';
  if (hour >= 22) return '03.05QA';
  return '03.05P';
};

const callbackValue = (code) => ({
  '03.03KA': 80,
  '03.03LA': 120,
  '03.03MC': 160,
  '03.03MD': 160,
  '03.05P': 159,
  '03.05QA': 197,
  '03.05QB': 197,
}[code] || 0);

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
      const activeShiftWindows = getShiftWindowsForRange(admitted, delivered);
      const activeShiftWindow = activeShiftWindows.length ? activeShiftWindows[0] : null;
      recommendations = buildOptimizedBillings(
        selectedPatient,
        patientSlots,
        activeShiftWindows
      );
      if (recommendations.length) {
        const recommendationCodes = recommendations.map((rec) => rec.code);
        const hasCode = (code) => recommendationCodes.includes(code);
        const uniqueModifiers = (code) => {
          const modifiers = recommendations
            .filter((rec) => rec.code === code && rec.modifier)
            .map((rec) => rec.modifier);
          return Array.from(new Set(modifiers));
        };

        const has1399JA = recommendations.some((rec) => rec.code === '13.99JA');
        const hasContinuousMonitoring = recommendations.some((rec) => rec.code === '87.54B');
        const has0303AR = recommendations.some((rec) => rec.code === '03.03AR');
        const triageSlots = patientSlots.filter((slot) => {
          const actionKey = (slot.action || '').toLowerCase();
          return actionKey === 'triage_visit' || actionKey === 'triage_reassessment';
        });
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

        if (has1399JA) {
          optimizationNotes.push(`13.99JA billed for up to 12 weighted slots within the active shift window; unmodified entries start at the first attended time, and none are billed within ${DELIVERY_BUFFER_MINUTES} minutes before delivery.`);
        } else if (has0303AR) {
          optimizationNotes.push('OB/VBAC deliveries use 03.03AR for attended slots instead of 13.99JA.');
        } else if (!activeShiftWindow) {
          optimizationNotes.push('No shift window overlaps the admitted-to-delivered range; 13.99JA and callback billing are not generated.');
        }

        if (activeShiftWindows.length) {
          const callbackDetails = [];
          activeShiftWindows.forEach((window) => {
            const firstSlot = dbGet(
              `SELECT * FROM shift_slots
               WHERE doctor_id = ? AND start_time >= ? AND start_time < ?
                 AND patient_id IS NOT NULL AND action IS NOT NULL AND action != ''
               ORDER BY start_time
               LIMIT 1`,
              [window.doctor_id, window.start_datetime, window.end_datetime]
            );
            if (!firstSlot || firstSlot.patient_id !== selectedPatient.id) return;
            const slotTime = toDate(firstSlot.start_time);
            const actionKey = (firstSlot.action || '').toLowerCase();
            const callbackCodes = [];
            let callbackTotal = 0;
            if (slotTime && (actionKey === 'triage_visit' || actionKey === 'triage_reassessment')) {
              const code = callbackCodeForTriage(slotTime);
              callbackCodes.push(code);
              callbackTotal = callbackValue(code);
            } else if (slotTime && admitted && slotTime >= admitted) {
              const code = callbackCodeForInpatient(slotTime);
              callbackCodes.push('03.03DF', code);
              callbackTotal = callbackValue(code);
            }

            if (callbackCodes.length) {
              callbackDetails.push({
                codes: callbackCodes,
                total: callbackTotal,
                slotTime,
                doctorId: firstSlot.doctor_id || null,
              });
            }
          });

          if (callbackDetails.length) {
            const billedCallbacks = callbackDetails.filter((detail) => {
              if (!detail.doctorId) {
                return recommendations.some((rec) => detail.codes.includes(rec.code));
              }
              return recommendations.some(
                (rec) => detail.codes.includes(rec.code) && rec.doctor && rec.doctor.id === detail.doctorId
              );
            });
            if (billedCallbacks.length) {
              if (billedCallbacks.length === 1) {
                optimizationNotes.push(`Callback billed: ${billedCallbacks[0].codes.join(' + ')}.`);
              } else {
                optimizationNotes.push(`Callbacks billed for ${billedCallbacks.length} doctors (first patient per doctor).`);
              }
            }

            const skippedCallbacks = callbackDetails.filter((detail) => {
              if (!detail.slotTime) return false;
              const ghostBeforeCallback = recommendations.filter(
                (rec) => rec.code === '13.99JA' && !rec.modifier && rec.time < detail.slotTime
              );
              const ghostTotal = ghostBeforeCallback.length * JA_VALUE;
              return ghostTotal > detail.total;
            });
            if (skippedCallbacks.length) {
              optimizationNotes.push('One or more callbacks skipped because ghost 13.99JA total exceeded callback value.');
            }
          }
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

        if (triageWindowEnd && delivered && triageWindowEnd > delivered) {
          optimizationNotes.push('Triage billing window extended to the latest triage event after delivery.');
        }

        if (hasCode('03.03BZ')) {
          const modifiers = uniqueModifiers('03.03BZ');
          if (modifiers.length) {
            optimizationNotes.push(`Triage visit billed (03.03BZ) with modifier ${modifiers.join(', ')} based on total triage visit time.`);
          } else {
            optimizationNotes.push('Triage visit billed (03.03BZ) with no time-based modifier applied.');
          }
        }

        const reassessmentCodes = ['03.05F', '03.05FA', '03.05FB'];
        const billedReassessments = reassessmentCodes.filter((code) => hasCode(code));
        if (billedReassessments.length) {
          const modifiers = billedReassessments.flatMap((code) => uniqueModifiers(code));
          if (modifiers.length) {
            optimizationNotes.push(`Triage reassessment billed (${billedReassessments.join(', ')}) with modifier ${Array.from(new Set(modifiers)).join(', ')}.`);
          } else {
            optimizationNotes.push(`Triage reassessment billed (${billedReassessments.join(', ')}).`);
          }
        }

        if (triageSlots.some((slot) => slot.triage_non_stress_test) && hasCode('87.54A')) {
          const count = triageSlots.filter((slot) => slot.triage_non_stress_test).length;
          optimizationNotes.push(`${count} triage non-stress test(s) billed (87.54A).`);
        }
        if (triageSlots.some((slot) => slot.triage_speculum_exam) && hasCode('13.99BE')) {
          const count = triageSlots.filter((slot) => slot.triage_speculum_exam).length;
          optimizationNotes.push(`${count} triage speculum exam(s) billed (13.99BE).`);
        }

        if (hasCode('03.01AA')) {
          const modifiers = uniqueModifiers('03.01AA');
          if (modifiers.length) {
            optimizationNotes.push(`After-hours premium billed (03.01AA) with modifiers ${modifiers.join(', ')}.`);
          } else {
            optimizationNotes.push('After-hours premium billed (03.01AA).');
          }
        }

        if (hasCode('85.5A')) {
          const modifiers = uniqueModifiers('85.5A');
          if (modifiers.length) {
            optimizationNotes.push(`Induction billed (85.5A) with after-hours modifier(s) ${modifiers.join(', ')}.`);
          } else {
            optimizationNotes.push('Induction billed (85.5A) with no after-hours modifier.');
          }
        }

        if (hasCode('87.54B')) {
          const modifiers = uniqueModifiers('87.54B');
          if (modifiers.length) {
            optimizationNotes.push(`Continuous Monitoring billed (87.54B) with after-hours modifier(s) ${modifiers.join(', ')}.`);
          } else {
            optimizationNotes.push('Continuous Monitoring billed (87.54B).');
          }
        }

        const deliveryCodes = ['87.98A', '87.98B', '87.98C'];
        const billedDeliveryCode = deliveryCodes.find((code) => hasCode(code));
        if (billedDeliveryCode) {
          const modifiers = uniqueModifiers(billedDeliveryCode);
          if (modifiers.length) {
            optimizationNotes.push(`Delivery billed (${billedDeliveryCode}) with after-hours modifier ${modifiers.join(', ')}.`);
          } else {
            optimizationNotes.push(`Delivery billed (${billedDeliveryCode}).`);
          }
        }

        const deliveryExtras = [
          { code: '87.99A', label: 'Postpartum hemorrhage' },
          { code: '84.21', label: 'Vacuum delivery' },
          { code: '87.89B', label: 'Extensive vaginal laceration' },
          { code: '85.69B', label: 'Shoulder dystocia' },
          { code: '87.6', label: 'Manual removal of placenta' },
        ];
        const billedExtras = deliveryExtras
          .filter((extra) => hasCode(extra.code))
          .map((extra) => `${extra.label} (${extra.code})`);
        if (billedExtras.length) {
          optimizationNotes.push(`Delivery extras billed: ${billedExtras.join(', ')}.`);
        }

        if (has0303AR) {
          const modifiers = uniqueModifiers('03.03AR');
          if (modifiers.includes('COINPT')) {
            optimizationNotes.push('COINPT modifier applied to 03.03AR for two attended slots 14-16 minutes apart within the active shift window.');
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
    getShiftWindowsForRange(admitted, delivered)
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
