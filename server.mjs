import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';

const root = path.dirname(fileURLToPath(import.meta.url));
for (const line of (fs.existsSync(path.join(root,'.env')) ? fs.readFileSync(path.join(root,'.env'),'utf8') : '').split(/\r?\n/)) {
  const m=line.match(/^([A-Z_]+)=(.*)$/); if(m && !process.env[m[1]]) process.env[m[1]]=m[2];
}
const password=process.env.ADMIN_PASSWORD;
const secret=process.env.SESSION_SECRET;
if(!password || password.length<16 || !secret || secret.length<32) throw Error('Set ADMIN_PASSWORD (16+ chars) and SESSION_SECRET (32+ chars) in .env');
const origin=process.env.PUBLIC_ORIGIN || 'http://localhost:3000';
const basePath=(process.env.BASE_PATH||'').replace(/\/$/,'');
if(basePath && !/^\/[a-zA-Z0-9_-]+(?:\/[a-zA-Z0-9_-]+)*$/.test(basePath)) throw Error('BASE_PATH must be a path such as /75hour');
const secure=origin.startsWith('https://');
const dataDir=path.resolve(root,process.env.DATA_DIR || './data');
fs.mkdirSync(dataDir,{recursive:true,mode:0o700});
const db=new DatabaseSync(path.join(dataDir,'hours75.sqlite'));
db.exec(`PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON;
CREATE TABLE IF NOT EXISTS students (id TEXT PRIMARY KEY, prefix TEXT NOT NULL, first_name TEXT NOT NULL, last_name TEXT NOT NULL, department TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS shifts (id INTEGER PRIMARY KEY AUTOINCREMENT, student_id TEXT NOT NULL REFERENCES students(id), work_date TEXT NOT NULL, start_time TEXT NOT NULL, end_time TEXT NOT NULL, break_minutes INTEGER NOT NULL, minutes INTEGER NOT NULL, note TEXT NOT NULL DEFAULT '', created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP);
CREATE INDEX IF NOT EXISTS idx_shifts_date_student ON shifts(work_date,student_id);
CREATE TABLE IF NOT EXISTS login_attempts (key TEXT PRIMARY KEY, count INTEGER NOT NULL, reset_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS accounts (student_id TEXT PRIMARY KEY REFERENCES students(id), password_hash TEXT NOT NULL, salt TEXT NOT NULL, session_version INTEGER NOT NULL DEFAULT 1, must_change INTEGER NOT NULL DEFAULT 1);`);
const people=[
['6811011662001','นาย','นิธิศ','เลิศรัชต์','กองคลัง'],
['6811011662003','นาย','ปภาวิน','วิริยวิชชากร','คณะพยาบาลศาสตร์'],
['6811011662008','นาย','ปภังกร','ทองเจริญ','กองคลัง'],
['6811011662010','นาย','อภิสิทธิ์','ศรีพัฒน์','คณะวิทยาศาสตร์และเทคโนโลยี'],
['6811011662016','นาย','นาธาน','บิลหร่อหีม','คณะพยาบาลศาสตร์'],
['6911011662001','นาย','ภูวิส','พิพิธกุล','กองคลัง'],
['6911011662002','นาย','นภัสพล','ผู้แสนสะอาด','โรงเรียนการเรือน'],
['6911011662003','นาย','วิมลลักษณ์','ชูทอง','โรงเรียนการเรือน'],
['6911011662004','นาย','ธนัญกรณ์','ภาคไพรศรี','บัณฑิตวิทยาลัย'],
['6911011662009','นาย','ทศวรรษ','คำบุญเรือง','คณะวิทยาศาสตร์และเทคโนโลยี'],
['6911011662011','นาย','ยูอุตะ','ยามาดะ','คณะวิทยาศาสตร์และเทคโนโลยี'],
['6911011662015','นาย','พีรพัฒน์','ศิลาโรจน์','สำนักนวัตกรรมชุมชน'],
['6911011662017','นางสาว','ชลินี','บุญชูวงค์','กองคลัง'],
['6911011662021','นาย','พงศกร','วัฒนบุตร','กองคลัง'],
['6911011662025','นาย','จาวา','เรืองขำ','บัณฑิตวิทยาลัย']
];
const seed=db.prepare('INSERT OR IGNORE INTO students (id,prefix,first_name,last_name,department) VALUES (?,?,?,?,?)');
for(const row of people) seed.run(...row);
const json=(res,status,data)=>{res.writeHead(status,{'content-type':'application/json; charset=utf-8','cache-control':'no-store','x-content-type-options':'nosniff'});res.end(JSON.stringify(data));};
const fail=(res,status,error)=>json(res,status,{error});
const sign=value=>crypto.createHmac('sha256',secret).update(value).digest('hex');
const account=db.prepare('SELECT student_id,password_hash,salt,session_version,must_change FROM accounts WHERE student_id=?');
const passwordHash=(value,salt)=>crypto.scryptSync(value,salt,64).toString('hex');
const freshPassword=()=>crypto.randomBytes(15).toString('base64url');
function authenticated(req){
  const raw=(req.headers.cookie||'').split(';').map(s=>s.trim()).find(s=>s.startsWith('hours75='))?.slice(8);
  if(!raw)return null;const [payload,signature]=raw.split('.');if(!payload||!signature||signature.length!==64)return null;
  const expected=sign(payload);if(!crypto.timingSafeEqual(Buffer.from(signature),Buffer.from(expected)))return null;
  try{
    const user=JSON.parse(Buffer.from(payload,'base64url').toString());
    if(!Number.isSafeInteger(user.exp)||user.exp<=Date.now()||user.exp>Date.now()+86400001)return null;
    if(user.role==='admin'&&user.id==='admin')return user;
    if(user.role==='student'&&typeof user.id==='string'){
      const row=account.get(user.id);if(row&&row.session_version===user.version)return {...user,mustChange:!!row.must_change};
    }
  }catch{}
  return null;
}
function sessionCookie(res,req,user){const payload=Buffer.from(JSON.stringify({role:user.role,id:user.id,version:user.version||0,exp:Date.now()+8*3600000})).toString('base64url');res.setHeader('set-cookie',`hours75=${payload}.${sign(payload)}; HttpOnly; SameSite=Strict; Path=${basePath||'/'}; Max-Age=28800${cookieSecure(req)?'; Secure':''}`);}
function localBrowser(req){
  try{
    const source=new URL(req.headers.origin);
    const host=new URL(`http://${req.headers.host}`);
    const loopback=name=>name==='localhost'||name==='127.0.0.1'||name==='[::1]';
    return source.protocol==='http:' && loopback(source.hostname) && loopback(host.hostname)
      && source.port===host.port && ['127.0.0.1','::1','::ffff:127.0.0.1'].includes(req.socket.remoteAddress);
  }catch{return false;}
}
function sameOrigin(req){
  const value=req.headers.origin;
  return value===origin || localBrowser(req) || (!value && req.headers['sec-fetch-site']==='same-origin');
}
function cookieSecure(req){return secure && !localBrowser(req);}
async function body(req){let size=0;const chunks=[];for await(const chunk of req){size+=chunk.length;if(size>8192)throw Error('payload too large');chunks.push(chunk);}return JSON.parse(Buffer.concat(chunks).toString('utf8'));}
const minute=t=>Number(t.slice(0,2))*60+Number(t.slice(3));
const validDate=s=>{if(!/^\d{4}-\d{2}-\d{2}$/.test(s))return false;const d=new Date(`${s}T00:00:00Z`);return !Number.isNaN(d.valueOf())&&d.toISOString().slice(0,10)===s;};
const validTime=s=>/^([01]\d|2[0-3]):[0-5]\d$/.test(s);
const loginCheck=db.prepare('SELECT count,reset_at FROM login_attempts WHERE key=?');
const loginFail=db.prepare('INSERT INTO login_attempts(key,count,reset_at) VALUES(?,1,?) ON CONFLICT(key) DO UPDATE SET count=CASE WHEN reset_at<? THEN 1 ELSE count+1 END, reset_at=CASE WHEN reset_at<? THEN excluded.reset_at ELSE reset_at END');
const loginClear=db.prepare('DELETE FROM login_attempts WHERE key=?');
const list=db.prepare('SELECT id,student_id,work_date,start_time,end_time,break_minutes,minutes,note FROM shifts WHERE work_date>=? AND work_date<? ORDER BY work_date,start_time,id');
const overlap=db.prepare('SELECT id FROM shifts WHERE student_id=? AND work_date=? AND start_time<? AND end_time>? LIMIT 1');
const insert=db.prepare('INSERT INTO shifts(student_id,work_date,start_time,end_time,break_minutes,minutes,note) VALUES(?,?,?,?,?,?,?)');
const remove=db.prepare('DELETE FROM shifts WHERE id=?');
const studentExists=db.prepare('SELECT 1 FROM students WHERE id=?');
const allStudents=db.prepare('SELECT id,prefix,first_name AS firstName,last_name AS lastName,department FROM students ORDER BY id');
const sumStudent=db.prepare('SELECT COALESCE(SUM(minutes),0) AS minutes FROM shifts WHERE student_id=?');
const scopedList=db.prepare('SELECT id,student_id,work_date,start_time,end_time,break_minutes,minutes,note FROM shifts WHERE student_id=? AND work_date>=? AND work_date<? ORDER BY work_date,start_time,id');
const shiftById=db.prepare('SELECT student_id FROM shifts WHERE id=?');
const editOverlap=db.prepare('SELECT id FROM shifts WHERE student_id=? AND work_date=? AND start_time<? AND end_time>? AND id<>? LIMIT 1');
const update=db.prepare('UPDATE shifts SET work_date=?,start_time=?,end_time=?,break_minutes=?,minutes=?,note=? WHERE id=?');
const dashboard=db.prepare(`SELECT s.id,s.prefix,s.first_name AS firstName,s.last_name AS lastName,s.department,
  COALESCE((SELECT SUM(minutes) FROM shifts WHERE student_id=s.id AND work_date>=? AND work_date<?),0) AS monthMinutes,
  COALESCE((SELECT SUM(minutes) FROM shifts WHERE student_id=s.id),0) AS totalMinutes,
  CASE WHEN a.student_id IS NULL THEN 0 ELSE 1 END AS hasAccount
  FROM students s LEFT JOIN accounts a ON a.student_id=s.id ORDER BY s.id`);
function validatedShift(input,res,owner){
  const studentId=owner.role==='student'?owner.id:input.studentId;
  const {workDate,startTime,endTime}=input;
  const breakMinutes=Number(input.breakMinutes);const note=String(input.note||'').trim();
  if(owner.role==='student'&&input.studentId && input.studentId!==owner.id){fail(res,403,'แก้ไขได้เฉพาะตารางของตนเอง');return null;}
  if(typeof studentId!=='string'||!studentExists.get(studentId)||typeof workDate!=='string'||!validDate(workDate)||typeof startTime!=='string'||!validTime(startTime)||typeof endTime!=='string'||!validTime(endTime)||!Number.isInteger(breakMinutes)||breakMinutes<0||note.length>300){fail(res,400,'กรุณาตรวจสอบข้อมูลอีกครั้ง');return null;}
  const minutes=minute(endTime)-minute(startTime)-breakMinutes;
  if(minutes<=0||minutes>1440){fail(res,400,'เวลาสิ้นสุดต้องหลังเวลาเริ่ม และเวลาพักต้องน้อยกว่าช่วงงาน');return null;}
  return {studentId,workDate,startTime,endTime,breakMinutes,minutes,note};
}
const files={'/':'index.html','/app.js':'app.js','/style.css':'style.css'};
const types={'.html':'text/html; charset=utf-8','.js':'text/javascript; charset=utf-8','.css':'text/css; charset=utf-8'};
const server=http.createServer(async(req,res)=>{
  try{
    const url=new URL(req.url,'http://localhost');
    if(basePath && url.pathname===basePath){res.writeHead(308,{location:`${basePath}/${url.search}`});return res.end();}
    if(basePath && !url.pathname.startsWith(`${basePath}/`))return fail(res,404,'ไม่พบหน้า');
    const pathname=basePath?url.pathname.slice(basePath.length):url.pathname;
    if(pathname==='/api/login'&&req.method==='POST'){
      if(!sameOrigin(req))return fail(res,403,'คำขอไม่ได้มาจากเว็บไซต์นี้');
      const input=await body(req);const username=String(input.username||'').trim();const proposed=String(input.password||'');
      const key=`${req.socket.remoteAddress||'unknown'}:${username.slice(0,40)}`;const now=Date.now();const attempts=loginCheck.get(key);
      if(attempts && attempts.reset_at>now && attempts.count>=5)return fail(res,429,'ลองใหม่อีกครั้งใน 15 นาที');
      const row=username==='admin'?null:account.get(username);
      const candidate=username==='admin'?passwordHash(proposed,'admin'):passwordHash(proposed,row?.salt||'unknown');
      const expected=username==='admin'?passwordHash(password,'admin'):(row?.password_hash||passwordHash('invalid','unknown'));
      if(candidate.length!==expected.length||!crypto.timingSafeEqual(Buffer.from(candidate,'hex'),Buffer.from(expected,'hex'))||(!row&&username!=='admin')){
        loginFail.run(key,now+900000,now,now);return fail(res,401,'รหัสหรือรหัสผ่านไม่ถูกต้อง');
      }
      loginClear.run(key);
      const user=username==='admin'?{role:'admin',id:'admin'}:{role:'student',id:username,version:row.session_version};
      sessionCookie(res,req,user);return json(res,200,{ok:true});
    }
    if(pathname==='/api/logout'&&req.method==='POST'){
      if(!sameOrigin(req))return fail(res,403,'คำขอไม่ได้มาจากเว็บไซต์นี้');
      res.setHeader('set-cookie',`hours75=; HttpOnly; SameSite=Strict; Path=${basePath||'/'}; Max-Age=0${cookieSecure(req)?'; Secure':''}`);return json(res,200,{ok:true});
    }
    if(pathname.startsWith('/api/')){
      const user=authenticated(req);if(!user)return fail(res,401,'กรุณาเข้าสู่ระบบ');
      if(pathname==='/api/me'&&req.method==='GET')return json(res,200,{role:user.role,id:user.id,mustChange:!!user.mustChange});
      if(pathname==='/api/change-password'&&req.method==='POST'){
        if(!sameOrigin(req))return fail(res,403,'คำขอไม่ได้มาจากเว็บไซต์นี้');
        if(user.role!=='student')return fail(res,403,'บัญชีนี้ใช้รหัสผ่านจากการตั้งค่าเซิร์ฟเวอร์');
        const input=await body(req);const old=String(input.currentPassword||'');const next=String(input.newPassword||'');
        const row=account.get(user.id);const proposed=passwordHash(old,row.salt);
        if(!crypto.timingSafeEqual(Buffer.from(proposed,'hex'),Buffer.from(row.password_hash,'hex')))return fail(res,401,'รหัสผ่านเดิมไม่ถูกต้อง');
        if(next.length<12||next.length>128||next===old)return fail(res,400,'รหัสผ่านใหม่ต้องมี 12–128 ตัวอักษร และต่างจากรหัสเดิม');
        const salt=crypto.randomBytes(16).toString('hex');
        db.prepare('UPDATE accounts SET password_hash=?,salt=?,session_version=session_version+1,must_change=0 WHERE student_id=?').run(passwordHash(next,salt),salt,user.id);
        sessionCookie(res,req,{role:'student',id:user.id,version:row.session_version+1});return json(res,200,{ok:true});
      }
      if(user.mustChange)return fail(res,403,'กรุณาเปลี่ยนรหัสผ่านเริ่มต้นก่อน');
      if(pathname==='/api/students'&&req.method==='GET'){
        const rows=allStudents.all();return json(res,200,{students:user.role==='admin'?rows:rows.filter(s=>s.id===user.id)});
      }
      if(pathname==='/api/dashboard'&&req.method==='GET'){
        if(user.role!=='admin')return fail(res,403,'สำหรับผู้ดูแลเท่านั้น');
        const month=url.searchParams.get('month')||'';if(!/^\d{4}-(0[1-9]|1[0-2])$/.test(month))return fail(res,400,'เดือนที่ระบุไม่ถูกต้อง');
        const next=new Date(`${month}-01T00:00:00Z`);next.setUTCMonth(next.getUTCMonth()+1);
        return json(res,200,{students:dashboard.all(`${month}-01`,next.toISOString().slice(0,10))});
      }
      if(pathname==='/api/accounts'&&req.method==='POST'){
        if(!sameOrigin(req))return fail(res,403,'คำขอไม่ได้มาจากเว็บไซต์นี้');
        if(user.role!=='admin')return fail(res,403,'สำหรับผู้ดูแลเท่านั้น');
        const input=await body(req);const id=String(input.studentId||'');if(!studentExists.get(id))return fail(res,400,'รหัสนักศึกษาไม่ถูกต้อง');
        const temporaryPassword=freshPassword(),salt=crypto.randomBytes(16).toString('hex');
        db.prepare('INSERT INTO accounts(student_id,password_hash,salt) VALUES(?,?,?) ON CONFLICT(student_id) DO UPDATE SET password_hash=excluded.password_hash,salt=excluded.salt,session_version=session_version+1,must_change=1').run(id,passwordHash(temporaryPassword,salt),salt);
        return json(res,200,{studentId:id,temporaryPassword});
      }
      if(pathname==='/api/summary'&&req.method==='GET'){
        const id=user.role==='admin'?(url.searchParams.get('studentId')||''):user.id;
        if(user.role==='student'&&url.searchParams.has('studentId')&&url.searchParams.get('studentId')!==id)return fail(res,403,'ดูได้เฉพาะข้อมูลของตนเอง');
        if(!studentExists.get(id))return fail(res,400,'รหัสนักศึกษาไม่ถูกต้อง');
        return json(res,200,{minutes:sumStudent.get(id).minutes});
      }
      if(pathname==='/api/shifts'&&req.method==='GET'){
        const month=url.searchParams.get('month')||'';if(!/^\d{4}-(0[1-9]|1[0-2])$/.test(month))return fail(res,400,'เดือนที่ระบุไม่ถูกต้อง');
        const next=new Date(`${month}-01T00:00:00Z`);next.setUTCMonth(next.getUTCMonth()+1);
        const start=`${month}-01`,end=next.toISOString().slice(0,10);
        return json(res,200,{shifts:user.role==='admin'?list.all(start,end):scopedList.all(user.id,start,end)});
      }
      if(!sameOrigin(req))return fail(res,403,'คำขอไม่ได้มาจากเว็บไซต์นี้');
      if(pathname==='/api/shifts'&&req.method==='POST'){
        const input=validatedShift(await body(req),res,user);if(!input)return;
        const {studentId,workDate,startTime,endTime,breakMinutes,minutes,note}=input;
        db.exec('BEGIN IMMEDIATE');try{
          if(overlap.get(studentId,workDate,endTime,startTime)){db.exec('ROLLBACK');return fail(res,409,'ช่วงเวลานี้ทับกับรายการที่บันทึกไว้');}
          const result=insert.run(studentId,workDate,startTime,endTime,breakMinutes,minutes,note);db.exec('COMMIT');return json(res,201,{id:Number(result.lastInsertRowid)});
        }catch(e){db.exec('ROLLBACK');throw e;}
      }
      if(pathname==='/api/shifts'&&['PUT','DELETE'].includes(req.method)){
        const id=Number(url.searchParams.get('id'));if(!Number.isSafeInteger(id)||id<=0)return fail(res,400,'รายการไม่ถูกต้อง');
        const existing=shiftById.get(id);if(!existing)return fail(res,404,'ไม่พบรายการ');
        if(user.role==='student'&&existing.student_id!==user.id)return fail(res,403,'แก้ไขได้เฉพาะตารางของตนเอง');
        if(req.method==='DELETE'){remove.run(id);return json(res,200,{ok:true});}
        const input=validatedShift(await body(req),res,user);if(!input)return;
        const {studentId,workDate,startTime,endTime,breakMinutes,minutes,note}=input;
        if(studentId!==existing.student_id)return fail(res,400,'ไม่สามารถย้ายรายการไปยังนักศึกษาคนอื่น');
        db.exec('BEGIN IMMEDIATE');try{
          if(editOverlap.get(studentId,workDate,endTime,startTime,id)){db.exec('ROLLBACK');return fail(res,409,'ช่วงเวลานี้ทับกับรายการที่บันทึกไว้');}
          update.run(workDate,startTime,endTime,breakMinutes,minutes,note,id);db.exec('COMMIT');return json(res,200,{ok:true});
        }catch(e){db.exec('ROLLBACK');throw e;}
      }
      return fail(res,404,'ไม่พบข้อมูล');
    }
    if(req.method!=='GET'||!files[pathname])return fail(res,404,'ไม่พบหน้า');
    const file=path.join(root,'public',files[pathname]);
    res.writeHead(200,{'content-type':types[path.extname(file)],'cache-control':'no-store','x-content-type-options':'nosniff','referrer-policy':'strict-origin-when-cross-origin','content-security-policy':"default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src 'self' https://fonts.gstatic.com data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'"});
    fs.createReadStream(file).pipe(res);
  }catch(e){console.error(e);fail(res,e.message==='payload too large'?413:500,'ดำเนินการไม่สำเร็จ กรุณาลองใหม่');}
});
server.listen(Number(process.env.PORT||3000),process.env.HOST||'127.0.0.1',()=>console.log(`hours75 ready on ${process.env.HOST||'127.0.0.1'}:${process.env.PORT||3000}`));
