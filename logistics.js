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
  let editingTripId = null;
  let completingTripId = null;
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
  async function uploadTripDeliverySlip(tripId, poId, file) {
    if (!file) throw new Error('Upload the signed delivery slip before completing the trip.');
    if (file.size > 10 * 1024 * 1024) throw new Error('Delivery slip must be 10 MB or smaller.');
    const fileName = file.name.replace(/[^a-zA-Z0-9._-]/g, '_');
    const path = `trip-delivery-slips/${tripId}/${poId}/${Date.now()}-${fileName}`;
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
      if (parsed.vehicleNumber) $('tripVehicle').value = parsed.vehicleNumber;
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
    const editTrip = editingTripId ? trips.find(trip => trip.id === editingTripId) : null;
    const editLinks = editTrip?.delivery_trip_pos || [];
    const editLinksByPo = new Map(editLinks.map(link => [link.purchase_order_id, link]));
    const chosen = editTrip
      ? editLinks.map(link => records.find(record => record.id === link.purchase_order_id)).filter(Boolean)
      : records.filter(record => selectedPoIds.has(record.id));
    $('tripDialogEyebrow').textContent = editTrip ? 'UPDATE DELIVERY PLAN' : 'PLAN FOR DELIVERY';
    $('tripDialogTitle').textContent = editTrip ? 'Edit trip' : 'Create new trip';
    $('selectedPoSummary').textContent = chosen.length ? `${chosen.length} PO${chosen.length === 1 ? '' : 's'}: ${chosen.map(record => record.po_number).join(', ')}` : 'Tick POs above to plan one delivery trip.';
    $('tripPoDetails').innerHTML = chosen.map(record => {
      const link = editLinksByPo.get(record.id); const hasInvoice = Boolean(link?.invoice_attachment_url);
      const invoiceStatusText = hasInvoice ? 'Invoice already attached. Upload a file only to replace it.' : 'Select a Tally PDF to auto-fill.';
      return `<tr data-po-id="${record.id}" data-invoice-state="${hasInvoice ? 'existing' : 'idle'}" data-existing-invoice="${safe(link?.invoice_attachment_url || '')}">
      <td><span class="po-main">${safe(record.po_number)}</span><span class="po-secondary">${safe(record.delivery_location || 'Location pending')}</span></td>
      <td><input class="po-invoice-number" required placeholder="Invoice number" value="${safe(link?.invoice_number || '')}" /></td>
      <td><input class="po-invoice-date" type="date" required value="${safe(link?.invoice_date || '')}" /></td>
      <td><input class="po-invoice-file" type="file" accept="application/pdf,image/*" ${hasInvoice ? '' : 'required'} /><small class="invoice-read-status" data-state="${hasInvoice ? 'matched' : 'idle'}">${invoiceStatusText}</small></td>
      <td><input class="po-allocated-cost" type="number" min="0" step="0.01" placeholder="Optional" value="${link?.allocated_cost ?? ''}" /></td>
    </tr>`;
    }).join('');
    const selectedCount = records.filter(record => selectedPoIds.has(record.id)).length;
    $('openTripDialogBtn').disabled = selectedCount === 0;
    $('openTripDialogBtn').textContent = `Create new trip (${selectedCount})`;
    $('createTripBtn').disabled = chosen.length === 0;
    $('createTripBtn').textContent = editTrip ? 'Save trip changes' : `Create trip with ${chosen.length} PO${chosen.length === 1 ? '' : 's'}`;
  }
  function renderTrips() {
    $('tripCount').textContent = `${trips.length} active trip${trips.length === 1 ? '' : 's'}`;
    $('inTripBody').innerHTML = trips.map(trip => {
      const links = trip.delivery_trip_pos || [];
      const chips = links.map(link => `<span class="trip-po-chip">${safe(link.purchase_orders?.po_number || 'PO')} · ${safe(link.purchase_orders?.delivery_location || 'Location pending')}</span>`).join('');
      const invoices = links.map(link => `<div><strong>${safe(link.purchase_orders?.po_number || 'PO')}:</strong> ${safe(link.invoice_number || '—')} · ${money(link.allocated_cost)}</div>`).join('');
      const tempoCost = Number(trip.actual_freight || 0);
      return `<tr><td>${localDate(trip.trip_date)}</td><td><div class="trip-po-list">${chips || 'No POs linked'}</div></td><td>${safe(trip.vehicle_number || trip.transporter || '—')}<span class="po-secondary">${safe(trip.driver_name || '')}</span></td><td>${invoices || '—'}</td><td><span class="executive-status">${safe(trip.status)}</span></td><td>${tempoCost ? money(tempoCost) : '—'}</td><td><div class="trip-actions"><button class="text-btn edit-trip-btn" type="button" data-trip-id="${trip.id}">Edit</button><button class="complete-trip-btn" type="button" data-trip-id="${trip.id}">Complete delivery</button></div></td></tr>`;
    }).join('');
    $('tripEmptyState').classList.toggle('hidden', trips.length !== 0);
  }
  function render() { renderOpenPos(); if (!$('tripPlanDialog').open) renderPlan(); renderTrips(); }

  function closeTripDialog() {
    if ($('tripPlanDialog').open) $('tripPlanDialog').close();
    editingTripId = null; $('tripPlanForm').reset(); $('tripDate').value = today(); $('tripPlanError').textContent = ''; renderPlan();
  }
  function openCreateTrip() {
    if (!selectedPoIds.size) return;
    editingTripId = null; $('tripPlanForm').reset(); $('tripDate').value = today(); $('tripPlanError').textContent = ''; renderPlan(); $('tripPlanDialog').showModal();
  }
  function openEditTrip(tripId) {
    const trip = trips.find(item => item.id === tripId); if (!trip) return;
    editingTripId = tripId; $('tripPlanForm').reset();
    $('tripDate').value = trip.trip_date || today(); $('tripTransporter').value = trip.transporter || ''; $('tripVehicle').value = trip.vehicle_number || '';
    $('tripDriver').value = trip.driver_name || ''; $('tripDriverPhone').value = trip.driver_phone || ''; $('tripFreight').value = Number(trip.actual_freight || 0) || '';
    $('tripPlanError').textContent = ''; renderPlan(); $('tripPlanDialog').showModal();
  }
  async function saveTrip(event) {
    event.preventDefault(); const error = $('tripPlanError'); error.textContent = '';
    const editTrip = editingTripId ? trips.find(trip => trip.id === editingTripId) : null;
    const editLinks = editTrip?.delivery_trip_pos || [];
    const chosen = editTrip ? editLinks.map(link => records.find(record => record.id === link.purchase_order_id)).filter(Boolean) : records.filter(record => selectedPoIds.has(record.id));
    if (!chosen.length) { error.textContent = 'Select at least one PO first.'; return; }
    if (!tripStorageReady) { error.textContent = 'Trip database setup is not ready. Run logistics-supabase.sql once in Supabase.'; return; }
    const button = $('createTripBtn');
    try {
      button.disabled = true; button.textContent = editTrip ? 'Saving changes…' : 'Creating trip…';
      const freight = Number($('tripFreight').value || 0), tripId = editTrip?.id || crypto.randomUUID();
      const details = chosen.map(record => {
        const row = $('tripPoDetails').querySelector(`tr[data-po-id="${record.id}"]`);
        return { record, invoiceState: row.dataset.invoiceState || 'idle', existingInvoicePath: row.dataset.existingInvoice || '', invoiceNumber: row.querySelector('.po-invoice-number').value.trim(), invoiceDate: row.querySelector('.po-invoice-date').value, invoiceFile: row.querySelector('.po-invoice-file').files[0], allocatedCost: Number(row.querySelector('.po-allocated-cost').value || 0) };
      });
      for (const detail of details) if (detail.invoiceState === 'reading') throw new Error(`Wait for invoice reading to finish for PO ${detail.record.po_number}.`);
      for (const detail of details) if (detail.invoiceState === 'mismatch') throw new Error(`The uploaded invoice does not match PO ${detail.record.po_number}. Replace it before saving.`);
      for (const detail of details) if (!detail.invoiceNumber || !detail.invoiceDate || (!detail.invoiceFile && !detail.existingInvoicePath)) throw new Error(`Upload and verify the invoice for PO ${detail.record.po_number}.`);
      await Promise.all(details.map(async detail => { detail.invoicePath = detail.invoiceFile ? await uploadTripInvoice(tripId, detail.record.id, detail.invoiceFile) : detail.existingInvoicePath; }));
      const tripPayload = { trip_date: $('tripDate').value, transporter: $('tripTransporter').value.trim(), vehicle_number: $('tripVehicle').value.trim() || null, driver_name: $('tripDriver').value.trim() || null, driver_phone: $('tripDriverPhone').value.trim() || null, quoted_cost: freight, actual_freight: freight };
      if (editTrip) {
        await api(`/rest/v1/delivery_trips?id=eq.${encodeURIComponent(tripId)}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json', Prefer: 'return=minimal' }, body: JSON.stringify(tripPayload) });
        await Promise.all(details.map(detail => api(`/rest/v1/delivery_trip_pos?trip_id=eq.${encodeURIComponent(tripId)}&purchase_order_id=eq.${encodeURIComponent(detail.record.id)}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json', Prefer: 'return=minimal' }, body: JSON.stringify({ allocation_method: 'Manual', allocated_cost: detail.allocatedCost, invoice_number: detail.invoiceNumber, invoice_date: detail.invoiceDate, invoice_attachment_url: detail.invoicePath }) })));
      } else {
        await api('/rest/v1/delivery_trips', { method: 'POST', headers: { 'Content-Type': 'application/json', Prefer: 'return=minimal' }, body: JSON.stringify({ id: tripId, status: 'Planning', ...tripPayload }) });
        const links = details.map(detail => ({ trip_id: tripId, purchase_order_id: detail.record.id, allocation_method: 'Manual', allocated_cost: detail.allocatedCost, invoice_number: detail.invoiceNumber, invoice_date: detail.invoiceDate, invoice_attachment_url: detail.invoicePath, delivery_status: 'Pending' }));
        await api('/rest/v1/delivery_trip_pos', { method: 'POST', headers: { 'Content-Type': 'application/json', Prefer: 'return=minimal' }, body: JSON.stringify(links) });
        selectedPoIds.clear();
      }
      closeTripDialog(); await loadData(); toast(editTrip ? 'Trip changes saved.' : 'Trip created — selected POs moved to POs in trip.');
    } catch (err) { error.textContent = err.message || `Could not ${editTrip ? 'update' : 'create'} the trip.`; }
    finally { button.disabled = false; button.textContent = editTrip ? 'Save trip changes' : `Create trip with ${chosen.length} PO${chosen.length === 1 ? '' : 's'}`; }
  }

  function closeCompleteTripDialog() {
    if ($('completeTripDialog').open) $('completeTripDialog').close();
    completingTripId = null; $('completeTripForm').reset(); $('completeTripError').textContent = '';
  }
  function updateCompleteTripTotal() {
    const total = [...document.querySelectorAll('.complete-po-cost')].reduce((sum, input) => sum + Number(input.value || 0), 0);
    $('completeTripTotal').textContent = money(total); return total;
  }
  function openCompleteTrip(tripId) {
    const trip = trips.find(item => item.id === tripId); if (!trip) return;
    const incompleteInvoice = (trip.delivery_trip_pos || []).find(link => !(link.invoice_number || trip.invoice_number) || !(link.invoice_date || trip.invoice_date) || !(link.invoice_attachment_url || trip.invoice_attachment_url));
    if (incompleteInvoice) { toast(`Edit trip and complete the invoice details for PO ${incompleteInvoice.purchase_orders?.po_number || ''}.`); return; }
    completingTripId = tripId; $('completeTripForm').reset(); $('completeTripError').textContent = '';
    const links = trip.delivery_trip_pos || [];
    $('completeTripSummary').textContent = `${links.length} PO${links.length === 1 ? '' : 's'} in this trip — complete each delivery separately.`;
    $('completeTripPoDetails').innerHTML = links.map(link => `<tr data-po-id="${link.purchase_order_id}">
      <td><span class="po-main">${safe(link.purchase_orders?.po_number || 'PO')}</span><span class="po-secondary">${safe(link.purchase_orders?.delivery_location || 'Location pending')}</span></td>
      <td><input class="complete-po-cost" type="number" min="0" step="0.01" placeholder="0" value="${Number(link.allocated_cost || 0) || ''}" /></td>
      <td><input class="complete-po-slip" type="file" accept="application/pdf,image/jpeg,image/png" required /></td>
    </tr>`).join('');
    updateCompleteTripTotal();
    $('completeTripDialog').showModal();
  }
  async function completeTrip(event) {
    event.preventDefault(); const error = $('completeTripError'); error.textContent = '';
    const trip = trips.find(item => item.id === completingTripId);
    if (!trip) { error.textContent = 'Trip not found. Refresh and try again.'; return; }
    const details = [...$('completeTripPoDetails').querySelectorAll('tr')].map(row => ({ poId: row.dataset.poId, finalCost: Number(row.querySelector('.complete-po-cost').value || 0), slip: row.querySelector('.complete-po-slip').files?.[0], poNumber: row.querySelector('.po-main')?.textContent || 'PO' }));
    const missingSlip = details.find(detail => !detail.slip); if (missingSlip) { error.textContent = `Upload the signed delivery slip for PO ${missingSlip.poNumber}.`; return; }
    const button = $('completeTripBtn');
    try {
      button.disabled = true; button.textContent = 'Completing delivery…';
      const deliveries = await Promise.all(details.map(async detail => ({ purchase_order_id: detail.poId, note_path: await uploadTripDeliverySlip(trip.id, detail.poId, detail.slip), final_cost: detail.finalCost })));
      await api('/rest/v1/rpc/complete_delivery_trip', { method: 'POST', headers: { 'Content-Type': 'application/json', Prefer: 'return=minimal' }, body: JSON.stringify({ trip: trip.id, deliveries }) });
      closeCompleteTripDialog(); await loadData(); toast('Delivery completed — linked POs updated in the owner tracker.');
    } catch (err) { error.textContent = err.message || 'Could not complete the delivery.'; }
    finally { button.disabled = false; button.textContent = 'Complete delivery'; }
  }

  function toggleCustomDates() { $('customDateFilters').classList.toggle('hidden', $('dateRangeFilter').value !== 'custom'); }
  function clearFilters() { $('searchInput').value = ''; $('statusFilter').value = ''; $('dateRangeFilter').value = ''; $('dateFrom').value = ''; $('dateTo').value = ''; toggleCustomDates(); render(); }
  function bindEvents() {
    $('loginForm').addEventListener('submit', async event => { event.preventDefault(); $('loginError').textContent = ''; try { await signIn($('emailInput').value.trim(), $('passwordInput').value); await start(); } catch (error) { $('loginError').textContent = error.message || 'Sign in failed.'; } });
    $('signOutBtn').addEventListener('click', signOut); $('refreshBtn').addEventListener('click', loadData); $('clearFilters').addEventListener('click', clearFilters); $('tripPlanForm').addEventListener('submit', saveTrip);
    $('openTripDialogBtn').addEventListener('click', openCreateTrip);
    $('closeTripDialogBtn').addEventListener('click', closeTripDialog); $('cancelTripBtn').addEventListener('click', closeTripDialog);
    $('tripPoDetails').addEventListener('change', event => { if (event.target.matches('.po-invoice-file')) handleInvoiceFile(event.target); });
    $('completeTripForm').addEventListener('submit', completeTrip); $('closeCompleteTripBtn').addEventListener('click', closeCompleteTripDialog); $('cancelCompleteTripBtn').addEventListener('click', closeCompleteTripDialog);
    $('completeTripPoDetails').addEventListener('input', event => { if (event.target.matches('.complete-po-cost')) updateCompleteTripTotal(); });
    $('inTripBody').addEventListener('click', event => {
      const editButton = event.target.closest('.edit-trip-btn'), completeButton = event.target.closest('.complete-trip-btn');
      if (editButton) openEditTrip(editButton.dataset.tripId); else if (completeButton) openCompleteTrip(completeButton.dataset.tripId);
    });
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
