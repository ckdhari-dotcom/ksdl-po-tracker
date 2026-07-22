(() => {
  'use strict';

  const CONFIG = window.PO_TRACKER_CONFIG || {};
  const BASE_URL = String(CONFIG.SUPABASE_URL || '').replace(/\/$/, '');
  const PUBLIC_KEY = CONFIG.SUPABASE_ANON_KEY || '';
  const SESSION_KEY = 'ksdl-po-tracker-session';
  const NOTE_BUCKET = 'delivery-notes';
  const OPEN_STATUSES = ['Received', 'Scheduled', 'In Transit', 'Partially Delivered'];
  const INR = new Intl.NumberFormat('en-IN', { style: 'currency', currency: 'INR', maximumFractionDigits: 0 });

  let session = null;
  let records = [];
  let refreshTimer = null;

  const $ = id => document.getElementById(id);
  const money = value => INR.format(Number(value || 0));
  const safe = value => String(value ?? '').replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]);
  const localDate = value => value ? new Date(`${value}T00:00:00`).toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' }) : '—';
  const isoDate = date => `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
  const ageDays = record => record.po_received_date ? Math.max(0, Math.floor((new Date() - new Date(`${record.po_received_date}T00:00:00`)) / 86400000)) : null;

  function show(id) { $(id).classList.remove('hidden'); }
  function hide(id) { $(id).classList.add('hidden'); }
  function headers(extra = {}) {
    return { apikey: PUBLIC_KEY, Authorization: `Bearer ${session?.access_token || PUBLIC_KEY}`, ...extra };
  }
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
    clearTimeout(toast.timer); toast.timer = setTimeout(() => element.classList.remove('show'), 2800);
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
    const text = String(value || '');
    const publicMarker = `/storage/v1/object/public/${NOTE_BUCKET}/`;
    return text.includes(publicMarker) ? text.split(publicMarker)[1].split('?')[0] : text;
  }
  async function signedFileUrl(value) {
    const path = filePath(value); if (!path) return '';
    const data = await api(`/storage/v1/object/sign/${NOTE_BUCKET}/${path}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ expiresIn: 3600 }) });
    return data?.signedURL ? `${BASE_URL}/storage/v1${data.signedURL}` : '';
  }

  async function loadRecords() {
    $('connectionStatus').textContent = 'Loading open POs…';
    try {
      const data = await api('/rest/v1/purchase_orders?select=*&order=po_received_date.desc');
      records = (Array.isArray(data) ? data : []).filter(record => OPEN_STATUSES.includes(record.status));
      await Promise.all(records.map(async record => {
        if (record.po_attachment_url) record.po_attachment_link = await signedFileUrl(record.po_attachment_url).catch(() => '');
      }));
      $('connectionStatus').textContent = 'Cloud synced'; render();
    } catch (error) {
      records = []; render(); $('connectionStatus').textContent = 'Could not load POs'; toast(error.message || 'Could not load open POs');
    }
  }

  function monthBounds(offset) {
    const now = new Date();
    const start = new Date(now.getFullYear(), now.getMonth() + offset, 1);
    const end = offset === 0 ? now : new Date(now.getFullYear(), now.getMonth() + offset + 1, 0);
    return { from: isoDate(start), to: isoDate(end) };
  }
  function selectedBounds() {
    const range = $('dateRangeFilter').value;
    if (range === 'current') return monthBounds(0);
    if (range === 'last') return monthBounds(-1);
    if (range === 'custom') return { from: $('dateFrom').value, to: $('dateTo').value };
    return { from: '', to: '' };
  }
  function filteredRecords() {
    const search = $('searchInput').value.trim().toLowerCase();
    const status = $('statusFilter').value;
    const { from, to } = selectedBounds();
    return records.filter(record => {
      const poDate = record.po_date || '';
      const searchable = [record.po_number, record.customer_name, record.delivery_location, record.invoice_number, record.transporter, record.tracking_number, record.assigned_to, record.remarks].join(' ').toLowerCase();
      return (!status || record.status === status) && (!from || (poDate && poDate >= from)) && (!to || (poDate && poDate <= to)) && (!search || searchable.includes(search));
    });
  }
  function statusClass(status) { return String(status || '').toLowerCase().replaceAll(' ', '-'); }
  function render() {
    const showing = filteredRecords();
    const totalValue = showing.reduce((sum, record) => sum + Number(record.po_value || 0), 0);
    $('openCount').textContent = showing.length; $('openValue').textContent = `${money(totalValue)} value`;
    $('receivedCount').textContent = showing.filter(record => record.status === 'Received').length;
    $('scheduledCount').textContent = showing.filter(record => record.status === 'Scheduled').length;
    $('transitCount').textContent = showing.filter(record => record.status === 'In Transit').length;
    $('partialCount').textContent = showing.filter(record => record.status === 'Partially Delivered').length;
    $('resultCount').textContent = `${showing.length} open PO${showing.length === 1 ? '' : 's'}`;
    $('poTableBody').innerHTML = showing.map(record => {
      const age = ageDays(record);
      const attachment = record.po_attachment_link ? `<a class="po-link" href="${safe(record.po_attachment_link)}" target="_blank" rel="noopener">View PO copy</a>` : '';
      return `<tr>
        <td><span class="po-main">${safe(record.po_number || '—')}</span><span class="po-secondary">${safe(record.customer_name || '—')}</span>${attachment}</td>
        <td>${localDate(record.po_date)}<span class="po-secondary">Received ${localDate(record.po_received_date)}</span></td>
        <td><span class="executive-status ${statusClass(record.status)}">${safe(record.status)}</span></td>
        <td>${safe(record.delivery_location || '—')}</td>
        <td>${money(record.po_value)}</td>
        <td>${safe(record.invoice_number || '—')}<span class="po-secondary">${localDate(record.invoice_date)}</span></td>
        <td>${safe(record.transporter || '—')}<span class="po-secondary">${safe(record.tracking_number || '')}${record.transport_amount ? ` · ${money(record.transport_amount)}` : ''}</span></td>
        <td>${safe(record.assigned_to || '—')}</td>
        <td>${age == null ? '—' : `${age} days`}</td>
        <td>${safe(record.remarks || '—')}</td>
      </tr>`;
    }).join('');
    $('emptyState').classList.toggle('hidden', showing.length !== 0);
  }
  function toggleCustomDates() { $('customDateFilters').classList.toggle('hidden', $('dateRangeFilter').value !== 'custom'); }
  function clearFilters() {
    $('searchInput').value = ''; $('statusFilter').value = ''; $('dateRangeFilter').value = '';
    $('dateFrom').value = ''; $('dateTo').value = ''; toggleCustomDates(); render();
  }
  function bindEvents() {
    $('loginForm').addEventListener('submit', async event => {
      event.preventDefault(); $('loginError').textContent = '';
      try { await signIn($('emailInput').value.trim(), $('passwordInput').value); await start(); }
      catch (error) { $('loginError').textContent = error.message || 'Sign in failed.'; }
    });
    $('signOutBtn').addEventListener('click', signOut); $('refreshBtn').addEventListener('click', loadRecords); $('clearFilters').addEventListener('click', clearFilters);
    ['searchInput', 'statusFilter', 'dateFrom', 'dateTo'].forEach(id => { $(id).addEventListener('input', render); $(id).addEventListener('change', render); });
    $('dateRangeFilter').addEventListener('change', () => { toggleCustomDates(); render(); });
  }
  async function start() {
    if (!BASE_URL || !PUBLIC_KEY) { show('loginScreen'); $('loginError').textContent = 'Supabase is not configured.'; return; }
    $('signedInAs').textContent = session?.user?.email || '';
    hide('loginScreen'); show('app'); await loadRecords();
    clearInterval(refreshTimer); refreshTimer = setInterval(loadRecords, 60000);
  }

  bindEvents(); toggleCustomDates();
  try { session = JSON.parse(sessionStorage.getItem(SESSION_KEY) || 'null'); } catch (_) { session = null; }
  if (session?.access_token && (!session.expires_at || session.expires_at * 1000 > Date.now() + 30000)) start();
  else { sessionStorage.removeItem(SESSION_KEY); show('loginScreen'); }
})();
