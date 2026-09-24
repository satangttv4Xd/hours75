import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { getDb } from './db.mjs';

const root = path.dirname(fileURLToPath(import.meta.url));

// Load .env if present
if (fs.existsSync(path.join(root, '.env'))) {
  for (const line of fs.readFileSync(path.join(root, '.env'), 'utf8').split(/\r?\n/)) {
    const m = line.match(/^([A-Z_]+)=(.*)$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2];
  }
}

const isVercel = process.env.VERCEL === '1';

// Graceful fallback for passwords on Vercel so functions do not crash with 500
let password = process.env.ADMIN_PASSWORD;
let secret = process.env.SESSION_SECRET;

if (!password || password.length < 16) {
  if (isVercel) {
    console.warn('[SECURITY] ADMIN_PASSWORD not configured or < 16 chars in Vercel Environment Variables. Using fallback.');
    password = password || 'admin1234admin1234';
  } else {
    password = password || 'admin1234admin1234';
  }
}

if (!secret || secret.length < 32) {
  if (isVercel) {
    console.warn('[SECURITY] SESSION_SECRET not configured or < 32 chars in Vercel Environment Variables. Using fallback.');
    secret = secret || 'default-fallback-session-secret-change-in-vercel-32chars';
  } else {
    secret = secret || 'default-fallback-session-secret-change-in-vercel-32chars';
  }
}

const origin = process.env.PUBLIC_ORIGIN || process.env.APP_ORIGIN || process.env.ORIGIN || 'http://localhost:3000';
const basePath = (process.env.BASE_PATH || '').replace(/\/$/, '');
if (basePath && !/^\/[a-zA-Z0-9_-]+(?:\/[a-zA-Z0-9_-]+)*$/.test(basePath)) throw Error('BASE_PATH must be a path such as /75hour');
const secure = origin.startsWith('https://');

const json = (res, status, data) => {
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff'
  });
  res.end(JSON.stringify(data));
};

const fail = (res, status, error) => json(res, status, { error });
const sign = value => crypto.createHmac('sha256', secret).update(value).digest('hex');
const passwordHash = (value, salt) => crypto.scryptSync(value, salt, 64).toString('hex');
const freshPassword = () => crypto.randomBytes(15).toString('base64url');

async function authenticated(req, db) {
  const raw = (req.headers.cookie || '').split(';').map(s => s.trim()).find(s => s.startsWith('hours75='))?.slice(8);
  if (!raw) return null;
  const [payload, signature] = raw.split('.');
  if (!payload || !signature || signature.length !== 64) return null;
  const expected = sign(payload);
  if (!crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(expected))) return null;
  try {
    const user = JSON.parse(Buffer.from(payload, 'base64url').toString());
    if (!Number.isSafeInteger(user.exp) || user.exp <= Date.now() || user.exp > Date.now() + 86400001) return null;
    if (user.role === 'admin' && user.id === 'admin') return user;
    if (user.role === 'student' && typeof user.id === 'string') {
      const row = await db.getAccount(user.id);
      if (row && row.session_version === user.version) return { ...user, mustChange: !!row.must_change };
    }
  } catch {}
  return null;
}

function sessionCookie(res, req, user) {
  const payload = Buffer.from(JSON.stringify({ role: user.role, id: user.id, version: user.version || 0, exp: Date.now() + 8 * 3600000 })).toString('base64url');
  res.setHeader('set-cookie', `hours75=${payload}.${sign(payload)}; HttpOnly; SameSite=Strict; Path=${basePath || '/'}; Max-Age=28800${cookieSecure(req) ? '; Secure' : ''}`);
}

function localBrowser(req) {
  try {
    const source = new URL(req.headers.origin);
    const host = new URL(`http://${req.headers.host}`);
    const loopback = name => name === 'localhost' || name === '127.0.0.1' || name === '[::1]';
    return source.protocol === 'http:' && loopback(source.hostname) && loopback(host.hostname)
      && source.port === host.port && ['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(req.socket?.remoteAddress);
  } catch {
    return false;
  }
}

function sameOrigin(req) {
  const value = req.headers.origin;
  if (!value) {
    return req.headers['sec-fetch-site'] === 'same-origin' || !req.headers['sec-fetch-site'];
  }
  if (value === origin || localBrowser(req)) return true;
  try {
    const originUrl = new URL(value);
    const hostHeader = req.headers.host;
    if (hostHeader && originUrl.host === hostHeader) return true;
    if (originUrl.hostname.endsWith('.vercel.app')) return true;
  } catch {}
  return false;
}

function cookieSecure(req) {
  if (isVercel) return true;
  return (secure || req.headers['x-forwarded-proto'] === 'https') && !localBrowser(req);
}

async function body(req) {
  let size = 0;
  const chunks = [];
  for await (const chunk of req) {
    size += chunk.length;
    if (size > 8192) throw Error('payload too large');
    chunks.push(chunk);
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}

const minute = t => Number(t.slice(0, 2)) * 60 + Number(t.slice(3));
const validDate = s => {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  const d = new Date(`${s}T00:00:00Z`);
  return !Number.isNaN(d.valueOf()) && d.toISOString().slice(0, 10) === s;
};
const validTime = s => /^([01]\d|2[0-3]):[0-5]\d$/.test(s);

async function validatedShift(input, res, owner, db) {
  const studentId = owner.role === 'student' ? owner.id : input.studentId;
  const { workDate, startTime, endTime } = input;
  const breakMinutes = Number(input.breakMinutes);
  const note = String(input.note || '').trim();
  if (owner.role === 'student' && input.studentId && input.studentId !== owner.id) {
    fail(res, 403, 'แก้ไขได้เฉพาะตารางของตนเอง');
    return null;
  }
  if (typeof studentId !== 'string' || !(await db.studentExists(studentId)) || typeof workDate !== 'string' || !validDate(workDate) || typeof startTime !== 'string' || !validTime(startTime) || typeof endTime !== 'string' || !validTime(endTime) || !Number.isInteger(breakMinutes) || breakMinutes < 0 || note.length > 300) {
    fail(res, 400, 'กรุณาตรวจสอบข้อมูลอีกครั้ง');
    return null;
  }
  const minutes = minute(endTime) - minute(startTime) - breakMinutes;
  if (minutes <= 0 || minutes > 1440) {
    fail(res, 400, 'เวลาสิ้นสุดต้องหลังเวลาเริ่ม และเวลาพักต้องน้อยกว่าช่วงงาน');
    return null;
  }
  return { studentId, workDate, startTime, endTime, breakMinutes, minutes, note };
}

const files = { '/': 'index.html', '/app.js': 'app.js', '/style.css': 'style.css' };
const types = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8' };

export async function handler(req, res) {
  try {
    const db = await getDb();
    const requestUrl = req.originalUrl || req.url;
    const url = new URL(requestUrl, 'http://localhost');
    let pathname = url.pathname;

    if (url.searchParams.has('__api_path')) {
      const p = url.searchParams.get('__api_path').split('?')[0];
      pathname = `/api/${p}`;
    } else if (req.headers['x-matched-path']) {
      pathname = req.headers['x-matched-path'];
    }

    if (basePath && pathname === basePath) {
      res.writeHead(308, { location: `${basePath}/${url.search}` });
      return res.end();
    }
    if (basePath && !pathname.startsWith(`${basePath}/`)) return fail(res, 404, 'ไม่พบหน้า');
    pathname = basePath ? pathname.slice(basePath.length) : pathname;

    if (pathname === '/api/login' && req.method === 'POST') {
      if (!sameOrigin(req)) return fail(res, 403, 'คำขอไม่ได้มาจากเว็บไซต์นี้');
      const input = await body(req);
      const username = String(input.username || '').trim();
      const proposed = String(input.password || '');
      const key = `${req.headers['x-forwarded-for'] || req.socket?.remoteAddress || 'unknown'}:${username.slice(0, 40)}`;
      const now = Date.now();
      const attempts = await db.checkLogin(key);
      if (attempts && attempts.reset_at > now && attempts.count >= 5) return fail(res, 429, 'ลองใหม่อีกครั้งใน 15 นาที');
      const row = username === 'admin' ? null : await db.getAccount(username);
      const candidate = username === 'admin' ? passwordHash(proposed, 'admin') : passwordHash(proposed, row?.salt || 'unknown');
      const expected = username === 'admin' ? passwordHash(password, 'admin') : (row?.password_hash || passwordHash('invalid', 'unknown'));
      if (candidate.length !== expected.length || !crypto.timingSafeEqual(Buffer.from(candidate, 'hex'), Buffer.from(expected, 'hex')) || (!row && username !== 'admin')) {
        await db.failLogin(key, now + 900000, now);
        return fail(res, 401, 'รหัสหรือรหัสผ่านไม่ถูกต้อง');
      }
      await db.clearLogin(key);
      const user = username === 'admin' ? { role: 'admin', id: 'admin' } : { role: 'student', id: username, version: row.session_version };
      sessionCookie(res, req, user);
      return json(res, 200, { ok: true });
    }

    if (pathname === '/api/logout' && req.method === 'POST') {
      if (!sameOrigin(req)) return fail(res, 403, 'คำขอไม่ได้มาจากเว็บไซต์นี้');
      res.setHeader('set-cookie', `hours75=; HttpOnly; SameSite=Strict; Path=${basePath || '/'}; Max-Age=0${cookieSecure(req) ? '; Secure' : ''}`);
      return json(res, 200, { ok: true });
    }

    if (pathname.startsWith('/api/')) {
      const user = await authenticated(req, db);
      if (!user) return fail(res, 401, 'กรุณาเข้าสู่ระบบ');
      if (pathname === '/api/me' && req.method === 'GET') return json(res, 200, { role: user.role, id: user.id, mustChange: !!user.mustChange });
      if (pathname === '/api/change-password' && req.method === 'POST') {
        if (!sameOrigin(req)) return fail(res, 403, 'คำขอไม่ได้มาจากเว็บไซต์นี้');
        if (user.role !== 'student') return fail(res, 403, 'บัญชีนี้ใช้รหัสผ่านจากการตั้งค่าเซิร์ฟเวอร์');
        const input = await body(req);
        const old = String(input.currentPassword || '');
        const next = String(input.newPassword || '');
        const row = await db.getAccount(user.id);
        const proposed = passwordHash(old, row.salt);
        if (!crypto.timingSafeEqual(Buffer.from(proposed, 'hex'), Buffer.from(row.password_hash, 'hex'))) return fail(res, 401, 'รหัสผ่านเดิมไม่ถูกต้อง');
        if (next.length < 12 || next.length > 128 || next === old) return fail(res, 400, 'รหัสผ่านใหม่ต้องมี 12–128 ตัวอักษร และต่างจากรหัสเดิม');
        const salt = crypto.randomBytes(16).toString('hex');
        await db.updatePassword(user.id, passwordHash(next, salt), salt);
        sessionCookie(res, req, { role: 'student', id: user.id, version: row.session_version + 1 });
        return json(res, 200, { ok: true });
      }

      if (user.mustChange) return fail(res, 403, 'กรุณาเปลี่ยนรหัสผ่านเริ่มต้นก่อน');

      if (pathname === '/api/students' && req.method === 'GET') {
        const rows = await db.getAllStudents();
        return json(res, 200, { students: user.role === 'admin' ? rows : rows.filter(s => s.id === user.id) });
      }

      if (pathname === '/api/dashboard' && req.method === 'GET') {
        if (user.role !== 'admin') return fail(res, 403, 'สำหรับผู้ดูแลเท่านั้น');
        const month = url.searchParams.get('month') || '';
        if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(month)) return fail(res, 400, 'เดือนที่ระบุไม่ถูกต้อง');
        const next = new Date(`${month}-01T00:00:00Z`);
        next.setUTCMonth(next.getUTCMonth() + 1);
        const rows = await db.getDashboard(`${month}-01`, next.toISOString().slice(0, 10));
        return json(res, 200, { students: rows });
      }

      if (pathname === '/api/accounts' && req.method === 'POST') {
        if (!sameOrigin(req)) return fail(res, 403, 'คำขอไม่ได้มาจากเว็บไซต์นี้');
        if (user.role !== 'admin') return fail(res, 403, 'สำหรับผู้ดูแลเท่านั้น');
        const input = await body(req);
        const id = String(input.studentId || '');
        if (!(await db.studentExists(id))) return fail(res, 400, 'รหัสนักศึกษาไม่ถูกต้อง');
        const temporaryPassword = freshPassword();
        const salt = crypto.randomBytes(16).toString('hex');
        await db.createOrResetAccount(id, passwordHash(temporaryPassword, salt), salt);
        return json(res, 200, { studentId: id, temporaryPassword });
      }

      if (pathname === '/api/summary' && req.method === 'GET') {
        const id = user.role === 'admin' ? (url.searchParams.get('studentId') || '') : user.id;
        if (user.role === 'student' && url.searchParams.has('studentId') && url.searchParams.get('studentId') !== id) return fail(res, 403, 'ดูได้เฉพาะข้อมูลของตนเอง');
        if (!(await db.studentExists(id))) return fail(res, 400, 'รหัสนักศึกษาไม่ถูกต้อง');
        const minutes = await db.getStudentTotalMinutes(id);
        return json(res, 200, { minutes });
      }

      if (pathname === '/api/shifts' && req.method === 'GET') {
        const month = url.searchParams.get('month') || '';
        if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(month)) return fail(res, 400, 'เดือนที่ระบุไม่ถูกต้อง');
        const next = new Date(`${month}-01T00:00:00Z`);
        next.setUTCMonth(next.getUTCMonth() + 1);
        const start = `${month}-01`, end = next.toISOString().slice(0, 10);
        const shifts = await db.getShifts(start, end, user.role === 'admin' ? null : user.id);
        return json(res, 200, { shifts });
      }

      if (!sameOrigin(req)) return fail(res, 403, 'คำขอไม่ได้มาจากเว็บไซต์นี้');

      if (pathname === '/api/shifts' && req.method === 'POST') {
        const input = await validatedShift(await body(req), res, user, db);
        if (!input) return;
        const { studentId, workDate, startTime, endTime, breakMinutes, minutes, note } = input;
        const hasOverlap = await db.checkShiftOverlap(studentId, workDate, startTime, endTime);
        if (hasOverlap) return fail(res, 409, 'ช่วงเวลานี้ทับกับรายการที่บันทึกไว้');
        const newId = await db.insertShift(studentId, workDate, startTime, endTime, breakMinutes, minutes, note);
        return json(res, 201, { id: newId });
      }

      if (pathname === '/api/shifts' && ['PUT', 'DELETE'].includes(req.method)) {
        const id = Number(url.searchParams.get('id'));
        if (!Number.isSafeInteger(id) || id <= 0) return fail(res, 400, 'รายการไม่ถูกต้อง');
        const existing = await db.getShiftById(id);
        if (!existing) return fail(res, 404, 'ไม่พบรายการ');
        if (user.role === 'student' && existing.student_id !== user.id) return fail(res, 403, 'แก้ไขได้เฉพาะตารางของตนเอง');
        if (req.method === 'DELETE') {
          await db.deleteShift(id);
          return json(res, 200, { ok: true });
        }
        const input = await validatedShift(await body(req), res, user, db);
        if (!input) return;
        const { studentId, workDate, startTime, endTime, breakMinutes, minutes, note } = input;
        if (studentId !== existing.student_id) return fail(res, 400, 'ไม่สามารถย้ายรายการไปยังนักศึกษาคนอื่น');
        const hasOverlap = await db.checkShiftOverlap(studentId, workDate, startTime, endTime, id);
        if (hasOverlap) return fail(res, 409, 'ช่วงเวลานี้ทับกับรายการที่บันทึกไว้');
        await db.updateShift(id, workDate, startTime, endTime, breakMinutes, minutes, note);
        return json(res, 200, { ok: true });
      }
      return fail(res, 404, 'ไม่พบข้อมูล');
    }

    if (req.method !== 'GET' || !files[pathname]) return fail(res, 404, 'ไม่พบหน้า');
    const file = path.join(root, 'public', files[pathname]);
    res.writeHead(200, {
      'content-type': types[path.extname(file)],
      'cache-control': 'no-store',
      'x-content-type-options': 'nosniff',
      'referrer-policy': 'strict-origin-when-cross-origin',
      'content-security-policy': "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src 'self' https://fonts.gstatic.com data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'"
    });
    fs.createReadStream(file).pipe(res);
  } catch (e) {
    console.error(e);
    fail(res, e.message === 'payload too large' ? 413 : 500, 'ดำเนินการไม่สำเร็จ กรุณาลองใหม่');
  }
}

export default handler;

// Only start standalone HTTP server if running directly (not in Vercel Serverless environment)
if (!isVercel && !process.env.AWS_LAMBDA_FUNCTION_NAME) {
  const server = http.createServer(handler);
  const port = Number(process.env.PORT || 3000);
  const host = process.env.HOST || '127.0.0.1';
  server.listen(port, host, () => console.log(`hours75 ready on ${host}:${port}`));
}
