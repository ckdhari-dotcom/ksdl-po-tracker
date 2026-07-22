/* KSDL Trips & Dispatch – works with the existing Supabase tracker login. */
(() => {
  'use strict';
  const config = window.PO_TRACKER_CONFIG || {};
  const baseUrl = String(config.SUPABASE_URL || '').replace(/\/$/, '');
  const publicKey = config.SUPABASE_ANON_KEY || '';
  const SESSION_KEY = 'ksdl_po_tracker_session';
  const MONEY = new Intl.NumberFormat('en-IN', { style: 'currency', currency: 'INR', maximumFractionDigits: 0 });
  const OPEN_PO_STATUSES = ['Received', 'Scheduled', 'In Transit', 'Partially Delivered'];
  let session = null;
  let role = '';
  let trips = [];
  let purchaseOrders = [];
  let activeTrip = null;
  let selectedOpenPoIds = new Set();

  const $ = id => document.getElementById(id);
  const isOwner = () => role === 'owner';
  const number = value => Number(value || 0);
  const money = value => MONEY.format(number(value));
  const esc = value => String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
  const today = () => new Date().toISOString().slice(0, 10);
  const totalActual = trip => number(trip.actual_freight) + number(trip.loading_cost) + number(trip.parking_toll) + number(trip.other_cost);

  function headers(extra = {}) {
    return { apikey: publicKey, Authorization: `Bearer ${session?.access_token || publicKey}`, ...extra };
  }
  async function api(path, options = {}) {
    const response = await fetch(`${baseUrl}${path}`, { ...options, headers: headers(options.headers || {}) });
    const text = await response.text();
    const data = text ? (() => { try { return JSON.parse(text); } catch { return text; } })() : null;
    if (!response.ok) throw new Error(data?.message || data?.error_description || text || `Request failed (${response.status})`);
    return data;
  }
  function saveSession(next) { session = next; sessionStorage.setItem(SESSION_KEY, JSON.stringify(next)); }
  function clearSession() { session = null; sessionStorage.removeItem(SESSION_KEY); }
  function show(id) { $(id).classList.remove('hidden'); }
  function hide(id) { $(id).classList.add('hidden'); }
  function setMessage(message = '', error = false) { const el = $('syncMessage'); el.textContent = message; el.style.color = error ? '#b42318' : ''; }
  function setOwnerVisibility() {
    document.querySelectorAll('.owner-only').forEach(el => el.classList.toggle('hidden', !isOwner()));
    $('manualPoBtn').classList.toggle('hidden', isOwner());
    $('newTripBtn').classList.toggle('hidden', !isOwner());
    $('executivePoToolbar').classList.toggle('hidden', isOwner());
    $('readyPoPanel').classList.toggle('hidden', isOwner());
    $('tripSummary').classList.toggle('hidden', !isOwner());
    $('tripToolbar').classList.toggle('hidden', !isOwner());
    $('tripListPanel').classList.toggle('hidden', !isOwner());
  }

  async function signIn(email, password) {
    const data = await api('/auth/v1/token?grant_type=password', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email, password }) });
    saveSession(data);
  }
  async function signOut() {
    try { if (session?.access_token) await api('/auth/v1/logout', { method: 'POST' }); } catch (_) { /* local sign out still succeeds */ }
    clearSession();
    hide('app'); show('loginScreen');
  }
  async function loadRole() {
    const data = await api('/rest/v1/rpc/po_tracker_role', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
    role = String(data || '').replaceAll('"', '').toLowerCase();
    if (!['owner', 'executive'].includes(role)) throw new Error('This email is not authorised for KSDL Trips & Dispatch.');
    $('roleBadge').textContent = role === 'owner' ? 'Owner view' : 'Dispatch executive';
    setOwnerVisibility();
    if (!isOwner()) hide('tripComposer');
  }
  async function loadData() {
    setMessage('Loading Received POs…');
    if (!isOwner()) {
      const poData = await api('/rest/v1/purchase_orders?select=*&status=eq.Received&order=po_received_date.desc');
      trips = [];
      purchaseOrders = Array.isArray(poData) ? poData : [];
      render();
      setMessage(`${purchaseOrders.length} Received PO${purchaseOrders.length === 1 ? '' : 's'} loaded.`);
      return;
    }
    const [tripResult, poResult] = await Promise.allSettled([
      api('/rest/v1/delivery_trips?select=*,delivery_trip_pos(id,purchase_order_id,allocated_cost,allocation_method,purchase_orders(id,po_number,customer_name,delivery_location,po_value,status))&order=trip_date.desc,created_at.desc'),
      api('/rest/v1/purchase_orders?select=*&order=po_received_date.desc')
    ]);
    if (poResult.status === 'rejected') throw poResult.reason;
    trips = tripResult.status === 'fulfilled' && Array.isArray(tripResult.value) ? tripResult.value : [];
    purchaseOrders = Array.isArray(poResult.value) ? poResult.value : [];
    render();
    const tripWarning = tripResult.status === 'rejected' ? ' Open POs loaded; trip history is temporarily unavailable.' : '';
    setMessage(`Updated ${new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}.${tripWarning}`, tripResult.status === 'rejected');
  }
  function tripMatches(trip, search, status) {
    if (status && trip.status !== status) return false;
    const pos = trip.delivery_trip_pos || [];
    const value = [trip.transporter, trip.vehicle_number, trip.driver_name, trip.driver_phone, ...pos.flatMap(link => [link.purchase_orders?.po_number, link.purchase_orders?.customer_name, link.purchase_orders?.delivery_location])].join(' ').toLowerCase();
    return !search || value.includes(search);
  }
  function renderSummary() {
    const live = trips.filter(t => !['Delivered', 'Cancelled'].includes(t.status));
    const awaiting = trips.filter(t => t.status === 'Awaiting Approval');
    const now = new Date();
    const monthly = trips.filter(t => { const d = new Date(`${t.trip_date}T00:00:00`); return d.getFullYear() === now.getFullYear() && d.getMonth() === now.getMonth() && t.status !== 'Cancelled'; });
    const tripCost = monthly.reduce((sum, t) => sum + totalActual(t), 0);
    const linkedValue = monthly.reduce((sum, t) => sum + (t.delivery_trip_pos || []).reduce((inner, link) => inner + number(link.purchase_orders?.po_value), 0), 0);
    $('openTrips').textContent = live.length;
    $('awaitingTrips').textContent = awaiting.length;
    $('monthCost').textContent = money(tripCost);
    $('costPercent').textContent = linkedValue ? `${((tripCost / linkedValue) * 100).toFixed(1)}%` : '0%';
  }
  function statusClass(status) { return status === 'Awaiting Approval' ? 'awaiting' : status === 'Cancelled' ? 'cancelled' : ''; }
  function render() {
    renderSummary();
    renderReadyPos();
    const search = $('searchInput').value.trim().toLowerCase();
    const status = $('statusFilter').value;
    const filtered = trips.filter(t => tripMatches(t, search, status));
    $('resultCount').textContent = `${filtered.length} trip${filtered.length === 1 ? '' : 's'}`;
    $('emptyState').classList.toggle('hidden', trips.length !== 0);
    $('tripTableBody').innerHTML = filtered.map(trip => {
      const pos = trip.delivery_trip_pos || [];
      const chips = pos.length ? pos.map(link => `<span class="po-chip">${esc(link.purchase_orders?.po_number || 'PO')} · ${esc(link.purchase_orders?.delivery_location || 'Location pending')}</span>`).join('') : '<span class="cell-muted">No POs linked</span>';
      return `<tr>
        <td><div class="cell-main">${esc(trip.trip_date)}</div><div class="cell-muted">${esc(trip.transporter || 'Transporter pending')}</div></td>
        <td><div class="cell-main">${esc(trip.vehicle_number || 'Vehicle pending')}</div><div class="cell-muted">${esc(trip.driver_name || 'Driver pending')}${trip.driver_phone ? ` · ${esc(trip.driver_phone)}` : ''}</div></td>
        <td><div class="trip-pos">${chips}</div></td>
        <td><span class="status ${statusClass(trip.status)}">${esc(trip.status)}</span></td>
        <td class="owner-only"><div class="cell-main">${money(trip.quoted_cost)}</div><div class="cell-muted">Approved: ${trip.approved_cost == null ? '—' : money(trip.approved_cost)}</div></td>
        <td><div class="cell-main">${money(totalActual(trip))}</div><div class="cell-muted">Freight + extras</div></td>
        <td><button class="view-trip" data-id="${trip.id}" type="button">View</button></td>
      </tr>`;
    }).join('');
    setOwnerVisibility();
  }

  function renderReadyPos() {
    const panel = $('readyPoPanel');
    const showForExecutive = !isOwner();
    panel.classList.toggle('hidden', !showForExecutive);
    if (!showForExecutive) return;
    const openPoSearch = $('openPoSearch').value.trim().toLowerCase();
    const ready = purchaseOrders.filter(po => po.status === 'Received').filter(po => {
      const searchable = [po.po_number, po.customer_name, po.delivery_location, po.invoice_number, po.transporter, po.remarks, po.status].join(' ').toLowerCase();
      return !openPoSearch || searchable.includes(openPoSearch);
    });
    $('readyPoBody').innerHTML = ready.map(po => `<tr><td><div class="cell-main">${esc(po.po_number)}</div><div class="cell-muted">${esc(po.customer_name || 'Customer')}</div></td><td>${esc(po.delivery_location || '—')}</td><td>${esc(po.po_date || '—')}<div class="cell-muted">Received ${esc(po.po_received_date || '—')}</div></td><td><span class="status">Received</span></td><td>${money(po.po_value)}</td><td>${esc(po.invoice_number || '—')}<div class="cell-muted">${esc(po.invoice_date || '')}</div></td><td>${esc(po.transporter || '—')}<div class="cell-muted">${money(po.transport_amount)}</div></td><td>${esc(po.assigned_to || '—')}</td><td>${esc(po.remarks || '—')}</td></tr>`).join('');
    $('readyPoEmpty').classList.toggle('hidden', ready.length !== 0);
  }

  function getSelectedIds() { return [...document.querySelectorAll('.po-choice:checked')].map(input => input.value); }
  function getFormTrip() {
    return {
      trip_date: $('tripDate').value, transporter: $('transporter').value.trim() || null, vehicle_number: $('vehicleNumber').value.trim() || null,
      driver_name: $('driverName').value.trim() || null, driver_phone: $('driverPhone').value.trim() || null, status: $('tripStatus').value,
      invoice_number: $('tripInvoiceNumber').value.trim() || null, invoice_date: $('tripInvoiceDate').value || null,
      quoted_cost: number($('quotedCost').value), approved_cost: $('approvedCost').value === '' ? null : number($('approvedCost').value),
      actual_freight: number($('actualFreight').value), loading_cost: number($('loadingCost').value), parking_toll: number($('parkingToll').value), other_cost: number($('otherCost').value), remarks: $('tripRemarks').value.trim() || null
    };
  }
  function renderChecklist(selected = []) {
    const term = $('poSearch').value.trim().toLowerCase();
    const selectedSet = new Set(selected);
    const available = purchaseOrders.filter(po => (OPEN_PO_STATUSES.includes(po.status) || selectedSet.has(po.id)) && (!term || [po.po_number, po.customer_name, po.delivery_location].join(' ').toLowerCase().includes(term)));
    $('poChecklist').innerHTML = available.length ? available.map(po => `<label class="po-option"><input class="po-choice" type="checkbox" value="${po.id}" ${selectedSet.has(po.id) ? 'checked' : ''}/><span><strong>${esc(po.po_number)} · ${esc(po.customer_name || 'Customer')}</strong><small>${esc(po.delivery_location || 'Location pending')} · ${money(po.po_value)} · ${esc(po.status)}</small></span></label>`).join('') : '<p class="cell-muted" style="padding:12px">No open PO matches this search.</p>';
    document.querySelectorAll('.po-choice').forEach(input => input.addEventListener('change', updateAllocationPreview));
    updateAllocationPreview();
  }
  function updateAllocationPreview() {
    const ids = getSelectedIds(); const total = number($('actualFreight').value) + number($('loadingCost').value) + number($('parkingToll').value) + number($('otherCost').value);
    if (!ids.length) { $('allocationPreview').textContent = 'Select POs to see the cost allocation.'; $('selectedTripPoSummary').textContent = 'Select POs from the list above, or use the checklist below.'; return; }
    const rows = purchaseOrders.filter(po => ids.includes(po.id)); const byValue = $('allocationMethod').value === 'PO Value'; const valueTotal = rows.reduce((sum, po) => sum + number(po.po_value), 0);
    const detail = rows.map(po => { const allocated = byValue && valueTotal ? total * number(po.po_value) / valueTotal : total / rows.length; return `${po.po_number}: ${money(allocated)}`; }).join(' · ');
    $('selectedTripPoSummary').textContent = `${rows.length} PO${rows.length === 1 ? '' : 's'} selected: ${rows.map(po => po.po_number).join(', ')}`;
    $('allocationPreview').textContent = `Total ${money(total)} will be allocated — ${detail}`;
  }
  function refreshTotal() { $('totalActual').textContent = money(number($('actualFreight').value) + number($('loadingCost').value) + number($('parkingToll').value) + number($('otherCost').value)); updateAllocationPreview(); }
  function setStatusOptions(value) {
    const allowed = isOwner() ? ['Planning', 'Awaiting Approval', 'Approved', 'Dispatched', 'Delivered', 'Cancelled'] : (activeTrip ? ['Planning', 'Awaiting Approval', 'Dispatched', 'Delivered'] : ['Planning', 'Awaiting Approval']);
    $('tripStatus').innerHTML = allowed.map(status => `<option ${status === value ? 'selected' : ''}>${status}</option>`).join('');
  }
  function openTripForm(trip = null, initialSelected = []) {
    activeTrip = trip;
    $('tripForm').reset(); $('tripError').textContent = ''; $('tripId').value = trip?.id || ''; $('tripDialogTitle').textContent = trip ? 'Update delivery trip' : 'New delivery trip';
    $('tripDate').value = trip?.trip_date || today(); $('transporter').value = trip?.transporter || ''; $('vehicleNumber').value = trip?.vehicle_number || '';
    $('driverName').value = trip?.driver_name || ''; $('driverPhone').value = trip?.driver_phone || ''; setStatusOptions(trip?.status || 'Planning');
    $('tripInvoiceNumber').value = trip?.invoice_number || ''; $('tripInvoiceDate').value = trip?.invoice_date || '';
    $('quotedCost').value = trip?.quoted_cost ?? 0; $('approvedCost').value = trip?.approved_cost ?? ''; $('actualFreight').value = trip?.actual_freight ?? 0;
    $('loadingCost').value = trip?.loading_cost ?? 0; $('parkingToll').value = trip?.parking_toll ?? 0; $('otherCost').value = trip?.other_cost ?? 0; $('tripRemarks').value = trip?.remarks || '';
    document.querySelectorAll('.owner-cost').forEach(el => el.classList.toggle('hidden', !isOwner()));
    const linked = trip ? (trip.delivery_trip_pos || []).map(link => link.purchase_order_id) : initialSelected;
    const selectedLabels = purchaseOrders.filter(po => linked.includes(po.id)).map(po => po.po_number);
    $('selectedTripPoSummary').textContent = selectedLabels.length ? `${selectedLabels.length} PO${selectedLabels.length === 1 ? '' : 's'} selected: ${selectedLabels.join(', ')}` : 'Select POs from the list above, or use the checklist below.';
    renderChecklist(linked); refreshTotal(); show('tripComposer'); $('tripComposer').scrollIntoView({ behavior: 'smooth', block: 'start' });
  }
  async function saveTrip(event) {
    event.preventDefault();
    const error = $('tripError'); error.textContent = '';
    const formData = getFormTrip(); const selected = getSelectedIds();
    if (!formData.trip_date) { error.textContent = 'Please enter the trip date.'; return; }
    if (!selected.length) { error.textContent = 'Select at least one PO loaded in this trip.'; return; }
    const invoiceCopy = $('tripInvoiceCopy').files[0];
    if (!activeTrip && !invoiceCopy) { error.textContent = 'Attach the invoice copy before saving this new trip.'; return; }
    if (!isOwner()) { formData.quoted_cost = activeTrip?.quoted_cost || 0; formData.approved_cost = activeTrip?.approved_cost ?? null; }
    try {
      $('saveTripBtn').disabled = true; $('saveTripBtn').textContent = 'Saving…';
      let tripId = activeTrip?.id || crypto.randomUUID();
      if (invoiceCopy) formData.invoice_attachment_url = await uploadTripInvoice(tripId, invoiceCopy);
      if (activeTrip) {
        await api(`/rest/v1/delivery_trips?id=eq.${encodeURIComponent(tripId)}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json', Prefer: 'return=minimal' }, body: JSON.stringify(formData) });
        await api(`/rest/v1/delivery_trip_pos?trip_id=eq.${encodeURIComponent(tripId)}`, { method: 'DELETE', headers: { Prefer: 'return=minimal' } });
      } else {
        formData.id = tripId;
        await api('/rest/v1/delivery_trips', { method: 'POST', headers: { 'Content-Type': 'application/json', Prefer: 'return=minimal' }, body: JSON.stringify(formData) });
      }
      const chosen = purchaseOrders.filter(po => selected.includes(po.id)); const total = totalActual(formData); const method = $('allocationMethod').value; const poValueTotal = chosen.reduce((sum, po) => sum + number(po.po_value), 0);
      const links = chosen.map(po => ({ trip_id: tripId, purchase_order_id: po.id, allocation_method: method, allocated_cost: method === 'PO Value' && poValueTotal ? total * number(po.po_value) / poValueTotal : total / chosen.length }));
      await api('/rest/v1/delivery_trip_pos', { method: 'POST', headers: { 'Content-Type': 'application/json', Prefer: 'return=minimal' }, body: JSON.stringify(links) });
      selectedOpenPoIds.clear(); hide('tripComposer'); await loadData(); setMessage('Trip saved successfully.');
    } catch (err) { error.textContent = err.message || 'Could not save this trip.'; }
    finally { $('saveTripBtn').disabled = false; $('saveTripBtn').textContent = 'Save trip'; }
  }
  function openTripView(id) {
    activeTrip = trips.find(t => t.id === id); if (!activeTrip) return;
    const pos = activeTrip.delivery_trip_pos || [];
    $('viewTripTitle').textContent = `${activeTrip.trip_date} · ${activeTrip.vehicle_number || 'Delivery trip'}`;
    $('viewTripBody').innerHTML = `<div class="view-grid">
      <div class="view-item"><span>Transporter</span><strong>${esc(activeTrip.transporter || '—')}</strong></div><div class="view-item"><span>Driver</span><strong>${esc(activeTrip.driver_name || '—')}${activeTrip.driver_phone ? ` · ${esc(activeTrip.driver_phone)}` : ''}</strong></div>
      <div class="view-item"><span>Status</span><strong>${esc(activeTrip.status)}</strong></div><div class="view-item"><span>Actual trip cost</span><strong>${money(totalActual(activeTrip))}</strong></div>
      <div class="view-item"><span>Invoice</span><strong>${esc(activeTrip.invoice_number || '—')}${activeTrip.invoice_date ? ` · ${esc(activeTrip.invoice_date)}` : ''}</strong></div>
      ${isOwner() ? `<div class="view-item"><span>Quoted / approved</span><strong>${money(activeTrip.quoted_cost)} / ${activeTrip.approved_cost == null ? '—' : money(activeTrip.approved_cost)}</strong></div>` : ''}
      <div class="view-item"><span>Cost detail</span><strong>Freight ${money(activeTrip.actual_freight)} · Extras ${money(number(activeTrip.loading_cost) + number(activeTrip.parking_toll) + number(activeTrip.other_cost))}</strong></div>
    </div><div class="view-pos"><h3>Linked POs</h3><div class="trip-pos" style="margin-top:8px">${pos.map(link => `<span class="po-chip">${esc(link.purchase_orders?.po_number || 'PO')} · ${esc(link.purchase_orders?.delivery_location || 'Location pending')} · ${money(link.allocated_cost)}</span>`).join('') || 'No PO linked'}</div></div>${activeTrip.remarks ? `<div class="view-pos"><h3>Remarks</h3><p>${esc(activeTrip.remarks)}</p></div>` : ''}`;
    $('approveTripBtn').classList.toggle('hidden', !isOwner() || !['Planning', 'Awaiting Approval'].includes(activeTrip.status));
    $('deleteTripBtn').classList.toggle('hidden', !isOwner()); $('viewDialog').showModal();
    const isClosed = ['Delivered', 'Cancelled'].includes(activeTrip.status);
    $('completeTripPanel').classList.toggle('hidden', isClosed);
    $('editTripBtn').classList.toggle('hidden', isClosed);
    $('deliverySlipInput').value = '';
  }

  async function uploadTripDeliverySlip(tripId, file) {
    if (!file) throw new Error('Please choose the signed delivery slip first.');
    if (file.size > 10 * 1024 * 1024) throw new Error('Delivery slip must be 10 MB or smaller.');
    const safeName = file.name.replace(/[^a-zA-Z0-9._-]/g, '_');
    const path = `trip-delivery-slips/${tripId}/${Date.now()}-${safeName}`;
    await api(`/storage/v1/object/delivery-notes/${path}`, { method: 'POST', headers: { 'Content-Type': file.type || 'application/octet-stream', 'x-upsert': 'true' }, body: file });
    return path;
  }

  async function uploadTripInvoice(tripId, file) {
    if (!file) return null;
    if (file.size > 10 * 1024 * 1024) throw new Error('Invoice copy must be 10 MB or smaller.');
    const safeName = file.name.replace(/[^a-zA-Z0-9._-]/g, '_');
    const path = `trip-invoices/${tripId}/${Date.now()}-${safeName}`;
    await api(`/storage/v1/object/delivery-notes/${path}`, { method: 'POST', headers: { 'Content-Type': file.type || 'application/octet-stream', 'x-upsert': 'true' }, body: file });
    return path;
  }

  async function completeActiveTrip() {
    if (!activeTrip) return;
    const button = $('completeTripBtn');
    try {
      button.disabled = true; button.textContent = 'Uploading…';
      const path = await uploadTripDeliverySlip(activeTrip.id, $('deliverySlipInput').files[0]);
      await api('/rest/v1/rpc/complete_delivery_trip', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ trip: activeTrip.id, note_path: path }) });
      $('viewDialog').close(); await loadData(); setMessage('Delivery slip saved — trip and linked POs are now Delivered.');
    } catch (err) { alert(err.message || 'Unable to complete this trip.'); }
    finally { button.disabled = false; button.textContent = 'Upload slip & complete trip'; }
  }

  async function uploadManualFile(recordId, file, folder) {
    if (!file) return null;
    if (file.size > 10 * 1024 * 1024) throw new Error('File must be 10 MB or smaller.');
    const safeName = file.name.replace(/[^a-zA-Z0-9._-]/g, '_');
    const path = `${folder}/${recordId}/${Date.now()}-${safeName}`;
    await api(`/storage/v1/object/delivery-notes/${path}`, { method: 'POST', headers: { 'Content-Type': file.type || 'application/octet-stream', 'x-upsert': 'true' }, body: file });
    return path;
  }

  function openManualPoForm(record = null) {
    $('manualPoForm').reset(); $('manualPoError').textContent = ''; $('manualPoId').value = record?.id || '';
    const correction = record?.review_status === 'Needs Correction';
    $('manualPoTitle').textContent = correction ? 'Correct returned PO' : 'Add manual PO';
    $('manualCustomer').value = record?.customer_name || ''; $('manualPoNumber').value = record?.po_number || '';
    $('manualLocation').value = record?.delivery_location || ''; $('manualPoDate').value = record?.po_date || today();
    $('manualReceivedDate').value = record?.po_received_date || today(); $('manualPoValue').value = record?.po_value ?? 0;
    $('manualRemarks').value = correction ? `${record?.remarks || ''}${record?.correction_note ? `\nOwner correction: ${record.correction_note}` : ''}`.trim() : (record?.remarks || '');
    $('manualSlipLabel').classList.toggle('hidden', !correction);
    $('manualPoDialog').showModal();
  }

  async function saveManualPo(event) {
    event.preventDefault();
    const error = $('manualPoError'); error.textContent = '';
    const existing = purchaseOrders.find(po => po.id === $('manualPoId').value);
    const id = existing?.id || crypto.randomUUID();
    const customer = $('manualCustomer').value.trim(), poNumber = $('manualPoNumber').value.trim();
    if (!customer || !poNumber) { error.textContent = 'Customer name and PO number are required.'; return; }
    try {
      $('saveManualPoBtn').disabled = true; $('saveManualPoBtn').textContent = 'Saving…';
      const record = {
        id, customer_name: customer, po_number: poNumber, delivery_location: $('manualLocation').value.trim() || null,
        po_date: $('manualPoDate').value, po_received_date: $('manualReceivedDate').value, po_value: number($('manualPoValue').value),
        remarks: $('manualRemarks').value.trim() || null, entry_source: 'Manual',
        status: existing?.status || 'Received', review_status: existing ? 'Submitted' : 'Draft', correction_note: null
      };
      const poCopy = $('manualPoCopy').files[0], replacementSlip = $('manualDeliverySlip').files[0];
      if (poCopy) record.po_attachment_url = await uploadManualFile(id, poCopy, 'manual-po-copies');
      if (replacementSlip) record.delivery_note_url = await uploadManualFile(id, replacementSlip, 'manual-delivery-corrections');
      if (existing) {
        await api(`/rest/v1/purchase_orders?id=eq.${encodeURIComponent(id)}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json', Prefer: 'return=minimal' }, body: JSON.stringify(record) });
      } else {
        await api('/rest/v1/purchase_orders', { method: 'POST', headers: { 'Content-Type': 'application/json', Prefer: 'return=minimal' }, body: JSON.stringify(record) });
      }
      $('manualPoDialog').close(); await loadData(); setMessage(existing ? 'Correction resubmitted to the owner.' : 'Manual PO created. Select it to create a dispatch trip.');
    } catch (err) { error.textContent = err.message || 'Could not save the manual PO.'; }
    finally { $('saveManualPoBtn').disabled = false; $('saveManualPoBtn').textContent = 'Save manual PO'; }
  }
  async function approveActiveTrip() {
    if (!activeTrip || !isOwner()) return;
    try {
      await api(`/rest/v1/delivery_trips?id=eq.${encodeURIComponent(activeTrip.id)}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json', Prefer: 'return=minimal' }, body: JSON.stringify({ status: 'Approved', approved_cost: activeTrip.approved_cost ?? activeTrip.quoted_cost, approved_at: new Date().toISOString() }) });
      $('viewDialog').close(); await loadData(); setMessage('Trip approved.');
    } catch (err) { alert(err.message || 'Unable to approve this trip.'); }
  }
  async function deleteActiveTrip() {
    if (!activeTrip || !isOwner() || !confirm('Delete this trip and its PO cost allocations?')) return;
    try { await api(`/rest/v1/delivery_trips?id=eq.${encodeURIComponent(activeTrip.id)}`, { method: 'DELETE', headers: { Prefer: 'return=minimal' } }); $('viewDialog').close(); await loadData(); setMessage('Trip deleted.'); }
    catch (err) { alert(err.message || 'Unable to delete this trip.'); }
  }
  function bindEvents() {
    $('loginForm').addEventListener('submit', async event => { event.preventDefault(); $('loginError').textContent = ''; try { await signIn($('emailInput').value.trim(), $('passwordInput').value); await start(); } catch (err) { $('loginError').textContent = err.message || 'Sign in failed.'; } });
    $('signOutBtn').addEventListener('click', signOut); $('newTripBtn').addEventListener('click', () => openTripForm()); $('emptyNewBtn').addEventListener('click', () => openTripForm()); $('manualPoBtn').addEventListener('click', () => openManualPoForm());
    $('refreshBtn').addEventListener('click', () => loadData().catch(err => setMessage(err.message, true))); $('executiveRefreshBtn').addEventListener('click', () => loadData().catch(err => setMessage(err.message, true))); $('openPoSearch').addEventListener('input', renderReadyPos); $('searchInput').addEventListener('input', render); $('statusFilter').addEventListener('change', render);
    $('tripForm').addEventListener('submit', saveTrip); $('manualPoForm').addEventListener('submit', saveManualPo); $('poSearch').addEventListener('input', () => renderChecklist(getSelectedIds())); $('allocationMethod').addEventListener('change', updateAllocationPreview);
    ['actualFreight', 'loadingCost', 'parkingToll', 'otherCost'].forEach(id => $(id).addEventListener('input', refreshTotal));
    document.addEventListener('click', event => { const closer = event.target.closest('[data-close]'); if (closer) $(closer.dataset.close).close(); if (event.target.closest('[data-hide-trip]')) hide('tripComposer'); const view = event.target.closest('.view-trip'); if (view) openTripView(view.dataset.id); const correction = event.target.closest('.correct-manual-po'); if (correction) openManualPoForm(purchaseOrders.find(po => po.id === correction.dataset.id)); });
    document.addEventListener('change', event => { if (!event.target.matches('.open-po-choice')) return; if (event.target.checked) selectedOpenPoIds.add(event.target.value); else selectedOpenPoIds.delete(event.target.value); renderReadyPos(); });
    $('editTripBtn').addEventListener('click', () => { $('viewDialog').close(); openTripForm(activeTrip); }); $('approveTripBtn').addEventListener('click', approveActiveTrip); $('deleteTripBtn').addEventListener('click', deleteActiveTrip); $('completeTripBtn').addEventListener('click', completeActiveTrip);
  }
  async function start() {
    if (!baseUrl || !publicKey) { $('loginError').textContent = 'Supabase is not configured in config.js.'; show('loginScreen'); return; }
    try { await loadRole(); hide('loginScreen'); show('app'); await loadData(); } catch (err) { clearSession(); hide('app'); show('loginScreen'); $('loginError').textContent = err.message || 'Your session has expired. Please sign in again.'; }
  }
  bindEvents();
  try { session = JSON.parse(sessionStorage.getItem(SESSION_KEY) || 'null'); } catch (_) { clearSession(); }
  if (session?.access_token) start(); else show('loginScreen');
})();
