import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.dirname(fileURLToPath(import.meta.url));

export const people = [
  ['6811011662001', 'นาย', 'นิธิศ', 'เลิศรัชต์', 'กองคลัง'],
  ['6811011662003', 'นาย', 'ปภาวิน', 'วิริยวิชชากร', 'คณะพยาบาลศาสตร์'],
  ['6811011662008', 'นาย', 'ปภังกร', 'ทองเจริญ', 'กองคลัง'],
  ['6811011662010', 'นาย', 'อภิสิทธิ์', 'ศรีพัฒน์', 'คณะวิทยาศาสตร์และเทคโนโลยี'],
  ['6811011662016', 'นาย', 'นาธาน', 'บิลหร่อหีม', 'คณะพยาบาลศาสตร์'],
  ['6911011662001', 'นาย', 'ภูวิส', 'พิพิธกุล', 'กองคลัง'],
  ['6911011662002', 'นาย', 'นภัสพล', 'ผู้แสนสะอาด', 'โรงเรียนการเรือน'],
  ['6911011662003', 'นาย', 'วิมลลักษณ์', 'ชูทอง', 'โรงเรียนการเรือน'],
  ['6911011662004', 'นาย', 'ธนัญกรณ์', 'ภาคไพรศรี', 'บัณฑิตวิทยาลัย'],
  ['6911011662009', 'นาย', 'ทศวรรษ', 'คำบุญเรือง', 'คณะวิทยาศาสตร์และเทคโนโลยี'],
  ['6911011662011', 'นาย', 'ยูอุตะ', 'ยามาดะ', 'คณะวิทยาศาสตร์และเทคโนโลยี'],
  ['6911011662015', 'นาย', 'พีรพัฒน์', 'ศิลาโรจน์', 'สำนักนวัตกรรมชุมชน'],
  ['6911011662017', 'นางสาว', 'ชลินี', 'บุญชูวงค์', 'กองคลัง'],
  ['6911011662021', 'นาย', 'พงศกร', 'วัฒนบุตร', 'กองคลัง'],
  ['6911011662025', 'นาย', 'จาวา', 'เรืองขำ', 'บัณฑิตวิทยาลัย']
];

const dbUrl = process.env.DATABASE_URL || process.env.POSTGRES_URL || process.env.SUPABASE_DATABASE_URL;

class PostgresAdapter {
  constructor(connectionString) {
    this.connectionString = connectionString;
    this.sql = null;
    this.initialized = false;
  }

  async getClient() {
    if (!this.sql) {
      const { default: postgres } = await import('postgres');
      this.sql = postgres(this.connectionString, {
        ssl: 'require',
        max: 5,
        idle_timeout: 20,
        connect_timeout: 10
      });
    }
    if (!this.initialized) {
      await this.init();
      this.initialized = true;
    }
    return this.sql;
  }

  async init() {
    const sql = this.sql;
    await sql`
      CREATE TABLE IF NOT EXISTS students (
        id TEXT PRIMARY KEY,
        prefix TEXT NOT NULL,
        first_name TEXT NOT NULL,
        last_name TEXT NOT NULL,
        department TEXT NOT NULL
      );
    `;
    await sql`
      CREATE TABLE IF NOT EXISTS shifts (
        id BIGSERIAL PRIMARY KEY,
        student_id TEXT NOT NULL REFERENCES students(id),
        work_date TEXT NOT NULL,
        start_time TEXT NOT NULL,
        end_time TEXT NOT NULL,
        break_minutes INTEGER NOT NULL,
        minutes INTEGER NOT NULL,
        note TEXT NOT NULL DEFAULT '',
        created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
      );
    `;
    await sql`CREATE INDEX IF NOT EXISTS idx_shifts_date_student ON shifts(work_date, student_id);`;
    await sql`
      CREATE TABLE IF NOT EXISTS login_attempts (
        key TEXT PRIMARY KEY,
        count INTEGER NOT NULL,
        reset_at BIGINT NOT NULL
      );
    `;
    await sql`
      CREATE TABLE IF NOT EXISTS accounts (
        student_id TEXT PRIMARY KEY REFERENCES students(id),
        password_hash TEXT NOT NULL,
        salt TEXT NOT NULL,
        session_version INTEGER NOT NULL DEFAULT 1,
        must_change INTEGER NOT NULL DEFAULT 1
      );
    `;

    for (const row of people) {
      await sql`
        INSERT INTO students (id, prefix, first_name, last_name, department)
        VALUES (${row[0]}, ${row[1]}, ${row[2]}, ${row[3]}, ${row[4]})
        ON CONFLICT (id) DO NOTHING;
      `;
    }
  }

  async getAccount(studentId) {
    const sql = await this.getClient();
    const rows = await sql`
      SELECT student_id, password_hash, salt, session_version, must_change
      FROM accounts
      WHERE student_id = ${studentId}
    `;
    return rows[0] || null;
  }

  async checkLogin(key) {
    const sql = await this.getClient();
    const rows = await sql`SELECT count, reset_at FROM login_attempts WHERE key = ${key}`;
    return rows[0] ? { count: Number(rows[0].count), reset_at: Number(rows[0].reset_at) } : null;
  }

  async failLogin(key, resetAt, now) {
    const sql = await this.getClient();
    await sql`
      INSERT INTO login_attempts (key, count, reset_at)
      VALUES (${key}, 1, ${resetAt})
      ON CONFLICT (key) DO UPDATE SET
        count = CASE WHEN login_attempts.reset_at < ${now} THEN 1 ELSE login_attempts.count + 1 END,
        reset_at = CASE WHEN login_attempts.reset_at < ${now} THEN EXCLUDED.reset_at ELSE login_attempts.reset_at END
    `;
  }

  async clearLogin(key) {
    const sql = await this.getClient();
    await sql`DELETE FROM login_attempts WHERE key = ${key}`;
  }

  async studentExists(id) {
    const sql = await this.getClient();
    const rows = await sql`SELECT 1 FROM students WHERE id = ${id}`;
    return rows.length > 0;
  }

  async getAllStudents() {
    const sql = await this.getClient();
    return await sql`
      SELECT id, prefix, first_name AS "firstName", last_name AS "lastName", department
      FROM students
      ORDER BY id
    `;
  }

  async getDashboard(startDate, endDate) {
    const sql = await this.getClient();
    return await sql`
      SELECT s.id, s.prefix, s.first_name AS "firstName", s.last_name AS "lastName", s.department,
        COALESCE((SELECT SUM(minutes) FROM shifts WHERE student_id = s.id AND work_date >= ${startDate} AND work_date < ${endDate}), 0)::INT AS "monthMinutes",
        COALESCE((SELECT SUM(minutes) FROM shifts WHERE student_id = s.id), 0)::INT AS "totalMinutes",
        CASE WHEN a.student_id IS NULL THEN 0 ELSE 1 END AS "hasAccount"
      FROM students s
      LEFT JOIN accounts a ON a.student_id = s.id
      ORDER BY s.id
    `;
  }

  async createOrResetAccount(studentId, passwordHash, salt) {
    const sql = await this.getClient();
    await sql`
      INSERT INTO accounts (student_id, password_hash, salt, session_version, must_change)
      VALUES (${studentId}, ${passwordHash}, ${salt}, 1, 1)
      ON CONFLICT (student_id) DO UPDATE SET
        password_hash = EXCLUDED.password_hash,
        salt = EXCLUDED.salt,
        session_version = accounts.session_version + 1,
        must_change = 1
    `;
  }

  async updatePassword(studentId, passwordHash, salt) {
    const sql = await this.getClient();
    await sql`
      UPDATE accounts
      SET password_hash = ${passwordHash},
          salt = ${salt},
          session_version = session_version + 1,
          must_change = 0
      WHERE student_id = ${studentId}
    `;
  }

  async getStudentTotalMinutes(studentId) {
    const sql = await this.getClient();
    const rows = await sql`SELECT COALESCE(SUM(minutes), 0)::INT AS minutes FROM shifts WHERE student_id = ${studentId}`;
    return rows[0] ? Number(rows[0].minutes) : 0;
  }

  async getShifts(startDate, endDate, studentId) {
    const sql = await this.getClient();
    if (studentId) {
      return await sql`
        SELECT id, student_id, work_date, start_time, end_time, break_minutes, minutes, note
        FROM shifts
        WHERE student_id = ${studentId} AND work_date >= ${startDate} AND work_date < ${endDate}
        ORDER BY work_date, start_time, id
      `;
    }
    return await sql`
      SELECT id, student_id, work_date, start_time, end_time, break_minutes, minutes, note
      FROM shifts
      WHERE work_date >= ${startDate} AND work_date < ${endDate}
      ORDER BY work_date, start_time, id
    `;
  }

  async checkShiftOverlap(studentId, workDate, startTime, endTime, excludeShiftId) {
    const sql = await this.getClient();
    let rows;
    if (excludeShiftId) {
      rows = await sql`
        SELECT id FROM shifts
        WHERE student_id = ${studentId} AND work_date = ${workDate}
          AND start_time < ${endTime} AND end_time > ${startTime}
          AND id <> ${excludeShiftId}
        LIMIT 1
      `;
    } else {
      rows = await sql`
        SELECT id FROM shifts
        WHERE student_id = ${studentId} AND work_date = ${workDate}
          AND start_time < ${endTime} AND end_time > ${startTime}
        LIMIT 1
      `;
    }
    return rows.length > 0;
  }

  async insertShift(studentId, workDate, startTime, endTime, breakMinutes, minutes, note) {
    const sql = await this.getClient();
    const rows = await sql`
      INSERT INTO shifts (student_id, work_date, start_time, end_time, break_minutes, minutes, note)
      VALUES (${studentId}, ${workDate}, ${startTime}, ${endTime}, ${breakMinutes}, ${minutes}, ${note})
      RETURNING id
    `;
    return Number(rows[0].id);
  }

  async getShiftById(id) {
    const sql = await this.getClient();
    const rows = await sql`SELECT student_id FROM shifts WHERE id = ${id}`;
    return rows[0] || null;
  }

  async deleteShift(id) {
    const sql = await this.getClient();
    await sql`DELETE FROM shifts WHERE id = ${id}`;
  }

  async updateShift(id, workDate, startTime, endTime, breakMinutes, minutes, note) {
    const sql = await this.getClient();
    await sql`
      UPDATE shifts
      SET work_date = ${workDate},
          start_time = ${startTime},
          end_time = ${endTime},
          break_minutes = ${breakMinutes},
          minutes = ${minutes},
          note = ${note}
      WHERE id = ${id}
    `;
  }
}

class SqliteAdapter {
  constructor() {
    this.db = null;
    this.stmts = {};
    this.init();
  }

  init() {
    let DatabaseSync;
    try {
      // Dynamic require / import
      const sqliteModule = awaitImportSqlite();
      DatabaseSync = sqliteModule.DatabaseSync;
    } catch {
      throw new Error('SQLite (DatabaseSync) is not available. Please provide DATABASE_URL (Supabase/PostgreSQL) in environment variables.');
    }

    const isVercel = process.env.VERCEL === '1';
    const defaultDataDir = isVercel ? '/tmp' : './data';
    const dataDir = path.resolve(root, process.env.DATA_DIR || defaultDataDir);
    try {
      fs.mkdirSync(dataDir, { recursive: true, mode: 0o700 });
    } catch {}

    const dbPath = path.join(dataDir, 'hours75.sqlite');
    this.db = new DatabaseSync(dbPath);

    this.db.exec(`
      PRAGMA journal_mode=WAL;
      PRAGMA foreign_keys=ON;
      CREATE TABLE IF NOT EXISTS students (id TEXT PRIMARY KEY, prefix TEXT NOT NULL, first_name TEXT NOT NULL, last_name TEXT NOT NULL, department TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS shifts (id INTEGER PRIMARY KEY AUTOINCREMENT, student_id TEXT NOT NULL REFERENCES students(id), work_date TEXT NOT NULL, start_time TEXT NOT NULL, end_time TEXT NOT NULL, break_minutes INTEGER NOT NULL, minutes INTEGER NOT NULL, note TEXT NOT NULL DEFAULT '', created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP);
      CREATE INDEX IF NOT EXISTS idx_shifts_date_student ON shifts(work_date,student_id);
      CREATE TABLE IF NOT EXISTS login_attempts (key TEXT PRIMARY KEY, count INTEGER NOT NULL, reset_at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS accounts (student_id TEXT PRIMARY KEY REFERENCES students(id), password_hash TEXT NOT NULL, salt TEXT NOT NULL, session_version INTEGER NOT NULL DEFAULT 1, must_change INTEGER NOT NULL DEFAULT 1);
    `);

    const seed = this.db.prepare('INSERT OR IGNORE INTO students (id,prefix,first_name,last_name,department) VALUES (?,?,?,?,?)');
    for (const row of people) seed.run(...row);

    this.stmts = {
      account: this.db.prepare('SELECT student_id,password_hash,salt,session_version,must_change FROM accounts WHERE student_id=?'),
      loginCheck: this.db.prepare('SELECT count,reset_at FROM login_attempts WHERE key=?'),
      loginFail: this.db.prepare('INSERT INTO login_attempts(key,count,reset_at) VALUES(?,1,?) ON CONFLICT(key) DO UPDATE SET count=CASE WHEN reset_at<? THEN 1 ELSE count+1 END, reset_at=CASE WHEN reset_at<? THEN excluded.reset_at ELSE reset_at END'),
      loginClear: this.db.prepare('DELETE FROM login_attempts WHERE key=?'),
      studentExists: this.db.prepare('SELECT 1 FROM students WHERE id=?'),
      allStudents: this.db.prepare('SELECT id,prefix,first_name AS firstName,last_name AS lastName,department FROM students ORDER BY id'),
      dashboard: this.db.prepare(`SELECT s.id,s.prefix,s.first_name AS firstName,s.last_name AS lastName,s.department,
        COALESCE((SELECT SUM(minutes) FROM shifts WHERE student_id=s.id AND work_date>=? AND work_date<?),0) AS monthMinutes,
        COALESCE((SELECT SUM(minutes) FROM shifts WHERE student_id=s.id),0) AS totalMinutes,
        CASE WHEN a.student_id IS NULL THEN 0 ELSE 1 END AS hasAccount
        FROM students s LEFT JOIN accounts a ON a.student_id=s.id ORDER BY s.id`),
      createAccount: this.db.prepare('INSERT INTO accounts(student_id,password_hash,salt) VALUES(?,?,?) ON CONFLICT(student_id) DO UPDATE SET password_hash=excluded.password_hash,salt=excluded.salt,session_version=session_version+1,must_change=1'),
      updatePassword: this.db.prepare('UPDATE accounts SET password_hash=?,salt=?,session_version=session_version+1,must_change=0 WHERE student_id=?'),
      sumStudent: this.db.prepare('SELECT COALESCE(SUM(minutes),0) AS minutes FROM shifts WHERE student_id=?'),
      list: this.db.prepare('SELECT id,student_id,work_date,start_time,end_time,break_minutes,minutes,note FROM shifts WHERE work_date>=? AND work_date<? ORDER BY work_date,start_time,id'),
      scopedList: this.db.prepare('SELECT id,student_id,work_date,start_time,end_time,break_minutes,minutes,note FROM shifts WHERE student_id=? AND work_date>=? AND work_date<? ORDER BY work_date,start_time,id'),
      overlap: this.db.prepare('SELECT id FROM shifts WHERE student_id=? AND work_date=? AND start_time<? AND end_time>? LIMIT 1'),
      editOverlap: this.db.prepare('SELECT id FROM shifts WHERE student_id=? AND work_date=? AND start_time<? AND end_time>? AND id<>? LIMIT 1'),
      insert: this.db.prepare('INSERT INTO shifts(student_id,work_date,start_time,end_time,break_minutes,minutes,note) VALUES(?,?,?,?,?,?,?)'),
      shiftById: this.db.prepare('SELECT student_id FROM shifts WHERE id=?'),
      remove: this.db.prepare('DELETE FROM shifts WHERE id=?'),
      update: this.db.prepare('UPDATE shifts SET work_date=?,start_time=?,end_time=?,break_minutes=?,minutes=?,note=? WHERE id=?')
    };
  }

  async getAccount(studentId) {
    return this.stmts.account.get(studentId) || null;
  }

  async checkLogin(key) {
    const row = this.stmts.loginCheck.get(key);
    return row ? { count: Number(row.count), reset_at: Number(row.reset_at) } : null;
  }

  async failLogin(key, resetAt, now) {
    this.stmts.loginFail.run(key, resetAt, now, now);
  }

  async clearLogin(key) {
    this.stmts.loginClear.run(key);
  }

  async studentExists(id) {
    return !!this.stmts.studentExists.get(id);
  }

  async getAllStudents() {
    return this.stmts.allStudents.all();
  }

  async getDashboard(startDate, endDate) {
    return this.stmts.dashboard.all(startDate, endDate);
  }

  async createOrResetAccount(studentId, passwordHash, salt) {
    this.stmts.createAccount.run(studentId, passwordHash, salt);
  }

  async updatePassword(studentId, passwordHash, salt) {
    this.stmts.updatePassword.run(passwordHash, salt, studentId);
  }

  async getStudentTotalMinutes(studentId) {
    return Number(this.stmts.sumStudent.get(studentId).minutes);
  }

  async getShifts(startDate, endDate, studentId) {
    return studentId
      ? this.stmts.scopedList.all(studentId, startDate, endDate)
      : this.stmts.list.all(startDate, endDate);
  }

  async checkShiftOverlap(studentId, workDate, startTime, endTime, excludeShiftId) {
    return excludeShiftId
      ? !!this.stmts.editOverlap.get(studentId, workDate, endTime, startTime, excludeShiftId)
      : !!this.stmts.overlap.get(studentId, workDate, endTime, startTime);
  }

  async insertShift(studentId, workDate, startTime, endTime, breakMinutes, minutes, note) {
    const result = this.stmts.insert.run(studentId, workDate, startTime, endTime, breakMinutes, minutes, note);
    return Number(result.lastInsertRowid);
  }

  async getShiftById(id) {
    return this.stmts.shiftById.get(id) || null;
  }

  async deleteShift(id) {
    this.stmts.remove.run(id);
  }

  async updateShift(id, workDate, startTime, endTime, breakMinutes, minutes, note) {
    this.stmts.update.run(workDate, startTime, endTime, breakMinutes, minutes, note, id);
  }
}

// Helper to safely import node:sqlite only when needed
let sqliteCache = null;
function awaitImportSqlite() {
  if (sqliteCache) return sqliteCache;
  try {
    // eslint-disable-next-line no-undef
    const req = typeof require !== 'undefined' ? require : null;
    if (req) {
      sqliteCache = req('node:sqlite');
      return sqliteCache;
    }
  } catch {}
  throw new Error('node:sqlite not found');
}

// In Node ES module context, dynamically import node:sqlite
let dbInstance = null;
export async function getDb() {
  if (dbInstance) return dbInstance;
  const url = process.env.DATABASE_URL || process.env.POSTGRES_URL || process.env.SUPABASE_DATABASE_URL;
  if (url) {
    dbInstance = new PostgresAdapter(url);
    await dbInstance.getClient(); // Ensure initialized
    return dbInstance;
  }

  try {
    const { DatabaseSync } = await import('node:sqlite');
    sqliteCache = { DatabaseSync };
  } catch {
    console.warn('[DB] node:sqlite is not available in this Node runtime.');
  }

  dbInstance = new SqliteAdapter();
  return dbInstance;
}
