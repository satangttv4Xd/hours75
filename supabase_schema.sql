-- Schema สำหรับฐานข้อมูล Supabase (PostgreSQL) ของระบบบันทึกเวลา 75 ชั่วโมง
-- หมายเหตุ: ระบบจะสร้างตารางและใส่ข้อมูลนักศึกษาเริ่มต้น 15 คนให้อัตโนมัติเมื่อเชื่อมต่อ DATABASE_URL
-- หรือคุณสามารถคัดลอกคำสั่งด้านล่างนี้ไปรันใน Supabase -> SQL Editor ได้เช่นกัน

-- 1. ตารางรายชื่อนักศึกษา
CREATE TABLE IF NOT EXISTS students (
  id TEXT PRIMARY KEY,
  prefix TEXT NOT NULL,
  first_name TEXT NOT NULL,
  last_name TEXT NOT NULL,
  department TEXT NOT NULL
);

-- 2. ตารางตารางงาน / การลงเวลาปฏิบัติงาน
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

CREATE INDEX IF NOT EXISTS idx_shifts_date_student ON shifts(work_date, student_id);

-- 3. ตารางบันทึกการพยายามเข้าสู่ระบบ (ป้องกัน Brute Force)
CREATE TABLE IF NOT EXISTS login_attempts (
  key TEXT PRIMARY KEY,
  count INTEGER NOT NULL,
  reset_at BIGINT NOT NULL
);

-- 4. ตารางบัญชีผู้ใช้นักศึกษา
CREATE TABLE IF NOT EXISTS accounts (
  student_id TEXT PRIMARY KEY REFERENCES students(id),
  password_hash TEXT NOT NULL,
  salt TEXT NOT NULL,
  session_version INTEGER NOT NULL DEFAULT 1,
  must_change INTEGER NOT NULL DEFAULT 1
);

-- ข้อมูลนักศึกษาเริ่มต้น 15 คน
INSERT INTO students (id, prefix, first_name, last_name, department) VALUES
  ('6811011662001', 'นาย', 'นิธิศ', 'เลิศรัชต์', 'กองคลัง'),
  ('6811011662003', 'นาย', 'ปภาวิน', 'วิริยวิชชากร', 'คณะพยาบาลศาสตร์'),
  ('6811011662008', 'นาย', 'ปภังกร', 'ทองเจริญ', 'กองคลัง'),
  ('6811011662010', 'นาย', 'อภิสิทธิ์', 'ศรีพัฒน์', 'คณะวิทยาศาสตร์และเทคโนโลยี'),
  ('6811011662016', 'นาย', 'นาธาน', 'บิลหร่อหีม', 'คณะพยาบาลศาสตร์'),
  ('6911011662001', 'นาย', 'ภูวิส', 'พิพิธกุล', 'กองคลัง'),
  ('6911011662002', 'นาย', 'นภัสพล', 'ผู้แสนสะอาด', 'โรงเรียนการเรือน'),
  ('6911011662003', 'นาย', 'วิมลลักษณ์', 'ชูทอง', 'โรงเรียนการเรือน'),
  ('6911011662004', 'นาย', 'ธนัญกรณ์', 'ภาคไพรศรี', 'บัณฑิตวิทยาลัย'),
  ('6911011662009', 'นาย', 'ทศวรรษ', 'คำบุญเรือง', 'คณะวิทยาศาสตร์และเทคโนโลยี'),
  ('6911011662011', 'นาย', 'ยูอุตะ', 'ยามาดะ', 'คณะวิทยาศาสตร์และเทคโนโลยี'),
  ('6911011662015', 'นาย', 'พีรพัฒน์', 'ศิลาโรจน์', 'สำนักนวัตกรรมชุมชน'),
  ('6911011662017', 'นางสาว', 'ชลินี', 'บุญชูวงค์', 'กองคลัง'),
  ('6911011662021', 'นาย', 'พงศกร', 'วัฒนบุตร', 'กองคลัง'),
  ('6911011662025', 'นาย', 'จาวา', 'เรืองขำ', 'บัณฑิตวิทยาลัย')
ON CONFLICT (id) DO NOTHING;
