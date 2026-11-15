const crypto = require('node:crypto');
const fs = require('node:fs/promises');
const http = require('node:http');
const path = require('node:path');

const PORT = Number(process.env.PORT) || 3000;
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || '';
const DATA_DIR = path.join(__dirname, 'data');
const DATA_FILE = path.join(DATA_DIR, 'tournament.json');
const SESSION_COOKIE = 'tournament_admin';
const SESSION_TTL_MS = 8 * 60 * 60 * 1000;
const MAX_BODY_BYTES = 1024 * 1024;
const SPORTS = ['classes', 'mlbb', 'futsal', 'basket'];
const MODES = ['leftright24', 'direct24', 'playin16', 'gradeleague'];
const sessions = new Map();
const loginAttempts = new Map();

let tournamentState = null;
let updatedAt = null;
let writeQueue = Promise.resolve();

function sendJson(response, status, value, headers = {}) {
    response.writeHead(status, {
        'Content-Type': 'application/json; charset=utf-8',
        'Cache-Control': 'no-store',
        'X-Content-Type-Options': 'nosniff',
        'Referrer-Policy': 'same-origin',
        ...headers
    });
    response.end(JSON.stringify(value));
}

function sameOrigin(request) {
    const origin = request.headers.origin;
    if (!origin || !request.headers.host) return false;
    try {
        return new URL(origin).host === request.headers.host;
    } catch {
        return false;
    }
}

async function readJson(request) {
    let body = '';
    for await (const chunk of request) {
        body += chunk;
        if (Buffer.byteLength(body) > MAX_BODY_BYTES) {
            const error = new Error('Request body is too large');
            error.status = 413;
            throw error;
        }
    }
    try {
        return JSON.parse(body);
    } catch {
        const error = new Error('Invalid JSON body');
        error.status = 400;
        throw error;
    }
}

function cookieValue(request, name) {
    const entry = (request.headers.cookie || '')
        .split(';')
        .map(cookie => cookie.trim())
        .find(cookie => cookie.startsWith(`${name}=`));
    return entry ? decodeURIComponent(entry.slice(name.length + 1)) : '';
}

function authenticatedSession(request) {
    const id = cookieValue(request, SESSION_COOKIE);
    const session = sessions.get(id);
    if (!session) return null;
    if (session.expiresAt <= Date.now()) {
        sessions.delete(id);
        return null;
    }
    return { id, session };
}

function requireAdmin(request, response) {
    if (authenticatedSession(request)) return true;
    sendJson(response, 401, { error: 'Admin login required' });
    return false;
}

function validateState(state) {
    if (!state || typeof state !== 'object' ||
        !SPORTS.includes(state.currentSport) ||
        !state.participantsBySport || typeof state.participantsBySport !== 'object' ||
        !state.bracketStatesBySport || typeof state.bracketStatesBySport !== 'object' ||
        !state.championsBySport || typeof state.championsBySport !== 'object') return false;

    for (const sport of SPORTS) {
        const participants = state.participantsBySport[sport];
        if (!Array.isArray(participants) || participants.length !== 24 ||
            participants.some(name => typeof name !== 'string' || !name.trim() || name.length > 80) ||
            new Set(participants.map(name => name.trim().toLowerCase())).size !== 24) return false;
        const bracket = state.bracketStatesBySport[sport];
        if (bracket && (!MODES.includes(bracket.mode) || !Array.isArray(bracket.rounds))) return false;
    }
    return true;
}

async function saveState(state) {
    const operation = writeQueue.then(async () => {
        const nextUpdatedAt = new Date().toISOString();
        await fs.mkdir(DATA_DIR, { recursive: true });
        const temporaryFile = `${DATA_FILE}.${process.pid}.tmp`;
        await fs.writeFile(temporaryFile, JSON.stringify({ state, updatedAt: nextUpdatedAt }), 'utf8');
        await fs.rename(temporaryFile, DATA_FILE);
        tournamentState = state;
        updatedAt = nextUpdatedAt;
    });
    writeQueue = operation.catch(() => {});
    await operation;
}

async function loadState() {
    try {
        const saved = JSON.parse(await fs.readFile(DATA_FILE, 'utf8'));
        if (!validateState(saved.state)) throw new Error('Saved tournament data is invalid');
        tournamentState = saved.state;
        updatedAt = saved.updatedAt || null;
    } catch (error) {
        if (error.code !== 'ENOENT') throw error;
    }
}

async function requestHandler(request, response) {
    const url = new URL(request.url, `http://${request.headers.host || 'localhost'}`);

    if (request.method === 'GET' && url.pathname === '/api/session') {
        sendJson(response, 200, { authenticated: Boolean(authenticatedSession(request)) });
        return;
    }

    if (request.method === 'POST' && url.pathname === '/api/login') {
        if (!sameOrigin(request)) {
            sendJson(response, 403, { error: 'Cross-origin request rejected' });
            return;
        }
        if (!ADMIN_PASSWORD) {
            sendJson(response, 503, { error: 'Set ADMIN_PASSWORD before enabling admin login' });
            return;
        }
        const ip = request.socket.remoteAddress || 'unknown';
        const attempts = loginAttempts.get(ip) || { failures: 0, blockedUntil: 0 };
        if (attempts.blockedUntil > Date.now()) {
            sendJson(response, 429, { error: 'Too many login attempts; try again later' });
            return;
        }

        const body = await readJson(request);
        const submitted = Buffer.from(typeof body.password === 'string' ? body.password : '');
        const expected = Buffer.from(ADMIN_PASSWORD);
        const valid = submitted.length === expected.length && crypto.timingSafeEqual(submitted, expected);
        if (!valid) {
            attempts.failures += 1;
            if (attempts.failures >= 5) attempts.blockedUntil = Date.now() + 15 * 60 * 1000;
            loginAttempts.set(ip, attempts);
            sendJson(response, 401, { error: 'Password admin salah' });
            return;
        }

        loginAttempts.delete(ip);
        const id = crypto.randomBytes(32).toString('base64url');
        sessions.set(id, { expiresAt: Date.now() + SESSION_TTL_MS });
        const secure = process.env.NODE_ENV === 'production' ? '; Secure' : '';
        sendJson(response, 200, { authenticated: true }, {
            'Set-Cookie': `${SESSION_COOKIE}=${encodeURIComponent(id)}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${SESSION_TTL_MS / 1000}${secure}`
        });
        return;
    }

    if (request.method === 'POST' && url.pathname === '/api/logout') {
        if (!sameOrigin(request)) {
            sendJson(response, 403, { error: 'Cross-origin request rejected' });
            return;
        }
        const active = authenticatedSession(request);
        if (active) sessions.delete(active.id);
        sendJson(response, 200, { authenticated: false }, {
            'Set-Cookie': `${SESSION_COOKIE}=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0`
        });
        return;
    }

    if (request.method === 'GET' && url.pathname === '/api/state') {
        sendJson(response, 200, { state: tournamentState, updatedAt });
        return;
    }

    if (request.method === 'PUT' && url.pathname === '/api/state') {
        if (!sameOrigin(request)) {
            sendJson(response, 403, { error: 'Cross-origin request rejected' });
            return;
        }
        if (!requireAdmin(request, response)) return;
        const state = await readJson(request);
        if (!validateState(state)) {
            sendJson(response, 400, { error: 'Invalid tournament state' });
            return;
        }
        await saveState(state);
        sendJson(response, 200, { updatedAt });
        return;
    }

    if (request.method === 'GET' && (url.pathname === '/' || url.pathname === '/index.html')) {
        const html = await fs.readFile(path.join(__dirname, '.html'));
        response.writeHead(200, {
            'Content-Type': 'text/html; charset=utf-8',
            'Cache-Control': 'no-store',
            'X-Content-Type-Options': 'nosniff',
            'X-Frame-Options': 'DENY',
            'Referrer-Policy': 'same-origin'
        });
        response.end(html);
        return;
    }

    sendJson(response, 404, { error: 'Not found' });
}

async function startServer() {
    await loadState();
    const server = http.createServer((request, response) => {
        requestHandler(request, response).catch(error => {
            console.error('Request failed:', error);
            if (!response.headersSent) {
                sendJson(response, error.status || 500, {
                    error: error.status ? error.message : 'Internal server error'
                });
            } else {
                response.destroy();
            }
        });
    });
    server.listen(PORT, '0.0.0.0', () => {
        console.log(`Tournament app is listening on http://localhost:${PORT}`);
        if (!ADMIN_PASSWORD) console.warn('Admin login is disabled until ADMIN_PASSWORD is set.');
        if (process.env.NODE_ENV === 'production') {
            console.warn('Use HTTPS at the reverse proxy in production.');
        }
    });
}

startServer().catch(error => {
    console.error('Could not start tournament server:', error);
    process.exitCode = 1;
});
