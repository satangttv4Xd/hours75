const $=id=>document.getElementById(id);
const basePath=new URL(document.querySelector('script[src$="app.js"]').src).pathname.slice(0,-7);
const state={students:[],shifts:[],studentId:'',role:'',editId:null};
const monthNow=()=>new Intl.DateTimeFormat('en-CA',{timeZone:'Asia/Bangkok',year:'numeric',month:'2-digit'}).format(new Date());
const formatHours=n=>`${(n/60).toLocaleString('th-TH',{maximumFractionDigits:2})} ชม.`;
function message(text,error=false){$('message').textContent=text;$('message').classList.toggle('error',error);}
async function api(url,options){const response=await fetch(`${basePath}${url}`,{credentials:'same-origin',...options});const data=await response.json();if(!response.ok)throw Error(data.error||'ดำเนินการไม่สำเร็จ');return data;}
function show(panel){for(const id of ['workspace','loginPanel','changePanel'])$(id).classList.toggle('hidden',id!==panel);$('logout').classList.toggle('hidden',panel==='loginPanel');$('changePassword').classList.toggle('hidden',panel!=='workspace'||state.role!=='student');}
async function init(){
  try{
    const me=await api('/api/me');state.role=me.role;
    if(me.mustChange){$('cancelChange').classList.add('hidden');show('changePanel');return;}
    const data=await api('/api/students');state.students=data.students;
    $('student').replaceChildren(...data.students.map(s=>{const option=document.createElement('option');option.value=s.id;option.textContent=`${s.prefix}${s.firstName} ${s.lastName} · ${s.id}`;return option;}));
    state.studentId=state.role==='student'?me.id:(state.students.find(s=>s.id===state.studentId)?.id||state.students[0]?.id||'');
    $('student').value=state.studentId;$('student').disabled=state.role==='student';
    $('adminDashboard').classList.toggle('hidden',state.role!=='admin');show('workspace');await load();
  }catch(e){show('loginPanel');if(e.message!=='กรุณาเข้าสู่ระบบ')message(e.message,true);}
}
async function load(){
  try{
    const student=state.studentId,month=$('month').value;
    const [data,summary]=await Promise.all([api(`/api/shifts?month=${encodeURIComponent(month)}`),api(`/api/summary?studentId=${encodeURIComponent(student)}`)]);
    if(student!==state.studentId||month!==$('month').value)return;
    state.shifts=data.shifts;render();$('allHours').textContent=`${formatHours(summary.minutes)} / 75 ชม.`;
    if(state.role==='admin')await loadDashboard(month);
    message('');
  }catch(e){message(e.message,true);}
}
async function loadDashboard(month){
  const result=await api(`/api/dashboard?month=${encodeURIComponent(month)}`);
  if(month!==$('month').value)return;
  const rows=result.students;
  $('dashboardTotal').textContent=`${rows.length} คน · ${formatHours(rows.reduce((sum,s)=>sum+s.monthMinutes,0))} ในเดือนนี้`;
  $('dashboardRows').replaceChildren(...rows.map(s=>{
    const tr=document.createElement('tr');
    const name=document.createElement('td'),choose=document.createElement('button');choose.className='edit';choose.type='button';choose.textContent=`${s.prefix}${s.firstName} ${s.lastName} · ${s.id}`;
    choose.addEventListener('click',()=>{$('student').value=s.id;state.studentId=s.id;resetEdit();void load();$('shiftForm').scrollIntoView({behavior:'smooth'});});name.append(choose);tr.append(name);
    for(const value of [s.department,formatHours(s.monthMinutes),`${formatHours(s.totalMinutes)} / 75 ชม.`]){const td=document.createElement('td');td.textContent=value;tr.append(td);}
    const cell=document.createElement('td'),button=document.createElement('button');button.type='button';button.className=s.hasAccount?'quiet':'';button.textContent=s.hasAccount?'ออกรหัสใหม่':'สร้างบัญชี';
    button.addEventListener('click',()=>createAccount(s.id,!!s.hasAccount));cell.append(button);tr.append(cell);return tr;
  }));
}
async function createAccount(id,exists){
  if(exists&&!confirm(`ออกรหัสเริ่มต้นใหม่ให้ ${id} หรือไม่? รหัสเดิมและการเข้าสู่ระบบเดิมจะใช้ไม่ได้`))return;
  try{
    const data=await api('/api/accounts',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({studentId:id})});
    $('credential').textContent=`รหัสนักศึกษา ${id} · รหัสผ่านเริ่มต้น: ${data.temporaryPassword} — คัดลอกและส่งให้เจ้าตัวเป็นการส่วนตัว รหัสนี้จะแสดงครั้งเดียว`;
    $('credential').classList.remove('hidden');await loadDashboard($('month').value);
  }catch(e){message(e.message,true);}
}
function render(){
  const selected=state.students.find(s=>s.id===state.studentId);if(!selected)return;
  $('person').textContent=`${selected.prefix}${selected.firstName} ${selected.lastName} · ${selected.department} · เป้าหมาย 75 ชั่วโมง`;
  const rows=state.shifts.filter(s=>s.student_id===state.studentId);
  $('monthHours').textContent=formatHours(rows.reduce((n,s)=>n+s.minutes,0));$('count').textContent=`${rows.length} รายการ`;$('empty').classList.toggle('hidden',rows.length>0);
  $('rows').replaceChildren(...rows.map(s=>{
    const tr=document.createElement('tr');const date=new Date(`${s.work_date}T00:00:00Z`).toLocaleDateString('th-TH',{day:'numeric',month:'short',year:'numeric',timeZone:'UTC'});
    for(const value of [date,`${s.start_time}–${s.end_time}`,`${s.break_minutes} นาที`,formatHours(s.minutes),s.note||'—']){const td=document.createElement('td');td.textContent=value;tr.append(td);}
    const td=document.createElement('td'),edit=document.createElement('button'),del=document.createElement('button');
    edit.type='button';edit.className='edit';edit.textContent='แก้ไข';edit.addEventListener('click',()=>startEdit(s));
    del.type='button';del.className='danger';del.textContent='ลบ';del.addEventListener('click',()=>remove(s.id));td.append(edit,del);tr.append(td);return tr;
  }));
}
function startEdit(s){state.editId=s.id;$('date').value=s.work_date;$('start').value=s.start_time;$('end').value=s.end_time;$('break').value=s.break_minutes;$('note').value=s.note;$('saveShift').textContent='บันทึกการแก้ไข';$('cancelEdit').classList.remove('hidden');$('shiftForm').scrollIntoView({behavior:'smooth'});}
function resetEdit(){state.editId=null;$('saveShift').textContent='บันทึกตารางงาน';$('cancelEdit').classList.add('hidden');$('note').value='';}
async function remove(id){if(!confirm('ลบรายการนี้หรือไม่?'))return;try{await api(`/api/shifts?id=${id}`,{method:'DELETE'});resetEdit();await load();message('ลบรายการแล้ว');}catch(e){message(e.message,true);}}
$('month').value=monthNow();$('date').value=`${monthNow()}-01`;
$('loginForm').addEventListener('submit',async e=>{e.preventDefault();try{await api('/api/login',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({username:$('username').value.trim(),password:$('password').value})});$('password').value='';message('');await init();}catch(error){message(error.message,true);}});
$('changeForm').addEventListener('submit',async e=>{e.preventDefault();try{await api('/api/change-password',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({currentPassword:$('currentPassword').value,newPassword:$('newPassword').value})});$('currentPassword').value='';$('newPassword').value='';await init();message('เปลี่ยนรหัสผ่านแล้ว');}catch(error){message(error.message,true);}});
$('changePassword').addEventListener('click',()=>{$('cancelChange').classList.remove('hidden');show('changePanel');});
$('cancelChange').addEventListener('click',()=>show('workspace'));
$('logout').addEventListener('click',async()=>{try{await api('/api/logout',{method:'POST'});state.role='';state.studentId='';$('credential').classList.add('hidden');show('loginPanel');message('ออกจากระบบแล้ว');}catch(e){message(e.message,true);}});
$('student').addEventListener('change',()=>{state.studentId=$('student').value;resetEdit();void load();});$('month').addEventListener('change',()=>{resetEdit();$('credential').classList.add('hidden');void load();});$('cancelEdit').addEventListener('click',resetEdit);
$('shiftForm').addEventListener('submit',async e=>{
  e.preventDefault();const button=$('saveShift');button.disabled=true;
  try{
    const editId=state.editId;
    await api(editId?`/api/shifts?id=${editId}`:'/api/shifts',{method:editId?'PUT':'POST',headers:{'content-type':'application/json'},body:JSON.stringify({studentId:state.studentId,workDate:$('date').value,startTime:$('start').value,endTime:$('end').value,breakMinutes:Number($('break').value),note:$('note').value})});
    resetEdit();$('month').value=$('date').value.slice(0,7);await load();message(editId?'แก้ไขตารางงานแล้ว':'บันทึกตารางงานแล้ว');
  }catch(error){message(error.message,true);}finally{button.disabled=false;}
});
/* ── Theme toggle ──────────────────────────────────────── */
(function(){
  const root=document.documentElement;
  const saved=localStorage.getItem('theme');
  if(saved)root.setAttribute('data-theme',saved);
  $('themeToggle').addEventListener('click',()=>{
    const next=root.getAttribute('data-theme')==='light'?'dark':'light';
    root.setAttribute('data-theme',next);
    localStorage.setItem('theme',next);
  });
})();
void init();

