const express = require('express');
const PDFDocument = require('pdfkit');
const { dbGet, dbAll, dbRun } = require('../db');
const {
  requireLogin,
  toDate,
  formatDisplay,
  formatDate,
  formatLocalDateTime,
  getShiftWindowsForRange,
  optimizeBillings,
} = require('../services/helpers');
const { buildOptimizedBillings, buildBabyBillings } = require('../services/rules');

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
    const patient = dbGet(
      `SELECT * FROM patients
       WHERE id = ? AND status = ?
         AND (patient_type IS NULL OR patient_type != 'baby')`,
      [patientId, 'active']
    );
    if (patient) {
      req.session[sessionKey] = patient.id;
      return patient;
    }
  }

  const fallback = dbGet(
    `SELECT * FROM patients
     WHERE status = ? AND (patient_type IS NULL OR patient_type != 'baby')
     ORDER BY id LIMIT 1`,
    ['active']
  );
  if (fallback) {
    req.session[sessionKey] = fallback.id;
  }
  return fallback || null;
};

const TIME_MODIFIERS = new Set(['COINPT', 'EV', 'WK', 'NTPM', 'NTAM']);
const AA_MODIFIERS = ['TEV', 'TWK', 'TNTP', 'TNTA', 'TST', 'TDES'];
const TRIAGE_BASE_CODES = new Set(['03.03BZ', '03.05F', '03.05FA', '03.05FB']);
const TRIAGE_ASSOC_CODES = new Set(['03.03KA', '03.03LA', '03.03MC', '03.03MD', '87.54A', '13.99BE']);
const INDUCTION_CODES = new Set(['85.5A', '87.54A']);
const DELIVERY_BASE_CODES = new Set(['87.98A', '87.98B', '87.98C']);
const DELIVERY_ASSOC_CODES = new Set(['87.99A', '84.21', '87.89B', '85.69B', '87.6']);

const parseModifierParts = (modifier) => {
  if (!modifier) return [];
  return modifier
    .split(',')
    .map((part) => part.trim())
    .filter((part) => part);
};

const extractCountsFromModifier = (modifier) => {
  const counts = {};
  AA_MODIFIERS.forEach((key) => { counts[key] = ''; });
  parseModifierParts(modifier).forEach((part) => {
    const match = part.match(/^(TEV|TWK|TNTP|TNTA|TST|TDES)\s+(\d+)/i);
    if (match) {
      const key = match[1].toUpperCase();
      counts[key] = String(parseInt(match[2], 10));
    }
  });
  return counts;
};

const sameMinute = (a, b) => {
  if (!a || !b) return false;
  return formatLocalDateTime(a) === formatLocalDateTime(b);
};

const nearestTime = (target, candidates) => {
  if (!target || !candidates || !candidates.length) return null;
  let best = candidates[0];
  let bestDelta = Math.abs(target - best);
  for (let i = 1; i < candidates.length; i += 1) {
    const delta = Math.abs(target - candidates[i]);
    if (delta < bestDelta) {
      best = candidates[i];
      bestDelta = delta;
    }
  }
  return best;
};

const diagnosticLookupKey = (doctorId, patientKey, dateOfService, billingCode, encounterNumber) => {
  return `${doctorId}|${patientKey}|${dateOfService}|${billingCode}|${encounterNumber}`;
};

const callOverrideLookupKey = (doctorId, patientKey, dateOfService, billingCode, encounterNumber) => {
  return `${doctorId}|${patientKey}|${dateOfService}|${billingCode}|${encounterNumber}`;
};

const loadDiagnosticCodeMap = (doctorId) => {
  const map = new Map();
  if (!doctorId) return map;
  const rows = dbAll(
    `SELECT * FROM diagnostic_codes WHERE doctor_id = ?`,
    [doctorId]
  );
  rows.forEach((row) => {
    const key = diagnosticLookupKey(
      row.doctor_id,
      row.patient_key,
      row.date_of_service,
      row.billing_code,
      row.encounter_number
    );
    map.set(key, row.diagnostic_code);
  });
  return map;
};

const loadCallOverrideMap = (doctorId) => {
  const map = new Map();
  if (!doctorId) return map;
  const rows = dbAll(
    `SELECT * FROM billing_call_overrides WHERE doctor_id = ?`,
    [doctorId]
  );
  rows.forEach((row) => {
    const key = callOverrideLookupKey(
      row.doctor_id,
      row.patient_key,
      row.date_of_service,
      row.billing_code,
      row.encounter_number
    );
    map.set(key, row.number_of_calls);
  });
  return map;
};

const calculateSurgicalAssistCalls = (entry) => {
  const start = entry && entry.time ? entry.time : null;
  const end = entry && entry.end_time ? toDate(entry.end_time) : null;
  if (!start || !end || end <= start) return 1;
  const minutes = Math.round((end - start) / (60 * 1000));
  if (minutes < 60) return 1;
  return 1 + Math.floor((minutes - 60) / 15) + 1;
};

const calculateDeliveryDetentionCalls = (entry) => {
  const start = entry && entry.time ? entry.time : null;
  const end = entry && entry.end_time ? toDate(entry.end_time) : null;
  if (!start || !end || end <= start) return 0;
  const minutes = Math.round((end - start) / (60 * 1000));
  if (minutes < 30) return 0;
  return Math.floor((minutes - 30) / 15) + 1;
};

const summarizeBillingsForGrid = (
  entries,
  patientLookup,
  diagnosticCodeMap = new Map(),
  callOverrideMap = new Map()
) => {
  const byDoctor = new Map();
  entries.forEach((entry) => {
    const doctorId = entry.doctor ? entry.doctor.id : 'unknown';
    if (!byDoctor.has(doctorId)) {
      byDoctor.set(doctorId, {
        doctor: entry.doctor || { id: 'unknown', name: 'Unknown' },
        entries: [],
      });
    }
    byDoctor.get(doctorId).entries.push(entry);
  });

  const tables = [];
  byDoctor.forEach((group) => {
    const sorted = group.entries.slice().sort((a, b) => a.time - b.time);
    const shiftAnchor = sorted.length ? sorted[0].time : null;
    const shiftDate = shiftAnchor ? formatDate(shiftAnchor) : '';
    const shiftDay = shiftAnchor ? shiftAnchor.toLocaleDateString('en-US', { weekday: 'long' }) : '';
    const shiftHour = shiftAnchor ? shiftAnchor.getHours() + shiftAnchor.getMinutes() / 60 : 0;
    const shiftType = shiftAnchor && (shiftHour < 7 || shiftHour >= 19) ? 'Night' : 'Day';

    const rows = [];
    const entriesByPatient = new Map();
    sorted.forEach((entry) => {
      const patientId = entry.patientId;
      if (!entriesByPatient.has(patientId)) {
        entriesByPatient.set(patientId, []);
      }
      entriesByPatient.get(patientId).push(entry);
    });

    entriesByPatient.forEach((patientEntries, patientId) => {
      const patient = patientLookup.get(patientId);
      const patientKey = patientId === null || patientId === undefined ? 'na' : String(patientId);
      const patientIdentifier = patientId === null || patientId === undefined
        ? 'N/A'
        : (patient ? patient.identifier : `Patient ${patientId}`);
      const sortedEntries = patientEntries.slice().sort((a, b) => a.time - b.time);
      const byDay = new Map();
      sortedEntries.forEach((entry) => {
        const key = formatDate(entry.time);
        if (!byDay.has(key)) byDay.set(key, []);
        byDay.get(key).push(entry);
      });

      const dayKeys = Array.from(byDay.keys()).sort();
      dayKeys.forEach((dayKey) => {
        const dayEntries = byDay.get(dayKey).slice().sort((a, b) => a.time - b.time);
        const groups = [];
        const activeByCode = new Map();
        const jaEntries = [];

        dayEntries.forEach((entry) => {
          const code = entry.code;
          if (code === '13.99JA') {
            jaEntries.push(entry);
            return;
          }
          if (entry._group_key) {
            groups.push({
              code,
              entries: [entry],
              startTime: entry.time,
              lastTime: entry.time,
              _encounter_key: `other|${entry._group_key}`,
            });
            return;
          }
          const existing = activeByCode.get(code);
          const contiguous = existing
            && entry.time - existing.lastTime === 15 * 60 * 1000;
          if (existing && contiguous) {
            existing.entries.push(entry);
            existing.lastTime = entry.time;
            return;
          }
          const groupEntry = {
            code,
            entries: [entry],
            startTime: entry.time,
            lastTime: entry.time,
          };
          groups.push(groupEntry);
          activeByCode.set(code, groupEntry);
        });

        if (jaEntries.length) {
          const sortedJa = jaEntries.slice().sort((a, b) => a.time - b.time);
          const attendedJa = sortedJa.filter((entry) => (entry.modifier || '').trim() !== '');
          const ghostJaCount = sortedJa.length - attendedJa.length;
          if (attendedJa.length) {
            attendedJa.forEach((entry, idx) => {
              groups.push({
                code: '13.99JA',
                entries: [entry],
                startTime: entry.time,
                lastTime: entry.time,
                _encounter_key: `ja|${formatLocalDateTime(entry.time)}|${idx}`,
                _calls: idx === 0 ? (1 + ghostJaCount) : 1,
              });
            });
          } else {
            groups.push({
              code: '13.99JA',
              entries: sortedJa,
              startTime: sortedJa[0].time,
              lastTime: sortedJa[sortedJa.length - 1].time,
              _encounter_key: `ja|${dayKey}|fallback`,
              _calls: sortedJa.length || 1,
            });
          }
        }

        const sortedGroups = groups.slice().sort((a, b) => a.startTime - b.startTime);
        const triageAnchors = sortedGroups
          .filter((g) => TRIAGE_BASE_CODES.has(g.code))
          .map((g) => g.startTime);
        const inductionAnchors = sortedGroups
          .filter((g) => g.code === '85.5A')
          .map((g) => g.startTime);
        const deliveryAnchors = sortedGroups
          .filter((g) => DELIVERY_BASE_CODES.has(g.code))
          .map((g) => g.startTime);

        const encounterKeyByGroup = new Map();
        sortedGroups.forEach((groupEntry) => {
          const code = groupEntry.code;
          const timeKey = formatLocalDateTime(groupEntry.startTime);
          let encounterKey = `default|${code}|${timeKey}`;

          if (code === '13.99JA') {
            encounterKey = groupEntry._encounter_key || `ja|${dayKey}|${timeKey}`;
          } else if (DELIVERY_BASE_CODES.has(code)) {
            encounterKey = `delivery|${timeKey}`;
          } else if (DELIVERY_ASSOC_CODES.has(code)) {
            const sameTimeDelivery = deliveryAnchors.find((t) => sameMinute(t, groupEntry.startTime));
            const deliveryAnchor = sameTimeDelivery || nearestTime(groupEntry.startTime, deliveryAnchors);
            encounterKey = deliveryAnchor
              ? `delivery|${formatLocalDateTime(deliveryAnchor)}`
              : `delivery|${timeKey}`;
          } else if (code === '85.5A') {
            encounterKey = `induction|${timeKey}`;
          } else if (code === '87.54A' && inductionAnchors.some((t) => sameMinute(t, groupEntry.startTime))) {
            const anchor = inductionAnchors.find((t) => sameMinute(t, groupEntry.startTime));
            encounterKey = `induction|${formatLocalDateTime(anchor)}`;
          } else if (TRIAGE_BASE_CODES.has(code)) {
            encounterKey = `triage|${timeKey}`;
          } else if (TRIAGE_ASSOC_CODES.has(code)) {
            const sameTimeTriage = triageAnchors.find((t) => sameMinute(t, groupEntry.startTime));
            const triageAnchor = sameTimeTriage || nearestTime(groupEntry.startTime, triageAnchors);
            encounterKey = triageAnchor
              ? `triage|${formatLocalDateTime(triageAnchor)}`
              : `triage|${timeKey}`;
          }

          encounterKeyByGroup.set(groupEntry, encounterKey);
        });

        const encounterOrder = [];
        const seenEncounter = new Set();
        sortedGroups.forEach((groupEntry) => {
          const key = encounterKeyByGroup.get(groupEntry);
          if (!seenEncounter.has(key)) {
            seenEncounter.add(key);
            encounterOrder.push(key);
          }
        });
        const encounterNumberByKey = new Map();
        encounterOrder.forEach((key, idx) => encounterNumberByKey.set(key, idx + 1));

        sortedGroups.forEach((groupEntry) => {
          const encounterNumber = encounterNumberByKey.get(encounterKeyByGroup.get(groupEntry));
          let numberOfCalls = groupEntry.code === '13.99JA'
            ? (groupEntry._calls || 1)
            : 1;
          const modifierParts = groupEntry.entries.flatMap((e) => parseModifierParts(e.modifier));
          const modifierSet = new Set(modifierParts.map((part) => part.toUpperCase()));
          let timeModifier = '';
          let cmgpModifier = '';
          let bmiModifier = '';

          modifierParts.forEach((part) => {
            const upper = part.toUpperCase();
            if (!timeModifier && TIME_MODIFIERS.has(upper)) {
              timeModifier = upper;
            }
            if (!bmiModifier && upper === 'BMIPRO') {
              bmiModifier = 'BMIPRO';
            }
            const cmgpMatch = upper.match(/^CMGP(\d+)/);
            if (cmgpMatch) {
              cmgpModifier = cmgpMatch[1];
            }
          });
          const explicitCmgp = groupEntry.entries.find((e) => e.cmgp_modifier);
          if (explicitCmgp && explicitCmgp.cmgp_modifier) {
            cmgpModifier = explicitCmgp.cmgp_modifier.replace(/^CMGP/i, '');
          }

          const firstEntry = groupEntry.entries[0];
          const aaCounts = groupEntry.code === '03.01AA'
            ? extractCountsFromModifier(firstEntry.modifier || '')
            : {};
          if (groupEntry.code === '03.01AA') {
            const countTotal = AA_MODIFIERS.reduce((sum, key) => {
              const val = parseInt(aaCounts[key], 10);
              return sum + (Number.isNaN(val) ? 0 : val);
            }, 0);
            if (countTotal > 0) {
              numberOfCalls = countTotal;
            }
          }
          if (groupEntry.code === '86.9D SA') {
            numberOfCalls = Math.max(1, calculateSurgicalAssistCalls(firstEntry));
          }
          if (groupEntry.code === '87.98E') {
            numberOfCalls = Math.max(1, calculateDeliveryDetentionCalls(firstEntry));
          }

          if (groupEntry.code === '03.01AA') {
            timeModifier = '';
            cmgpModifier = '';
            bmiModifier = '';
          } else if (modifierSet.has('COINPT')) {
            timeModifier = 'COINPT';
          }

          const dateOfService = formatDate(groupEntry.startTime);
          const diagKey = diagnosticLookupKey(
            group.doctor && group.doctor.id ? group.doctor.id : 'unknown',
            patientKey,
            dateOfService,
            groupEntry.code,
            encounterNumber
          );
          const diagnosticCode = diagnosticCodeMap.get(diagKey) || '';
          const callKey = callOverrideLookupKey(
            group.doctor && group.doctor.id ? group.doctor.id : 'unknown',
            patientKey,
            dateOfService,
            groupEntry.code,
            encounterNumber
          );
          if (groupEntry.code === '87.89B') {
            const overrideCalls = parseInt(callOverrideMap.get(callKey), 10);
            if (!Number.isNaN(overrideCalls) && overrideCalls > 0) {
              numberOfCalls = overrideCalls;
            }
          }
          rows.push({
            doctor_id: group.doctor && group.doctor.id ? group.doctor.id : '',
            patient_id: patientId === null || patientId === undefined ? '' : patientId,
            patient_key: patientKey,
            patient_identifier: patientIdentifier,
            date_of_service: dateOfService,
            diagnostic_code: diagnosticCode,
            billing_code: groupEntry.code,
            number_of_calls: numberOfCalls,
            encounter_number: encounterNumber,
            modifier: timeModifier,
            cmgp_modifier: cmgpModifier,
            bmi_modifier: bmiModifier,
            aa_counts: aaCounts,
          });
        });
      });
    });

    tables.push({
      doctor: group.doctor,
      shift_date: shiftDate,
      shift_day: shiftDay,
      shift_type: shiftAnchor ? shiftType : '',
      rows,
    });
  });

  return tables;
};

const otherBillingsForPatient = (patientId) => {
  if (!patientId) return [];
  const rows = dbAll(
    `SELECT o.*, d.name as doctor_name
     FROM other_billings o
     LEFT JOIN doctors d ON o.doctor_id = d.id
     WHERE o.patient_id = ?
     ORDER BY o.start_time`,
    [patientId]
  );
  return rows.map((row) => ({
    time: toDate(row.start_time),
    code: row.code,
    modifier: row.modifier || '',
    doctor: row.doctor_id ? { id: row.doctor_id, name: row.doctor_name } : null,
    cmgp_modifier: row.cmgp_modifier || '',
    action: row.action || '',
    end_time: row.end_time || null,
    _group_key: row.id ? `other-${row.id}` : '',
  }));
};

const otherBillingsForDoctorWindow = (doctorId, window) => {
  if (!doctorId || !window) return [];
  const rows = dbAll(
    `SELECT o.*, d.name as doctor_name
     FROM other_billings o
     LEFT JOIN doctors d ON o.doctor_id = d.id
     WHERE o.doctor_id = ? AND o.start_time >= ? AND o.start_time < ?
     ORDER BY o.start_time`,
    [doctorId, window.start_datetime, window.end_datetime]
  );
  return rows.map((row) => ({
    time: toDate(row.start_time),
    code: row.code,
    modifier: row.modifier || '',
    doctor: row.doctor_id ? { id: row.doctor_id, name: row.doctor_name } : null,
    cmgp_modifier: row.cmgp_modifier || '',
    patientId: row.patient_id || null,
    action: row.action || '',
    end_time: row.end_time || null,
    _group_key: row.id ? `other-${row.id}` : '',
  }));
};

const buildDoctorOptimizationTables = (doctorId, cutoffStr, diagnosticCodeMap = new Map(), callOverrideMap = new Map(), windowId = null) => {
  const allEntries = [];
  let doctorWindows = [];
  if (windowId !== null && windowId !== undefined) {
    doctorWindows = dbAll(
      `SELECT start_datetime, end_datetime, doctor_id FROM shift_windows
       WHERE id = ? AND doctor_id = ?`,
      [windowId, doctorId]
    );
  } else {
    doctorWindows = dbAll(
      `SELECT start_datetime, end_datetime, doctor_id FROM shift_windows
       WHERE doctor_id = ? AND end_datetime >= ?`,
      [doctorId, cutoffStr]
    );
  }

  const attendedIds = new Set();
  doctorWindows.forEach((window) => {
    if (!window.start_datetime || !window.end_datetime) return;
    const rows = dbAll(
      `SELECT DISTINCT patient_id FROM shift_slots
       WHERE doctor_id = ? AND start_time >= ? AND start_time < ?
         AND patient_id IS NOT NULL`,
      [doctorId, window.start_datetime, window.end_datetime]
    );
    rows.forEach((row) => {
      if (row && row.patient_id) attendedIds.add(row.patient_id);
    });
    const otherRecs = otherBillingsForDoctorWindow(doctorId, window);
    otherRecs.forEach((rec) => allEntries.push(rec));
  });

  const patientIds = Array.from(attendedIds);
  const patients = patientIds.length
    ? dbAll(`SELECT * FROM patients WHERE id IN (${patientIds.map(() => '?').join(',')})`, patientIds)
    : [];
  const patientLookup = new Map(patients.map((patient) => [patient.id, patient]));

  patients.forEach((patient) => {
    if (patient.patient_type === 'baby') {
      const babyBillings = buildBabyBillings(patient);
      babyBillings.forEach((rec) => allEntries.push({ ...rec, patientId: patient.id }));
      return;
    }
    const admitted = toDate(patient.care_admitted_at);
    const delivered = toDate(patient.care_delivered_at);
    if (!admitted || !delivered || admitted >= delivered) return;
    const startPoint = toDate(patient.start_datetime) || admitted;
    const triageWindowEnd = getTriageWindowEnd(patient, delivered);
    const patientSlots = dbAll(
      `SELECT * FROM shift_slots
       WHERE patient_id = ? AND start_time >= ? AND start_time <= ?
       ORDER BY start_time`,
      [patient.id, formatLocalDateTime(startPoint), formatLocalDateTime(triageWindowEnd)]
    );
    const activeShiftWindows = getShiftWindowsForRange(admitted, delivered);
    const recs = buildOptimizedBillings(patient, patientSlots, activeShiftWindows);
    recs.forEach((rec) => allEntries.push({ ...rec, patientId: patient.id }));
  });

  return summarizeBillingsForGrid(allEntries, patientLookup, diagnosticCodeMap, callOverrideMap)
    .filter((table) => table.doctor && table.doctor.id === doctorId);
};

router.get('/optimization', requireLogin, (req, res) => {
  const viewMode = (req.query.view_mode || 'patient').toLowerCase();
  const isDoctorView = viewMode === 'doctor';
  const activePatients = dbAll(
    `SELECT * FROM patients
     WHERE status = ? AND (patient_type IS NULL OR patient_type != 'baby')
     ORDER BY id`,
    ['active']
  );
  let selectedPatient = isDoctorView ? null : getSelectedPatient(req);
  let recentDoctors = [];
  let selectedDoctor = null;

  let recommendations = [];
  let babyRecommendations = [];
  let babyPatient = null;
  let summaryTables = [];
  let optimizationError = req.query.opt_error || '';
  const optimizationNotes = [];
  let doctorBillingsLocked = false;

  if (selectedPatient) {
    babyPatient = dbGet(
      'SELECT * FROM patients WHERE parent_patient_id = ? AND patient_type = ? ORDER BY id LIMIT 1',
      [selectedPatient.id, 'baby']
    );
    if (babyPatient && !babyPatient.baby_resuscitation) {
      const deliverySlot = dbGet(
        `SELECT delivery_resuscitation FROM shift_slots
         WHERE patient_id = ? AND action = ?
         ORDER BY start_time
         LIMIT 1`,
        [selectedPatient.id, 'delivery']
      );
      if (deliverySlot && deliverySlot.delivery_resuscitation) {
        babyPatient.baby_resuscitation = 1;
      }
    }
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
          optimizationNotes.push(`13.99JA billed for up to 12 weighted slots within the active shift window; unmodified entries are allowed before the first attended time, and none are billed within ${DELIVERY_BUFFER_MINUTES} minutes before delivery.`);
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
    if (babyPatient) {
      babyRecommendations = buildBabyBillings(babyPatient);
    }
    const momOtherBillings = otherBillingsForPatient(selectedPatient.id);
    const babyOtherBillings = babyPatient ? otherBillingsForPatient(babyPatient.id) : [];
    if (momOtherBillings.length) {
      recommendations = recommendations.concat(momOtherBillings).sort((a, b) => a.time - b.time);
    }
    if (babyOtherBillings.length) {
      babyRecommendations = babyRecommendations.concat(babyOtherBillings).sort((a, b) => a.time - b.time);
    }
    const allEntries = [];
      recommendations.forEach((rec) => {
        allEntries.push({ ...rec, patientId: selectedPatient.id });
      });
    if (babyPatient) {
      babyRecommendations.forEach((rec) => {
        allEntries.push({ ...rec, patientId: babyPatient.id });
      });
    }
    const patientLookup = new Map();
    patientLookup.set(selectedPatient.id, selectedPatient);
    if (babyPatient) {
      patientLookup.set(babyPatient.id, babyPatient);
    }
    summaryTables = summarizeBillingsForGrid(allEntries, patientLookup);
  }

  if (isDoctorView) {
    const cutoff = new Date(Date.now() - 4 * 24 * 60 * 60 * 1000);
    const cutoffStr = formatLocalDateTime(cutoff);
    recentDoctors = dbAll(
      `SELECT DISTINCT d.id, d.name, d.is_on_shift
       FROM shift_windows w
       LEFT JOIN doctors d ON w.doctor_id = d.id
       WHERE w.end_datetime >= ? AND w.doctor_id IS NOT NULL
       ORDER BY d.name`,
      [cutoffStr]
    ).filter((row) => row && row.id);

    const sessionKey = 'last_optimization_doctor';
    let doctorId = parseInt(req.query.selected_doctor || req.session[sessionKey], 10);
    if (!Number.isNaN(doctorId)) {
      selectedDoctor = recentDoctors.find((doc) => doc.id === doctorId)
        || dbGet('SELECT * FROM doctors WHERE id = ?', [doctorId]);
    }
    if (!selectedDoctor && recentDoctors.length) {
      selectedDoctor = recentDoctors[0];
    }
    if (selectedDoctor) {
      req.session[sessionKey] = selectedDoctor.id;
      const diagnosticCodeMap = loadDiagnosticCodeMap(selectedDoctor.id);
      const callOverrideMap = loadCallOverrideMap(selectedDoctor.id);
      summaryTables = buildDoctorOptimizationTables(selectedDoctor.id, cutoffStr, diagnosticCodeMap, callOverrideMap);
      doctorBillingsLocked = Number(selectedDoctor.is_on_shift) !== 1;
    }
  }

  return res.render('optimization', {
    session: req.session,
    active_patients: activePatients,
    selected_patient: selectedPatient,
    recommendations,
    baby_patient: babyPatient,
    baby_recommendations: babyRecommendations,
    summary_tables: summaryTables,
    view_mode: viewMode,
    recent_doctors: recentDoctors,
    selected_doctor: selectedDoctor,
    doctor_billings_locked: doctorBillingsLocked,
    optimization_error: optimizationError,
    optimization_notes: optimizationNotes,
    format_display: formatDisplay,
  });
});

router.post('/optimization/diagnostic_code', requireLogin, (req, res) => {
  const doctorId = parseInt(req.body.doctor_id, 10);
  const patientIdRaw = (req.body.patient_id || '').trim();
  const patientKey = (req.body.patient_key || '').trim() || 'na';
  const dateOfService = (req.body.date_of_service || '').trim();
  const billingCode = (req.body.billing_code || '').trim();
  const encounterNumber = parseInt(req.body.encounter_number, 10);
  const codeRaw = (req.body.diagnostic_code || '').trim();

  if (Number.isNaN(doctorId) || Number.isNaN(encounterNumber) || !dateOfService || !billingCode) {
    return res.redirect('/optimization?view_mode=doctor');
  }
  const doctor = dbGet('SELECT id, is_on_shift FROM doctors WHERE id = ?', [doctorId]);
  if (!doctor || Number(doctor.is_on_shift) !== 1) {
    return res.redirect(`/optimization?view_mode=doctor&selected_doctor=${doctorId}`);
  }

  if (!/^\d{3}$/.test(codeRaw)) {
    return res.redirect(`/optimization?view_mode=doctor&selected_doctor=${doctorId}`);
  }
  const codeNum = parseInt(codeRaw, 10);
  if (codeNum < 1 || codeNum > 999) {
    return res.redirect(`/optimization?view_mode=doctor&selected_doctor=${doctorId}`);
  }
  const normalizedCode = String(codeNum).padStart(3, '0');
  const patientId = patientIdRaw ? parseInt(patientIdRaw, 10) : null;

  const existing = dbGet(
    `SELECT id FROM diagnostic_codes
     WHERE doctor_id = ? AND patient_key = ? AND date_of_service = ? AND billing_code = ? AND encounter_number = ?`,
    [doctorId, patientKey, dateOfService, billingCode, encounterNumber]
  );
  if (existing && existing.id) {
    dbRun(
      `UPDATE diagnostic_codes
       SET patient_id = ?, diagnostic_code = ?, updated_at = ?
       WHERE id = ?`,
      [
        Number.isNaN(patientId) ? null : patientId,
        normalizedCode,
        formatLocalDateTime(new Date()),
        existing.id,
      ]
    );
  } else {
    dbRun(
      `INSERT INTO diagnostic_codes
       (doctor_id, patient_id, patient_key, date_of_service, billing_code, encounter_number, diagnostic_code, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        doctorId,
        Number.isNaN(patientId) ? null : patientId,
        patientKey,
        dateOfService,
        billingCode,
        encounterNumber,
        normalizedCode,
        formatLocalDateTime(new Date()),
      ]
    );
  }

  return res.redirect(`/optimization?view_mode=doctor&selected_doctor=${doctorId}`);
});

router.post('/optimization/number_of_calls', requireLogin, (req, res) => {
  const doctorId = parseInt(req.body.doctor_id, 10);
  const patientIdRaw = (req.body.patient_id || '').trim();
  const patientKey = (req.body.patient_key || '').trim() || 'na';
  const dateOfService = (req.body.date_of_service || '').trim();
  const billingCode = (req.body.billing_code || '').trim();
  const encounterNumber = parseInt(req.body.encounter_number, 10);
  const callsRaw = (req.body.number_of_calls || '').trim();

  if (billingCode !== '87.89B') {
    return res.redirect('/optimization?view_mode=doctor');
  }
  if (Number.isNaN(doctorId) || Number.isNaN(encounterNumber) || !dateOfService || !billingCode) {
    return res.redirect('/optimization?view_mode=doctor');
  }
  const doctor = dbGet('SELECT id, is_on_shift FROM doctors WHERE id = ?', [doctorId]);
  if (!doctor || Number(doctor.is_on_shift) !== 1) {
    return res.redirect(`/optimization?view_mode=doctor&selected_doctor=${doctorId}`);
  }
  if (!/^\d+$/.test(callsRaw)) {
    return res.redirect(`/optimization?view_mode=doctor&selected_doctor=${doctorId}`);
  }
  const calls = parseInt(callsRaw, 10);
  if (Number.isNaN(calls) || calls < 1 || calls > 99) {
    return res.redirect(`/optimization?view_mode=doctor&selected_doctor=${doctorId}`);
  }
  const patientId = patientIdRaw ? parseInt(patientIdRaw, 10) : null;

  const existing = dbGet(
    `SELECT id FROM billing_call_overrides
     WHERE doctor_id = ? AND patient_key = ? AND date_of_service = ? AND billing_code = ? AND encounter_number = ?`,
    [doctorId, patientKey, dateOfService, billingCode, encounterNumber]
  );
  if (existing && existing.id) {
    dbRun(
      `UPDATE billing_call_overrides
       SET patient_id = ?, number_of_calls = ?, updated_at = ?
       WHERE id = ?`,
      [
        Number.isNaN(patientId) ? null : patientId,
        calls,
        formatLocalDateTime(new Date()),
        existing.id,
      ]
    );
  } else {
    dbRun(
      `INSERT INTO billing_call_overrides
       (doctor_id, patient_id, patient_key, date_of_service, billing_code, encounter_number, number_of_calls, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        doctorId,
        Number.isNaN(patientId) ? null : patientId,
        patientKey,
        dateOfService,
        billingCode,
        encounterNumber,
        calls,
        formatLocalDateTime(new Date()),
      ]
    );
  }

  return res.redirect(`/optimization?view_mode=doctor&selected_doctor=${doctorId}`);
});

router.get('/optimization/doctor/:doctorId/optimized_pdf', requireLogin, (req, res) => {
  const doctorId = parseInt(req.params.doctorId, 10);
  if (Number.isNaN(doctorId)) {
    return res.redirect('/doctors/manage');
  }
  const doctor = dbGet('SELECT * FROM doctors WHERE id = ?', [doctorId]);
  if (!doctor) {
    return res.redirect('/doctors/manage');
  }

  const cutoff = new Date(Date.now() - 4 * 24 * 60 * 60 * 1000);
  const cutoffStr = formatLocalDateTime(cutoff);
  const windowId = req.query.window_id ? parseInt(req.query.window_id, 10) : null;
  const resolvedWindowId = Number.isNaN(windowId) ? null : windowId;
  const diagnosticCodeMap = loadDiagnosticCodeMap(doctor.id);
  const callOverrideMap = loadCallOverrideMap(doctor.id);
  const summaryTables = buildDoctorOptimizationTables(
    doctor.id,
    cutoffStr,
    diagnosticCodeMap,
    callOverrideMap,
    resolvedWindowId
  );

  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', `attachment; filename=doctor_${doctor.id}_optimized_billing.pdf`);

  const doc = new PDFDocument({ margin: 28, size: 'A4', layout: 'landscape' });
  doc.pipe(res);

  const margin = 28;
  const pageWidth = doc.page.width;
  const pageHeight = doc.page.height;
  const usableBottom = pageHeight - margin;
  const rowHeight = 18;
  const headerHeight = 20;
  const columns = [
    { key: 'patient_identifier', label: 'Pt Identifier', width: 160 },
    { key: 'date_of_service', label: 'Date', width: 78 },
    { key: 'diagnostic_code', label: 'Dx', width: 36 },
    { key: 'billing_code', label: 'Code', width: 60 },
    { key: 'number_of_calls', label: '# Calls', width: 36 },
    { key: 'encounter_number', label: 'Enc#', width: 36 },
    { key: 'modifier', label: 'Modifier', width: 84 },
    { key: 'cmgp_modifier', label: 'CMGP', width: 40 },
    { key: 'bmi_modifier', label: 'BMI', width: 42 },
    { key: 'TEV', label: 'TEV', width: 32 },
    { key: 'TWK', label: 'TWK', width: 32 },
    { key: 'TNTP', label: 'TNTP', width: 38 },
    { key: 'TNTA', label: 'TNTA', width: 38 },
    { key: 'TST', label: 'TST', width: 32 },
    { key: 'TDES', label: 'TDES', width: 36 },
  ];
  const tableWidth = columns.reduce((sum, col) => sum + col.width, 0);
  const tableX = margin;
  let cursorY = margin;
  const generatedAt = formatDisplay(new Date());

  const drawPageTop = (subtitle) => {
    cursorY = margin;
    doc.font('Helvetica-Bold').fontSize(14).fillColor('#111827').text('Doctor Optimized Billing Summary', tableX, cursorY);
    cursorY += 18;
    doc.font('Helvetica').fontSize(10).fillColor('#111827').text(`Doctor: Dr. ${doctor.name}`, tableX, cursorY);
    cursorY += 14;
    doc.text(`Generated: ${generatedAt}`, tableX, cursorY);
    cursorY += 14;
    if (resolvedWindowId) {
      const win = dbGet('SELECT start_datetime, end_datetime FROM shift_windows WHERE id = ? AND doctor_id = ?', [resolvedWindowId, doctor.id]);
      if (win) {
        doc.text(`Shift Window: ${formatDisplay(toDate(win.start_datetime))} - ${formatDisplay(toDate(win.end_datetime))}`, tableX, cursorY);
      } else {
        doc.text('Window: Selected Shift', tableX, cursorY);
      }
    } else {
      doc.text('Window: Last 4 days', tableX, cursorY);
    }
    cursorY += 16;
    doc.font('Helvetica-Bold').fontSize(10).fillColor('#111827').text(subtitle, tableX, cursorY);
    cursorY += 16;
  };

  const drawTableHeader = () => {
    doc.save();
    doc.rect(tableX, cursorY, tableWidth, headerHeight).fill('#e5edf5');
    doc.restore();
    doc.strokeColor('#cbd5e1').lineWidth(0.8).rect(tableX, cursorY, tableWidth, headerHeight).stroke();
    let x = tableX;
    doc.font('Helvetica-Bold').fontSize(8.5).fillColor('#1f2937');
    columns.forEach((col, idx) => {
      doc.text(col.label, x + 3, cursorY + 6, {
        width: col.width - 6,
        align: idx >= 9 ? 'center' : 'left',
        lineBreak: false,
      });
      if (idx < columns.length - 1) {
        doc.moveTo(x + col.width, cursorY).lineTo(x + col.width, cursorY + headerHeight).stroke('#cbd5e1');
      }
      x += col.width;
    });
    cursorY += headerHeight;
  };

  const drawRow = (row, isAlt) => {
    if (isAlt) {
      doc.save();
      doc.rect(tableX, cursorY, tableWidth, rowHeight).fill('#f8fafc');
      doc.restore();
    }
    doc.strokeColor('#e2e8f0').lineWidth(0.6).rect(tableX, cursorY, tableWidth, rowHeight).stroke();
    const values = {
      patient_identifier: row.patient_identifier || '',
      date_of_service: row.date_of_service || '',
      diagnostic_code: row.diagnostic_code || '',
      billing_code: row.billing_code || '',
      number_of_calls: String(row.number_of_calls || ''),
      encounter_number: String(row.encounter_number || ''),
      modifier: row.modifier || '',
      cmgp_modifier: row.cmgp_modifier || '',
      bmi_modifier: row.bmi_modifier || '',
      TEV: (row.aa_counts && row.aa_counts.TEV) || '',
      TWK: (row.aa_counts && row.aa_counts.TWK) || '',
      TNTP: (row.aa_counts && row.aa_counts.TNTP) || '',
      TNTA: (row.aa_counts && row.aa_counts.TNTA) || '',
      TST: (row.aa_counts && row.aa_counts.TST) || '',
      TDES: (row.aa_counts && row.aa_counts.TDES) || '',
    };
    let x = tableX;
    doc.font('Helvetica').fontSize(8).fillColor('#0f172a');
    columns.forEach((col, idx) => {
      const align = idx >= 9 ? 'center' : 'left';
      doc.text(String(values[col.key] || ''), x + 3, cursorY + 5, {
        width: col.width - 6,
        align,
        ellipsis: true,
        lineBreak: false,
      });
      if (idx < columns.length - 1) {
        doc.moveTo(x + col.width, cursorY).lineTo(x + col.width, cursorY + rowHeight).stroke('#e2e8f0');
      }
      x += col.width;
    });
    cursorY += rowHeight;
  };

  if (!summaryTables.length) {
    drawPageTop('No summary entries');
    doc.font('Helvetica-Oblique').fontSize(11).fillColor('#334155').text('No summary entries for this doctor.', tableX, cursorY + 8);
    doc.end();
    return;
  }

  summaryTables.forEach((table, tableIdx) => {
    if (tableIdx > 0) {
      doc.addPage();
    }
    const subtitle = `Dr. ${table.doctor ? table.doctor.name : 'Unknown'} - ${table.shift_date || '-'} - ${table.shift_day || '-'} - ${table.shift_type || '-'} Shift`;
    drawPageTop(subtitle);
    drawTableHeader();

    if (!table.rows || !table.rows.length) {
      doc.font('Helvetica-Oblique').fontSize(10).fillColor('#334155').text('No summary entries for this doctor yet.', tableX, cursorY + 8);
      return;
    }

    table.rows.forEach((row, rowIdx) => {
      if (cursorY + rowHeight > usableBottom) {
        doc.addPage();
        drawPageTop(subtitle);
        drawTableHeader();
      }
      drawRow(row, rowIdx % 2 === 1);
    });
  });

  doc.end();
});

router.post('/optimization/:pid/confirm', requireLogin, (req, res) => {
  const pid = parseInt(req.params.pid, 10);
  const patient = dbGet(
    `SELECT * FROM patients
     WHERE id = ? AND status = ?
       AND (patient_type IS NULL OR patient_type != 'baby')`,
    [pid, 'active']
  );
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
  dbRun('DELETE FROM ghost_ja_locks WHERE patient_id = ?', [pid]);
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

  const startStr = formatLocalDateTime(startPoint);
  const endStr = formatLocalDateTime(triageWindowEnd);
  const shiftSlots = dbAll(
    `SELECT doctor_id, start_time FROM shift_slots
     WHERE start_time >= ? AND start_time <= ?`,
    [startStr, endStr]
  );
  const occupiedKeys = new Set(
    shiftSlots
      .map((slot) => {
        const key = formatLocalDateTime(toDate(slot.start_time));
        return key ? `${slot.doctor_id}|${key}` : null;
      })
      .filter((key) => key)
  );

  recommendations.forEach((rec) => {
    if (rec.code !== '13.99JA' || !rec.doctor) return;
    const slotKey = formatLocalDateTime(rec.time);
    if (!slotKey) return;
    const composite = `${rec.doctor.id}|${slotKey}`;
    if (occupiedKeys.has(composite)) return;
    dbRun(
      'INSERT INTO ghost_ja_locks (patient_id, doctor_id, start_time) VALUES (?, ?, ?)',
      [pid, rec.doctor.id, slotKey]
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
