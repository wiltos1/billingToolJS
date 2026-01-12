const path = require('path');
const express = require('express');
const session = require('express-session');

const { initDb } = require('./db');
const authRoutes = require('./routes/auth');
const patientsRoutes = require('./routes/patients');
const doctorsRoutes = require('./routes/doctors');
const shiftRoutes = require('./routes/shift');
const optimizationRoutes = require('./routes/optimization');

const app = express();

app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));

app.use(express.urlencoded({ extended: true }));
app.use(
  session({
    secret: process.env.SESSION_SECRET,
    resave: false,
    saveUninitialized: false,
    cookie: {
      secure: process.env.NODE_ENV === 'production', // https only in prod
      sameSite: 'lax',
    },
  })
);

app.use('/static', express.static(path.join(__dirname, 'public')));

app.use(authRoutes);
app.use(patientsRoutes);
app.use(doctorsRoutes);
app.use(shiftRoutes);
app.use(optimizationRoutes);

const start = async () => {
  await initDb();
  const port = process.env.PORT || 5000;
  app.listen(port, () => {
    // eslint-disable-next-line no-console
    console.log(`Billing Tool JS running on port ${port}`);
  });
};

start();
