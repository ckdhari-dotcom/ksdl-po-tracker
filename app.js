/* global XLSX */
const CONFIG = window.PO_TRACKER_CONFIG || {};
const STATUSES = ['Received', 'Scheduled', 'In Transit', 'Delivered', 'Partially Delivered', 'Cancelled'];
const STORAGE_KEY = 'ksdl-po-tracker-v1';
let records = [];

const $ = (id) => document.getElementById(id);
const fields = ['customerName','poNumber','poDate','poReceivedDate','deliveryDate','status','poValue','invoiceNumber','invoiceDate','transporter','transportAmount','trackingNumber','assignedTo','remarks'];
const dateFields = ['poDate','poReceivedDate','deliveryDate','invoiceDate'];

function money(value) { return new Intl.NumberFormat('en-IN',{style:'currency',currency:'INR',maximumFractionDigits:0}).format(Number(value || 0)); }
function date(value) { return value ? new Date(`${value}T00:00:00`).toLocaleDateString('en-IN',{day:'2-digit',month:'short',year:'numeric'}) : '—'; }
function safe(s) { return String(s ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c])); }
function slug(s) { return String(s).toLowerCase().replace(/\s+/g,'-'); }
function ageDays(record) { if (!record.poReceivedDate) return null; return Math.max(0, Math.floor((new Date() - new Date(`${record.poReceivedDate}T00:00:00`))/86400000)); }
function delayDays(record) { if (!record.deliveryDate || !record.poDate) return null; return Math.round((new Date(`${record.deliveryDate}T00:00:00`)-new Date(`${record.poDate}T00:00:00`))/86400000); }
function isOpen(record) { return !['Delivered','Cancelled'].includes(record.status); }

async function loadRecords() {
  if (CONFIG.SUPABASE_URL && CONFIG.SUPABASE_ANON_KEY) {
    try {
      const response = await fetch(`${CONFIG.SUPABASE_URL}/rest/v1/purchase_orders?select=*&order=po_received_date.desc`, {headers: supabaseHeaders()});
      if (!response.ok) throw new Error('Could not load cloud data');
      records = (await response.json()).map(fromCloud);
      $('connectionStatus').textContent = 'Cloud synced';
    } catch (error) { toast('Cloud unavailable — showing saved local data'); records = JSON.parse(localStorage.getItem(STORAGE_KEY) || '[]'); }
  } else records = JSON.parse(localStorage.getItem(STORAGE_KEY) || '[]');
  render();
}
function supabaseHeaders() { return {apikey:CONFIG.SUPABASE_ANON_KEY,Authorization:`Bearer ${CONFIG.SUPABASE_ANON_KEY}`,'Content-Type':'application/json',Prefer:'return=representation'}; }
function toCloud(r) { return {id:r.id,customer_name:r.customerName,po_number:r.poNumber,po_date:r.poDate||null,po_received_date:r.poReceivedDate||null,delivery_date:r.deliveryDate||null,status:r.status,po_value:Number(r.poValue||0),invoice_number:r.invoiceNumber||null,invoice_date:r.invoiceDate||null,transporter:r.transporter||null,transport_amount:Number(r.transportAmount||0),tracking_number:r.trackingNumber||null,assigned_to:r.assignedTo||null,remarks:r.remarks||null,updated_at:new Date().toISOString()}; }
function fromCloud(r) { return {id:r.id,customerName:r.customer_name,poNumber:r.po_number,poDate:r.po_date,poReceivedDate:r.po_received_date,deliveryDate:r.delivery_date,status:r.status,poValue:r.po_value,invoiceNumber:r.invoice_number,invoiceDate:r.invoice_date,transporter:r.transporter,transportAmount:r.transport_amount,trackingNumber:r.tracking_number,assignedTo:r.assigned_to,remarks:r.remarks}; }
async function persist(record, deleting=false, isNew=false) {
  if (!CONFIG.SUPABASE_URL || !CONFIG.SUPABASE_ANON_KEY) { localStorage.setItem(STORAGE_KEY, JSON.stringify(records)); return; }
  const url = `${CONFIG.SUPABASE_URL}/rest/v1/purchase_orders?id=eq.${encodeURIComponent(record.id)}`;
  const response = await fetch(isNew ? `${CONFIG.SUPABASE_URL}/rest/v1/purchase_orders` : url,{method:deleting?'DELETE':isNew?'POST':'PATCH',headers:supabaseHeaders(),body:deleting?undefined:JSON.stringify(toCloud(record))});
  if (!response.ok) throw new Error('Cloud save failed');
}
function updateFilters() {
  const customers = [...new Set(records.map(r=>r.customerName).filter(Boolean))].sort();
  const select = $('customerFilter'), current = select.value;
  select.innerHTML = '<option value="">All customers</option>' + customers.map(c=>`<option value="${safe(c)}">${safe(c)}</option>`).join(''); select.value=current;
}
function filtered() { const q=$('searchInput').value.trim().toLowerCase(), st=$('statusFilter').value, cu=$('customerFilter').value; return records.filter(r => (!st||r.status===st)&&(!cu||r.customerName===cu)&&(!q||Object.values(r).join(' ').toLowerCase().includes(q))).sort((a,b)=>(b.poReceivedDate||'').localeCompare(a.poReceivedDate||'')); }
function render() {
  updateFilters(); const all=records, showing=filtered(), total=all.reduce((s,r)=>s+Number(r.poValue||0),0), delivered=all.filter(r=>r.status==='Delivered'), pending=all.filter(r=>['Received','Scheduled'].includes(r.status)), attention=all.filter(r=>isOpen(r)&&ageDays(r)>=3);
  $('totalCount').textContent=all.length; $('totalValue').textContent=money(total); $('pendingCount').textContent=pending.length; $('transitCount').textContent=all.filter(r=>r.status==='In Transit').length; $('deliveredCount').textContent=delivered.length; $('deliveredValue').textContent=`${money(delivered.reduce((s,r)=>s+Number(r.poValue||0),0))} value`; $('attentionCount').textContent=attention.length; $('resultCount').textContent=`${showing.length} record${showing.length===1?'':'s'}`;
  $('poTableBody').innerHTML=showing.map(r=>`<tr><td><span class="primary-cell">${safe(r.poNumber)}</span><span class="secondary">${safe(r.customerName)}</span></td><td>${date(r.poDate)}<span class="secondary">Received ${date(r.poReceivedDate)}</span></td><td><span class="pill ${slug(r.status)}">${safe(r.status)}</span></td><td>${date(r.deliveryDate)}${delayDays(r)!==null?`<span class="secondary">${delayDays(r)} day${Math.abs(delayDays(r))===1?'':'s'} from PO</span>`:''}</td><td>${money(r.poValue)}</td><td>${safe(r.invoiceNumber||'—')}<span class="secondary">${date(r.invoiceDate)}</span></td><td>${safe(r.transporter||'—')}<span class="secondary">${safe(r.trackingNumber||'')}</span></td><td>${safe(r.assignedTo||'—')}</td><td>${ageDays(r)===null?'—':`${ageDays(r)} days`}</td><td><button class="action-btn" data-edit="${r.id}">Edit</button></td></tr>`).join('');
  $('emptyState').classList.toggle('hidden', showing.length>0);
}
function openDialog(record) { $('poForm').reset(); $('recordId').value=record?.id||''; $('formTitle').textContent=record?'Edit PO':'Add PO'; $('deleteBtn').classList.toggle('hidden',!record); fields.forEach(f=>{if(record && record[f]!==undefined)$('poForm').elements[f].value=record[f]??'';}); if(!record){ const today=new Date().toISOString().slice(0,10); $('poForm').elements.poReceivedDate.value=today; $('poForm').elements.poDate.value=today; $('poForm').elements.status.value='Received'; } $('poDialog').showModal(); }
function toast(message) { const el=$('toast');el.textContent=message;el.classList.add('show');clearTimeout(toast.timer);toast.timer=setTimeout(()=>el.classList.remove('show'),2600); }
function formatImportDate(v) { if (!v) return ''; if (v instanceof Date) return v.toISOString().slice(0,10); const d=new Date(v); return Number.isNaN(d)?'':d.toISOString().slice(0,10); }
function mapped(row, keys) { for (const key of keys) if (row[key] !== undefined && row[key] !== null) return row[key]; return ''; }
function importRows(rows) { const additions=rows.map(row=>({id:crypto.randomUUID(),customerName:mapped(row,['Customer Name','Customer','customerName']),poNumber:mapped(row,['PO Number','PO No','poNumber']),poDate:formatImportDate(mapped(row,['PO Date','poDate'])),poReceivedDate:formatImportDate(mapped(row,['PO Received Date','Received Date','poReceivedDate']))||new Date().toISOString().slice(0,10),deliveryDate:formatImportDate(mapped(row,['Delivery Date','deliveryDate'])),status:mapped(row,['Delivery Status','Status','status'])||'Received',poValue:mapped(row,['PO Value (₹)','PO Value','poValue'])||0,invoiceNumber:mapped(row,['Invoice Number','invoiceNumber']),invoiceDate:formatImportDate(mapped(row,['Invoice Date','invoiceDate'])),transporter:mapped(row,['Transporter','transporter']),transportAmount:mapped(row,['Transport Amount (₹)','Transport Amount','transportAmount'])||0,trackingNumber:mapped(row,['LR / Tracking No','LR/Tracking No','Tracking Number','trackingNumber']),assignedTo:mapped(row,['Assigned To','assignedTo']),remarks:mapped(row,['Remarks','remarks'])})).filter(r=>r.customerName&&r.poNumber); records.push(...additions); return additions.length; }
function exportExcel() { const exportRows=records.map(r=>({'Customer Name':r.customerName,'PO Number':r.poNumber,'PO Date':r.poDate,'PO Received Date':r.poReceivedDate,'Delivery Date':r.deliveryDate,'Delivery Status':r.status,'PO Value (₹)':Number(r.poValue||0),'Invoice Number':r.invoiceNumber,'Invoice Date':r.invoiceDate,'Transporter':r.transporter,'Transport Amount (₹)':Number(r.transportAmount||0),'LR / Tracking No':r.trackingNumber,'Assigned To':r.assignedTo,'PO Age (Days)':ageDays(r),'Delay (Days)':delayDays(r),'Remarks':r.remarks})); const sheet=XLSX.utils.json_to_sheet(exportRows); sheet['!cols']=[20,16,14,18,15,20,14,18,14,18,20,20,18,14,14,35].map(w=>({wch:w})); const book=XLSX.utils.book_new();XLSX.utils.book_append_sheet(book,sheet,'PO Tracker');XLSX.writeFile(book,`KSDL_PO_Tracker_${new Date().toISOString().slice(0,10)}.xlsx`); }

function initialise() {
  $('statusFilter').innerHTML='<option value="">All statuses</option>'+STATUSES.map(x=>`<option>${x}</option>`).join(''); $('poForm').elements.status.innerHTML=STATUSES.map(x=>`<option>${x}</option>`).join('');
  ['searchInput','statusFilter','customerFilter'].forEach(id=>$(id).addEventListener('input',render)); $('clearFilters').onclick=()=>{$('searchInput').value='';$('statusFilter').value='';$('customerFilter').value='';render();};
  $('newPoBtn').onclick=()=>openDialog(); $('emptyNewBtn').onclick=()=>openDialog(); $('closeDialog').onclick=()=>$('poDialog').close(); $('cancelBtn').onclick=()=>$('poDialog').close();
  $('poTableBody').onclick=e=>{const id=e.target.dataset.edit;if(id)openDialog(records.find(r=>r.id===id));};
  $('poForm').addEventListener('submit',async e=>{e.preventDefault();const form=new FormData(e.target), id=$('recordId').value, record=Object.fromEntries(fields.map(f=>[f,form.get(f)]));record.id=id||crypto.randomUUID();record.poValue=Number(record.poValue||0);record.transportAmount=Number(record.transportAmount||0);const index=records.findIndex(r=>r.id===id), isNew=index<0;if(index>=0)records[index]=record;else records.push(record);try{await persist(record,false,isNew);$('poDialog').close();render();toast('PO saved');}catch(err){toast('Could not save to cloud');}});
  $('deleteBtn').onclick=async()=>{const id=$('recordId').value, record=records.find(r=>r.id===id);if(!record||!confirm(`Delete PO ${record.poNumber}?`))return;records=records.filter(r=>r.id!==id);try{await persist(record,true);$('poDialog').close();render();toast('PO deleted');}catch(e){toast('Could not delete from cloud');loadRecords();}};
  $('exportBtn').onclick=exportExcel; $('importBtn').onclick=()=>$('importFile').click(); $('importFile').onchange=e=>{const file=e.target.files[0];if(!file)return;const reader=new FileReader();reader.onload=async ev=>{const wb=XLSX.read(ev.target.result,{type:'array',cellDates:true});const rows=XLSX.utils.sheet_to_json(wb.Sheets[wb.SheetNames[0]],{defval:''});const previous=records.length,count=importRows(rows),added=records.slice(previous);try{await Promise.all(added.map(r=>persist(r,false,true)));render();toast(`${count} PO${count===1?'':'s'} imported`);}catch(error){localStorage.setItem(STORAGE_KEY,JSON.stringify(records));render();toast('Imported locally; cloud import could not finish');}};reader.readAsArrayBuffer(file);e.target.value='';};
  if(CONFIG.SIMPLE_PIN){$('loginScreen').classList.remove('hidden');$('loginForm').onsubmit=e=>{e.preventDefault();if($('pinInput').value===CONFIG.SIMPLE_PIN){$('loginScreen').classList.add('hidden');}else $('loginError').textContent='Incorrect PIN. Try again.';};}
  loadRecords();
}
initialise();
