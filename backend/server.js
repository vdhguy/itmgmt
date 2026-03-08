require('dotenv').config();

const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const morgan = require('morgan');
const rateLimit = require('express-rate-limit');
const path = require('path');

const devicesRouter = require('./routes/devices');
const inventoryRouter = require('./routes/inventory');
const usersRouter = require('./routes/users');
const securityRouter = require('./routes/security');
const autopatchRouter = require('./routes/autopatch');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(helmet({
    contentSecurityPolicy: {
        directives: {
            defaultSrc: ["'self'"],
            scriptSrc:  ["'self'", "'unsafe-inline'"],
            styleSrc:   ["'self'", "'unsafe-inline'", "https://fonts.googleapis.com"],
            fontSrc:    ["'self'", "https://fonts.gstatic.com"],
            connectSrc: ["'self'"],
            imgSrc:     ["'self'", "data:"],
        }
    }
}));
app.use(morgan('combined'));
app.use(cors({
    origin: process.env.ALLOWED_ORIGINS ? process.env.ALLOWED_ORIGINS.split(',') : '*'
}));
app.use(express.json());

const limiter = rateLimit({ windowMs: 15 * 60 * 1000, max: 2000 });
app.use('/api', limiter);

app.use('/api/devices', devicesRouter);
app.use('/api/inventory', inventoryRouter);
app.use('/api/users', usersRouter);
app.use('/api/security', securityRouter);
app.use('/api/autopatch', autopatchRouter);

app.get('/health', (req, res) => res.json({ status: 'ok' }));

app.use(express.static(path.join(__dirname, '../frontend')));

app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
