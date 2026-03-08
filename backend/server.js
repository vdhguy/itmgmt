const _iisnodePort = process.env.PORT; // preserve named pipe set by iisnode before dotenv overrides
require('dotenv').config({ path: require('path').join(__dirname, '.env'), override: true });
if (_iisnodePort) process.env.PORT = _iisnodePort; // restore so iisnode pipe is used

const express = require('express');
const session = require('express-session');
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
const authRouter = require('./routes/auth');


const app = express();
app.set('trust proxy', 1); // required behind IIS/iisnode (named pipe — no TCP IP)
const PORT = process.env.PORT || 3000;
const isProd = process.env.NODE_ENV === 'production';

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

// ── SESSION
app.use(session({
    secret: process.env.SESSION_SECRET || 'change-this-secret-in-production',
    resave: false,
    saveUninitialized: false,
    cookie: {
        httpOnly: true,
        secure: isProd,
        sameSite: 'lax',
        maxAge: 8 * 60 * 60 * 1000, // 8 hours
    }
}));

// ── PUBLIC ROUTES (no auth required)
app.use('/auth', authRouter);
app.get('/health', (req, res) => res.json({ status: 'ok' }));
app.get('/api/version', (req, res) => {
    const v = require('./version.json');
    res.json({ version: `${v.major}.${v.minor}` });
});

// ── GATE: redirect unauthenticated users; return 401 for API calls
const PUBLIC_PATHS = ['/login.html', '/css/', '/js/', '/img/'];
app.use((req, res, next) => {
    if (PUBLIC_PATHS.some(p => req.path.startsWith(p))) return next();
    if (!req.session?.user) {
        if (req.path.startsWith('/api/')) return res.status(401).json({ error: 'Not authenticated' });
        return res.redirect('/login.html');
    }
    next();
});

// ── PROTECTED API ROUTES
const limiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    max: 2000,
    keyGenerator: (req) => req.ip || req.headers['x-forwarded-for'] || 'internal',
    validate: { ip: false }
});
app.use('/api', limiter);
app.use('/api/devices', devicesRouter);
app.use('/api/inventory', inventoryRouter);
app.use('/api/users', usersRouter);
app.use('/api/security', securityRouter);
app.use('/api/autopatch', autopatchRouter);

// ── STATIC (frontend)
app.use(express.static(path.join(__dirname, '../frontend')));

app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
