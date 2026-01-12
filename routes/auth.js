const express = require('express');
const bcrypt = require('bcryptjs');
const { dbGet } = require('../db');

const router = express.Router();

router.get('/login', (req, res) => {
  res.render('login', { error: null });
});

router.post('/login', (req, res) => {
  const user = (req.body.username || '').trim();
  const pw = (req.body.password || '').trim();
  const userRecord = dbGet('SELECT * FROM users WHERE username = ?', [user]);

  if (userRecord && bcrypt.compareSync(pw, userRecord.password_hash)) {
    req.session.user = userRecord.username;
    return res.redirect('/?view=active');
  }

  return res.render('login', { error: 'Invalid username or password' });
});

router.get('/logout', (req, res) => {
  req.session.destroy(() => {
    res.redirect('/login');
  });
});

module.exports = router;
