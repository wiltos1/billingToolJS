const express = require('express');
const PDFDocument = require('pdfkit');
const { dbGet, dbAll, dbRun } = require('../db');
const {
  parseDateTime,
  formatDate,
  formatTime,
  formatDisplay,
  formatLocalDateTime,
  toDate,
  getShiftDoctor,
  getActiveShiftWindow,
  requireLogin,
  optimizeBillings,
  formatCurrency,
} = require('../services/helpers');
const { buildOptimizedBillings } = require('../services/rules');

const router = express.Router();

const getSelectedPatient = (req, statusFilter) => {
  const sessionKey = `last_patient_${statusFilter}`;
  let patientId = parseInt(req.query.selected_patient || req.session[sessionKey], 10);
  if (!Number.isNaN(patientId)) {
    const patient = dbGet(
      'SELECT * FROM patients WHERE id = ? AND status = ?',
      [patientId, statusFilter]
    );
    if (patient) {
      req.session[sessionKey] = patient.id;
      return patient;
    }
  }

  const fallback = dbGet(
    'SELECT * FROM patients WHERE status = ? ORDER BY id LIMIT 1',
    [statusFilter]
  );
  if (fallback) {
    req.session[sessionKey] = fallback.id;
  }
  return fallback || null;
};

router.get('/', requireLogin, (req, res) => {
  let currentView = (req.query.view || 'active').toLowerCase();
  if (!['active', 'archived'].includes(currentView)) {
    currentView = 'active';
  }

  const statusFilter = currentView === 'active' ? 'active' : 'discharged';
  const selectedPatient = getSelectedPatient(req, statusFilter);

  const now = new Date();
  const currentShiftDoctor = getShiftDoctor();

  const activePatients = dbAll(
    'SELECT * FROM patients WHERE status = ? ORDER BY id',
    ['active']
  );
  const archivedPatients = dbAll(
    'SELECT * FROM patients WHERE status = ? ORDER BY id',
    ['discharged']
  );

  let patientBillings = [];
  let optimizedBillings = [];
  let patientDoctors = [];
  let shiftEntries = [];
  let timelineEntries = [];
  let statusDtDefault = now;
  const optimizationError = req.query.opt_error;

  if (selectedPatient) {
    patientBillings = dbAll(
      `SELECT b.*, d.name as doctor_name
       FROM billings b
       LEFT JOIN doctors d ON b.doctor_id = d.id
       WHERE b.patient_id = ?
       ORDER BY b.timestamp`,
      [selectedPatient.id]
    ).map((b) => ({
      ...b,
      doctor: b.doctor_name ? { id: b.doctor_id, name: b.doctor_name } : null,
    }));

    optimizedBillings = patientBillings.filter((b) => b.optimized_included === 1);

    const docIds = new Set();
    patientBillings.forEach((billing) => {
      if (billing.doctor && !docIds.has(billing.doctor_id)) {
        docIds.add(billing.doctor_id);
        patientDoctors.push(billing.doctor);
      }
    });

    const admittedAt = toDate(selectedPatient.care_admitted_at);
    const deliveredAt = toDate(selectedPatient.care_delivered_at);
    statusDtDefault = admittedAt || deliveredAt || now;

    shiftEntries = dbAll(
      `SELECT s.*, d.name as doctor_name
       FROM shift_slots s
       LEFT JOIN doctors d ON s.doctor_id = d.id
       WHERE s.patient_id = ?
       ORDER BY s.start_time`,
      [selectedPatient.id]
    ).map((s) => ({
      ...s,
      doctor: s.doctor_name ? { id: s.doctor_id, name: s.doctor_name } : null,
    }));

    const statusRows = [];
    const baseOrder = {
      Triage: 1,
      Admitted: 2,
      Delivered: 3,
      Discharged: 4,
    };
    const statusEvents = dbAll(
      'SELECT * FROM patient_status_events WHERE patient_id = ? ORDER BY occurred_at',
      [selectedPatient.id]
    );
    if (selectedPatient.second_triage_at) {
      statusEvents.push({
        id: `legacy-${selectedPatient.id}`,
        patient_id: selectedPatient.id,
        status: 'Triage',
        occurred_at: selectedPatient.second_triage_at,
        after_status: selectedPatient.second_triage_after || 'Triage',
      });
    }
    if (selectedPatient.start_datetime) {
      statusRows.push({
        time: toDate(selectedPatient.start_datetime),
        doctor: null,
        doctor_name: '',
        action: 'Triage',
        delivery_by: '',
        status_row: true,
        order: baseOrder.Triage,
      });
    }
    statusEvents.forEach((event) => {
      const eventTime = toDate(event.occurred_at);
      if (!eventTime) return;
      const afterStatus = (event.after_status || '').trim() || 'Triage';
      const afterOrder = baseOrder[afterStatus] || baseOrder.Triage;
      const extras = [];
      if (event.status === 'Induction' && event.induction_non_stress_test) {
        extras.push('NST');
      }
      const extrasLabel = extras.length ? ` [${extras.join(', ')}]` : '';
      statusRows.push({
        time: eventTime,
        doctor: null,
        doctor_name: '',
        action: `${event.status}${extrasLabel}`,
        delivery_by: '',
        status_row: true,
        order: afterOrder + 0.5,
      });
    });
    if (selectedPatient.care_admitted_at) {
      statusRows.push({
        time: toDate(selectedPatient.care_admitted_at),
        doctor: null,
        doctor_name: '',
        action: 'Admitted',
        delivery_by: '',
        status_row: true,
        order: baseOrder.Admitted,
      });
    }
    if (selectedPatient.care_delivered_at) {
      statusRows.push({
        time: toDate(selectedPatient.care_delivered_at),
        doctor: null,
        doctor_name: '',
        action: 'Delivered',
        delivery_by: selectedPatient.care_status,
        status_row: true,
        order: baseOrder.Delivered,
      });
    }
    if (selectedPatient.discharge_datetime) {
      statusRows.push({
        time: toDate(selectedPatient.discharge_datetime),
        doctor: null,
        doctor_name: '',
        action: 'Discharged',
        delivery_by: '',
        status_row: true,
        order: baseOrder.Discharged,
      });
    }

    const actionLabels = {
      attended: 'Attended',
      delivery: 'Delivery',
      triage_visit: 'Triage Visit',
      triage_reassessment: 'Triage Re-assessment',
    };
    const actionRows = shiftEntries.map((slot) => {
      let deliveryLabel = '';
      if (slot.delivery_code) {
        deliveryLabel = slot.delivery_code;
      } else if (slot.delivery_by) {
        deliveryLabel = slot.delivery_by.toLowerCase() === 'ob' ? '87.98B' : '87.98A';
      }
      const rawAction = (slot.action || '').toLowerCase();
      const extras = [];
      if (rawAction === 'delivery') {
        if (slot.delivery_postpartum_hemorrhage) extras.push('Postpartum hemorrhage');
        if (slot.delivery_vacuum) extras.push('Vacuum delivery');
        if (slot.delivery_vaginal_laceration) extras.push('Extensive vaginal laceration');
        if (slot.delivery_shoulder_dystocia) extras.push('Shoulder dystocia');
        if (slot.delivery_manual_placenta) extras.push('Manual removal of placenta');
      }
      if (rawAction === 'triage_visit' || rawAction === 'triage_reassessment') {
        if (slot.triage_non_stress_test) extras.push('Non-stress test');
        if (slot.triage_speculum_exam) extras.push('Speculum exam');
      }
      const extrasLabel = extras.length ? ` [${extras.join(', ')}]` : '';
      return {
        time: toDate(slot.start_time),
        doctor: slot.doctor,
        doctor_name: slot.doctor ? slot.doctor.name : '',
        action: (actionLabels[rawAction] || (slot.action ? slot.action.charAt(0).toUpperCase() + slot.action.slice(1) : '')) + extrasLabel,
        delivery_by: deliveryLabel,
        status_row: false,
        order: 10,
      };
    });

    timelineEntries = statusRows.concat(actionRows).filter((e) => e.time);
    timelineEntries.sort((a, b) => (a.time - b.time) || ((a.order || 0) - (b.order || 0)));
  }

  const triageDt = selectedPatient ? toDate(selectedPatient.start_datetime) : null;
  const admittedDt = selectedPatient ? toDate(selectedPatient.care_admitted_at) : null;
  const deliveredDt = selectedPatient ? toDate(selectedPatient.care_delivered_at) : null;
  const dischargedDt = selectedPatient ? toDate(selectedPatient.discharge_datetime) : null;
  const extraStatusRows = [];
  const baseOrderKeys = ['Triage', 'Admitted', 'Delivered', 'Discharged'];
  const baseTimes = {
    Triage: triageDt,
    Admitted: admittedDt,
    Delivered: deliveredDt,
    Discharged: dischargedDt,
  };

  const statusEventsForTable = dbAll(
    'SELECT * FROM patient_status_events WHERE patient_id = ? ORDER BY occurred_at',
    [selectedPatient ? selectedPatient.id : -1]
  );
  if (selectedPatient && selectedPatient.second_triage_at) {
    statusEventsForTable.push({
      id: `legacy-${selectedPatient.id}`,
      status: 'Triage',
      occurred_at: selectedPatient.second_triage_at,
      after_status: selectedPatient.second_triage_after || 'Triage',
    });
  }

  statusEventsForTable.forEach((event) => {
    const eventTime = toDate(event.occurred_at);
    if (!eventTime) return;
    const baseEvents = baseOrderKeys
      .map((status) => ({ status, time: baseTimes[status] }))
      .filter((item) => item.time)
      .sort((a, b) => a.time - b.time);
    let displayAfter = (event.after_status || '').trim() || 'Triage';
    baseEvents.forEach((baseEvent) => {
      if (baseEvent.time <= eventTime) {
        displayAfter = baseEvent.status;
      }
    });
    extraStatusRows.push({
      id: event.id,
      label: event.status,
      after_status: (event.after_status || '').trim() || displayAfter,
      date_display: formatDate(eventTime),
      time_display: formatTime(eventTime),
      display_after: displayAfter,
      sort_time: eventTime,
      induction_nst: event.induction_non_stress_test ? 1 : 0,
    });
  });

  const statusTimelineRows = baseOrderKeys.map((status) => ({
    label: status,
    editable: true,
    name_prefix: status.toLowerCase(),
    date_value: baseTimes[status] ? formatDate(baseTimes[status]) : '',
    time_value: baseTimes[status] ? formatTime(baseTimes[status]) : '',
  }));

  extraStatusRows
    .sort((a, b) => a.sort_time - b.sort_time)
    .forEach((row) => {
      const insertAfter = row.after_status || row.display_after;
      let insertIndex = -1;
      statusTimelineRows.forEach((existing, idx) => {
        if (existing.label === insertAfter) {
          insertIndex = idx;
        }
      });
      const insertion = {
        label: row.label,
        editable: false,
        event_id: row.id,
        date_value: row.date_display,
        time_value: row.time_display,
        induction_nst: row.induction_nst,
      };
      if (insertIndex >= 0) {
        statusTimelineRows.splice(insertIndex + 1, 0, insertion);
      } else {
        statusTimelineRows.push(insertion);
      }
    });

  const selectedWithDisplay = selectedPatient
    ? {
        ...selectedPatient,
        start_display: selectedPatient.start_datetime
          ? formatDisplay(toDate(selectedPatient.start_datetime))
          : null,
        discharge_display: selectedPatient.discharge_datetime
          ? formatDisplay(toDate(selectedPatient.discharge_datetime))
          : null,
      }
    : null;

  return res.render('main', {
    session: req.session,
    current_view: currentView,
    current_shift_doctor: currentShiftDoctor,
    selected_patient: selectedWithDisplay,
    active_patients: activePatients,
    archived_patients: archivedPatients,
    patient_billings: patientBillings,
    optimized_billings: optimizedBillings,
    patient_doctors: patientDoctors,
    shift_entries: shiftEntries,
    timeline_entries: timelineEntries,
    optimization_error: optimizationError,
    care_status_options: ['Triage', 'Admitted', 'Delivered', 'Discharged'],
    status_default_date: formatDate(statusDtDefault),
    status_default_time: formatTime(statusDtDefault),
    triage_date: triageDt ? formatDate(triageDt) : '',
    triage_time: triageDt ? formatTime(triageDt) : '',
    status_timeline_rows: statusTimelineRows,
    admitted_date: admittedDt ? formatDate(admittedDt) : '',
    admitted_time: admittedDt ? formatTime(admittedDt) : '',
    delivered_date: deliveredDt ? formatDate(deliveredDt) : '',
    delivered_time: deliveredDt ? formatTime(deliveredDt) : '',
    discharged_date: dischargedDt ? formatDate(dischargedDt) : '',
    discharged_time: dischargedDt ? formatTime(dischargedDt) : '',
    default_start_date: formatDate(now),
    default_start_time: formatTime(now),
    default_billing_date: formatDate(now),
    default_billing_time: formatTime(now),
    default_discharge_date: formatDate(now),
    default_discharge_time: formatTime(now),
    format_display: formatDisplay,
    format_currency: formatCurrency,
  });
});

router.post('/patients', requireLogin, (req, res) => {
  const initials = (req.body.patient_initials || '').trim();
  const identifier = (req.body.patient_identifier || '').trim();
  const startDate = (req.body.start_date || '').trim();
  const startTime = (req.body.start_time || '').trim();

  if (!initials || !identifier) {
    return res.redirect('/?view=active');
  }

  const startDt = parseDateTime(startDate, startTime);
  const result = dbRun(
    `INSERT INTO patients
      (initials, identifier, start_datetime, status, care_status)
     VALUES (?, ?, ?, ?, ?)`,
    [initials, identifier, formatLocalDateTime(startDt), 'active', 'Triage']
  );

  return res.redirect(`/?view=active&selected_patient=${result.lastInsertRowid}`);
});

router.post('/patients/:pid/billings', requireLogin, (req, res) => {
  const pid = parseInt(req.params.pid, 10);
  const patient = dbGet('SELECT * FROM patients WHERE id = ?', [pid]);
  if (!patient || patient.status !== 'active') {
    return res.redirect('/?view=active');
  }

  const shiftDoctor = getShiftDoctor();
  if (!shiftDoctor) {
    return res.redirect('/doctors/manage');
  }

  const billingDate = (req.body.billing_date || '').trim();
  const billingTime = (req.body.billing_time || '').trim();
  const billingDt = parseDateTime(billingDate, billingTime);

  dbRun(
    `INSERT INTO billings
      (patient_id, doctor_id, code, description, amount, timestamp)
     VALUES (?, ?, ?, ?, ?, ?)`,
    [
      patient.id,
      shiftDoctor.id,
      (req.body.code || '').trim(),
      (req.body.description || '').trim(),
      parseFloat(req.body.amount || 0),
      formatLocalDateTime(billingDt),
    ]
  );

  return res.redirect(`/?view=active&selected_patient=${pid}`);
});

router.post('/patients/:pid/discharge', requireLogin, (req, res) => {
  const pid = parseInt(req.params.pid, 10);
  const dischargeDate = (req.body.discharge_date || '').trim();
  const dischargeTime = (req.body.discharge_time || '').trim();

  const patient = dbGet('SELECT * FROM patients WHERE id = ?', [pid]);
  if (patient && patient.status === 'active') {
    const dischargeDt = parseDateTime(dischargeDate, dischargeTime);
    const deliveredAt = patient.care_delivered_at || formatLocalDateTime(dischargeDt);

    dbRun(
      `UPDATE patients
       SET discharge_datetime = ?, care_status = ?, care_delivered_at = ?
       WHERE id = ?`,
      [formatLocalDateTime(dischargeDt), 'Delivered', deliveredAt, pid]
    );

    optimizeBillings(pid);
  }

  return res.redirect('/?view=active');
});

router.post('/patients/:pid/restore', requireLogin, (req, res) => {
  const pid = parseInt(req.params.pid, 10);
  const patient = dbGet('SELECT * FROM patients WHERE id = ?', [pid]);
  if (patient && patient.status === 'discharged') {
    dbRun('UPDATE patients SET status = ? WHERE id = ?', ['active', pid]);
  }
  return res.redirect(`/?view=active&selected_patient=${pid}`);
});

router.post('/patients/:pid/delete', requireLogin, (req, res) => {
  const pid = parseInt(req.params.pid, 10);
  const view = req.body.view || 'active';
  dbRun('DELETE FROM patients WHERE id = ?', [pid]);
  return res.redirect(`/?view=${view}`);
});

router.get('/patients/:pid/optimized_pdf', requireLogin, (req, res) => {
  const pid = parseInt(req.params.pid, 10);
  const patient = dbGet('SELECT * FROM patients WHERE id = ?', [pid]);
  if (!patient) {
    return res.redirect('/?view=active');
  }

  const admitted = toDate(patient.care_admitted_at);
  const delivered = toDate(patient.care_delivered_at);
  if (!admitted || !delivered) {
    return res.redirect(
      `/?view=active&selected_patient=${pid}&opt_error=${encodeURIComponent('Set both Admitted and Delivered times to generate billing.')}`
    );
  }
  if (admitted >= delivered) {
    return res.redirect(
      `/?view=active&selected_patient=${pid}&opt_error=${encodeURIComponent('Delivered time must be after Admitted time.')}`
    );
  }

  const startPoint = toDate(patient.start_datetime) || admitted;
  const triageEvents = dbAll(
    'SELECT occurred_at FROM patient_status_events WHERE patient_id = ? AND status = ?',
    [pid, 'Triage']
  );
  let triageWindowEnd = delivered;
  triageEvents.forEach((event) => {
    const eventTime = toDate(event.occurred_at);
    if (eventTime && delivered && eventTime > delivered) {
      triageWindowEnd = !triageWindowEnd || eventTime > triageWindowEnd ? eventTime : triageWindowEnd;
    }
  });
  if (patient.second_triage_at) {
    const legacy = toDate(patient.second_triage_at);
    if (legacy && delivered && legacy > delivered) {
      triageWindowEnd = !triageWindowEnd || legacy > triageWindowEnd ? legacy : triageWindowEnd;
    }
  }
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

  if (!recommendations || recommendations.length === 0) {
    return res.redirect(
      `/?view=active&selected_patient=${pid}&opt_error=${encodeURIComponent('No eligible billing slots found within the Admitted-to-Delivered window.')}`
    );
  }

  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', `attachment; filename=patient_${patient.id}_billing.pdf`);

  const doc = new PDFDocument({ margin: 40 });
  doc.pipe(res);

  const line = (text, opts = {}) => {
    const { bold = false, size = 11 } = opts;
    doc.font(bold ? 'Helvetica-Bold' : 'Helvetica').fontSize(size).text(text, { continued: false });
  };

  line('Patient Billing Summary', { bold: true, size: 13 });
  line(`Patient ID: ${patient.id}`);
  line(`Initials / Identifier: ${patient.initials} / ${patient.identifier}`);
  line(`Care Status: ${patient.care_status}`);
  if (patient.start_datetime) {
    line(`Activated: ${formatDisplay(toDate(patient.start_datetime))}`);
  }
  line(`Admitted: ${formatDisplay(admitted)}`);
  line(`Delivered: ${formatDisplay(delivered)}`);
  if (patient.discharge_datetime) {
    line(`Discharged: ${formatDisplay(toDate(patient.discharge_datetime))}`);
  }

  doc.moveDown();
  line('Optimized Billing', { bold: true, size: 12 });
  doc.moveDown(0.5);

  doc.font('Helvetica-Bold').text('Time', 40, doc.y, { continued: true });
  doc.text('Code', 180, doc.y, { continued: true });
  doc.text('Modifier', 240, doc.y, { continued: true });
  doc.text('Doctor', 320, doc.y);
  doc.font('Helvetica');

  recommendations.forEach((rec) => {
    if (doc.y > doc.page.height - 60) {
      doc.addPage();
      doc.font('Helvetica-Bold').text('Time', 40, doc.y, { continued: true });
      doc.text('Code', 180, doc.y, { continued: true });
      doc.text('Modifier', 240, doc.y, { continued: true });
      doc.text('Doctor', 320, doc.y);
      doc.font('Helvetica');
    }
    const doctorName = rec.doctor ? `Dr. ${rec.doctor.name}` : '-';
    doc.text(formatDisplay(rec.time), 40, doc.y, { continued: true });
    doc.text(rec.code, 180, doc.y, { continued: true });
    doc.text(rec.modifier || '-', 240, doc.y, { continued: true });
    doc.text(doctorName, 320, doc.y);
  });

  doc.end();
});

router.get('/patients/:pid/confirmed_pdf', requireLogin, (req, res) => {
  const pid = parseInt(req.params.pid, 10);
  const patient = dbGet('SELECT * FROM patients WHERE id = ?', [pid]);
  if (!patient) {
    return res.redirect('/?view=archived');
  }

  let confirmed = dbAll(
    `SELECT c.*, d.name as doctor_name
     FROM confirmed_billings c
     LEFT JOIN doctors d ON c.doctor_id = d.id
     WHERE c.patient_id = ?
     ORDER BY c.timestamp`,
    [pid]
  );

  if (!confirmed.length) {
    const admitted = toDate(patient.care_admitted_at);
    const delivered = toDate(patient.care_delivered_at);
    if (!admitted || !delivered || admitted >= delivered) {
      return res.redirect('/?view=archived');
    }
    const startPoint = toDate(patient.start_datetime) || admitted;
    const triageEvents = dbAll(
      'SELECT occurred_at FROM patient_status_events WHERE patient_id = ? AND status = ?',
      [pid, 'Triage']
    );
    let triageWindowEnd = delivered;
    triageEvents.forEach((event) => {
      const eventTime = toDate(event.occurred_at);
      if (eventTime && delivered && eventTime > delivered) {
        triageWindowEnd = !triageWindowEnd || eventTime > triageWindowEnd ? eventTime : triageWindowEnd;
      }
    });
    if (patient.second_triage_at) {
      const legacy = toDate(patient.second_triage_at);
      if (legacy && delivered && legacy > delivered) {
        triageWindowEnd = !triageWindowEnd || legacy > triageWindowEnd ? legacy : triageWindowEnd;
      }
    }
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
      return res.redirect('/?view=archived');
    }
    confirmed = recommendations.map((rec) => ({
      timestamp: formatLocalDateTime(rec.time),
      code: rec.code,
      modifier: rec.modifier || '',
      doctor_name: rec.doctor ? rec.doctor.name : null,
    }));
  }

  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', `attachment; filename=patient_${patient.id}_confirmed.pdf`);

  const doc = new PDFDocument({ margin: 40 });
  doc.pipe(res);

  const line = (text, opts = {}) => {
    const { bold = false, size = 11 } = opts;
    doc.font(bold ? 'Helvetica-Bold' : 'Helvetica').fontSize(size).text(text, { continued: false });
  };

  line('Patient Billing Summary', { bold: true, size: 13 });
  line(`Patient ID: ${patient.id}`);
  line(`Initials / Identifier: ${patient.initials} / ${patient.identifier}`);
  line(`Care Status: ${patient.care_status}`);
  if (patient.start_datetime) {
    line(`Activated: ${formatDisplay(toDate(patient.start_datetime))}`);
  }
  if (patient.care_admitted_at) {
    line(`Admitted: ${formatDisplay(toDate(patient.care_admitted_at))}`);
  }
  if (patient.care_delivered_at) {
    line(`Delivered: ${formatDisplay(toDate(patient.care_delivered_at))}`);
  }
  if (patient.discharge_datetime) {
    line(`Discharged: ${formatDisplay(toDate(patient.discharge_datetime))}`);
  }
  if (patient.billing_note) {
    doc.moveDown(0.5);
    line('Billing Notes:', { bold: true, size: 11 });
    doc.font('Helvetica').fontSize(10).text(patient.billing_note, { width: 520 });
  }

  doc.moveDown();
  line('Confirmed Billing', { bold: true, size: 12 });
  doc.moveDown(0.5);

  doc.font('Helvetica-Bold').text('Time', 40, doc.y, { continued: true });
  doc.text('Code', 180, doc.y, { continued: true });
  doc.text('Modifier', 240, doc.y, { continued: true });
  doc.text('Doctor', 320, doc.y);
  doc.font('Helvetica');

  confirmed.forEach((billing) => {
    if (doc.y > doc.page.height - 60) {
      doc.addPage();
      doc.font('Helvetica-Bold').text('Time', 40, doc.y, { continued: true });
      doc.text('Code', 180, doc.y, { continued: true });
      doc.text('Modifier', 240, doc.y, { continued: true });
      doc.text('Doctor', 320, doc.y);
      doc.font('Helvetica');
    }
    const doctorName = billing.doctor_name ? `Dr. ${billing.doctor_name}` : '-';
    doc.text(formatDisplay(toDate(billing.timestamp)), 40, doc.y, { continued: true });
    doc.text(billing.code, 180, doc.y, { continued: true });
    doc.text(billing.modifier || '-', 240, doc.y, { continued: true });
    doc.text(doctorName, 320, doc.y);
  });

  doc.end();
});

router.post('/patients/:pid/timeline', requireLogin, (req, res) => {
  const pid = parseInt(req.params.pid, 10);
  const patient = dbGet('SELECT * FROM patients WHERE id = ?', [pid]);
  if (!patient || patient.status !== 'active') {
    return res.redirect('/?view=active');
  }

  const parseOptional = (dateStr, timeStr) => {
    const dateVal = (dateStr || '').trim();
    if (!dateVal) return null;
    return parseDateTime(dateVal, (timeStr || '').trim());
  };

  const triageInput = (req.body.triage_date || '').trim();
  const admittedInput = (req.body.admitted_date || '').trim();
  const deliveredInput = (req.body.delivered_date || '').trim();
  const dischargedInput = (req.body.discharged_date || '').trim();

  const triageDt = triageInput
    ? parseOptional(triageInput, req.body.triage_time)
    : (patient.start_datetime ? toDate(patient.start_datetime) : null);
  const admittedDt = admittedInput
    ? parseOptional(admittedInput, req.body.admitted_time)
    : (patient.care_admitted_at ? toDate(patient.care_admitted_at) : null);
  const deliveredDt = deliveredInput
    ? parseOptional(deliveredInput, req.body.delivered_time)
    : (patient.care_delivered_at ? toDate(patient.care_delivered_at) : null);
  const dischargedDt = dischargedInput
    ? parseOptional(dischargedInput, req.body.discharged_time)
    : (patient.discharge_datetime ? toDate(patient.discharge_datetime) : null);

  let careStatus = 'Triage';
  if (admittedDt) careStatus = 'Admitted';
  if (deliveredDt) careStatus = 'Delivered';
  if (dischargedDt) careStatus = 'Discharged';

  const updates = {
    start_datetime: triageDt ? formatLocalDateTime(triageDt) : null,
    care_admitted_at: admittedDt ? formatLocalDateTime(admittedDt) : null,
    care_delivered_at: deliveredDt ? formatLocalDateTime(deliveredDt) : null,
    discharge_datetime: dischargedDt ? formatLocalDateTime(dischargedDt) : null,
    care_status: careStatus,
    status: careStatus === 'Discharged' ? 'discharged' : 'active',
  };

  dbRun(
    `UPDATE patients
     SET start_datetime = ?, care_admitted_at = ?, care_delivered_at = ?, discharge_datetime = ?,
         care_status = ?, status = ?
     WHERE id = ?`,
    [
      updates.start_datetime,
      updates.care_admitted_at,
      updates.care_delivered_at,
      updates.discharge_datetime,
      updates.care_status,
      updates.status,
      pid,
    ]
  );

  if (careStatus === 'Discharged') {
    optimizeBillings(pid);
  }

  return res.redirect(`/?view=active&selected_patient=${pid}`);
});

router.post('/patients/:pid/status_events', requireLogin, (req, res) => {
  const pid = parseInt(req.params.pid, 10);
  const patient = dbGet('SELECT * FROM patients WHERE id = ?', [pid]);
  if (!patient || patient.status !== 'active') {
    return res.redirect('/?view=active');
  }

  const status = (req.body.status_event || '').trim();
  const afterStatus = (req.body.status_after || '').trim();
  const eventDate = (req.body.status_date || '').trim();
  const eventTime = (req.body.status_time || '').trim();

  if (!eventDate || !status) {
    return res.redirect(`/?view=active&selected_patient=${pid}`);
  }

  const eventDt = parseDateTime(eventDate, eventTime);
  const inductionNst = status === 'Induction' && req.body.induction_nst ? 1 : 0;
  const shiftDoctor = getShiftDoctor();
  dbRun(
    `INSERT INTO patient_status_events
     (patient_id, status, occurred_at, after_status, induction_non_stress_test, doctor_id)
     VALUES (?, ?, ?, ?, ?, ?)`,
    [pid, status, formatLocalDateTime(eventDt), afterStatus || null, inductionNst, shiftDoctor ? shiftDoctor.id : null]
  );

  return res.redirect(`/?view=active&selected_patient=${pid}`);
});

router.post('/patients/:pid/status_events/:eventId/induction_nst', requireLogin, (req, res) => {
  const pid = parseInt(req.params.pid, 10);
  const eventId = parseInt(req.params.eventId, 10);
  if (Number.isNaN(pid) || Number.isNaN(eventId)) {
    return res.redirect('/?view=active');
  }
  const event = dbGet(
    'SELECT * FROM patient_status_events WHERE id = ? AND patient_id = ?',
    [eventId, pid]
  );
  if (!event || event.status !== 'Induction') {
    return res.redirect(`/?view=active&selected_patient=${pid}`);
  }
  const enabled = req.body.induction_nst ? 1 : 0;
  dbRun(
    'UPDATE patient_status_events SET induction_non_stress_test = ? WHERE id = ?',
    [enabled, eventId]
  );
  return res.redirect(`/?view=active&selected_patient=${pid}`);
});

module.exports = router;
