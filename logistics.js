(() => {
  'use strict';

  const CONFIG = window.PO_TRACKER_CONFIG || {};
  const BASE_URL = String(CONFIG.SUPABASE_URL || '').replace(/\/$/, '');
  const PUBLIC_KEY = CONFIG.SUPABASE_ANON_KEY || '';
  const SESSION_KEY = 'ksdl-po-tracker-session';
  const NOTE_BUCKET = 'delivery-notes';
  const OPEN_STATUSES = ['Received', 'Scheduled', 'In Transit', 'Partially Delivered'];
  const CLOSED_TRIP_STATUSES = ['Delivered', 'Cancelled'];
  const INR = new Intl.NumberFormat('en-IN', { style: 'currency', currency: 'INR', maximumFractionDigits: 0 });

  if (window.pdfjsLib) {
    window.pdfjsLib.GlobalWorkerOptions.workerSrc = 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js';
  }

  let session = null;
  let records = [];
  let trips = [];
  let selectedPoIds = new Set();
  let tripStorageReady = true;
  let refreshTimer = null;

  const $ = id => document.getElementById(id);
  const money = value => INR.format(Number(value || 0));
  const safe = value => String(value ?? '').replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]);
  const localDate = value => value ? new Date(`${value}T00:00:00`).toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' }) : '—';
  const isoDate = date => `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
  const today = () => isoDate(new Date());
  const ageDays = record => record.po_received_date ? Math.max(0, Math.floor((new Date() - new Date(`${record.po_received_date}T00:00:00`)) / 86400000)) : null;

  function show(id) { $(id).classList.remove('hidden'); }
  function hide(id) { $(id).classList.add('hidden'); }
  function headers(extra = {}) { return { apikey: PUBLIC_KEY, Authorization: `Bearer ${session?.access_token || PUBLIC_KEY}`, ...extra }; }
  async function api(path, options = {}) {
    const response = await fetch(`${BASE_URL}${path}`, { ...options, headers: headers(options.headers || {}) });
    const text = await response.text();
    let data = null;
    if (text) { try { data = JSON.parse(text); } catch (_) { data = text; } }
    if (!response.ok) throw new Error(data?.message || data?.error_description || text || `Request failed (${response.status})`);
    return data;
  }
  function toast(message) {
    const element = $('toast'); element.textContent = message; element.classList.add('show');
    clearTimeout(toast.timer); toast.timer = setTimeout(() => element.classList.remove('show'), 3000);
  }
  async function signIn(email, password) {
    const data = await api('/auth/v1/token?grant_type=password', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email, password }) });
    session = data; sessionStorage.setItem(SESSION_KEY, JSON.stringify(data));
  }
  async function signOut() {
    try { if (session?.access_token) await api('/auth/v1/logout', { method: 'POST' }); } catch (_) { /* local sign-out still succeeds */ }
    clearInterval(refreshTimer); session = null; sessionStorage.removeItem(SESSION_KEY); hide('app'); show('loginScreen');
  }

  function filePath(value) {
    const text = String(value || ''); const marker = `/storage/v1/object/public/${NOTE_BUCKET}/`;
    return text.includes(marker) ? text.split(marker)[1].split('?')[0] : text;
  }
  async function signedFileUrl(value) {
    const path = filePath(value); if (!path) return '';
    const data = await api(`/storage/v1/object/sign/${NOTE_BUCKET}/${path}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ expiresIn: 3600 }) });
    return data?.signedURL ? `${BASE_URL}/storage/v1${data.signedURL}` : '';
  }
  async function uploadTripInvoice(tripId, poId, file) {
    if (!file) throw new Error('Attach the invoice copy before creating the trip.');
    if (file.size > 10 * 1024 * 1024) throw new Error('Invoice copy must be 10 MB or smaller.');
    const fileName = file.name.replace(/[^a-zA-Z0-9._-]/g, '_');
    const path = `trip-invoices/${tripId}/${poId}/${Date.now()}-${fileName}`;
    await api(`/storage/v1/object/${NOTE_BUCKET}/${path}`, { method: 'POST', headers: { 'Content-Type': file.type || 'application/octet-stream', 'x-upsert': 'true' }, body: file });
    return path;
  }

  function normalizePoNumber(value) { return String(value || '').replace(/\D/g, ''); }
  function tallyDateToIso(value) {
    const match = String(value || '').match(/(\d{1,2})[-\s/]([A-Za-z]{3,9})[-\s/](\d{2,4})/);
    if (!match) return '';
    const months = { jan: 1, january: 1, feb: 2, february: 2, mar: 3, march: 3, apr: 4, april: 4, may: 5, jun: 6, june: 6, jul: 7, july: 7, aug: 8, august: 8, sep: 9, sept: 9, september: 9, oct: 10, october: 10, nov: 11, november: 11, dec: 12, december: 12 };
    const month = months[match[2].toLowerCase()];
    if (!month) return '';
    const year = match[3].length === 2 ? 2000 + Number(match[3]) : Number(match[3]);
    return `${year}-${String(month).padStart(2, '0')}-${String(Number(match[1])).padStart(2, '0')}`;
  }
  function nearbyValue(lines, labelPattern, valuePattern, lookAhead = 8) {
    const index = lines.findIndex(line => labelPattern.test(line));
    if (index < 0) return '';
    return lines.slice(index, index + lookAhead).join(' ').match(valuePattern)?.[1] || '';
  }
  async function readPdfLines(file) {
    if (!window.pdfjsLib) throw new Error('The PDF reader did not load. Check the internet connection and try again.');
    const pdf = await window.pdfjsLib.getDocument({ data: await file.arrayBuffer() }).promise;
    const pages = [];
    for (let pageNumber = 1; pageNumber <= pdf.numPages; pageNumber += 1) {
      const page = await pdf.getPage(pageNumber);
      const content = await page.getTextContent();
      const positioned = content.items
        .filter(item => String(item.str || '').trim())
        .map(item => ({ text: String(item.str).trim(), x: item.transform?.[4] || 0, y: item.transform?.[5] || 0 }));
      const rows = [];
      positioned.sort((a, b) => Math.abs(b.y - a.y) > 2 ? b.y - a.y : a.x - b.x).forEach(item => {
        let row = rows.find(candidate => Math.abs(candidate.y - item.y) <= 2);
        if (!row) { row = { y: item.y, items: [] }; rows.push(row); }
        row.items.push(item);
      });
      pages.push(rows.sort((a, b) => b.y - a.y).map(row => row.items.sort((a, b) => a.x - b.x).map(item => item.text).join(' ').replace(/\s+/g, ' ').trim()));
    }
    return pages.flat();
  }
  function parseTallyInvoice(lines) {
    const flat = lines.join(' ').replace(/\s+/g, ' ');
    const invoiceNumber = flat.match(/\b(BMAG\/\d{2}-\d{2}\/\d{3,8})\b/i)?.[1] || flat.match(/\b([A-Z]{2,10}[A-Z0-9 -]*\/\d{2}-\d{2}\/\d{3,8})\b/i)?.[1]?.replace(/\s+/g, ' ') || '';
    let invoiceDate = '';
    const invoiceLineIndex = lines.findIndex(line => invoiceNumber && line.includes(invoiceNumber));
    if (invoiceLineIndex >= 0) invoiceDate = lines.slice(invoiceLineIndex, invoiceLineIndex + 6).join(' ').match(/\b(\d{1,2}[-\s/][A-Za-z]{3,9}[-\s/]\d{2,4})\b/)?.[1] || '';
    if (!invoiceDate) invoiceDate = nearbyValue(lines, /\bDated\b/i, /\b(\d{1,2}[-\s/][A-Za-z]{3,9}[-\s/]\d{2,4})\b/, 5);
    const poNumber = nearbyValue(lines, /Buyer'?s\s+Order\s+No/i, /\b(\d{8,12})\b/, 10);
    let destination = nearbyValue(lines, /\bDestination\b/i, /\bDestination\b\s*[:\-]?\s*([A-Za-z][A-Za-z .'-]{1,45})/i, 3).trim();
    destination = destination.replace(/\s+(Terms|Dispatch|Dated|Buyer|Mode|Other)\b.*$/i, '').trim();
    const amountWordsIndex = lines.findIndex(line => /Amount\s+Chargeable/i.test(line));
    const invoiceAmountBlock = amountWordsIndex > 0 ? lines.slice(Math.max(0, amountWordsIndex - 4), amountWordsIndex).join(' ') : '';
    const ewayInvoiceAmount = flat.match(/Total\s+Inv\s+Amt\s*:\s*([\d,]+\.\d{2})/i)?.[1] || '';
    const invoiceAmounts = invoiceAmountBlock.match(/\d[\d,]*\.\d{2}/g) || [];
    const invoiceValue = ewayInvoiceAmount ? Number(ewayInvoiceAmount.replace(/,/g, '')) : invoiceAmounts.length ? Math.max(...invoiceAmounts.map(value => Number(value.replace(/,/g, '')))) : null;
    const ewayBill = flat.match(/(?:e-?Way\s+Bill(?:\s+No\.?)?)[^0-9]{0,30}(\d{12})/i)?.[1] || '';
    const vehicleNumber = flat.match(/\b([A-Z]{2}\s?\d{1,2}\s?[A-Z]{1,3}\s?\d{4})\b/i)?.[1]?.replace(/\s+/g, '').toUpperCase() || '';
    return { invoiceNumber, invoiceDate: tallyDateToIso(invoiceDate), poNumber, destination, invoiceValue, ewayBill, vehicleNumber };
  }
  function invoiceStatus(row, state, message) {
    row.dataset.invoiceState = state;
    row.classList.toggle('invoice-mismatch', state === 'mismatch');
    row.classList.toggle('invoice-matched', state === 'matched');
    const status = row.querySelector('.invoice-read-status');
    status.dataset.state = state; status.textContent = message;
  }
  async function handleInvoiceFile(input) {
    const row = input.closest('tr'), file = input.files?.[0], record = records.find(item => item.id === row?.dataset.poId);
    if (!row || !record || !file) { if (row) invoiceStatus(row, 'idle', 'Select a Tally PDF to auto-fill.'); return; }
    if (file.type !== 'application/pdf' && !file.name.toLowerCase().endsWith('.pdf')) {
      invoiceStatus(row, 'warning', 'Image attached — enter the invoice number and date manually.'); return;
    }
    invoiceStatus(row, 'reading', 'Reading invoice…');
    try {
      const parsed = parseTallyInvoice(await readPdfLines(file));
      if (parsed.invoiceNumber) row.querySelector('.po-invoice-number').value = parsed.invoiceNumber;
      if (parsed.invoiceDate) row.querySelector('.po-invoice-date').value = parsed.invoiceDate;
      if (parsed.vehicleNumber && !$('tripVehicle').value) $('tripVehicle').value = parsed.vehicleNumber;
      const expectedPo = normalizePoNumber(record.po_number), invoicePo = normalizePoNumber(parsed.poNumber);
      const details = [parsed.invoiceNumber, record.delivery_location || parsed.destination, parsed.invoiceValue != null ? money(parsed.invoiceValue) : '', parsed.ewayBill ? `e-Way ${parsed.ewayBill}` : ''].filter(Boolean).join(' · ');
      if (invoicePo && expectedPo && invoicePo !== expectedPo) {
        invoiceStatus(row, 'mismatch', `Wrong invoice: it belongs to PO ${parsed.poNumber}, not ${record.po_number}.`); return;
      }
      if (invoicePo && expectedPo === invoicePo && parsed.invoiceNumber && parsed.invoiceDate) {
        invoiceStatus(row, 'matched', `✓ PO ${record.po_number} matched${details ? ` · ${details}` : ''}`); return;
      }
      const missing = [!parsed.poNumber && 'PO number', !parsed.invoiceNumber && 'invoice number', !parsed.invoiceDate && 'invoice date'].filter(Boolean).join(', ');
      invoiceStatus(row, 'warning', `Please verify manually — could not read ${missing || 'all invoice details'}.`);
    } catch (error) { invoiceStatus(row, 'warning', error.message || 'Could not read this PDF. Enter details manually.'); }
  }

  async function loadData() {
    $('connectionStatus').textContent = 'Loading POs…';
    const [poResult, tripResult] = await Promise.allSettled([
      api('/rest/v1/purchase_orders?select=*&order=po_received_date.desc'),
      api('/rest/v1/delivery_trips?select=*,delivery_trip_pos(purchase_order_id,allocated_cost,invoice_number,invoice_date,invoice_attachment_url,delivery_status,purchase_orders(id,po_number,customer_name,delivery_location,status))&order=trip_date.desc,created_at.desc')
    ]);
    if (poResult.status === 'rejected') {
      records = []; trips = []; render(); $('connectionStatus').textContent = 'Could not load POs'; toast(poResult.reason?.message || 'Could not load POs'); return;
    }
    records = (Array.isArray(poResult.value) ? poResult.value : []).filter(record => OPEN_STATUSES.includes(record.status));
    tripStorageReady = tripResult.status === 'fulfilled';
    trips = tripStorageReady && Array.isArray(tripResult.value) ? tripResult.value.filter(trip => !CLOSED_TRIP_STATUSES.includes(trip.status)) : [];
    await Promise.all(records.map(async record => {
      if (record.po_attachment_url) record.po_attachment_link = await signedFileUrl(record.po_attachment_url).catch(() => '');
    }));
    const availableIds = new Set(availableRecords().map(record => record.id));
    selectedPoIds = new Set([...selectedPoIds].filter(id => availableIds.has(id)));
    $('connectionStatus').textContent = tripStorageReady ? 'Cloud synced' : 'POs loaded; trip setup required';
    render();
  }

  function linkedPoIds() {
    return new Set(trips.flatMap(trip => (trip.delivery_trip_pos || []).map(link => link.purchase_order_id)));
  }
  function availableRecords() {
    const linked = linkedPoIds();
    return records.filter(record => !linked.has(record.id));
  }
  function monthBounds(offset) {
    const now = new Date(); const start = new Date(now.getFullYear(), now.getMonth() + offset, 1);
    const end = offset === 0 ? now : new Date(now.getFullYear(), now.getMonth() + offset + 1, 0);
    return { from: isoDate(start), to: isoDate(end) };
  }
  function selectedBounds() {
    const range = $('dateRangeFilter').value;
    if (range === 'current') return monthBounds(0); if (range === 'last') return monthBounds(-1);
    if (range === 'custom') return { from: $('dateFrom').value, to: $('dateTo').value };
    return { from: '', to: '' };
  }
  function filteredRecords() {
    const search = $('searchInput').value.trim().toLowerCase(), status = $('statusFilter').value, { from, to } = selectedBounds();
    return availableRecords().filter(record => {
      const poDate = record.po_date || '';
      const searchable = [record.po_number, record.customer_name, record.delivery_location, record.invoice_number, record.transporter, record.tracking_number, record.assigned_to].join(' ').toLowerCase();
      return (!status || record.status === status) && (!from || (poDate && poDate >= from)) && (!to || (poDate && poDate <= to)) && (!search || searchable.includes(search));
    });
  }
  function statusClass(status) { return String(status || '').toLowerCase().replaceAll(' ', '-'); }

  function renderOpenPos() {
    const showing = filteredRecords(); const totalValue = showing.reduce((sum, record) => sum + Number(record.po_value || 0), 0);
    $('openCount').textContent = showing.length; $('openValue').textContent = `${money(totalValue)} value`;
    $('receivedCount').textContent = showing.filter(record => record.status === 'Received').length;
    $('scheduledCount').textContent = showing.filter(record => record.status === 'Scheduled').length;
    $('transitCount').textContent = showing.filter(record => record.status === 'In Transit').length;
    $('partialCount').textContent = showing.filter(record => record.status === 'Partially Delivered').length;
    $('resultCount').textContent = `${showing.length} open PO${showing.length === 1 ? '' : 's'}`;
    $('poTableBody').innerHTML = showing.map(record => {
      const age = ageDays(record), attachment = record.po_attachment_link ? `<a class="po-link" href="${safe(record.po_attachment_link)}" target="_blank" rel="noopener">View PO copy</a>` : '';
      return `<tr class="${selectedPoIds.has(record.id) ? 'selected-row' : ''}">
        <td class="selection-cell"><input class="po-choice" type="checkbox" value="${record.id}" ${selectedPoIds.has(record.id) ? 'checked' : ''} aria-label="Select ${safe(record.po_number)}" /></td>
        <td><span class="po-main">${safe(record.po_number || '—')}</span><span class="po-secondary">${safe(record.customer_name || '—')}</span>${attachment}</td>
        <td>${localDate(record.po_date)}<span class="po-secondary">Received ${localDate(record.po_received_date)}</span></td>
        <td><span class="executive-status ${statusClass(record.status)}">${safe(record.status)}</span></td>
        <td>${safe(record.delivery_location || '—')}</td><td>${money(record.po_value)}</td><td>${localDate(record.delivery_date)}</td>
        <td>${safe(record.invoice_number || '—')}<span class="po-secondary">${localDate(record.invoice_date)}</span></td>
        <td>${safe(record.transporter || '—')}<span class="po-secondary">${safe(record.tracking_number || '')}${record.transport_amount ? ` · ${money(record.transport_amount)}` : ''}</span></td>
        <td>${safe(record.assigned_to || '—')}</td><td>${age == null ? '—' : `${age} days`}</td>
      </tr>`;
    }).join('');
    $('emptyState').classList.toggle('hidden', showing.length !== 0);
    const visibleIds = showing.map(record => record.id), selectedVisible = visibleIds.filter(id => selectedPoIds.has(id));
    $('selectAllPos').checked = visibleIds.length > 0 && selectedVisible.length === visibleIds.length;
    $('selectAllPos').indeterminate = selectedVisible.length > 0 && selectedVisible.length < visibleIds.length;
  }
  function renderPlan() {
    const chosen = records.filter(record => selectedPoIds.has(record.id));
    $('selectedPoSummary').textContent = chosen.length ? `${chosen.length} PO${chosen.length === 1 ? '' : 's'} selected: ${chosen.map(record => record.po_number).join(', ')}` : 'Tick POs above to plan one delivery trip.';
    $('tripPoDetails').innerHTML = chosen.map(record => `<tr data-po-id="${record.id}">
      <td><span class="po-main">${safe(record.po_number)}</span><span class="po-secondary">${safe(record.delivery_location || 'Location pending')}</span></td>
      <td><input class="po-invoice-number" required placeholder="Invoice number" /></td>
      <td><input class="po-invoice-date" type="date" required /></td>
      <td><input class="po-invoice-file" type="file" accept="application/pdf,image/*" required /><small class="invoice-read-status" data-state="idle">Select a Tally PDF to auto-fill.</small></td>
      <td><input class="po-allocated-cost" type="number" min="0" step="0.01" value="0" required /></td>
    </tr>`).join('');
    $('openTripDialogBtn').disabled = chosen.length === 0;
    $('openTripDialogBtn').textContent = `Create new trip (${chosen.length})`;
    $('createTripBtn').disabled = chosen.length === 0;
    $('createTripBtn').textContent = `Create trip with ${chosen.length} PO${chosen.length === 1 ? '' : 's'}`;
    updateCostSummary();
  }
  function updateCostSummary() {
    const totalTripCost = Number($('tripFreight').value || 0) + Number($('tripLoadingCost').value || 0) + Number($('tripTollCost').value || 0) + Number($('tripOtherCost').value || 0);
    const allocated = [...document.querySelectorAll('.po-allocated-cost')].reduce((sum, input) => sum + Number(input.value || 0), 0);
    const difference = allocated - totalTripCost;
    $('totalTripCost').textContent = money(totalTripCost); $('allocatedPoCost').textContent = money(allocated);
    $('allocationDifference').textContent = `Difference ${money(Math.abs(difference))}${difference > 0 ? ' over' : difference < 0 ? ' short' : ''}`;
    $('allocationDifference').className = Math.abs(difference) < 0.5 ? 'cost-balanced' : 'cost-mismatch';
    return { totalTripCost, allocated, difference };
  }
  function renderTrips() {
    $('tripCount').textContent = `${trips.length} active trip${trips.length === 1 ? '' : 's'}`;
    $('inTripBody').innerHTML = trips.map(trip => {
      const links = trip.delivery_trip_pos || [];
      const chips = links.map(link => `<span class="trip-po-chip">${safe(link.purchase_orders?.po_number || 'PO')} · ${safe(link.purchase_orders?.delivery_location || 'Location pending')}</span>`).join('');
      const invoices = links.map(link => `<div><strong>${safe(link.purchase_orders?.po_number || 'PO')}:</strong> ${safe(link.invoice_number || '—')} · ${money(link.allocated_cost)}</div>`).join('');
      const totalCost = Number(trip.actual_freight || 0) + Number(trip.loading_cost || 0) + Number(trip.parking_toll || 0) + Number(trip.other_cost || 0);
      return `<tr><td>${localDate(trip.trip_date)}</td><td><div class="trip-po-list">${chips || 'No POs linked'}</div></td><td>${safe(trip.vehicle_number || trip.transporter || '—')}<span class="po-secondary">${safe(trip.driver_name || '')}</span></td><td>${invoices || '—'}</td><td><span class="executive-status">${safe(trip.status)}</span></td><td>${money(totalCost)}</td></tr>`;
    }).join('');
    $('tripEmptyState').classList.toggle('hidden', trips.length !== 0);
  }
  function render() { renderOpenPos(); renderPlan(); renderTrips(); }

  async function createTrip(event) {
    event.preventDefault(); const error = $('tripPlanError'); error.textContent = '';
    const chosen = records.filter(record => selectedPoIds.has(record.id));
    if (!chosen.length) { error.textContent = 'Select at least one PO first.'; return; }
    if (!tripStorageReady) { error.textContent = 'Trip database setup is not ready. Run logistics-supabase.sql once in Supabase.'; return; }
    const costCheck = updateCostSummary();
    if (Math.abs(costCheck.difference) >= 0.5) { error.textContent = 'PO-wise allocated costs must equal the total trip cost.'; return; }
    try {
      const button = $('createTripBtn'); button.disabled = true; button.textContent = 'Creating trip…';
      const freight = Number($('tripFreight').value || 0), tripId = crypto.randomUUID();
      const details = chosen.map(record => {
        const row = $('tripPoDetails').querySelector(`tr[data-po-id="${record.id}"]`);
        return { record, invoiceState: row.dataset.invoiceState || 'idle', invoiceNumber: row.querySelector('.po-invoice-number').value.trim(), invoiceDate: row.querySelector('.po-invoice-date').value, invoiceFile: row.querySelector('.po-invoice-file').files[0], allocatedCost: Number(row.querySelector('.po-allocated-cost').value || 0) };
      });
      for (const detail of details) if (detail.invoiceState === 'reading') throw new Error(`Wait for invoice reading to finish for PO ${detail.record.po_number}.`);
      for (const detail of details) if (detail.invoiceState === 'mismatch') throw new Error(`The uploaded invoice does not match PO ${detail.record.po_number}. Replace it before creating the trip.`);
      for (const detail of details) if (!detail.invoiceNumber || !detail.invoiceDate || !detail.invoiceFile) throw new Error(`Complete invoice details for PO ${detail.record.po_number}.`);
      await Promise.all(details.map(async detail => { detail.invoicePath = await uploadTripInvoice(tripId, detail.record.id, detail.invoiceFile); }));
      const payload = { id: tripId, trip_date: $('tripDate').value, status: 'Planning', transporter: $('tripTransporter').value.trim(), vehicle_number: $('tripVehicle').value.trim() || null, driver_name: $('tripDriver').value.trim() || null, driver_phone: $('tripDriverPhone').value.trim() || null, quoted_cost: freight, actual_freight: freight, loading_cost: Number($('tripLoadingCost').value || 0), parking_toll: Number($('tripTollCost').value || 0), other_cost: Number($('tripOtherCost').value || 0) };
      await api('/rest/v1/delivery_trips', { method: 'POST', headers: { 'Content-Type': 'application/json', Prefer: 'return=minimal' }, body: JSON.stringify(payload) });
      const links = details.map(detail => ({ trip_id: tripId, purchase_order_id: detail.record.id, allocation_method: 'Manual', allocated_cost: detail.allocatedCost, invoice_number: detail.invoiceNumber, invoice_date: detail.invoiceDate, invoice_attachment_url: detail.invoicePath, delivery_status: 'Pending' }));
      await api('/rest/v1/delivery_trip_pos', { method: 'POST', headers: { 'Content-Type': 'application/json', Prefer: 'return=minimal' }, body: JSON.stringify(links) });
      selectedPoIds.clear(); $('tripPlanDialog').close(); $('tripPlanForm').reset(); $('tripDate').value = today(); await loadData(); toast('Trip created — selected POs moved to POs in trip.');
    } catch (err) { error.textContent = err.message || 'Could not create the trip.'; }
    finally { $('createTripBtn').disabled = selectedPoIds.size === 0; $('createTripBtn').textContent = `Create trip with ${selectedPoIds.size} PO${selectedPoIds.size === 1 ? '' : 's'}`; }
  }

  function toggleCustomDates() { $('customDateFilters').classList.toggle('hidden', $('dateRangeFilter').value !== 'custom'); }
  function clearFilters() { $('searchInput').value = ''; $('statusFilter').value = ''; $('dateRangeFilter').value = ''; $('dateFrom').value = ''; $('dateTo').value = ''; toggleCustomDates(); render(); }
  function bindEvents() {
    $('loginForm').addEventListener('submit', async event => { event.preventDefault(); $('loginError').textContent = ''; try { await signIn($('emailInput').value.trim(), $('passwordInput').value); await start(); } catch (error) { $('loginError').textContent = error.message || 'Sign in failed.'; } });
    $('signOutBtn').addEventListener('click', signOut); $('refreshBtn').addEventListener('click', loadData); $('clearFilters').addEventListener('click', clearFilters); $('tripPlanForm').addEventListener('submit', createTrip);
    $('openTripDialogBtn').addEventListener('click', () => { if (!selectedPoIds.size) return; $('tripPlanError').textContent = ''; renderPlan(); $('tripPlanDialog').showModal(); });
    $('closeTripDialogBtn').addEventListener('click', () => $('tripPlanDialog').close()); $('cancelTripBtn').addEventListener('click', () => $('tripPlanDialog').close());
    ['tripFreight', 'tripLoadingCost', 'tripTollCost', 'tripOtherCost'].forEach(id => $(id).addEventListener('input', updateCostSummary));
    $('tripPoDetails').addEventListener('input', event => { if (event.target.matches('.po-allocated-cost')) updateCostSummary(); });
    $('tripPoDetails').addEventListener('change', event => { if (event.target.matches('.po-invoice-file')) handleInvoiceFile(event.target); });
    ['searchInput', 'statusFilter', 'dateFrom', 'dateTo'].forEach(id => { $(id).addEventListener('input', render); $(id).addEventListener('change', render); });
    $('dateRangeFilter').addEventListener('change', () => { toggleCustomDates(); render(); });
    $('poTableBody').addEventListener('change', event => { if (!event.target.matches('.po-choice')) return; if (event.target.checked) selectedPoIds.add(event.target.value); else selectedPoIds.delete(event.target.value); render(); });
    $('selectAllPos').addEventListener('change', event => { filteredRecords().forEach(record => event.target.checked ? selectedPoIds.add(record.id) : selectedPoIds.delete(record.id)); render(); });
  }
  async function start() {
    if (!BASE_URL || !PUBLIC_KEY) { show('loginScreen'); $('loginError').textContent = 'Supabase is not configured.'; return; }
    $('signedInAs').textContent = session?.user?.email || ''; hide('loginScreen'); show('app'); $('tripDate').value = today(); await loadData(); clearInterval(refreshTimer); refreshTimer = setInterval(loadData, 60000);
  }

  bindEvents(); toggleCustomDates();
  try { session = JSON.parse(sessionStorage.getItem(SESSION_KEY) || 'null'); } catch (_) { session = null; }
  if (session?.access_token && (!session.expires_at || session.expires_at * 1000 > Date.now() + 30000)) start();
  else { sessionStorage.removeItem(SESSION_KEY); show('loginScreen'); }
})();
