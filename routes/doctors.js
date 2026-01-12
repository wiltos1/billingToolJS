const express = require('express');
const { dbGet, dbAll, dbRun } = require('../db');
const { parseDateTime, formatDate, formatTime, getShiftDoctor, getActiveShiftWindow, requireLogin, formatLocalDateTime, formatDisplay24, cleanupOldShiftData } = require('../services/helpers');

const router = express.Router();

router.post('/doctors', requireLogin, (req, res) => {
  const name = (req.body.doctor_name || '').trim();
  if (!name) {
    return res.redirect('/?view=active');
  }
  dbRun('INSERT INTO doctors (name, is_on_shift) VALUES (?, 0)', [name]);
  return res.redirect('/doctors/manage');
});

router.get('/doctors/manage', requireLogin, (req, res) => {
  cleanupOldShiftData();
  const shiftDoctor = getShiftDoctor();
  const shiftWindow = getActiveShiftWindow();

  let defaultStartDate;
  let defaultStartTime;
  let defaultEndDate;
  let defaultEndTime;

  if (shiftWindow) {
    const start = new Date(shiftWindow.start_datetime);
    const end = new Date(shiftWindow.end_datetime);
    defaultStartDate = formatDate(start);
    defaultStartTime = formatTime(start);
    defaultEndDate = formatDate(end);
    defaultEndTime = formatTime(end);
  } else {
    const now = new Date();
    defaultStartDate = formatDate(now);
    defaultStartTime = '08:00';
    defaultEndDate = formatDate(now);
    defaultEndTime = '20:00';
  }

  const doctors = dbAll('SELECT * FROM doctors ORDER BY name');
  const cutoff = new Date(Date.now() - 4 * 24 * 60 * 60 * 1000);
  const recentWindows = dbAll(
    `SELECT w.*, d.name as doctor_name
     FROM shift_windows w
     LEFT JOIN doctors d ON w.doctor_id = d.id
     WHERE w.end_datetime >= ?
     ORDER BY w.start_datetime DESC`,
    [formatLocalDateTime(cutoff)]
  );

  return res.render('doctors', {
    session: req.session,
    doctors,
    shiftDoctor,
    shiftWindow,
    recent_shift_windows: recentWindows,
    default_start_date: defaultStartDate,
    default_start_time: defaultStartTime,
    default_end_date: defaultEndDate,
    default_end_time: defaultEndTime,
    format_display_24: formatDisplay24,
  });
});

router.post('/doctors/on_shift', requireLogin, (req, res) => {
  cleanupOldShiftData();
  const doctorId = parseInt(req.body.doctor_id, 10);
  if (Number.isNaN(doctorId)) {
    return res.redirect('/doctors/manage');
  }

  const doctor = dbGet('SELECT * FROM doctors WHERE id = ?', [doctorId]);
  if (doctor) {
    const shiftType = (req.body.shift_type || 'day').trim().toLowerCase();
    let startDate = (req.body.shift_date || '').trim();
    let startTime = (req.body.shift_start_time || '').trim();
    let endDate = '';
    let endTime = (req.body.shift_end_time || '').trim();

    if (!startDate) {
      startDate = formatDate(new Date());
    }

    if (shiftType === 'day') {
      startTime = '08:00';
      endTime = '20:00';
      endDate = startDate;
    } else if (shiftType === 'night') {
      startTime = '20:00';
      endTime = '08:00';
    } else {
      if (!startTime) startTime = '08:00';
      if (!endTime) endTime = '20:00';
    }

    const startDt = parseDateTime(startDate, startTime);
    let endDt = parseDateTime(endDate, endTime, startDate || formatDate(startDt));
    if (!endDate && endDt <= startDt) {
      endDt = new Date(endDt.getTime() + 24 * 60 * 60 * 1000);
    }

    dbRun('UPDATE doctors SET is_on_shift = 0');
    dbRun('UPDATE shift_windows SET is_active = 0');

    dbRun('UPDATE doctors SET is_on_shift = 1 WHERE id = ?', [doctor.id]);
    dbRun(
      'INSERT INTO shift_windows (doctor_id, start_datetime, end_datetime, is_active) VALUES (?, ?, ?, 1)'
    , [doctor.id, formatLocalDateTime(startDt), formatLocalDateTime(endDt)]);
  }

  return res.redirect('/doctors/manage');
});

router.post('/doctors/activate_shift', requireLogin, (req, res) => {
  cleanupOldShiftData();
  const windowId = parseInt(req.body.window_id, 10);
  if (Number.isNaN(windowId)) {
    return res.redirect('/doctors/manage');
  }
  const window = dbGet('SELECT * FROM shift_windows WHERE id = ?', [windowId]);
  if (!window) {
    return res.redirect('/doctors/manage');
  }

  dbRun('UPDATE doctors SET is_on_shift = 0');
  dbRun('UPDATE shift_windows SET is_active = 0');
  dbRun('UPDATE doctors SET is_on_shift = 1 WHERE id = ?', [window.doctor_id]);
  dbRun('UPDATE shift_windows SET is_active = 1 WHERE id = ?', [window.id]);

  return res.redirect(`/shift_grid?window_id=${window.id}`);
});

module.exports = router;
