const { toDate, formatLocalDateTime } = require('./helpers');
const { dbGet } = require('../db');

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

const generateSlots = (start, end) => {
  const slots = [];
  let cursor = new Date(start);
  while (cursor < end) {
    slots.push(new Date(cursor));
    cursor = new Date(cursor.getTime() + 15 * 60 * 1000);
  }
  return slots;
};

const buildOptimizedBillings = (patient, patientSlots, activeShiftWindow) => {
  const admitted = toDate(patient.care_admitted_at);
  const delivered = toDate(patient.care_delivered_at);
  if (!admitted || !delivered || admitted >= delivered) return [];

  const triageCodes = {
    triage_visit: '03.03BZ',
    triage_reassessment: '03.05F',
  };

  const triageBillings = patientSlots
    .map((slot) => {
      const slotTime = toDate(slot.start_time);
      if (!slotTime || slotTime > delivered) return null;
      const actionKey = (slot.action || '').toLowerCase();
      const code = triageCodes[actionKey];
      if (!code) return null;
      const doctor = slot.doctor_id
        ? dbGet('SELECT * FROM doctors WHERE id = ?', [slot.doctor_id])
        : null;
      return {
        time: slotTime,
        code,
        modifier: '',
        doctor,
      };
    })
    .filter((entry) => entry);

  const scopedSlots = patientSlots.filter((slot) => {
    const slotTime = toDate(slot.start_time);
    return slotTime && slotTime >= admitted && slotTime <= delivered;
  });

  const sortedScoped = [...scopedSlots].sort((a, b) => new Date(a.start_time) - new Date(b.start_time));
  const deliverySlot = sortedScoped.find((slot) => (slot.action || '').toLowerCase() === 'delivery') || null;
  const deliveredTime = deliverySlot ? toDate(deliverySlot.start_time) : null;
  const deliveredByOb = deliverySlot && (deliverySlot.delivery_by || '').toLowerCase() === 'ob';

  if (deliveredByOb) {
    const attended = sortedScoped.filter((slot) => {
      const slotTime = toDate(slot.start_time);
      if (!slot.doctor_id || !slotTime) return false;
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
        if (activeShiftWindow) {
          const windowStart = toDate(activeShiftWindow.start_datetime);
          const windowEnd = toDate(activeShiftWindow.end_datetime);
          const inShift = windowStart && windowEnd && firstTime >= windowStart && firstTime < windowEnd && secondTime >= windowStart && secondTime < windowEnd;
          if (!inShift) continue;
        }
        coinptTimes = new Set([formatLocalDateTime(firstTime), formatLocalDateTime(secondTime)]);
        break;
      }
    }

    const shiftDoctor = activeShiftWindow
      ? dbGet('SELECT * FROM doctors WHERE id = ?', [activeShiftWindow.doctor_id])
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
      billings.push({
        time: deliveredTime,
        code: '87.98B',
        modifier: '',
        doctor,
      });
    }

    const combined = billings.concat(triageBillings);
    return combined.sort((a, b) => a.time - b.time);
  }

  if (!activeShiftWindow) {
    return triageBillings.sort((a, b) => a.time - b.time);
  }

  const attendedKeys = new Set(
    scopedSlots
      .filter((slot) => (slot.action || '').toLowerCase() === 'attended')
      .map((slot) => {
        const slotTime = toDate(slot.start_time);
        return slotTime ? formatLocalDateTime(slotTime) : '';
      })
      .filter((key) => key)
  );

  const shiftDoctor = dbGet('SELECT * FROM doctors WHERE id = ?', [activeShiftWindow.doctor_id]);
  const windowStart = new Date(Math.max(admitted.getTime(), toDate(activeShiftWindow.start_datetime).getTime()));
  const windowEnd = new Date(Math.min(delivered.getTime(), toDate(activeShiftWindow.end_datetime).getTime()));
  if (windowStart >= windowEnd) return [];

  let alignedStart = floorToQuarter(windowStart);
  const shiftStart = toDate(activeShiftWindow.start_datetime);
  if (alignedStart < shiftStart) {
    alignedStart = new Date(shiftStart);
    alignedStart.setSeconds(0, 0);
  }

  const slots = [];
  generateSlots(alignedStart, windowEnd).forEach((slotTime) => {
    if (deliveredTime && slotTime.getTime() === deliveredTime.getTime()) return;
    const { modifier, weight } = timeModifier(slotTime);
    slots.push({ slotTime, modifier, weight });
  });

  if (slots.length === 0) return [];

  const topSlots = slots
    .slice()
    .sort((a, b) => (b.weight - a.weight) || (a.slotTime - b.slotTime))
    .slice(0, 12)
    .sort((a, b) => a.slotTime - b.slotTime);

  const billings = topSlots.map(({ slotTime, modifier }) => {
    const slotKey = formatLocalDateTime(slotTime);
    return {
      time: slotTime,
      code: '13.99JA',
      modifier: attendedKeys.has(slotKey) ? modifier : '',
      doctor: shiftDoctor,
    };
  });

  if (deliveredTime && deliveredTime >= windowStart && deliveredTime <= windowEnd) {
    billings.push({
      time: deliveredTime,
      code: '87.98A',
      modifier: '',
      doctor: shiftDoctor,
    });
  }

  const combined = billings.concat(triageBillings);
  return combined.sort((a, b) => a.time - b.time);
};

module.exports = { buildOptimizedBillings };
