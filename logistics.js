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
  async function uploadTripInvoice(tripId, file) {
    if (!file) throw new Error('Attach the invoice copy before creating the trip.');
    if (file.size > 10 * 1024 * 1024) throw new Error('Invoice copy must be 10 MB or smaller.');
    const fileName = file.name.replace(/[^a-zA-Z0-9._-]/g, '_');
    const path = `trip-invoices/${tripId}/${Date.now()}-${fileName}`;
    await api(`/storage/v1/object/${NOTE_BUCKET}/${path}`, { method: 'POST', headers: { 'Content-Type': file.type || 'application/octet-stream', 'x-upsert': 'true' }, body: file });
    return path;
  }

  async function loadData() {
    $('connectionStatus').textContent = 'Loading POs…';
    const [poResult, tripResult] = await Promise.allSettled([
      api('/rest/v1/purchase_orders?select=*&order=po_received_date.desc'),
      api('/rest/v1/delivery_trips?select=*,delivery_trip_pos(purchase_order_id,allocated_cost,purchase_orders(id,po_number,customer_name,delivery_location,status))&order=trip_date.desc,created_at.desc')
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
    $('openTripDialogBtn').disabled = chosen.length === 0;
    $('openTripDialogBtn').textContent = `Create new trip (${chosen.length})`;
    $('createTripBtn').disabled = chosen.length === 0;
    $('createTripBtn').textContent = `Create trip with ${chosen.length} PO${chosen.length === 1 ? '' : 's'}`;
  }
  function renderTrips() {
    $('tripCount').textContent = `${trips.length} active trip${trips.length === 1 ? '' : 's'}`;
    $('inTripBody').innerHTML = trips.map(trip => {
      const links = trip.delivery_trip_pos || [];
      const chips = links.map(link => `<span class="trip-po-chip">${safe(link.purchase_orders?.po_number || 'PO')} · ${safe(link.purchase_orders?.delivery_location || 'Location pending')}</span>`).join('');
      return `<tr><td>${localDate(trip.trip_date)}</td><td><div class="trip-po-list">${chips || 'No POs linked'}</div></td><td>${safe(trip.vehicle_number || trip.transporter || '—')}<span class="po-secondary">${safe(trip.driver_name || '')}</span></td><td>${safe(trip.invoice_number || '—')}<span class="po-secondary">${localDate(trip.invoice_date)}</span></td><td><span class="executive-status">${safe(trip.status)}</span></td><td>${money(trip.actual_freight || trip.quoted_cost)}</td></tr>`;
    }).join('');
    $('tripEmptyState').classList.toggle('hidden', trips.length !== 0);
  }
  function render() { renderOpenPos(); renderPlan(); renderTrips(); }

  async function createTrip(event) {
    event.preventDefault(); const error = $('tripPlanError'); error.textContent = '';
    const chosen = records.filter(record => selectedPoIds.has(record.id));
    if (!chosen.length) { error.textContent = 'Select at least one PO first.'; return; }
    if (!tripStorageReady) { error.textContent = 'Trip database setup is not ready. Run logistics-supabase.sql once in Supabase.'; return; }
    try {
      const button = $('createTripBtn'); button.disabled = true; button.textContent = 'Creating trip…';
      const freight = Number($('tripFreight').value || 0), tripId = crypto.randomUUID();
      const invoicePath = await uploadTripInvoice(tripId, $('tripInvoiceCopy').files[0]);
      const payload = { id: tripId, trip_date: $('tripDate').value, status: 'Planning', transporter: $('tripTransporter').value.trim(), vehicle_number: $('tripVehicle').value.trim() || null, driver_name: $('tripDriver').value.trim() || null, driver_phone: $('tripDriverPhone').value.trim() || null, invoice_number: $('tripInvoice').value.trim() || null, invoice_date: $('tripInvoiceDate').value || null, invoice_attachment_url: invoicePath, quoted_cost: freight, actual_freight: freight };
      await api('/rest/v1/delivery_trips', { method: 'POST', headers: { 'Content-Type': 'application/json', Prefer: 'return=minimal' }, body: JSON.stringify(payload) });
      const allocated = chosen.length ? freight / chosen.length : 0;
      const links = chosen.map(record => ({ trip_id: tripId, purchase_order_id: record.id, allocation_method: 'Equal', allocated_cost: allocated }));
      await api('/rest/v1/delivery_trip_pos', { method: 'POST', headers: { 'Content-Type': 'application/json', Prefer: 'return=minimal' }, body: JSON.stringify(links) });
      selectedPoIds.clear(); $('tripPlanDialog').close(); $('tripPlanForm').reset(); $('tripDate').value = today(); await loadData(); toast('Trip created — selected POs moved to POs in trip.');
    } catch (err) { error.textContent = err.message || 'Could not create the trip.'; }
    finally { $('createTripBtn').disabled = selectedPoIds.size === 0; renderPlan(); }
  }

  function toggleCustomDates() { $('customDateFilters').classList.toggle('hidden', $('dateRangeFilter').value !== 'custom'); }
  function clearFilters() { $('searchInput').value = ''; $('statusFilter').value = ''; $('dateRangeFilter').value = ''; $('dateFrom').value = ''; $('dateTo').value = ''; toggleCustomDates(); render(); }
  function bindEvents() {
    $('loginForm').addEventListener('submit', async event => { event.preventDefault(); $('loginError').textContent = ''; try { await signIn($('emailInput').value.trim(), $('passwordInput').value); await start(); } catch (error) { $('loginError').textContent = error.message || 'Sign in failed.'; } });
    $('signOutBtn').addEventListener('click', signOut); $('refreshBtn').addEventListener('click', loadData); $('clearFilters').addEventListener('click', clearFilters); $('tripPlanForm').addEventListener('submit', createTrip);
    $('openTripDialogBtn').addEventListener('click', () => { if (!selectedPoIds.size) return; $('tripPlanError').textContent = ''; renderPlan(); $('tripPlanDialog').showModal(); });
    $('closeTripDialogBtn').addEventListener('click', () => $('tripPlanDialog').close()); $('cancelTripBtn').addEventListener('click', () => $('tripPlanDialog').close());
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
