const { toDate, formatLocalDateTime } = require('./helpers');
const { dbGet, dbAll } = require('../db');

const TRIAGE_SLOT_MINUTES = 15;
const INDUCTION_DAILY_LIMIT = 2;
const INDUCTION_TOTAL_LIMIT = 4;
const INDUCTION_WINDOW_MS = 24 * 60 * 60 * 1000;
const DELIVERY_BUFFER_MINUTES = 30;
const JA_VALUE = 55;
const STAT_HOLIDAYS = [];
const DESIGNATED_STAT_HOLIDAYS = [];

const floorToQuarter = (date) => {
  const minutes = date.getMinutes();
  const minuteBlock = Math.floor(minutes / 15) * 15;
  const floored = new Date(date);
  floored.setMinutes(minuteBlock, 0, 0);
  return floored;
};

const timeModifier = (date) => {
  const weekday = date.getDay();
  const hour = date.getHours();
  const minute = date.getMinutes();
  const hm = hour + minute / 60;

  if (hm < 7) return { modifier: 'NTAM', weight: 3 };
  if (hm >= 22) return { modifier: 'NTPM', weight: 3 };
  if (weekday === 0 || weekday === 6) {
    if (hm >= 7 && hm < 22) return { modifier: 'WK', weight: 2 };
  } else if (hm >= 17 && hm < 22) {
    return { modifier: 'EV', weight: 2 };
  }
  return { modifier: '', weight: 1 };
};

const afterHoursModifier = (date) => {
  const weekday = date.getDay();
  const hour = date.getHours() + date.getMinutes() / 60;
  const isWeekend = weekday === 0 || weekday === 6;

  if (hour < 7) return 'NTAM';
  if (hour >= 22) return 'NTPM';
  if (isWeekend) {
    if (hour >= 7 && hour < 22) return 'WK';
  } else if (hour >= 17 && hour < 22) {
    return 'EV';
  }
  return '';
};

const isHoliday = (date, list) => {
  if (!date) return false;
  const key = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
  return list.includes(key);
};

const afterHoursPremiumModifier = (date) => {
  const hour = date.getHours() + date.getMinutes() / 60;
  const weekday = date.getDay();
  const isWeekend = weekday === 0 || weekday === 6;

  if (hour >= 7 && hour < 22) {
    if (isHoliday(date, STAT_HOLIDAYS)) return 'TST';
    if (isHoliday(date, DESIGNATED_STAT_HOLIDAYS)) return 'TDES';
  }
  if (hour < 7) return 'TNTA';
  if (hour >= 22) return 'TNTP';
  if (isWeekend) return 'TWK';
  if (hour >= 17) return 'TEV';
  return '';
};

const buildAfterHoursPremiumBillings = (patient, admitted, delivered, activeShiftWindows) => {
  if (!patient || !admitted || !delivered) return [];
  const windows = Array.isArray(activeShiftWindows)
    ? activeShiftWindows
    : (activeShiftWindows ? [activeShiftWindows] : []);
  if (!windows.length) return [];

  const countsByDoctor = new Map();
  const seenByDoctor = new Map();

  windows.forEach((window) => {
    if (!window) return;
    const windowStart = new Date(Math.max(admitted.getTime(), toDate(window.start_datetime).getTime()));
    const windowEnd = new Date(Math.min(delivered.getTime(), toDate(window.end_datetime).getTime()));
    if (windowStart >= windowEnd) return;
    const windowStartStr = formatLocalDateTime(windowStart);
    const windowEndStr = formatLocalDateTime(windowEnd);
    if (!windowStartStr || !windowEndStr) return;

    const slots = dbAll(
      `SELECT * FROM shift_slots
       WHERE doctor_id = ? AND patient_id = ? AND start_time >= ? AND start_time < ?`,
      [window.doctor_id, patient.id, windowStartStr, windowEndStr]
    );
    slots.forEach((slot) => {
      const slotTime = toDate(slot.start_time);
      if (!slotTime) return;
      const actionKey = (slot.action || '').toLowerCase();
      if (!['triage_visit', 'triage_reassessment', 'attended'].includes(actionKey)) return;
      const modifier = afterHoursPremiumModifier(slotTime);
      if (!modifier) return;
      const doctorId = slot.doctor_id;
      if (!doctorId) return;
      const slotKey = formatLocalDateTime(slotTime);
      if (!slotKey) return;
      if (!seenByDoctor.has(doctorId)) {
        seenByDoctor.set(doctorId, new Set());
      }
      const seen = seenByDoctor.get(doctorId);
      if (seen.has(slotKey)) return;
      seen.add(slotKey);

      if (!countsByDoctor.has(doctorId)) {
        countsByDoctor.set(doctorId, {
          earliestTime: slotTime,
          counts: {},
        });
      }
      const info = countsByDoctor.get(doctorId);
      info.counts[modifier] = (info.counts[modifier] || 0) + 1;
      if (slotTime < info.earliestTime) {
        info.earliestTime = slotTime;
      }
    });
  });

  const billings = [];
  countsByDoctor.forEach((info, doctorId) => {
    const modifiers = Object.keys(info.counts)
      .sort()
      .map((key) => `${key} ${String(info.counts[key]).padStart(2, '0')}`);
    if (!modifiers.length) return;
    const doctor = dbGet('SELECT * FROM doctors WHERE id = ?', [doctorId]);
    billings.push({
      time: info.earliestTime,
      code: '03.01AA',
      modifier: modifiers.join(', '),
      doctor,
    });
  });

  return billings;
};

const generateSlots = (start, end) => {
  const slots = [];
  let cursor = new Date(start);
  while (cursor < end) {
    slots.push(new Date(cursor));
    cursor = new Date(cursor.getTime() + 15 * 60 * 1000);
  }
  return slots;
};

const triageVisitModifier = (totalMinutes) => {
  if (totalMinutes >= 85) return 'CMGP08';
  if (totalMinutes >= 75) return 'CMGP07';
  if (totalMinutes >= 65) return 'CMGP06';
  if (totalMinutes >= 55) return 'CMGP05';
  if (totalMinutes >= 45) return 'CMGP04';
  if (totalMinutes >= 35) return 'CMGP03';
  if (totalMinutes >= 25) return 'CMGP02';
  if (totalMinutes >= 15) return 'CMGP01';
  return '';
};

const reassessmentBaseCode = (date) => {
  const weekday = date.getDay();
  const hour = date.getHours() + date.getMinutes() / 60;
  const isWeekend = weekday === 0 || weekday === 6;

  if (hour < 7 || hour >= 22) {
    return '03.05FB';
  }
  if (isWeekend) {
    return '03.05FA';
  }
  if (hour >= 17) {
    return '03.05FA';
  }
  return '03.05F';
};

const collectTriageSlots = (patientSlots, triageCutoff) => {
  return patientSlots
    .map((slot) => {
      const slotTime = toDate(slot.start_time);
      if (!slotTime) return null;
      if (triageCutoff && slotTime > triageCutoff) return null;
      const actionKey = (slot.action || '').toLowerCase();
      if (actionKey !== 'triage_visit' && actionKey !== 'triage_reassessment') return null;
      return { ...slot, slotTime, actionKey };
    })
    .filter((entry) => entry);
};

const buildTriageBillings = (triageSlots, allowTriageVisit) => {
  if (!triageSlots.length) return [];

  const triageVisits = triageSlots.filter((slot) => slot.actionKey === 'triage_visit');
  const reassessments = triageSlots.filter((slot) => slot.actionKey === 'triage_reassessment');
  const triageBillings = [];

  if (triageVisits.length && allowTriageVisit) {
    const totalMinutes = triageVisits.length * TRIAGE_SLOT_MINUTES;
    const visitSlot = triageVisits
      .slice()
      .sort((a, b) => a.slotTime - b.slotTime)[0];
    const doctor = visitSlot.doctor_id
      ? dbGet('SELECT * FROM doctors WHERE id = ?', [visitSlot.doctor_id])
      : null;

    triageBillings.push({
      time: visitSlot.slotTime,
      code: '03.03BZ',
      modifier: triageVisitModifier(totalMinutes),
      doctor,
    });
  }

  if (reassessments.length) {
    const sorted = reassessments
      .slice()
      .sort((a, b) => a.slotTime - b.slotTime);
    const groups = [];
    let current = null;
    sorted.forEach((slot) => {
      if (!current) {
        current = {
          doctor_id: slot.doctor_id || null,
          slots: [slot],
          lastTime: slot.slotTime,
        };
        return;
      }
      const sameDoctor = (slot.doctor_id || null) === current.doctor_id;
      const contiguous = slot.slotTime - current.lastTime === TRIAGE_SLOT_MINUTES * 60 * 1000;
      if (sameDoctor && contiguous) {
        current.slots.push(slot);
        current.lastTime = slot.slotTime;
      } else {
        groups.push(current);
        current = {
          doctor_id: slot.doctor_id || null,
          slots: [slot],
          lastTime: slot.slotTime,
        };
      }
    });
    if (current) groups.push(current);

    groups.forEach((group) => {
      const startSlot = group.slots[0];
      const minutes = group.slots.length * TRIAGE_SLOT_MINUTES;
      let modifier = '';
      if (minutes > 35) {
        modifier = 'CMXV35';
      } else if (minutes > 20) {
        modifier = 'CMXV20';
      }
      const doctor = group.doctor_id
        ? dbGet('SELECT * FROM doctors WHERE id = ?', [group.doctor_id])
        : null;
      triageBillings.push({
        time: startSlot.slotTime,
        code: reassessmentBaseCode(startSlot.slotTime),
        modifier,
        doctor,
      });
    });
  }

  triageSlots.forEach((slot) => {
    const doctor = slot.doctor_id
      ? dbGet('SELECT * FROM doctors WHERE id = ?', [slot.doctor_id])
      : null;
    if (slot.triage_non_stress_test) {
      triageBillings.push({
        time: slot.slotTime,
        code: '87.54A',
        modifier: '',
        doctor,
      });
    }
    if (slot.triage_speculum_exam) {
      triageBillings.push({
        time: slot.slotTime,
        code: '13.99BE',
        modifier: '',
        doctor,
      });
    }
  });

  return triageBillings.sort((a, b) => a.time - b.time);
};

const buildStatusEventBillings = (patientId, allowContinuousMonitoring) => {
  const events = dbAll(
    `SELECT * FROM patient_status_events
     WHERE patient_id = ? AND status IN (?, ?)
     ORDER BY occurred_at`,
    [patientId, 'Induction', 'Continuous Monitoring']
  );
  if (!events.length) return [];

  const billings = [];
  const inductionTimes = [];

  events.forEach((event) => {
    const eventTime = toDate(event.occurred_at);
    if (!eventTime) return;
    if (event.status === 'Induction') {
      if (inductionTimes.length >= INDUCTION_TOTAL_LIMIT) return;
      const recentCount = inductionTimes.filter(
        (t) => eventTime - t < INDUCTION_WINDOW_MS && eventTime >= t
      ).length;
      if (recentCount >= INDUCTION_DAILY_LIMIT) return;

      const modifier = afterHoursModifier(eventTime);
      const doctor = event.doctor_id ? dbGet('SELECT * FROM doctors WHERE id = ?', [event.doctor_id]) : null;
      billings.push({
        time: eventTime,
        code: '85.5A',
        modifier,
        doctor,
      });
      inductionTimes.push(eventTime);

      if (event.induction_non_stress_test) {
        billings.push({
          time: eventTime,
          code: '87.54A',
          modifier: '',
          doctor,
        });
      }
    } else if (event.status === 'Continuous Monitoring') {
      if (!allowContinuousMonitoring) return;
      const modifier = afterHoursModifier(eventTime);
      const doctor = event.doctor_id ? dbGet('SELECT * FROM doctors WHERE id = ?', [event.doctor_id]) : null;
      billings.push({
        time: eventTime,
        code: '87.54B',
        modifier,
        doctor,
      });
    }
  });

  return billings;
};

const isSameDate = (a, b) => {
  return a && b
    && a.getFullYear() === b.getFullYear()
    && a.getMonth() === b.getMonth()
    && a.getDate() === b.getDate();
};

const normalizeDeliveryCode = (slot) => {
  if (!slot) return '87.98A';
  if (slot.delivery_code) return slot.delivery_code;
  if ((slot.delivery_by || '').toLowerCase() === 'ob') return '87.98B';
  return '87.98A';
};

const deliveryExtras = (slot, time, doctor, extraModifier = '') => {
  const extras = [];
  const modifier = extraModifier || '';
  if (slot.delivery_postpartum_hemorrhage) {
    extras.push({ time, code: '87.99A', modifier, doctor });
  }
  if (slot.delivery_vacuum) {
    extras.push({ time, code: '84.21', modifier, doctor });
  }
  if (slot.delivery_vaginal_laceration) {
    extras.push({ time, code: '87.89B', modifier, doctor });
  }
  if (slot.delivery_shoulder_dystocia) {
    extras.push({ time, code: '85.69B', modifier, doctor });
  }
  if (slot.delivery_manual_placenta) {
    extras.push({ time, code: '87.6', modifier, doctor });
  }
  return extras;
};

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

const appendModifier = (base, extra) => {
  if (!extra) return base || '';
  if (!base) return extra;
  return `${base},${extra}`;
};

const isWeekday = (date) => {
  const weekday = date.getDay();
  return weekday >= 1 && weekday <= 5;
};

const isWeekdayDaytime = (date) => {
  if (!isWeekday(date)) return false;
  const hm = date.getHours() + date.getMinutes() / 60;
  return hm >= 7 && hm < 17;
};

const groupContiguousSlots = (slots) => {
  const groups = [];
  let current = null;
  slots.forEach((slot) => {
    if (!current) {
      current = {
        doctor_id: slot.doctor_id || null,
        careType: slot.rounds_care_type || '',
        slots: [slot],
        lastTime: slot.slotTime,
      };
      return;
    }
    const sameDoctor = (slot.doctor_id || null) === current.doctor_id;
    const sameCare = (slot.rounds_care_type || '') === current.careType;
    const contiguous = slot.slotTime - current.lastTime === TRIAGE_SLOT_MINUTES * 60 * 1000;
    if (sameDoctor && sameCare && contiguous) {
      current.slots.push(slot);
      current.lastTime = slot.slotTime;
    } else {
      groups.push(current);
      current = {
        doctor_id: slot.doctor_id || null,
        careType: slot.rounds_care_type || '',
        slots: [slot],
        lastTime: slot.slotTime,
      };
    }
  });
  if (current) groups.push(current);
  return groups;
};

const buildSupportiveCareBillings = (patient) => {
  if (!patient || patient.patient_type === 'baby') return [];
  const baby = dbGet(
    'SELECT id FROM patients WHERE parent_patient_id = ? AND patient_type = ? ORDER BY id LIMIT 1',
    [patient.id, 'baby']
  );
  const ids = [patient.id];
  if (baby && baby.id) ids.push(baby.id);
  const placeholders = ids.map(() => '?').join(',');
  const supportiveSlots = dbAll(
    `SELECT * FROM shift_slots
     WHERE patient_id IN (${placeholders})
       AND (rounds_supportive_care = 1 OR tongue_tie_supportive_care = 1)`,
    ids
  );
  return supportiveSlots
    .map((slot) => {
      const slotTime = toDate(slot.start_time);
      if (!slotTime) return null;
      const doctor = slot.doctor_id
        ? dbGet('SELECT * FROM doctors WHERE id = ?', [slot.doctor_id])
        : null;
      return {
        time: slotTime,
        code: '03.05M',
        modifier: '',
        doctor,
      };
    })
    .filter((entry) => entry);
};

const buildBabyBillings = (babyPatient) => {
  if (!babyPatient) return [];
  const babySlots = dbAll(
    `SELECT * FROM shift_slots
     WHERE patient_id = ?
     ORDER BY start_time`,
    [babyPatient.id]
  );
  const billings = [];

  let deliveryDoctor = null;
  let resuscitation = babyPatient.baby_resuscitation ? 1 : 0;
  if (babyPatient.parent_patient_id) {
    const deliverySlot = dbGet(
      `SELECT * FROM shift_slots
       WHERE patient_id = ? AND action = ?
       ORDER BY start_time
       LIMIT 1`,
      [babyPatient.parent_patient_id, 'delivery']
    );
    if (deliverySlot && deliverySlot.doctor_id) {
      deliveryDoctor = dbGet('SELECT * FROM doctors WHERE id = ?', [deliverySlot.doctor_id]);
    }
    if (deliverySlot && deliverySlot.delivery_resuscitation) {
      resuscitation = 1;
    }
  }

  const admittedAt = toDate(babyPatient.care_admitted_at || babyPatient.start_datetime);
  if (admittedAt) {
    billings.push({
      time: admittedAt,
      code: resuscitation ? '13.99F' : '03.05G',
      modifier: '',
      doctor: deliveryDoctor,
    });
  }

  const roundsSlots = babySlots
    .map((slot) => {
      const slotTime = toDate(slot.start_time);
      if (!slotTime) return null;
      if ((slot.action || '').toLowerCase() !== 'rounds') return null;
      if (!slot.rounds_care_type) return null;
      return { ...slot, slotTime };
    })
    .filter((slot) => slot);
  const groupedRounds = groupContiguousSlots(roundsSlots);
  groupedRounds.forEach((group) => {
    const firstSlot = group.slots[0];
    const doctor = group.doctor_id
      ? dbGet('SELECT * FROM doctors WHERE id = ?', [group.doctor_id])
      : null;
    if (group.careType === 'daily_newborn_care') {
      billings.push({
        time: firstSlot.slotTime,
        code: '03.05GA',
        modifier: '',
        doctor,
      });
    } else if (group.careType === 'daily_inpatient_care') {
      billings.push({
        time: firstSlot.slotTime,
        code: '03.03D',
        modifier: group.slots.length >= 2 ? 'COINPT' : '',
        doctor,
      });
    }
  });

  const tongueTieSlots = babySlots
    .map((slot) => {
      const slotTime = toDate(slot.start_time);
      if (!slotTime) return null;
      if ((slot.action || '').toLowerCase() !== 'tongue_tie_clip') return null;
      return { ...slot, slotTime };
    })
    .filter((slot) => slot);
  tongueTieSlots.forEach((slot) => {
    const doctor = slot.doctor_id
      ? dbGet('SELECT * FROM doctors WHERE id = ?', [slot.doctor_id])
      : null;
    if (isWeekdayDaytime(slot.slotTime)) {
      billings.push({
        time: slot.slotTime,
        code: '03.03AR',
        modifier: 'COINPT',
        doctor,
      });
      return;
    }
    billings.push({
      time: slot.slotTime,
      code: '37.91A',
      modifier: afterHoursModifier(slot.slotTime),
      doctor,
    });
  });

  return billings.sort((a, b) => a.time - b.time);
};

const buildCallbackBillingInfo = (patient, activeShiftWindows) => {
  if (!patient) return [];
  const windows = Array.isArray(activeShiftWindows)
    ? activeShiftWindows
    : (activeShiftWindows ? [activeShiftWindows] : []);
  if (!windows.length) return [];

  return windows.map((window) => {
    const firstSlot = dbGet(
      `SELECT * FROM shift_slots
       WHERE doctor_id = ? AND start_time >= ? AND start_time < ?
         AND patient_id IS NOT NULL AND action IS NOT NULL AND action != ''
       ORDER BY start_time
       LIMIT 1`,
      [window.doctor_id, window.start_datetime, window.end_datetime]
    );
    if (!firstSlot || firstSlot.patient_id !== patient.id) {
      return { billings: [], slotTime: null, total: 0 };
    }

    const slotTime = toDate(firstSlot.start_time);
    if (!slotTime) return { billings: [], slotTime: null, total: 0 };
    const doctor = firstSlot.doctor_id
      ? dbGet('SELECT * FROM doctors WHERE id = ?', [firstSlot.doctor_id])
      : null;

    const actionKey = (firstSlot.action || '').toLowerCase();
    if (actionKey === 'triage_visit' || actionKey === 'triage_reassessment') {
      const code = callbackCodeForTriage(slotTime);
      return {
        billings: [{
          time: slotTime,
          code,
          modifier: '',
          doctor,
        }],
        slotTime,
        total: {
          '03.03KA': 80,
          '03.03LA': 120,
          '03.03MC': 160,
          '03.03MD': 160,
        }[code] || 0,
      };
    }

    const admittedAt = patient.care_admitted_at ? toDate(patient.care_admitted_at) : null;
    if (admittedAt && slotTime >= admittedAt) {
      const inpatientCode = callbackCodeForInpatient(slotTime);
      const total = {
        '03.05P': 159,
        '03.05QA': 197,
        '03.05QB': 197,
      }[inpatientCode] || 0;
      return {
        billings: [
          {
            time: slotTime,
            code: '03.03DF',
            modifier: '',
            doctor,
          },
          {
            time: slotTime,
            code: inpatientCode,
            modifier: '',
            doctor,
          },
        ],
        slotTime,
        total,
      };
    }

    return { billings: [], slotTime, total: 0 };
  }).filter((info) => info.billings.length);
};

const buildOptimizedBillings = (patient, patientSlots, activeShiftWindow) => {
  const admitted = toDate(patient.care_admitted_at);
  const delivered = toDate(patient.care_delivered_at);
  if (!admitted || !delivered || admitted >= delivered) return [];
  const activeShiftWindows = Array.isArray(activeShiftWindow)
    ? activeShiftWindow
    : (activeShiftWindow ? [activeShiftWindow] : []);
  const primaryShiftWindow = activeShiftWindows.length ? activeShiftWindows[0] : null;

  const triageEvents = dbAll(
    'SELECT occurred_at FROM patient_status_events WHERE patient_id = ? AND status = ?',
    [patient.id, 'Triage']
  );
  let triageCutoff = delivered;
  triageEvents.forEach((event) => {
    const eventTime = toDate(event.occurred_at);
    if (eventTime && delivered && eventTime > delivered) {
      triageCutoff = !triageCutoff || eventTime > triageCutoff ? eventTime : triageCutoff;
    }
  });
  if (patient.second_triage_at) {
    const legacy = toDate(patient.second_triage_at);
    if (legacy && delivered && legacy > delivered) {
      triageCutoff = !triageCutoff || legacy > triageCutoff ? legacy : triageCutoff;
    }
  }
  const triageSlots = collectTriageSlots(patientSlots, triageCutoff);

  let allowTriageVisit = true;
  if (triageSlots.some((slot) => slot.actionKey === 'triage_visit')) {
    const triageVisitSlots = triageSlots.filter((slot) => slot.actionKey === 'triage_visit');
    const firstTriageVisit = triageVisitSlots.slice().sort((a, b) => a.slotTime - b.slotTime)[0];
    const triageVisitDoctors = new Set(
      triageVisitSlots.map((slot) => slot.doctor_id).filter((id) => id)
    );
    const inductionEvents = dbAll(
      'SELECT * FROM patient_status_events WHERE patient_id = ? AND status = ?',
      [patient.id, 'Induction']
    );
    const hasBlockingInduction = inductionEvents.some((event) => {
      const eventTime = toDate(event.occurred_at);
      if (!eventTime) return false;
      const duringTriage = admitted ? eventTime < admitted : true;
      if (!duringTriage) return false;
      const sameDay = firstTriageVisit ? isSameDate(eventTime, firstTriageVisit.slotTime) : true;
      const inductionDoctor = event.doctor_id || null;
      const sameDoctor = inductionDoctor
        ? triageVisitDoctors.has(inductionDoctor)
        : triageVisitDoctors.size > 0;
      return sameDay && sameDoctor;
    });
    if (hasBlockingInduction) {
      allowTriageVisit = false;
    }
  }

  const scopedSlots = patientSlots.filter((slot) => {
    const slotTime = toDate(slot.start_time);
    return slotTime && slotTime >= admitted && slotTime <= delivered;
  });

  const triageBillings = buildTriageBillings(triageSlots, allowTriageVisit);
  const afterHoursBillings = buildAfterHoursPremiumBillings(patient, admitted, delivered, activeShiftWindows);

  const sortedScoped = [...scopedSlots].sort((a, b) => new Date(a.start_time) - new Date(b.start_time));
  const deliverySlot = sortedScoped.find((slot) => (slot.action || '').toLowerCase() === 'delivery') || null;
  const deliveredTime = deliverySlot
    ? (toDate(deliverySlot.delivery_time) || toDate(deliverySlot.start_time))
    : null;
  const deliveryCode = deliverySlot ? normalizeDeliveryCode(deliverySlot) : '87.98A';
  const deliveredByOb = deliverySlot && deliveryCode === '87.98B';
  const deliveredByVbac = deliverySlot && deliveryCode === '87.98C';

  const callbackInfos = buildCallbackBillingInfo(patient, activeShiftWindows);

  if (deliveredByOb || deliveredByVbac) {
    const attended = sortedScoped.filter((slot) => {
      const slotTime = toDate(slot.start_time);
      if (!slot.doctor_id || !slotTime) return false;
      if ((slot.action || '').toLowerCase() === 'delivery') return false;
      if (deliveredTime && slotTime.getTime() === deliveredTime.getTime()) return false;
      return true;
    });

    let coinptTimes = new Set();
    for (let i = 0; i < attended.length - 1; i += 1) {
      const first = attended[i];
      const second = attended[i + 1];
      const firstTime = toDate(first.start_time);
      const secondTime = toDate(second.start_time);
      if (!firstTime || !secondTime) continue;
      const gap = secondTime - firstTime;
      if (gap >= 14 * 60 * 1000 && gap <= 16 * 60 * 1000) {
        if (primaryShiftWindow) {
          const windowStart = toDate(primaryShiftWindow.start_datetime);
          const windowEnd = toDate(primaryShiftWindow.end_datetime);
          const inShift = windowStart && windowEnd && firstTime >= windowStart && firstTime < windowEnd && secondTime >= windowStart && secondTime < windowEnd;
          if (!inShift) continue;
        }
        coinptTimes = new Set([formatLocalDateTime(firstTime), formatLocalDateTime(secondTime)]);
        break;
      }
    }

    const shiftDoctor = primaryShiftWindow
      ? dbGet('SELECT * FROM doctors WHERE id = ?', [primaryShiftWindow.doctor_id])
      : null;

    const billings = attended.map((slot) => {
      const slotTime = toDate(slot.start_time);
      const slotKey = slotTime ? formatLocalDateTime(slotTime) : '';
      const doctor = slot.doctor_id
        ? dbGet('SELECT * FROM doctors WHERE id = ?', [slot.doctor_id])
        : shiftDoctor;
      return {
        time: slotTime,
        code: '03.03AR',
        modifier: coinptTimes.has(slotKey) ? 'COINPT' : '',
        doctor,
      };
    });

    if (deliveredTime) {
      const doctor = deliverySlot.doctor_id
        ? dbGet('SELECT * FROM doctors WHERE id = ?', [deliverySlot.doctor_id])
        : shiftDoctor;
      const bmiproMod = deliverySlot.delivery_bmipro ? 'BMIPRO' : '';
      billings.push({
        time: deliveredTime,
        code: deliveryCode,
        modifier: appendModifier(afterHoursModifier(deliveredTime), bmiproMod),
        doctor,
      });
      billings.push(...deliveryExtras(deliverySlot, deliveredTime, doctor, bmiproMod));
    }

    const statusBillings = buildStatusEventBillings(patient.id, true);
    const callbackBillings = callbackInfos.flatMap((info) => info.billings);
    const supportiveBillings = buildSupportiveCareBillings(patient);
    const combined = billings.concat(
      triageBillings,
      statusBillings,
      callbackBillings,
      afterHoursBillings,
      supportiveBillings
    );
    return combined.sort((a, b) => a.time - b.time);
  }

  if (!primaryShiftWindow) {
    const statusBillings = buildStatusEventBillings(patient.id, true);
    const supportiveBillings = buildSupportiveCareBillings(patient);
    return triageBillings
      .concat(statusBillings, afterHoursBillings, supportiveBillings)
      .sort((a, b) => a.time - b.time);
  }

  const otherPatients = dbAll(
    `SELECT id, care_admitted_at, care_delivered_at
     FROM patients
     WHERE id != ? AND care_admitted_at IS NOT NULL AND care_delivered_at IS NOT NULL`,
    [patient.id]
  ).map((p) => ({
    id: p.id,
    admitted: toDate(p.care_admitted_at),
    delivered: toDate(p.care_delivered_at),
  })).filter((p) => p.admitted && p.delivered);

  const obVbacIds = new Set(
    dbAll(
      `SELECT DISTINCT patient_id FROM shift_slots
       WHERE delivery_code IN ('87.98B', '87.98C')`
    ).map((row) => row.patient_id)
  );

  const buildJaBillingsForWindow = (window) => {
    const shiftDoctor = dbGet('SELECT * FROM doctors WHERE id = ?', [window.doctor_id]);
    if (!shiftDoctor) return [];
    const windowStart = new Date(Math.max(admitted.getTime(), toDate(window.start_datetime).getTime()));
    const windowEnd = new Date(Math.min(delivered.getTime(), toDate(window.end_datetime).getTime()));
    if (windowStart >= windowEnd) return [];

    const attendedTimes = scopedSlots
      .filter((slot) => (slot.action || '').toLowerCase() === 'attended')
      .filter((slot) => slot.doctor_id === shiftDoctor.id)
      .map((slot) => toDate(slot.start_time))
      .filter((time) => time && time >= windowStart && time < windowEnd)
      .sort((a, b) => a - b);
    const encounterStarts = [];
    attendedTimes.forEach((time, idx) => {
      const prev = idx ? attendedTimes[idx - 1] : null;
      if (!prev || time - prev > 15 * 60 * 1000) {
        encounterStarts.push(time);
      }
    });
    const encounterStartKeys = new Set(
      encounterStarts
        .map((time) => formatLocalDateTime(time))
        .filter((key) => key)
    );

    let alignedStart = floorToQuarter(windowStart);
    const shiftStart = toDate(window.start_datetime);
    if (alignedStart < shiftStart) {
      alignedStart = new Date(shiftStart);
      alignedStart.setSeconds(0, 0);
    }

    const slots = [];
    const deliveryCutoff = deliveredTime || delivered;
    const cutoffStart = deliveryCutoff
      ? new Date(deliveryCutoff.getTime() - DELIVERY_BUFFER_MINUTES * 60 * 1000)
      : null;
    generateSlots(alignedStart, windowEnd).forEach((slotTime) => {
      if (deliveryCutoff && slotTime.getTime() === deliveryCutoff.getTime()) return;
      if (cutoffStart && deliveryCutoff && slotTime >= cutoffStart && slotTime < deliveryCutoff) return;
      const { modifier, weight } = timeModifier(slotTime);
      slots.push({ slotTime, modifier, weight });
    });

    if (slots.length === 0) return [];

    const slotByKey = new Map();
    slots.forEach((slot) => {
      const key = formatLocalDateTime(slot.slotTime);
      if (key) slotByKey.set(key, slot);
    });

    // Build a set of occupied slot times for this doctor so ghost JAs only use empty slots.
    const windowStartStr = formatLocalDateTime(windowStart);
    const windowEndStr = formatLocalDateTime(windowEnd);
    const occupiedKeys = new Set(
      dbAll(
        `SELECT start_time FROM shift_slots
         WHERE doctor_id = ? AND start_time >= ? AND start_time < ?`,
        [shiftDoctor.id, windowStartStr, windowEndStr]
      )
        .map((slot) => formatLocalDateTime(toDate(slot.start_time)))
        .filter((key) => key)
    );

    // Always prioritize attended encounter starts, then other attended slots, then ghost slots.
    const encounterSlots = Array.from(encounterStartKeys)
      .map((key) => ({ key, slot: slotByKey.get(key) }))
      .filter((entry) => entry.slot)
      .sort((a, b) => (b.slot.weight - a.slot.weight) || (a.slot.slotTime - b.slot.slotTime));

    const selected = new Map();
    encounterSlots.slice(0, 12).forEach(({ key, slot }) => {
      selected.set(key, slot);
    });

    const attendedKeys = new Set(
      attendedTimes
        .map((time) => formatLocalDateTime(time))
        .filter((key) => key)
    );
    const attendedNonModifiable = attendedTimes
      .map((time) => {
        const key = formatLocalDateTime(time);
        return key ? { key, slot: slotByKey.get(key) } : null;
      })
      .filter((entry) => entry && entry.slot && !encounterStartKeys.has(entry.key))
      .sort((a, b) => a.slot.slotTime - b.slot.slotTime);

    attendedNonModifiable.forEach(({ key, slot }) => {
      if (selected.size >= 12) return;
      if (!selected.has(key)) {
        selected.set(key, slot);
      }
    });

    // Ghost JA slots should avoid times other patients are most likely to need.
    const overlappingPatients = otherPatients.filter((p) => {
      if (obVbacIds.has(p.id)) return false;
      return p.delivered > windowStart && p.admitted < windowEnd;
    });

    const getContention = (slotTime) => {
      let count = 0;
      overlappingPatients.forEach((p) => {
        const cutoffStart = new Date(p.delivered.getTime() - DELIVERY_BUFFER_MINUTES * 60 * 1000);
        if (slotTime < p.admitted || slotTime > p.delivered) return;
        if (slotTime >= cutoffStart && slotTime < p.delivered) return;
        count += 1;
      });
      return count;
    };

    const remaining = 12 - selected.size;
    if (remaining <= 0) {
      return Array.from(selected.values())
        .sort((a, b) => a.slotTime - b.slotTime)
        .map(({ slotTime, modifier }) => {
          const slotKey = formatLocalDateTime(slotTime);
          const isModifiable = encounterStartKeys.has(slotKey);
          const isAttended = attendedKeys.has(slotKey);
          return {
            time: slotTime,
            code: '13.99JA',
            modifier: isModifiable ? modifier : '',
            doctor: shiftDoctor,
            _jaPriority: isModifiable ? 2 : (isAttended ? 1 : 0),
            _jaWeight: isModifiable ? timeModifier(slotTime).weight : 0,
          };
        });
    }
    const ghostCandidates = slots
      .filter((slot) => {
        const key = formatLocalDateTime(slot.slotTime);
        if (!key || selected.has(key)) return false;
        return !occupiedKeys.has(key);
      })
      .map((slot) => ({
        ...slot,
        contention: getContention(slot.slotTime),
      }))
      .sort((a, b) => (a.contention - b.contention) || (b.weight - a.weight) || (a.slotTime - b.slotTime))
      .slice(0, remaining);

    ghostCandidates.forEach((slot) => {
      const key = formatLocalDateTime(slot.slotTime);
      if (key) selected.set(key, slot);
    });

    return Array.from(selected.values())
      .sort((a, b) => a.slotTime - b.slotTime)
      .map(({ slotTime, modifier }) => {
        const slotKey = formatLocalDateTime(slotTime);
        const isModifiable = encounterStartKeys.has(slotKey);
        const isAttended = attendedKeys.has(slotKey);
        return {
          time: slotTime,
          code: '13.99JA',
          modifier: isModifiable ? modifier : '',
          doctor: shiftDoctor,
          _jaPriority: isModifiable ? 2 : (isAttended ? 1 : 0),
          _jaWeight: isModifiable ? timeModifier(slotTime).weight : 0,
        };
      });
  };

  const billings = activeShiftWindows
    .filter((window) => window)
    .flatMap((window) => buildJaBillingsForWindow(window));

  const primaryShiftDoctor = primaryShiftWindow
    ? dbGet('SELECT * FROM doctors WHERE id = ?', [primaryShiftWindow.doctor_id])
    : null;
  const primaryStart = primaryShiftWindow ? toDate(primaryShiftWindow.start_datetime) : null;
  const primaryEnd = primaryShiftWindow ? toDate(primaryShiftWindow.end_datetime) : null;
  if (deliveredTime && primaryStart && primaryEnd && deliveredTime >= primaryStart && deliveredTime <= primaryEnd) {
    const doctor = deliverySlot && deliverySlot.doctor_id
      ? dbGet('SELECT * FROM doctors WHERE id = ?', [deliverySlot.doctor_id])
      : primaryShiftDoctor;
    const bmiproMod = deliverySlot && deliverySlot.delivery_bmipro ? 'BMIPRO' : '';
    billings.push({
      time: deliveredTime,
      code: deliveryCode,
      modifier: appendModifier(afterHoursModifier(deliveredTime), bmiproMod),
      doctor,
    });
    if (deliverySlot) {
      billings.push(...deliveryExtras(deliverySlot, deliveredTime, doctor, bmiproMod));
    }
  }

  const jaBillings = billings.filter((billing) => billing.code === '13.99JA');
  const otherBillings = billings.filter((billing) => billing.code !== '13.99JA');
  const cappedJaBillings = jaBillings
    .slice()
    .sort((a, b) => {
      if ((b._jaPriority || 0) !== (a._jaPriority || 0)) {
        return (b._jaPriority || 0) - (a._jaPriority || 0);
      }
      if ((b._jaWeight || 0) !== (a._jaWeight || 0)) {
        return (b._jaWeight || 0) - (a._jaWeight || 0);
      }
      return a.time - b.time;
    })
    .slice(0, 12);

  const cleanedJaBillings = cappedJaBillings.map(({ _jaPriority, _jaWeight, ...rest }) => rest);
  let filteredBillings = otherBillings.concat(cleanedJaBillings);

  let callbackBillings = [];
  if (callbackInfos.length) {
    const sortedCallbacks = callbackInfos
      .filter((info) => info.slotTime && info.billings.length)
      .slice()
      .sort((a, b) => a.slotTime - b.slotTime);
    sortedCallbacks.forEach((info) => {
      const ghostBeforeCallback = filteredBillings.filter(
        (billing) => billing.code === '13.99JA' && !billing.modifier && billing.time < info.slotTime
      );
      const ghostTotal = ghostBeforeCallback.length * JA_VALUE;
      if (ghostTotal > info.total) {
        return;
      }
      callbackBillings = callbackBillings.concat(info.billings);
      filteredBillings = filteredBillings.filter(
        (billing) => !(billing.code === '13.99JA' && !billing.modifier && billing.time < info.slotTime)
      );
    });
  }

  const has1399JA = filteredBillings.some((billing) => billing.code === '13.99JA');
  const statusBillings = buildStatusEventBillings(patient.id, !has1399JA);
  const supportiveBillings = buildSupportiveCareBillings(patient);
  const combined = filteredBillings.concat(
    triageBillings,
    statusBillings,
    callbackBillings,
    afterHoursBillings,
    supportiveBillings
  );
  return combined.sort((a, b) => a.time - b.time);
};

module.exports = { buildOptimizedBillings, buildBabyBillings };
