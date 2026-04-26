'use strict';

const crypto = require('crypto');
const express = require('express');
const mysql = require('mysql2/promise');
const PDFKit = require('pdfkit');
const path = require('path');

const app = express();
const isProduction = process.env.NODE_ENV === 'production';
const PORT = Number(process.env.PORT || 3000);
const EMPLEADOR_NOMBRE = process.env.EMPLOYER_NAME || 'TRAMARSA S.A.';
const INDEX_FILE = path.join(__dirname, 'index.html');
const SESSION_COOKIE_NAME = 'vida_ley_session';
const SESSION_TTL_MS = 8 * 60 * 60 * 1000;
const AUTH_PASSWORD = String(process.env.APP_ACCESS_PASSWORD || '');
const AUTH_REQUIRED = AUTH_PASSWORD.length > 0;
const LOGIN_LIMIT_MAX = 8;
const API_LIMIT_MAX = 180;
const RATE_LIMIT_WINDOW_MS = 15 * 60 * 1000;
const ALLOWED_PARENTESCOS = {
  PRIMERO: new Set([1, 2, 4]),
  SEGUNDO: new Set([3, 5, 6])
};
const PARENTESCO_LABELS = {
  1: 'Conyuge',
  2: 'Hijo',
  3: 'Padre',
  4: 'Conviviente',
  5: 'Madre',
  6: 'Hermano'
};
const sessions = new Map();

if (isProduction && !AUTH_REQUIRED) {
  throw new Error('Define APP_ACCESS_PASSWORD antes de publicar el proyecto en internet.');
}

app.disable('x-powered-by');
app.set('trust proxy', 1);

app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
  res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
  res.setHeader('Cross-Origin-Resource-Policy', 'same-origin');
  res.setHeader(
    'Content-Security-Policy',
    [
      "default-src 'self'",
      "connect-src 'self'",
      "img-src 'self' data:",
      "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com https://cdn.jsdelivr.net",
      "font-src 'self' https://fonts.gstatic.com https://cdn.jsdelivr.net",
      "script-src 'self' 'unsafe-inline'",
      "base-uri 'self'",
      "form-action 'self'",
      "frame-ancestors 'none'",
      "object-src 'none'"
    ].join('; ')
  );

  if (isProduction) {
    res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
  }

  next();
});

app.use(express.json({ limit: '20kb', strict: true }));
app.use(express.urlencoded({ extended: false, limit: '20kb' }));

const pool = mysql.createPool({
  host: process.env.DB_HOST || '127.0.0.1',
  user: process.env.DB_USER || 'root',
  password: process.env.DB_PASSWORD || '',
  database: process.env.DB_NAME || 'registrovidaley',
  waitForConnections: true,
  connectionLimit: 10,
  queueLimit: 0
});

const loginRateLimit = createRateLimiter({
  windowMs: RATE_LIMIT_WINDOW_MS,
  max: LOGIN_LIMIT_MAX,
  bucket: 'login',
  message: 'Demasiados intentos de acceso. Intenta nuevamente en unos minutos.'
});

const apiRateLimit = createRateLimiter({
  windowMs: RATE_LIMIT_WINDOW_MS,
  max: API_LIMIT_MAX,
  bucket: 'api',
  message: 'Demasiadas solicitudes. Espera un momento e intenta otra vez.'
});

const disableCache = (req, res, next) => {
  res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, private');
  res.setHeader('Pragma', 'no-cache');
  res.setHeader('Expires', '0');
  next();
};

app.get('/', disableCache, (req, res) => {
  res.sendFile(INDEX_FILE);
});

app.get('/auth/status', disableCache, (req, res) => {
  if (!AUTH_REQUIRED) {
    return res.json({ ok: true, authEnabled: false, authenticated: true });
  }

  const sessionId = getSessionIdFromRequest(req);
  const session = getValidSession(sessionId, req);

  if (!session) {
    clearSessionCookie(res);
    return res.json({ ok: true, authEnabled: true, authenticated: false });
  }

  refreshSession(res, sessionId, session);
  return res.json({ ok: true, authEnabled: true, authenticated: true });
});

app.post('/auth/login', disableCache, loginRateLimit, (req, res) => {
  if (!AUTH_REQUIRED) {
    return res.json({ ok: true, authEnabled: false });
  }

  const password = String(req.body && req.body.password ? req.body.password : '').trim();

  if (!password || !safeCompare(password, AUTH_PASSWORD)) {
    return res.status(401).json({ ok: false, msg: 'Clave de acceso invalida.' });
  }

  const sessionId = createSession(req);
  setSessionCookie(res, sessionId);
  res.json({ ok: true });
});

app.post('/auth/logout', disableCache, (req, res) => {
  const sessionId = getSessionIdFromRequest(req);

  if (sessionId) {
    sessions.delete(sessionId);
  }

  clearSessionCookie(res);
  res.json({ ok: true });
});

app.get('/colaborador/:dni', disableCache, requireAuth, apiRateLimit, async (req, res, next) => {
  try {
    const dni = normalizeDni(req.params.dni);

    if (!isValidDni(dni)) {
      return res.status(400).json({ ok: false, msg: 'El DNI ingresado no es valido.' });
    }

    const [rows] = await pool.execute(
      `
      SELECT c.id, c.dni, c.apellido_paterno, c.apellido_materno, c.nombres, g.genero
      FROM colaboradores c
      LEFT JOIN genero g ON c.id_genero = g.id_genero
      WHERE c.dni = ?
      LIMIT 1
    `,
      [dni]
    );

    if (!rows.length) {
      return res.json({ ok: false });
    }

    const { sessionId, session } = getOrCreateFlowSession(req, res);
    setRegistrationFlow(sessionId, session, rows[0]);

    res.json({ ok: true, data: rows[0] });
  } catch (err) {
    next(err);
  }
});

app.post('/guardar-beneficiario', disableCache, requireAuth, apiRateLimit, async (req, res, next) => {
  try {
    const { sessionId, session } = getOrCreateFlowSession(req, res);
    const payload = buildBeneficiaryPayload(req.body);
    const validationError = validateBeneficiaryPayload(payload);

    if (validationError) {
      return res.status(400).json({ ok: false, msg: validationError });
    }

    const registrationFlow = getRegistrationFlow(session);

    if (!registrationFlow || !registrationFlow.colaborador || registrationFlow.colaborador.id !== payload.id_colaborador) {
      return res.status(409).json({
        ok: false,
        msg: 'Primero vuelve a buscar el DNI del colaborador antes de guardar beneficiarios.'
      });
    }

    const [colaboradorRows] = await pool.execute(
      `
      SELECT id, dni
      FROM colaboradores
      WHERE id = ?
      LIMIT 1
    `,
      [payload.id_colaborador]
    );

    if (!colaboradorRows.length) {
      return res.status(404).json({ ok: false, msg: 'Colaborador no encontrado.' });
    }

    if (colaboradorRows[0].dni === payload.dni) {
      return res.status(400).json({ ok: false, msg: 'El DNI del beneficiario no puede ser igual al del colaborador.' });
    }

    const [existente] = await pool.execute(
      `
      SELECT id
      FROM beneficiarios
      WHERE dni = ?
      LIMIT 1
    `,
      [payload.dni]
    );

    if (existente.length) {
      return res.status(409).json({ ok: false, msg: 'Ya ingresaste este DNI.' });
    }

    await pool.execute(
      `
      INSERT INTO beneficiarios
      (id_colaborador, tipo, dni, apellido_paterno, apellido_materno, nombres, id_parentesco, id_genero, fecha_nacimiento, domicilio)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `,
      [
        payload.id_colaborador,
        payload.tipo,
        payload.dni,
        payload.apellido_paterno,
        payload.apellido_materno,
        payload.nombres,
        payload.id_parentesco,
        payload.id_genero,
        payload.fecha_nacimiento,
        payload.domicilio
      ]
    );

    addBeneficiaryToFlow(sessionId, session, {
      tipo: payload.tipo,
      dni: payload.dni,
      apellido_paterno: payload.apellido_paterno,
      apellido_materno: payload.apellido_materno,
      nombres: payload.nombres,
      fecha_nacimiento: payload.fecha_nacimiento,
      domicilio: payload.domicilio,
      parentesco: PARENTESCO_LABELS[payload.id_parentesco] || ''
    });

    res.json({ ok: true });
  } catch (err) {
    if (err.code === 'ER_DUP_ENTRY') {
      return res.status(409).json({ ok: false, msg: 'Ya ingresaste este DNI.' });
    }

    next(err);
  }
});

app.post('/generar-pdf', disableCache, requireAuth, apiRateLimit, async (req, res, next) => {
  try {
    const { sessionId, session } = getOrCreateFlowSession(req, res);
    const registrationFlow = getRegistrationFlow(session);

    if (!registrationFlow || !registrationFlow.colaborador) {
      return res.status(400).json({
        ok: false,
        msg: 'Primero busca al colaborador y registra sus beneficiarios en este mismo flujo.'
      });
    }

    if (!registrationFlow.beneficiarios.length) {
      return res.status(400).json({
        ok: false,
        msg: 'Aun no has registrado beneficiarios en este flujo.'
      });
    }

    const primeros = registrationFlow.beneficiarios.filter((beneficiario) => beneficiario.tipo === 'PRIMERO');
    const segundos = registrationFlow.beneficiarios.filter((beneficiario) => beneficiario.tipo === 'SEGUNDO');
    const pdfBuffer = await generarPDF(registrationFlow.colaborador, primeros, segundos);
    const fileName = buildPdfFileName(registrationFlow.colaborador.dni);
    clearRegistrationFlow(sessionId, session);

    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `inline; filename="${fileName}"`);
    res.setHeader('Content-Length', String(pdfBuffer.length));
    res.send(pdfBuffer);
  } catch (err) {
    next(err);
  }
});

app.use((req, res) => {
  res.status(404).json({ ok: false, msg: 'Ruta no encontrada.' });
});

app.use((err, req, res, next) => {
  if (err instanceof SyntaxError && Object.prototype.hasOwnProperty.call(err, 'body')) {
    return res.status(400).json({ ok: false, msg: 'El cuerpo de la solicitud no tiene un JSON valido.' });
  }

  console.error('ERROR:', err);
  res.status(500).json({ ok: false, msg: 'Ocurrio un error interno. Intenta nuevamente.' });
});

function createRateLimiter({ windowMs, max, bucket, message }) {
  const hits = new Map();

  return (req, res, next) => {
    const now = Date.now();
    const key = `${bucket}:${req.ip}`;
    const entry = hits.get(key);

    if (!entry || entry.expiresAt <= now) {
      hits.set(key, { count: 1, expiresAt: now + windowMs });
      return next();
    }

    entry.count += 1;

    if (entry.count > max) {
      const retryAfterSeconds = Math.ceil((entry.expiresAt - now) / 1000);
      res.setHeader('Retry-After', String(retryAfterSeconds));
      return res.status(429).json({ ok: false, msg: message });
    }

    return next();
  };
}

function normalizeText(value, maxLength) {
  return String(value || '')
    .replace(/[\u0000-\u001F\u007F]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, maxLength);
}

function normalizeDni(value) {
  return String(value || '').replace(/\D/g, '').slice(0, 8);
}

function normalizePositiveInteger(value) {
  const parsed = Number.parseInt(String(value || ''), 10);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : null;
}

function isValidDni(value) {
  return /^\d{8}$/.test(value);
}

function isValidDate(value) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    return false;
  }

  const date = new Date(`${value}T00:00:00Z`);

  if (Number.isNaN(date.getTime())) {
    return false;
  }

  if (date.toISOString().slice(0, 10) !== value) {
    return false;
  }

  const minDate = new Date('1900-01-01T00:00:00Z');
  const today = new Date();

  return date >= minDate && date <= today;
}

function buildBeneficiaryPayload(body) {
  return {
    id_colaborador: normalizePositiveInteger(body && body.id_colaborador),
    tipo: normalizeText(body && body.tipo, 10).toUpperCase(),
    dni: normalizeDni(body && body.dni),
    apellido_paterno: normalizeText(body && body.apellido_paterno, 50),
    apellido_materno: normalizeText(body && body.apellido_materno, 50),
    nombres: normalizeText(body && body.nombres, 100),
    id_parentesco: normalizePositiveInteger(body && body.id_parentesco),
    id_genero: normalizePositiveInteger(body && body.id_genero),
    fecha_nacimiento: normalizeText(body && body.fecha_nacimiento, 10),
    domicilio: normalizeText(body && body.domicilio, 250)
  };
}

function validateBeneficiaryPayload(payload) {
  if (!payload.id_colaborador) {
    return 'El colaborador no es valido.';
  }

  if (!Object.prototype.hasOwnProperty.call(ALLOWED_PARENTESCOS, payload.tipo)) {
    return 'El tipo de beneficiario no es valido.';
  }

  if (!isValidDni(payload.dni)) {
    return 'El DNI del beneficiario debe tener 8 digitos.';
  }

  if (!payload.nombres || !payload.apellido_paterno || !payload.apellido_materno) {
    return 'Completa los nombres y apellidos del beneficiario.';
  }

  if (!payload.domicilio) {
    return 'Ingresa el domicilio del beneficiario.';
  }

  if (!payload.id_genero || !new Set([1, 2]).has(payload.id_genero)) {
    return 'El genero del beneficiario no es valido.';
  }

  if (!payload.id_parentesco || !ALLOWED_PARENTESCOS[payload.tipo].has(payload.id_parentesco)) {
    return 'El parentesco no coincide con el tipo de beneficiario.';
  }

  if (!isValidDate(payload.fecha_nacimiento)) {
    return 'La fecha de nacimiento no es valida.';
  }

  return null;
}

function safeCompare(left, right) {
  const leftBuffer = Buffer.from(String(left));
  const rightBuffer = Buffer.from(String(right));

  if (leftBuffer.length !== rightBuffer.length) {
    return false;
  }

  return crypto.timingSafeEqual(leftBuffer, rightBuffer);
}

function getCookieOptions() {
  return {
    httpOnly: true,
    sameSite: 'Strict',
    secure: isProduction,
    path: '/'
  };
}

function serializeCookie(name, value, options = {}) {
  const parts = [`${name}=${encodeURIComponent(value)}`];

  if (options.maxAge !== undefined) {
    parts.push(`Max-Age=${options.maxAge}`);
  }

  if (options.expires) {
    parts.push(`Expires=${options.expires.toUTCString()}`);
  }

  if (options.httpOnly) {
    parts.push('HttpOnly');
  }

  if (options.secure) {
    parts.push('Secure');
  }

  if (options.sameSite) {
    parts.push(`SameSite=${options.sameSite}`);
  }

  parts.push(`Path=${options.path || '/'}`);
  return parts.join('; ');
}

function parseCookies(cookieHeader) {
  return String(cookieHeader || '')
    .split(';')
    .map((chunk) => chunk.trim())
    .filter(Boolean)
    .reduce((acc, chunk) => {
      const separatorIndex = chunk.indexOf('=');

      if (separatorIndex === -1) {
        return acc;
      }

      const key = chunk.slice(0, separatorIndex).trim();
      const value = chunk.slice(separatorIndex + 1).trim();
      acc[key] = decodeURIComponent(value);
      return acc;
    }, {});
}

function getUserAgentHash(req) {
  return crypto.createHash('sha256').update(String(req.get('user-agent') || '')).digest('hex');
}

function getSessionIdFromRequest(req) {
  const cookies = parseCookies(req.headers.cookie);
  return cookies[SESSION_COOKIE_NAME] || null;
}

function createSession(req) {
  const sessionId = crypto.randomBytes(32).toString('hex');
  const expiresAt = Date.now() + SESSION_TTL_MS;

  sessions.set(sessionId, {
    expiresAt,
    userAgentHash: getUserAgentHash(req)
  });

  return sessionId;
}

function getValidSession(sessionId, req) {
  if (!sessionId) {
    return null;
  }

  const session = sessions.get(sessionId);

  if (!session) {
    return null;
  }

  if (session.expiresAt <= Date.now()) {
    sessions.delete(sessionId);
    return null;
  }

  if (session.userAgentHash !== getUserAgentHash(req)) {
    sessions.delete(sessionId);
    return null;
  }

  return session;
}

function setSessionCookie(res, sessionId) {
  const expires = new Date(Date.now() + SESSION_TTL_MS);
  const cookie = serializeCookie(SESSION_COOKIE_NAME, sessionId, {
    ...getCookieOptions(),
    maxAge: Math.floor(SESSION_TTL_MS / 1000),
    expires
  });

  res.setHeader('Set-Cookie', cookie);
}

function clearSessionCookie(res) {
  const cookie = serializeCookie(SESSION_COOKIE_NAME, '', {
    ...getCookieOptions(),
    maxAge: 0,
    expires: new Date(0)
  });

  res.setHeader('Set-Cookie', cookie);
}

function refreshSession(res, sessionId, session) {
  session.expiresAt = Date.now() + SESSION_TTL_MS;
  sessions.set(sessionId, session);
  setSessionCookie(res, sessionId);
}

function getOrCreateFlowSession(req, res) {
  const existingSessionId = getSessionIdFromRequest(req);
  const existingSession = getValidSession(existingSessionId, req);

  if (existingSessionId && existingSession) {
    refreshSession(res, existingSessionId, existingSession);
    return { sessionId: existingSessionId, session: existingSession };
  }

  const sessionId = createSession(req);
  const session = sessions.get(sessionId);
  setSessionCookie(res, sessionId);
  return { sessionId, session };
}

function getRegistrationFlow(session) {
  if (!session || !session.registrationFlow || typeof session.registrationFlow !== 'object') {
    return null;
  }

  return session.registrationFlow;
}

function setRegistrationFlow(sessionId, session, collaborator) {
  session.registrationFlow = {
    colaborador: {
      id: collaborator.id,
      dni: normalizeDni(collaborator.dni),
      apellido_paterno: normalizeText(collaborator.apellido_paterno, 50),
      apellido_materno: normalizeText(collaborator.apellido_materno, 50),
      nombres: normalizeText(collaborator.nombres, 100),
      genero: normalizeText(collaborator.genero, 20)
    },
    beneficiarios: []
  };

  sessions.set(sessionId, session);
}

function addBeneficiaryToFlow(sessionId, session, beneficiary) {
  const registrationFlow = getRegistrationFlow(session);

  if (!registrationFlow) {
    return;
  }

  registrationFlow.beneficiarios = registrationFlow.beneficiarios
    .filter((item) => item.dni !== beneficiary.dni)
    .concat({
      tipo: beneficiary.tipo,
      dni: normalizeDni(beneficiary.dni),
      apellido_paterno: normalizeText(beneficiary.apellido_paterno, 50),
      apellido_materno: normalizeText(beneficiary.apellido_materno, 50),
      nombres: normalizeText(beneficiary.nombres, 100),
      fecha_nacimiento: normalizeText(beneficiary.fecha_nacimiento, 10),
      domicilio: normalizeText(beneficiary.domicilio, 250),
      parentesco: normalizeText(beneficiary.parentesco, 30)
    });

  sessions.set(sessionId, session);
}

function clearRegistrationFlow(sessionId, session) {
  if (!session) {
    return;
  }

  delete session.registrationFlow;
  sessions.set(sessionId, session);
}

function requireAuth(req, res, next) {
  if (!AUTH_REQUIRED) {
    return next();
  }

  const sessionId = getSessionIdFromRequest(req);
  const session = getValidSession(sessionId, req);

  if (!session) {
    clearSessionCookie(res);
    return res.status(401).json({ ok: false, msg: 'Tu sesion ha expirado. Vuelve a ingresar la clave.' });
  }

  refreshSession(res, sessionId, session);
  return next();
}

setInterval(() => {
  const now = Date.now();

  for (const [sessionId, session] of sessions.entries()) {
    if (session.expiresAt <= now) {
      sessions.delete(sessionId);
    }
  }
}, 10 * 60 * 1000).unref();

function buildPdfFileName(dni) {
  const safeDni = normalizeDni(dni) || 'documento';
  return `DJ_${safeDni}.pdf`;
}

function generarPDF(c, primeros, segundos) {
  return new Promise((resolve, reject) => {
    const doc = new PDFKit({ margin: 40, size: 'A4' });
    const chunks = [];

    doc.on('data', (chunk) => chunks.push(chunk));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);

    const left = 52;
    const usableWidth = doc.page.width - left * 2;
    const tableColumns = [118, 70, 92, 92, 140];
    const rowHeight = 24;
    const tableHeaderHeight = 38;
    const strokeColor = '#222222';
    const sectionGray = '#d9d9d9';

    const trabajador = `${c.apellido_paterno} ${c.apellido_materno}, ${c.nombres}`
      .replace(/\s+/g, ' ')
      .trim();

    function formatDate(value) {
      if (!value) return '';
      return new Date(value).toLocaleDateString('es-PE');
    }

    function fitText(value, max = 90) {
      const text = String(value || '').replace(/\s+/g, ' ').trim();
      if (!text) return '';
      return text.length > max ? `${text.slice(0, max - 3)}...` : text;
    }

    function drawCell(x, y, width, height, text, options = {}) {
      const {
        align = 'left',
        valign = 'center',
        bold = false,
        fill = null,
        fontSize = 9,
        padding = 6
      } = options;

      if (fill) {
        doc.save();
        doc.rect(x, y, width, height).fill(fill);
        doc.restore();
      }

      doc.rect(x, y, width, height).stroke(strokeColor);
      doc.font(bold ? 'Helvetica-Bold' : 'Helvetica');
      doc.fontSize(fontSize).fillColor('#000');

      const textHeight = doc.heightOfString(text || '', {
        width: width - padding * 2,
        align
      });

      let textY = y + padding;
      if (valign === 'center') {
        textY = y + Math.max((height - textHeight) / 2, padding / 2);
      }

      doc.text(text || '', x + padding, textY, {
        width: width - padding * 2,
        align
      });
    }

    function drawInfoRow(y, leftLabel, leftValue, rightLabel, rightValue) {
      const leftWidth = 320;
      const rightWidth = usableWidth - leftWidth;

      drawCell(left, y, leftWidth, 32, `${leftLabel}: ${leftValue || ''}`, { fontSize: 9.5 });
      drawCell(left + leftWidth, y, rightWidth, 32, `${rightLabel}: ${rightValue || ''}`, { fontSize: 9.5 });

      return y + 32;
    }

    function drawFullRow(y, label, value) {
      drawCell(left, y, usableWidth, 32, `${label}: ${value || ''}`, { fontSize: 9.5 });
      return y + 32;
    }

    function drawBeneficiariosTable(y, title, subtitle, rows, notes) {
      drawCell(left, y, usableWidth, 28, `${title}\n${subtitle}`, {
        fill: sectionGray,
        bold: true,
        fontSize: 9,
        padding: 4
      });
      y += 40;

      const headers = [
        'Nombre y apellidos',
        'DNI',
        'Parentesco',
        'Fecha de nacimiento',
        'Domicilio'
      ];

      let currentX = left;
      headers.forEach((header, index) => {
        drawCell(currentX, y, tableColumns[index], tableHeaderHeight, header, {
          bold: true,
          align: 'center',
          fontSize: 8.5,
          padding: 5
        });
        currentX += tableColumns[index];
      });
      y += tableHeaderHeight;

      const printableRows = rows.length ? rows : [{}];
      const totalRows = Math.max(printableRows.length, 3);

      for (let i = 0; i < totalRows; i++) {
        const row = printableRows[i] || {};
        const nombreCompleto = `${row.apellido_paterno || ''} ${row.apellido_materno || ''}, ${row.nombres || ''}`
          .replace(/^,\s*/, '')
          .replace(/\s+/g, ' ')
          .trim();

        const values = [
          fitText(nombreCompleto, 46),
          fitText(row.dni || '', 12),
          fitText(row.parentesco || '', 18),
          fitText(formatDate(row.fecha_nacimiento), 18),
          fitText(row.domicilio || '', 34)
        ];

        currentX = left;
        values.forEach((value, index) => {
          drawCell(currentX, y, tableColumns[index], rowHeight, value, {
            fontSize: 8.5,
            padding: 4
          });
          currentX += tableColumns[index];
        });
        y += rowHeight;
      }

      doc.font('Helvetica').fontSize(8.5).fillColor('#000');
      notes.forEach((note) => {
        doc.text(note, left, y + 4, {
          width: usableWidth,
          align: 'left'
        });
        y = doc.y + 2;
      });

      return y + 10;
    }

    function drawFirma(y) {
      const boxHeight = 110;
      drawCell(left, y, usableWidth, boxHeight, '', {});

      doc.moveTo(left + 40, y + 52)
        .lineTo(left + 250, y + 52)
        .stroke(strokeColor);

      doc.font('Helvetica').fontSize(8.5);
      doc.text('Firma del trabajador(a) asegurado(a)', left + 38, y + 56, {
        width: 220,
        align: 'center'
      });

      doc.fontSize(7.5);
      doc.text('(Legalizada notarialmente, o por\nJuez de Paz a falta de notario)', left + 46, y + 70, {
        width: 200,
        align: 'center'
      });

      doc.fontSize(10);
      doc.text('..........., ...... de ........................ del 20......', left + 272, y + 80, {
        width: 210,
        align: 'left'
      });
    }

    let y = 46;

    doc.font('Helvetica-Bold').fontSize(12).text('ANEXO', left, y, {
      width: usableWidth,
      align: 'center'
    });
    y = doc.y + 10;

    doc.fontSize(11.5).text(
      'FORMATO REFERENCIAL DE DECLARACION JURADA DE BENEFICIARIOS',
      left,
      y,
      { width: usableWidth, align: 'center' }
    );
    y = doc.y + 1;

    doc.text('DEL SEGURO DE VIDA', left, y, {
      width: usableWidth,
      align: 'center'
    });
    y = doc.y + 1;

    doc.fontSize(8.5).text(
      '(Decreto Legislativo N 688 y sus normas modificatorias, complementarias y reglamentarias)',
      left,
      y,
      { width: usableWidth, align: 'center' }
    );
    y = doc.y + 14;

    doc.font('Helvetica').fontSize(9);
    doc.text(
      'El/la suscrito(a), de acuerdo a lo dispuesto en el articulo 6 del Decreto Legislativo N 688, Ley de Consolidacion de Beneficios Sociales, formula la presente Declaracion Jurada sobre los beneficiarios del seguro de vida en caso de fallecimiento natural o en caso de fallecimiento a consecuencia de un accidente.',
      left,
      y,
      { width: usableWidth, align: 'justify' }
    );
    y = doc.y + 16;

    y = drawInfoRow(y, 'Nombres y apellidos del trabajador(a) asegurado(a)', trabajador, 'DNI', c.dni);
    y = drawFullRow(y, 'Nombre y apellidos o razon social del empleador', EMPLEADOR_NOMBRE);
    y += 18;

    y = drawBeneficiariosTable(
      y,
      'Primeros Beneficiarios:',
      'Conyuge o conviviente y descendientes (*) (**)',
      primeros,
      [
        '(*) A falta de conyuge, se puede nombrar como beneficiario a la persona con la cual conviva por un periodo minimo de dos (2) anos continuos, conforme al articulo 326 del Codigo Civil.',
        '(**) En el caso de los descendientes, solo a falta de hijos puede nombrarse nietos de conformidad con lo establecido en los articulos 816 y 817 del Codigo Civil.'
      ]
    );

    y = drawBeneficiariosTable(
      y,
      'Solo a falta de los Primeros Beneficiarios:',
      'Ascendientes y hermanos menores de dieciocho (18) anos (***)',
      segundos,
      [
        '(***) En el caso de los ascendientes, solo a falta de ambos padres puede nombrarse abuelos de conformidad con lo establecido en los articulos 816 y 817 del Codigo Civil.'
      ]
    );

    drawFirma(y + 8);
    doc.end();
  });
}

app.listen(PORT, () => {
  console.log(`Servidor en http://localhost:${PORT}`);
});
