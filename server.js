import express from 'express';
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { fileURLToPath } from 'url';
const __dirname=path.dirname(fileURLToPath(import.meta.url));
const app=express(); const port=Number(process.env.PORT||10000);
const adminPassword=process.env.ADMIN_PASSWORD||'demo-admin';
const vendorPassword=process.env.VENDOR_PASSWORD||'demo-vendor';
const powerAutomateUrl=String(process.env.POWER_AUTOMATE_URL||'').trim();
const baseUrl=String(process.env.PUBLIC_BASE_URL||'').replace(/\/$/,'');
const testMode=String(process.env.TEST_MODE||'true').toLowerCase()!=='false';
const testEmail=process.env.TEST_EMAIL||'aciraky@fecrent.com';
const dataDir=path.join(__dirname,'data'); const dataFile=path.join(dataDir,'store.json');
fs.mkdirSync(dataDir,{recursive:true});
const seed={cycles:[{id:'2026-10-1',name:'October Cycle 1',start:'2026-10-12',end:'2026-11-22',due:'2026-10-09T17:00:00-04:00',active:true}],partners:[
{id:'northstar',company:'Northstar Plumbing',contact:'Demo Trade Partner',email:testEmail,token:'demo-northstar-2026-10-1',cycleId:'2026-10-1',status:'outstanding',reminders:0,lastReminder:null,submittedAt:null,submission:null},
{id:'apex',company:'Apex Electrical',contact:'Demo Contact',email:'apex@example.com',token:'demo-apex',cycleId:'2026-10-1',status:'complete',reminders:0,submittedAt:'2026-10-07T08:42:00-04:00',submission:{submittedBy:'Demo User',email:'apex@example.com',noEquipment:false,items:[{type:"19' Scissor Lift",quantity:8,dateNeeded:'2026-10-19',duration:'4 weeks',area:'Area C / L2',notes:'Rough-in'}]}},
{id:'summit',company:'Summit Mechanical',contact:'Demo Contact',email:'summit@example.com',token:'demo-summit',cycleId:'2026-10-1',status:'complete',reminders:1,submittedAt:'2026-10-07T14:16:00-04:00',submission:{submittedBy:'Demo User',email:'summit@example.com',noEquipment:false,items:[{type:'Telehandler',quantity:2,dateNeeded:'2026-10-26',duration:'3 weeks',area:'North laydown',notes:''}]}},
{id:'keystone',company:'Keystone Drywall',contact:'Demo Contact',email:'keystone@example.com',token:'demo-keystone',cycleId:'2026-10-1',status:'outstanding',reminders:2,lastReminder:'2026-10-03T08:00:00-04:00',submittedAt:null,submission:null}
]};
function load(){try{return JSON.parse(fs.readFileSync(dataFile,'utf8'));}catch{fs.writeFileSync(dataFile,JSON.stringify(seed,null,2));return structuredClone(seed)}}
function save(d){fs.writeFileSync(dataFile,JSON.stringify(d,null,2))}
function clean(v,n=500){return String(v??'').trim().slice(0,n)}
app.disable('x-powered-by'); app.use(express.json({limit:'300kb'})); app.use(express.static(__dirname));
app.get('/api/health',(_q,r)=>r.json({ok:true,testMode,powerAutomateConfigured:Boolean(powerAutomateUrl)}));
app.get('/api/request/:token',(q,r)=>{const d=load();const p=d.partners.find(x=>x.token===q.params.token);if(!p)return r.status(404).json({error:'Request link not found.'});const c=d.cycles.find(x=>x.id===p.cycleId);r.json({company:p.company,contact:p.contact,status:p.status,submittedAt:p.submittedAt,cycle:c});});
app.post('/api/request/:token',(q,r)=>{const d=load();const p=d.partners.find(x=>x.token===q.params.token);if(!p)return r.status(404).json({error:'Request link not found.'});if(p.status==='complete')return r.status(409).json({error:'This look-ahead has already been submitted.'});const submittedBy=clean(q.body.submittedBy,100),email=clean(q.body.email,160),noEquipment=Boolean(q.body.noEquipment);const raw=Array.isArray(q.body.items)?q.body.items:[];const items=noEquipment?[]:raw.slice(0,50).map(x=>({type:clean(x.type,100),quantity:Math.max(1,Math.min(999,Number(x.quantity)||1)),dateNeeded:clean(x.dateNeeded,20),duration:clean(x.duration,80),area:clean(x.area,120),notes:clean(x.notes,500)})).filter(x=>x.type&&x.dateNeeded);if(!submittedBy||!email||(!noEquipment&&!items.length))return r.status(400).json({error:'Please complete the required fields and add at least one equipment request.'});p.status='complete';p.submittedAt=new Date().toISOString();p.submission={submittedBy,email,noEquipment,items,certified:true};save(d);r.json({ok:true,company:p.company,submittedAt:p.submittedAt,itemCount:items.length,noEquipment});});
function auth(q,role){const h=String(q.headers.authorization||'');const pw=h.startsWith('Bearer ')?h.slice(7):'';return role==='admin'?crypto.timingSafeEqual(Buffer.from(pw.padEnd(64).slice(0,64)),Buffer.from(adminPassword.padEnd(64).slice(0,64))):crypto.timingSafeEqual(Buffer.from(pw.padEnd(64).slice(0,64)),Buffer.from(vendorPassword.padEnd(64).slice(0,64)));}
app.get('/api/dashboard',(q,r)=>{if(!auth(q,'admin'))return r.status(401).json({error:'Unauthorized'});const d=load();r.json(d)});
app.get('/api/vendor', (q, r) => {
  if (!auth(q, 'vendor')) {
    return r.status(401).json({ error: 'Unauthorized' });
  }

  const d = load();
  const rows = [];

  d.partners
    .filter(p => p.status === 'complete' && p.submission)
    .forEach(p => {
      const items = p.submission.items || [];

      items.forEach(item => {
        rows.push({
          company: p.company,
          type: item.type || '',
          quantity: Number(item.quantity) || 0,
          dateNeeded: item.dateNeeded || '',
          duration: item.duration || '',
          location: item.location || item.area || '',
          notes: item.notes || ''
        });
      });
    });

  return r.json(rows);
});
app.post('/api/admin/test-email',(q,r)=>{if(!auth(q,'admin'))return r.status(401).json({error:'Unauthorized'});const d=load();const p=d.partners.find(x=>x.id==='northstar');const url=`${baseUrl||`${q.protocol}://${q.get('host')}`}/request.html?token=${encodeURIComponent(p.token)}`;r.json({ok:true,to:testEmail,subject:'Action Required - Equipment Look-Ahead',link:url,powerAutomateConfigured:Boolean(powerAutomateUrl),note:powerAutomateUrl?'Power Automate endpoint is configured.':'Preview only until POWER_AUTOMATE_URL is configured.'});});
app.listen(port,()=>console.log(`FEC Equipment Look-Ahead listening on ${port}`));
