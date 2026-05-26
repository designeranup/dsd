const PALETTE = ['#42a5f5','#66bb6a','#ffa726','#ab47bc','#ef5350','#26c6da','#ec407a','#ffca28','#7e57c2','#26a69a','#5c6bc0','#8d6e63','#789262','#bf6e6e','#7a9fbf'];

const state = {
  bcoming: [],
  individuals: [],
  extraction: [],
  cdna: [],
  pcr: [],
  sanger: [],
  samplesOverview: [],
  charts: {},
  matrixFilter: { animalSet: 'all', sort: 'year-desc', count: 'samples' },
  allTablesMetadata: [],
  allColumns: [],
  refTables: {},
  columnMeta: {},
  individualsColumnMeta: {},
  extractionColumnMeta: {},
  cdnaColumnMeta: {},
  pcrColumnMeta: {},
  sangerColumnMeta: {},
  attachmentsById: new Map(),
  attachmentBlobUrls: new Map(),
  gristTokenInfo: null,
  diag: { allTables: [], overviewTable: null, bcomingTable: null, individualsTable: null, extractionTable: null, cdnaTable: null, pcrTable: null, sangerTable: null }
};

const PROJECT_YEAR_ORDER = ['BD4', 'BD3', 'BD2', 'BD'];
const MODAL_PAGE_SIZE = 50;
const MODAL_SCROLL_THRESHOLD_PX = 300;

function getCssVar(name) {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
}

function chartDefaults() {
  const text = getCssVar('--text-secondary');
  const grid = getCssVar('--border-color');
  Chart.defaults.color = text;
  Chart.defaults.borderColor = grid;
  Chart.defaults.font.family = '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif';
  Chart.defaults.font.size = 12;
  Chart.defaults.plugins.legend.labels.color = text;
  Chart.defaults.plugins.legend.labels.usePointStyle = true;
  Chart.defaults.plugins.legend.labels.boxWidth = 8;
}

function destroyChart(id) {
  if (state.charts[id]) {
    state.charts[id].destroy();
    delete state.charts[id];
  }
}

function safeStr(v) {
  if (v === null || v === undefined) return '';
  return v.toString().trim();
}

function escapeHtml(s) {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function isValidReference(v) {
  return typeof v === 'number' && Number.isInteger(v) && v > 0;
}

function parseYear(v) {
  if (v === null || v === undefined) return null;
  const s = v.toString().trim();
  const m = s.match(/^\d{4}$/);
  if (!m) return null;
  const n = parseInt(s, 10);
  if (n >= 1900 && n <= 2030) return n;
  return null;
}

function getField(row, names) {
  if (!row) return undefined;
  for (const n of names) {
    if (row[n] !== undefined) return row[n];
  }
  const keys = Object.keys(row);
  const lowerMap = {};
  keys.forEach(k => { lowerMap[k.toLowerCase()] = k; });
  for (const n of names) {
    const found = lowerMap[n.toLowerCase()];
    if (found) return row[found];
  }
  return undefined;
}

function groupCI(rows, keyFn) {
  const map = new Map();
  rows.forEach(r => {
    const raw = keyFn(r);
    if (raw === null || raw === undefined) return;
    const s = raw.toString().trim();
    if (!s) return;
    const key = s.toLowerCase();
    if (!map.has(key)) {
      map.set(key, { display: s, count: 0 });
    }
    map.get(key).count++;
  });
  return [...map.values()].sort((a, b) => b.count - a.count);
}

function parseWidgetOptions(s) {
  if (!s || typeof s !== 'string') return {};
  try { return JSON.parse(s); } catch { return {}; }
}

function pad2(n) { return String(n).padStart(2, '0'); }

async function loadAllColumnMetadata() {
  try {
    const [tablesRaw, columnsRaw] = await Promise.all([
      grist.docApi.fetchTable('_grist_Tables').catch(() => null),
      grist.docApi.fetchTable('_grist_Tables_column').catch(() => null)
    ]);
    state.allTablesMetadata = tablesRaw ? tableToRows(tablesRaw) : [];
    state.allColumns = columnsRaw ? tableToRows(columnsRaw) : [];
  } catch (e) {
    console.warn('Metadata load failed:', e);
    state.allTablesMetadata = [];
    state.allColumns = [];
  }
}

function getColumnMetaMap(tableId) {
  if (!tableId) return {};
  const tableRow = state.allTablesMetadata.find(t => t.tableId === tableId);
  if (!tableRow) return {};
  const cols = state.allColumns.filter(c => c.parentId === tableRow.id);
  const colByRef = new Map();
  state.allColumns.forEach(c => colByRef.set(c.id, c));
  const meta = {};
  cols.forEach(c => {
    const visibleColId = c.visibleCol ? colByRef.get(c.visibleCol)?.colId : null;
    meta[c.colId] = {
      colRef: c.id,
      type: c.type || 'Any',
      label: c.label || c.colId,
      visibleCol: c.visibleCol,
      visibleColId,
      widgetOptions: parseWidgetOptions(c.widgetOptions),
      parentPos: typeof c.parentPos === 'number' ? c.parentPos : 999999
    };
  });
  return meta;
}

async function preloadRefTablesFor(colMetaMap) {
  const targets = new Set();
  Object.values(colMetaMap).forEach(m => {
    if (m.type && /^Ref(List)?:/.test(m.type)) {
      const t = m.type.split(':')[1];
      if (t && !state.refTables[t]) targets.add(t);
    }
  });
  await Promise.all([...targets].map(async (t) => {
    if (state.refTables[t]) return;
    try {
      const data = await grist.docApi.fetchTable(t);
      const rows = tableToRows(data);
      const rowsById = new Map();
      rows.forEach(r => rowsById.set(r.id, r));
      state.refTables[t] = { rowsById };
    } catch (e) {
      console.warn(`Could not preload ref table "${t}":`, e.message);
    }
  }));
}

function formatDateTimeInTz(d, tz) {
  if (!tz) tz = 'UTC';
  try {
    const dtf = new Intl.DateTimeFormat('en-GB', {
      year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', hour12: false,
      timeZone: tz
    });
    const parts = dtf.formatToParts(d);
    const get = (t) => (parts.find(p => p.type === t) || {}).value || '';
    let hour = get('hour');
    if (hour === '24') hour = '00';
    return `${get('year')}-${get('month')}-${get('day')} ${hour}:${get('minute')}`;
  } catch {
    return d.toISOString().replace('T', ' ').slice(0, 16);
  }
}

function formatCellForGrist(value, colMeta) {
  if (value === null || value === undefined) return { text: '', cls: '' };
  const type = (colMeta && colMeta.type) || 'Any';

  if (Array.isArray(value) && value[0] === 'E') {
    return { text: '#' + (value[1] || 'Error'), cls: 'error' };
  }

  if (Array.isArray(value) && value[0] === 'L') {
    const items = value.slice(1);
    if (type.startsWith('RefList:')) {
      const target = type.split(':')[1];
      const refTable = state.refTables[target];
      const visibleColId = colMeta && colMeta.visibleColId;
      const labels = items.map(id => {
        if (refTable && visibleColId) {
          const refRow = refTable.rowsById.get(id);
          if (refRow) {
            const v = refRow[visibleColId];
            if (v != null && v !== '') return safeStr(v);
          }
        }
        return `#${id}`;
      });
      return { text: labels.join(', '), cls: 'ref' };
    }
    if (type === 'Attachments') {
      const count = items.length;
      if (!count) return { text: '', cls: 'attachment' };
      return {
        text: `${count} file${count > 1 ? 's' : ''}`,
        cls: 'attachment has-files',
        attachmentIds: items
      };
    }
    return { text: items.map(v => safeStr(v)).join(', '), cls: '' };
  }

  if (type === 'Date') {
    if (typeof value === 'number') {
      const d = new Date(value * 1000);
      return { text: `${d.getUTCFullYear()}-${pad2(d.getUTCMonth() + 1)}-${pad2(d.getUTCDate())}`, cls: 'date' };
    }
  }

  if (type.startsWith('DateTime')) {
    if (typeof value === 'number') {
      const d = new Date(value * 1000);
      const tz = type.split(':')[1] || 'UTC';
      return { text: formatDateTimeInTz(d, tz), cls: 'datetime' };
    }
  }

  if (type.startsWith('Ref:')) {
    if (typeof value === 'number' && value > 0) {
      const target = type.split(':')[1];
      const refTable = state.refTables[target];
      if (refTable) {
        const refRow = refTable.rowsById.get(value);
        if (refRow) {
          const visibleColId = colMeta && colMeta.visibleColId;
          if (visibleColId) {
            const v = refRow[visibleColId];
            if (v != null && v !== '') return { text: safeStr(v), cls: 'ref' };
          }
        }
      }
      return { text: `#${value}`, cls: 'ref' };
    }
    return { text: '', cls: '' };
  }

  if (type === 'Bool') {
    if (value === true) return { text: 'true', cls: 'bool' };
    if (value === false) return { text: 'false', cls: 'bool' };
    return { text: safeStr(value), cls: 'bool' };
  }

  if (type === 'Numeric' || type === 'Int') {
    if (typeof value === 'number') {
      const opts = (colMeta && colMeta.widgetOptions) || {};
      let text;
      if (opts.numMode === 'percent') {
        const dec = opts.decimals != null ? opts.decimals : 0;
        text = (value * 100).toFixed(dec) + '%';
      } else if (opts.numMode === 'currency') {
        const dec = opts.decimals != null ? opts.decimals : 2;
        const curr = opts.currency || 'USD';
        try {
          text = new Intl.NumberFormat(undefined, {
            style: 'currency', currency: curr,
            minimumFractionDigits: dec, maximumFractionDigits: dec
          }).format(value);
        } catch {
          text = value.toFixed(dec);
        }
      } else if (opts.decimals != null) {
        text = value.toFixed(opts.decimals);
      } else {
        text = value.toString();
      }
      return { text, cls: 'num' };
    }
  }

  if (type === 'Choice') {
    return { text: safeStr(value), cls: 'choice' };
  }

  if (typeof value === 'object') {
    return { text: JSON.stringify(value), cls: '' };
  }
  return { text: value.toString(), cls: '' };
}

function positionSubtabSlider(group) {
  const slider = group.querySelector('.subtab-slider');
  const active = group.querySelector('.subtab.active');
  if (!slider || !active) return;
  if (active.offsetWidth === 0) return;
  const firstPaint = !slider.dataset.positioned;
  if (firstPaint) slider.style.transition = 'none';
  slider.style.left = active.offsetLeft + 'px';
  slider.style.top = active.offsetTop + 'px';
  slider.style.width = active.offsetWidth + 'px';
  slider.style.height = active.offsetHeight + 'px';
  if (firstPaint) {
    void slider.offsetWidth;
    slider.style.transition = '';
    slider.dataset.positioned = '1';
  }
}

function positionVisibleSliders() {
  document.querySelectorAll('.subtabs').forEach(positionSubtabSlider);
}

function setupTabs() {
  document.querySelectorAll('.tab').forEach(btn => {
    btn.addEventListener('click', () => {
      const target = btn.dataset.tab;
      document.querySelectorAll('.tab').forEach(b => b.classList.toggle('active', b === btn));
      document.querySelectorAll('.tab-content').forEach(c => c.classList.remove('active'));
      const el = document.getElementById(target + 'Tab');
      if (el) {
        el.classList.add('active');
        el.querySelectorAll('.subtabs').forEach(positionSubtabSlider);
      }
      setTimeout(() => {
        Object.values(state.charts).forEach(c => c.resize && c.resize());
        positionVisibleSliders();
      }, 50);
    });
  });

  document.querySelectorAll('.subtabs').forEach(group => {
    const buttons = group.querySelectorAll('.subtab');
    buttons.forEach(btn => {
      btn.addEventListener('click', () => {
        const target = btn.dataset.subtab;
        buttons.forEach(b => b.classList.toggle('active', b === btn));
        const parent = group.parentElement;
        parent.querySelectorAll(':scope > .subtab-content').forEach(c => c.classList.remove('active'));
        const el = document.getElementById(target + 'Tab');
        if (el) el.classList.add('active');
        positionSubtabSlider(group);
        setTimeout(() => {
          Object.values(state.charts).forEach(c => c.resize && c.resize());
        }, 50);
      });
    });
  });
}

function updateModalSubtitle() {
  const parts = [];
  if (state.modalFilterDesc) parts.push(state.modalFilterDesc);
  const total = state.modalRows.length;
  if (total === 0) {
    parts.push('0 records');
  } else if (state.modalShown >= total) {
    parts.push(`${total.toLocaleString()} record${total !== 1 ? 's' : ''}`);
  } else {
    parts.push(`${state.modalShown.toLocaleString()} showing out of ${total.toLocaleString()}`);
  }
  document.getElementById('modalSubtitle').textContent = parts.join(' • ');
}

function appendModalRows() {
  const tbody = document.getElementById('modalTableBody');
  if (!tbody) return;

  const start = state.modalShown;
  const end = Math.min(start + MODAL_PAGE_SIZE, state.modalRows.length);
  if (start >= end) return;

  let html = '';
  for (let i = start; i < end; i++) {
    const r = state.modalRows[i];
    html += '<tr>';
    state.modalCols.forEach(c => {
      const m = state.modalColMeta[c];
      const formatted = formatCellForGrist(r[c], m);
      const cls = formatted.cls ? ` class="${formatted.cls}"` : '';
      const safe = escapeHtml(formatted.text);
      const colLabel = (m && m.label) || c;
      const attrs = formatted.attachmentIds
        ? ` data-attachments="${formatted.attachmentIds.join(',')}" data-col-label="${escapeHtml(colLabel)}" title="Click to view photos"`
        : ` title="${safe}"`;
      html += `<td${cls}${attrs}>${safe}</td>`;
    });
    html += '</tr>';
  }

  tbody.insertAdjacentHTML('beforeend', html);
  state.modalShown = end;
  updateModalSubtitle();
}

async function ensureGristToken() {
  if (state.gristTokenInfo && state.gristTokenInfo.expiresAt > Date.now()) {
    return state.gristTokenInfo;
  }
  try {
    const info = await grist.docApi.getAccessToken({ readOnly: true });
    if (info && info.token && info.baseUrl) {
      state.gristTokenInfo = {
        token: info.token,
        baseUrl: info.baseUrl.replace(/\/$/, ''),
        expiresAt: Date.now() + Math.max(10000, (info.ttlMsecs || 60000) - 5000)
      };
      console.log(`[grist] access token baseUrl="${state.gristTokenInfo.baseUrl}" ttl=${info.ttlMsecs || 'n/a'}ms`);
      return state.gristTokenInfo;
    }
    console.warn('[grist] getAccessToken returned incomplete info:', info);
  } catch (e) {
    console.warn('[grist] getAccessToken failed:', e);
  }
  state.gristTokenInfo = null;
  return null;
}

async function loadAttachmentsMetadata() {
  try {
    const data = await grist.docApi.fetchTable('_grist_Attachments').catch(() => null);
    if (!data) return;
    const rows = tableToRows(data);
    state.attachmentsById = new Map();
    rows.forEach(r => state.attachmentsById.set(r.id, r));
  } catch (e) {
    console.warn('Could not load _grist_Attachments:', e);
  }
}

function attachmentUrl(attId) {
  const info = state.gristTokenInfo;
  if (!info) return null;
  return `${info.baseUrl}/attachments/${attId}/download?auth=${encodeURIComponent(info.token)}&inline=true`;
}

function buildAttachmentFetchAttempts(attId) {
  const attempts = [];
  const info = state.gristTokenInfo;
  if (info && info.baseUrl) {
    const base = info.baseUrl;
    const tok = encodeURIComponent(info.token);
    attempts.push({
      label: 'token-query + inline + credentials',
      url: `${base}/attachments/${attId}/download?auth=${tok}&inline=true`,
      opts: { credentials: 'include' }
    });
    attempts.push({
      label: 'token-query + credentials (no inline)',
      url: `${base}/attachments/${attId}/download?auth=${tok}`,
      opts: { credentials: 'include' }
    });
    attempts.push({
      label: 'Bearer header + inline + credentials',
      url: `${base}/attachments/${attId}/download?inline=true`,
      opts: {
        credentials: 'include',
        headers: { 'Authorization': `Bearer ${info.token}` }
      }
    });
    attempts.push({
      label: 'credentials only (cookie auth) + inline',
      url: `${base}/attachments/${attId}/download?inline=true`,
      opts: { credentials: 'include' }
    });
  }
  return attempts;
}

async function getAttachmentBlobUrl(attId) {
  if (state.attachmentBlobUrls.has(attId)) {
    return state.attachmentBlobUrls.get(attId);
  }
  await ensureGristToken();

  const attempts = buildAttachmentFetchAttempts(attId);
  if (!attempts.length) {
    console.warn(`[attachment ${attId}] no access token / baseUrl available`);
    return null;
  }

  for (const att of attempts) {
    try {
      const resp = await fetch(att.url, att.opts);
      if (resp.ok) {
        const blob = await resp.blob();
        const blobUrl = URL.createObjectURL(blob);
        state.attachmentBlobUrls.set(attId, blobUrl);
        console.log(`[attachment ${attId}] OK via "${att.label}" — ${blob.size} bytes, type=${blob.type || '(none)'}`);
        return blobUrl;
      }
      console.warn(`[attachment ${attId}] "${att.label}" returned HTTP ${resp.status} ${resp.statusText}`);
    } catch (e) {
      console.warn(`[attachment ${attId}] "${att.label}" threw:`, e.message);
    }
  }

  console.error(`[attachment ${attId}] all fetch attempts failed; URL of last attempt was ${attempts[attempts.length - 1].url}`);
  return null;
}

async function getImageDisplayUrl(attId) {
  const blobUrl = await getAttachmentBlobUrl(attId);
  if (blobUrl) return blobUrl;
  await ensureGristToken();
  return attachmentUrl(attId);
}

function openLightbox(url, caption) {
  const img = document.getElementById('lightboxImage');
  const captionEl = document.getElementById('lightboxCaption');
  captionEl.textContent = caption || '';

  img.onerror = () => {
    console.warn('[lightbox] image failed to load:', url);
    captionEl.textContent = `Unable to load image — ${caption || ''}`.trim();
  };
  img.onload = () => {
    captionEl.textContent = caption || '';
  };

  img.src = url;
  document.getElementById('lightboxOverlay').classList.add('visible');
}

function closeLightbox() {
  const img = document.getElementById('lightboxImage');
  img.removeAttribute('src');
  document.getElementById('lightboxOverlay').classList.remove('visible');
}

function isImageAttachment(meta) {
  if (!meta) return false;
  const mime = safeStr(meta.fileType || meta.mimeType || '').toLowerCase();
  if (mime.startsWith('image/')) return true;
  const name = safeStr(meta.fileName || '').toLowerCase();
  return /\.(jpe?g|png|gif|webp|bmp|svg|heic|heif|avif)$/.test(name);
}

function fileExtension(meta) {
  const name = safeStr(meta && meta.fileName);
  const m = name.match(/\.([a-z0-9]{1,5})$/i);
  return m ? m[1].toUpperCase() : 'FILE';
}

function buildBlockedTileHtml(meta, attId, directUrl) {
  const name = safeStr(meta.fileName) || `#${attId}`;
  const safeName = escapeHtml(name);
  const ext = escapeHtml(fileExtension(meta));
  const linkAttr = directUrl ? ` href="${escapeHtml(directUrl)}" target="_blank" rel="noopener"` : '';
  const linkHtml = directUrl ? `<a class="gallery-open-btn"${linkAttr}>Open</a>` : '';
  return `
    <div class="gallery-placeholder">
      <div class="ext">${ext}</div>
      <div>${safeName}</div>
      ${linkHtml}
    </div>
    <div class="gallery-caption">${safeName}</div>
  `;
}

async function openGalleryModal(ids, colLabel) {
  document.getElementById('galleryTitle').textContent = colLabel || 'Attachments';
  document.getElementById('gallerySubtitle').textContent = `${ids.length} attachment${ids.length !== 1 ? 's' : ''}`;

  const grid = document.getElementById('galleryGrid');
  document.getElementById('galleryModal').classList.add('visible');

  await ensureGristToken();
  if (!state.gristTokenInfo) {
    grid.innerHTML = '<div class="empty-state" style="grid-column: 1/-1;">Attachment access unavailable. Make sure the widget has Full access to the document.</div>';
    return;
  }

  grid.innerHTML = ids.map(id => {
    const meta = state.attachmentsById.get(id) || {};
    const name = safeStr(meta.fileName) || `#${id}`;
    const safeName = escapeHtml(name);
    const isImage = isImageAttachment(meta);
    return `
      <div class="gallery-item ${isImage ? '' : 'not-clickable'}" data-att-id="${id}" data-is-image="${isImage ? '1' : '0'}">
        <div class="gallery-placeholder">
          ${isImage ? '<div class="gallery-spinner"></div>' : `<div class="ext">${escapeHtml(fileExtension(meta))}</div><div>${safeName}</div>`}
        </div>
        <div class="gallery-caption">${safeName}</div>
      </div>
    `;
  }).join('');

  let anyBlocked = false;

  await Promise.all(ids.map(async (id) => {
    const meta = state.attachmentsById.get(id) || {};
    if (!isImageAttachment(meta)) return;

    const item = grid.querySelector(`[data-att-id="${id}"]`);
    if (!item) return;

    const url = await getImageDisplayUrl(id);
    const stillThere = grid.querySelector(`[data-att-id="${id}"]`);
    if (!stillThere) return;
    const name = safeStr(meta.fileName) || `#${id}`;
    const safeName = escapeHtml(name);

    if (!url) {
      anyBlocked = true;
      stillThere.classList.add('not-clickable');
      stillThere.innerHTML = buildBlockedTileHtml(meta, id, null);
      return;
    }

    stillThere.innerHTML = `
      <img alt="${safeName}" loading="lazy" draggable="false">
      <div class="gallery-placeholder" style="display:none;">
        <div class="ext">${escapeHtml(fileExtension(meta))}</div>
        <div>${safeName}</div>
        <a class="gallery-open-btn" href="${escapeHtml(url)}" target="_blank" rel="noopener">Open</a>
      </div>
      <div class="gallery-caption">${safeName}</div>
    `;

    const img = stillThere.querySelector('img');
    await new Promise((resolve) => {
      img.addEventListener('load', () => {
        stillThere.addEventListener('click', () => openLightbox(url, name));
        resolve();
      }, { once: true });
      img.addEventListener('error', () => {
        console.warn(`[attachment ${id}] <img> failed to load url=${url}`);
        anyBlocked = true;
        img.remove();
        const placeholder = stillThere.querySelector('.gallery-placeholder');
        if (placeholder) placeholder.style.display = 'flex';
        stillThere.classList.add('not-clickable');
        resolve();
      }, { once: true });
      img.src = url;
    });
  }));

  if (anyBlocked) {
    const widgetOrigin = window.location.origin;
    const gristOrigin = state.gristTokenInfo ? new URL(state.gristTokenInfo.baseUrl).origin : 'your Grist server';
    const notice = document.createElement('div');
    notice.className = 'gallery-notice';
    notice.innerHTML = `
      <strong>Image preview blocked by browser</strong>
      The widget origin <code>${escapeHtml(widgetOrigin)}</code> can't load files from <code>${escapeHtml(gristOrigin)}</code> because of Chrome's Private Network Access policy.
      Click <strong>Open</strong> on any tile to view the file in a new tab (it will be served as a download because Grist sets <code>Content-Disposition: attachment</code> on its only attachment endpoint).
      To enable inline previews, either host this widget on the same origin as your Grist server, or have your Grist admin add
      <code>Access-Control-Allow-Origin: ${escapeHtml(widgetOrigin)}</code> and
      <code>Access-Control-Allow-Private-Network: true</code> to the Grist server's response headers.
    `;
    grid.insertBefore(notice, grid.firstChild);
  }
}

function closeGalleryModal() {
  document.getElementById('galleryModal').classList.remove('visible');
  document.getElementById('galleryGrid').innerHTML = '';
}

function onModalScroll(e) {
  const el = e.currentTarget;
  if (state.modalShown >= state.modalRows.length) return;
  const distanceFromBottom = el.scrollHeight - el.scrollTop - el.clientHeight;
  if (distanceFromBottom < MODAL_SCROLL_THRESHOLD_PX) {
    appendModalRows();
  }
}

function openDataModal(filterDesc, rows, options) {
  options = options || {};
  const title = options.title || 'BCOMING_Samples';
  const columnMeta = options.columnMeta || state.columnMeta || {};

  document.getElementById('modalTitle').textContent = title;

  state.modalRows = rows;
  state.modalShown = 0;
  state.modalFilterDesc = filterDesc;
  state.modalCols = [];
  state.modalColMeta = columnMeta;

  const wrap = document.getElementById('modalTableWrap');
  const modalBody = document.querySelector('#dataModal .modal-body');
  if (modalBody) {
    modalBody.removeEventListener('scroll', onModalScroll);
    modalBody.scrollTop = 0;
  }

  if (!rows.length) {
    wrap.innerHTML = '<div class="empty-state" style="padding:60px 20px;">No matching records.</div>';
    updateModalSubtitle();
    document.getElementById('dataModal').classList.add('visible');
    document.body.style.overflow = 'hidden';
    return;
  }

  const colMeta = state.modalColMeta;
  const allCols = Object.keys(rows[0]).filter(k => {
    if (k === 'id' || k === 'manualSort') return false;
    if (k.startsWith('gristHelper_')) return false;
    return true;
  });
  allCols.sort((a, b) => {
    const pa = (colMeta[a] && colMeta[a].parentPos) != null ? colMeta[a].parentPos : 999999;
    const pb = (colMeta[b] && colMeta[b].parentPos) != null ? colMeta[b].parentPos : 999999;
    if (pa !== pb) return pa - pb;
    return a.localeCompare(b);
  });
  state.modalCols = allCols;

  let html = '<table class="modal-table"><thead><tr>';
  allCols.forEach(c => {
    const m = colMeta[c];
    const label = (m && m.label) || c;
    html += `<th title="${escapeHtml(c)}">${escapeHtml(label)}</th>`;
  });
  html += '</tr></thead><tbody id="modalTableBody"></tbody></table>';
  wrap.innerHTML = html;

  appendModalRows();

  if (modalBody) {
    modalBody.addEventListener('scroll', onModalScroll);
  }

  document.getElementById('dataModal').classList.add('visible');
  document.body.style.overflow = 'hidden';
}

function closeDataModal() {
  const modalBody = document.querySelector('#dataModal .modal-body');
  if (modalBody) modalBody.removeEventListener('scroll', onModalScroll);
  document.getElementById('dataModal').classList.remove('visible');
  document.body.style.overflow = '';
}

function openIndividualsModal(filterDesc, filterFn) {
  const rows = state.individuals.filter(filterFn);
  openDataModal(filterDesc, rows, {
    title: 'BCOMING_Individuals',
    columnMeta: state.individualsColumnMeta || {}
  });
}

function openExtractionModal(filterDesc, filterFn) {
  openDataModal(filterDesc, state.extraction.filter(filterFn), {
    title: state.diag.extractionTable || 'BCOMING_Extraction',
    columnMeta: state.extractionColumnMeta || {}
  });
}

function openCdnaModal(filterDesc, filterFn) {
  openDataModal(filterDesc, state.cdna.filter(filterFn), {
    title: state.diag.cdnaTable || 'BCOMING_CDNA',
    columnMeta: state.cdnaColumnMeta || {}
  });
}

function openPcrModal(filterDesc, filterFn) {
  openDataModal(filterDesc, state.pcr.filter(filterFn), {
    title: state.diag.pcrTable || 'BCOMING_PCR',
    columnMeta: state.pcrColumnMeta || {}
  });
}

function openSangerModal(filterDesc, filterFn) {
  openDataModal(filterDesc, state.sanger.filter(filterFn), {
    title: state.diag.sangerTable || 'BCOMING_SangerSequencing',
    columnMeta: state.sangerColumnMeta || {}
  });
}

function setupModal() {
  document.getElementById('modalClose').addEventListener('click', closeDataModal);
  document.getElementById('dataModal').addEventListener('click', (e) => {
    if (e.target.id === 'dataModal') closeDataModal();
  });

  document.getElementById('galleryClose').addEventListener('click', closeGalleryModal);
  document.getElementById('galleryModal').addEventListener('click', (e) => {
    if (e.target.id === 'galleryModal') closeGalleryModal();
  });

  document.getElementById('lightboxClose').addEventListener('click', closeLightbox);
  document.getElementById('lightboxOverlay').addEventListener('click', (e) => {
    if (e.target.id === 'lightboxOverlay') closeLightbox();
  });

  document.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape') return;
    if (document.getElementById('lightboxOverlay').classList.contains('visible')) {
      closeLightbox();
    } else if (document.getElementById('galleryModal').classList.contains('visible')) {
      closeGalleryModal();
    } else if (document.getElementById('dataModal').classList.contains('visible')) {
      closeDataModal();
    }
  });

  document.getElementById('modalTableWrap').addEventListener('click', (e) => {
    const cell = e.target.closest('td[data-attachments]');
    if (!cell) return;
    const ids = cell.dataset.attachments.split(',').map(Number).filter(n => n > 0);
    if (!ids.length) return;
    openGalleryModal(ids, cell.dataset.colLabel || 'Attachments');
  });
}

function resolveCellDisplayValue(row, colId, colMeta) {
  const v = row[colId];
  if (v == null) return '';
  if (colMeta && typeof colMeta.type === 'string' && colMeta.type.startsWith('Ref:')) {
    if (typeof v === 'number' && v > 0) {
      const target = colMeta.type.split(':')[1];
      const refTable = state.refTables[target];
      if (refTable && colMeta.visibleColId) {
        const refRow = refTable.rowsById.get(v);
        if (refRow) {
          const dv = refRow[colMeta.visibleColId];
          if (dv != null && dv !== '') return safeStr(dv);
        }
      }
      return '#' + v;
    }
    return '';
  }
  return safeStr(v);
}

function projectFieldFromBcoming() {
  if (!state.bcoming.length) return null;
  const sample = state.bcoming[0];
  const keys = Object.keys(sample);

  const projectCandidates = ['project', 'mission', 'mission_code', 'project_code', 'campaign', 'bd', 'bd_mission'];
  const siteCandidates = ['site', 'site_code', 'site_name', 'fieldsite_code'];

  const findByName = (candidates) => {
    for (const c of candidates) {
      const k = keys.find(key => key.toLowerCase() === c);
      if (k) return k;
    }
    return null;
  };

  const findByRefTarget = (targetPatterns) => {
    const cm = state.columnMeta;
    if (!cm) return null;
    for (const [colId, meta] of Object.entries(cm)) {
      if (!meta || typeof meta.type !== 'string') continue;
      if (!meta.type.startsWith('Ref:')) continue;
      const target = meta.type.split(':')[1].toLowerCase();
      if (targetPatterns.some(p => target.includes(p))) return colId;
    }
    return null;
  };

  const siteKey = findByName(siteCandidates) || findByRefTarget(['site']);
  if (!siteKey) {
    if (!projectFieldFromBcoming._logged) {
      console.log('[matrix] No site field in BCOMING. Columns:', keys);
      projectFieldFromBcoming._logged = true;
    }
    return null;
  }

  let projectKey = findByName(projectCandidates) || findByRefTarget(['mission', 'project']);
  let projectFromSampleId = false;

  if (!projectKey) {
    const sampleIdKey = keys.find(k => k.toLowerCase() === 'sample_id');
    if (sampleIdKey) {
      projectKey = sampleIdKey;
      projectFromSampleId = true;
    }
  }

  if (!projectKey) {
    if (!projectFieldFromBcoming._logged) {
      console.log('[matrix] No project field nor sample_id in BCOMING. Columns:', keys);
      projectFieldFromBcoming._logged = true;
    }
    return null;
  }

  if (!projectFieldFromBcoming._logged) {
    const src = projectFromSampleId ? ' (mission derived from sample_id prefix)' : '';
    console.log(`[matrix] Using BCOMING fields project="${projectKey}"${src}, site="${siteKey}"`);
    projectFieldFromBcoming._logged = true;
  }
  return { projectKey, siteKey, projectFromSampleId };
}

function buildProjectPivotFromBcoming(animalSetFilter, countMode) {
  const fields = projectFieldFromBcoming();
  if (!fields) return null;
  const rows = state.bcoming;

  const filtered = (animalSetFilter && animalSetFilter !== 'all')
    ? rows.filter(r => safeStr(r.animal_set).toLowerCase() === animalSetFilter.toLowerCase())
    : rows;

  const colMeta = state.columnMeta || {};
  const projectMeta = colMeta[fields.projectKey];
  const siteMeta = colMeta[fields.siteKey];

  const resolveProject = (r) => {
    if (fields.projectFromSampleId) {
      const sid = safeStr(r[fields.projectKey]);
      if (!sid) return '';
      return sid.split('-')[0] || '';
    }
    return resolveCellDisplayValue(r, fields.projectKey, projectMeta);
  };

  const projectMap = new Map();
  const siteSet = new Set();

  if (countMode === 'animals') {
    const cellData = new Map();
    const allInd = new Set();
    const assignedInd = new Set();

    filtered.forEach(r => {
      const ind = r.individual_code;
      if (ind == null || ind === '') return;
      if (typeof ind === 'number' && ind <= 0) return;

      const p = resolveProject(r);
      const s = resolveCellDisplayValue(r, fields.siteKey, siteMeta);

      allInd.add(ind);
      if (!p || !s) return;

      assignedInd.add(ind);
      const key = p + '|' + s;
      let entry = cellData.get(key);
      if (!entry) { entry = { p, s, set: new Set() }; cellData.set(key, entry); }
      entry.set.add(ind);
      siteSet.add(s);
    });

    cellData.forEach(({ p, s, set }) => {
      if (!projectMap.has(p)) projectMap.set(p, {});
      projectMap.get(p)[s] = set.size;
    });

    return {
      projectMap,
      sites: [...siteSet].sort(),
      filteredCount: allInd.size,
      noSiteAmong: allInd.size - assignedInd.size,
      countMode: 'animals'
    };
  }

  let noCell = 0;
  filtered.forEach(r => {
    const p = resolveProject(r);
    const s = resolveCellDisplayValue(r, fields.siteKey, siteMeta);
    if (!p || !s) { noCell++; return; }
    if (!projectMap.has(p)) projectMap.set(p, {});
    projectMap.get(p)[s] = (projectMap.get(p)[s] || 0) + 1;
    siteSet.add(s);
  });

  return {
    projectMap,
    sites: [...siteSet].sort(),
    filteredCount: filtered.length,
    noSiteAmong: noCell,
    countMode: 'samples'
  };
}

function sortProjects(projects, projectMap, mode) {
  const totals = {};
  projects.forEach(p => {
    totals[p] = Object.values(projectMap.get(p) || {}).reduce((x, y) => x + y, 0);
  });

  if (mode === 'total-desc') {
    return [...projects].sort((a, b) => totals[b] - totals[a]);
  }
  if (mode === 'total-asc') {
    return [...projects].sort((a, b) => totals[a] - totals[b]);
  }
  return [...projects].sort((a, b) => {
    const ia = PROJECT_YEAR_ORDER.indexOf(a);
    const ib = PROJECT_YEAR_ORDER.indexOf(b);
    if (ia === -1 && ib === -1) return a.localeCompare(b);
    if (ia === -1) return 1;
    if (ib === -1) return -1;
    return ia - ib;
  });
}

function setupMatrixControls() {
  const controls = document.getElementById('matrixControls');
  if (!controls) return;
  const canFilter = !!projectFieldFromBcoming();

  let html = '';
  if (canFilter) {
    const animalSets = [...new Set(state.bcoming.map(r => safeStr(r.animal_set)).filter(s => s))].sort();
    html += `
      <label class="matrix-control-label" for="matrixAnimalSet">Animal set</label>
      <select class="matrix-select" id="matrixAnimalSet">
        <option value="all">All animal sets</option>
        ${animalSets.map(a => `<option value="${escapeHtml(a)}">${escapeHtml(a)}</option>`).join('')}
      </select>
    `;
  }
  html += `
    <label class="matrix-control-label" for="matrixSort">Sort</label>
    <select class="matrix-select" id="matrixSort">
      <option value="year-desc">Year (newest first)</option>
      <option value="total-desc">Total (high to low)</option>
      <option value="total-asc">Total (low to high)</option>
    </select>
  `;
  controls.innerHTML = html;

  const animalSel = document.getElementById('matrixAnimalSet');
  if (animalSel) {
    animalSel.value = state.matrixFilter.animalSet;
    animalSel.addEventListener('change', (e) => {
      state.matrixFilter.animalSet = e.target.value;
      renderProjectMatrix();
    });
  }
  const sortSel = document.getElementById('matrixSort');
  sortSel.value = state.matrixFilter.sort;
  sortSel.addEventListener('change', (e) => {
    state.matrixFilter.sort = e.target.value;
    renderProjectMatrix();
  });
}

function renderKpis(items, targetId) {
  document.getElementById(targetId).innerHTML = items.map(it => `
    <div class="kpi-card ${it.accent || ''}">
      <p class="kpi-label">${escapeHtml(it.label)}</p>
      <p class="kpi-value">${it.value}</p>
      ${it.sub ? `<p class="kpi-sub">${escapeHtml(it.sub)}</p>` : ''}
    </div>
  `).join('');
}

function renderQualityCard(containerId, totalId, total, rows) {
  document.getElementById(totalId).textContent = `${total.toLocaleString()} total`;
  const container = document.getElementById(containerId);
  container.innerHTML = rows.map((r, i) => `
    <div class="quality-row ${r.onClick ? 'clickable' : ''}" data-idx="${i}">
      <div class="quality-row-name">
        <span class="quality-dot ${r.dot}"></span>
        <span>${escapeHtml(r.name)}</span>
      </div>
      <div>
        <span class="quality-row-count">${r.count.toLocaleString()}</span>
        <span class="quality-row-pct">${total ? Math.round((r.count / total) * 100) : 0}%</span>
      </div>
    </div>
  `).join('');

  rows.forEach((r, i) => {
    if (r.onClick) {
      const el = container.querySelector(`[data-idx="${i}"]`);
      if (el) el.addEventListener('click', r.onClick);
    }
  });
}

function isFinished(v) {
  if (v === true || v === 1) return true;
  if (v === false || v === 0 || v === null || v === undefined) return false;
  const s = safeStr(v).toLowerCase();
  return ['true', 'yes', 'y', '1', 't', 'finished', 'done', 'complete', 'completed'].includes(s);
}

function renderStats() {
  const rows = state.bcoming;
  const total = rows.length;

  const finished = rows.filter(r => isFinished(r.SampleFinished)).length;

  const pivot = buildProjectPivot(state.samplesOverview);
  let sitesAssigned = 0;
  if (pivot && pivot.projectMap.size) {
    pivot.projectMap.forEach(siteMap => {
      Object.values(siteMap).forEach(v => { sitesAssigned += v; });
    });
  }
  const noSiteAssigned = total - sitesAssigned;

  const speciesGroups = groupCI(rows, r => r.species_field_identification);
  const materialGroups = groupCI(rows, r => r.material);

  const flagged = rows.filter(r => safeStr(r.potential_problems)).length;
  const invalidValidity = rows.filter(r => {
    const v = safeStr(r.validity).toLowerCase();
    return v && v !== 'valid' && v !== 'ok' && v !== 'true' && v !== '1' && v !== 'yes';
  }).length;

  const labRegisterHas = rows.filter(r => safeStr(r.labregister_id)).length;
  const labRegisterMissing = total - labRegisterHas;

  renderKpis([
    { label: 'Total Samples', value: total.toLocaleString() },
    { label: 'Sites Assigned', value: sitesAssigned.toLocaleString(), accent: 'accent-orange', sub: noSiteAssigned ? `${noSiteAssigned.toLocaleString()} without site` : 'all assigned' },
    { label: 'Flagged Issues', value: flagged.toLocaleString(), accent: 'accent-red', sub: 'with potential_problems' },
    { label: 'Validity Concerns', value: invalidValidity.toLocaleString(), accent: 'accent-pink', sub: 'non-valid status' }
  ], 'overviewKpisTop');

  renderKpis([
    { label: 'Finished', value: finished.toLocaleString(), accent: 'accent-green', sub: total ? `${Math.round((finished / total) * 100)}% of total` : '' },
    { label: 'Lab Register ID', value: labRegisterHas.toLocaleString(), accent: 'accent-teal', sub: labRegisterMissing ? `${labRegisterMissing.toLocaleString()} without` : 'all assigned' },
    { label: 'Unique Species', value: speciesGroups.length, accent: 'accent-purple', sub: 'case-insensitive' },
    { label: 'Unique Materials', value: materialGroups.length, accent: 'accent-cyan', sub: 'case-insensitive' }
  ], 'overviewKpisBottom');

  let boxValid = 0, boxInvalid = 0;
  rows.forEach(r => isValidReference(r.box_id) ? boxValid++ : boxInvalid++);
  renderQualityCard('boxIdQuality', 'boxIdTotal', total, [
    {
      name: 'Valid Reference', dot: 'valid', count: boxValid,
      onClick: () => openDataModal(
        'box_id: Valid Reference',
        rows.filter(r => isValidReference(r.box_id))
      )
    },
    {
      name: 'Invalid / Empty', dot: 'invalid', count: boxInvalid,
      onClick: () => openDataModal(
        'box_id: Invalid / Empty',
        rows.filter(r => !isValidReference(r.box_id))
      )
    }
  ]);

  let indvValid = 0, indvInvalid = 0;
  rows.forEach(r => isValidReference(r.individual_code) ? indvValid++ : indvInvalid++);
  renderQualityCard('indvCodeQuality', 'indvCodeTotal', total, [
    {
      name: 'Valid Reference', dot: 'valid', count: indvValid,
      onClick: () => openDataModal(
        'individual_code: Valid Reference',
        rows.filter(r => isValidReference(r.individual_code))
      )
    },
    {
      name: 'Invalid / Empty', dot: 'invalid', count: indvInvalid,
      onClick: () => openDataModal(
        'individual_code: Invalid / Empty',
        rows.filter(r => !isValidReference(r.individual_code))
      )
    }
  ]);

  const animalGroups = groupCI(rows, r => r.animal_set);
  const animalEmpty = rows.filter(r => !safeStr(r.animal_set)).length;
  const animalRows = animalGroups.slice(0, 8).map(g => ({
    name: g.display, dot: 'other', count: g.count,
    onClick: () => openDataModal(
      `animal_set: ${g.display}`,
      rows.filter(r => safeStr(r.animal_set).toLowerCase() === g.display.toLowerCase())
    )
  }));
  if (animalEmpty) {
    animalRows.push({
      name: 'Empty', dot: 'empty', count: animalEmpty,
      onClick: () => openDataModal(
        'animal_set: Empty',
        rows.filter(r => !safeStr(r.animal_set))
      )
    });
  }
  renderQualityCard('animalSetQuality', 'animalSetTotal', total, animalRows);
}

function diagnosticHtml(message) {
  const tables = state.diag.allTables;
  const tablesText = tables.length
    ? `Available tables: ${tables.join(', ')}`
    : 'No tables visible — widget may not have Full document access. Open widget settings (gear icon) and set Access to "Full document access".';
  const sourceText = state.diag.overviewTable
    ? `Loaded from: ${state.diag.overviewTable}`
    : 'No matching table loaded.';
  return `
    <div class="empty-state">
      ${escapeHtml(message)}
      <span class="diag">${escapeHtml(tablesText)}<br>${escapeHtml(sourceText)}</span>
    </div>
  `;
}

function buildProjectPivot(overview) {
  if (!overview || !overview.length) return null;
  const sample = overview[0];
  const countKeys = ['Samples_Count', 'samples_count', 'Samples Count', 'SamplesCount', 'count', 'Count'];
  const hasCountField = countKeys.some(k => sample[k] !== undefined);

  const projectMap = new Map();
  const siteSet = new Set();
  overview.forEach(r => {
    const p = safeStr(getField(r, ['Project', 'project']));
    const s = safeStr(getField(r, ['Site', 'site']));
    if (!p || !s) return;
    if (!projectMap.has(p)) projectMap.set(p, {});
    const add = hasCountField
      ? (Number(getField(r, countKeys)) || 0)
      : 1;
    projectMap.get(p)[s] = (projectMap.get(p)[s] || 0) + add;
    siteSet.add(s);
  });

  return { projectMap, sites: [...siteSet].sort(), hasCountField };
}

function renderProjectMatrix() {
  const container = document.getElementById('matrixContent');
  const subtitle = document.getElementById('matrixSubtitle');
  const useBcoming = !!projectFieldFromBcoming();
  const overview = state.samplesOverview;

  let pivot;
  let baseTotal;
  if (useBcoming) {
    pivot = buildProjectPivotFromBcoming(state.matrixFilter.animalSet, 'samples');
    baseTotal = pivot ? pivot.filteredCount : 0;
  } else {
    if (!overview.length) {
      container.innerHTML = diagnosticHtml("Couldn't load a SAMPLES_OVERVIEW-style table.");
      subtitle.textContent = 'No data';
      return;
    }
    pivot = buildProjectPivot(overview);
    baseTotal = state.bcoming.length;
  }

  if (!pivot || !pivot.projectMap.size) {
    container.innerHTML = '<div class="empty-state">No data after filter.</div>';
    subtitle.textContent = 'No data';
    return;
  }

  const { projectMap, sites } = pivot;
  const projects = sortProjects([...projectMap.keys()], projectMap, state.matrixFilter.sort);

  const projectTotals = {};
  const siteTotals = {};
  let grand = 0;
  projects.forEach(p => {
    projectTotals[p] = 0;
    sites.forEach(s => {
      const v = projectMap.get(p)[s] || 0;
      projectTotals[p] += v;
      siteTotals[s] = (siteTotals[s] || 0) + v;
      grand += v;
    });
  });

  const noSiteCount = useBcoming ? (pivot.noSiteAmong || 0) : Math.max(0, state.bcoming.length - grand);
  const trueGrand = baseTotal;

  const filterPart = (useBcoming && state.matrixFilter.animalSet !== 'all')
    ? ` (animal_set: ${state.matrixFilter.animalSet})`
    : '';
  subtitle.textContent = noSiteCount > 0
    ? `${noSiteCount.toLocaleString()} samples have no Sites assigned${filterPart}`
    : `All samples assigned to Sites${filterPart}`;

  const maxCell = Math.max(1, ...projects.flatMap(p => sites.map(s => projectMap.get(p)[s] || 0)));

  let html = '<table class="matrix-table"><thead><tr>';
  html += '<th class="row-header">Mission</th>';
  sites.forEach(s => { html += `<th>${escapeHtml(s)}</th>`; });
  html += '<th>Total</th></tr></thead><tbody>';

  projects.forEach(p => {
    html += '<tr>';
    html += `<td class="row-header">${escapeHtml(p)}</td>`;
    sites.forEach(s => {
      const v = projectMap.get(p)[s] || 0;
      if (v === 0) {
        html += '<td class="cell zero">—</td>';
      } else {
        const intensity = v / maxCell;
        const alpha = (0.12 + intensity * 0.5).toFixed(2);
        html += `<td class="cell" style="background: rgba(66, 165, 245, ${alpha});">${v.toLocaleString()}</td>`;
      }
    });
    html += `<td>${projectTotals[p].toLocaleString()}</td>`;
    html += '</tr>';
  });

  if (noSiteCount > 0) {
    html += '<tr>';
    html += `<td class="row-header" style="color:var(--text-secondary);font-style:italic;">Not Assigned</td>`;
    sites.forEach(() => { html += '<td class="cell zero">—</td>'; });
    html += `<td>${noSiteCount.toLocaleString()}</td>`;
    html += '</tr>';
  }

  html += '</tbody><tfoot><tr>';
  html += '<td class="label">Total</td>';
  sites.forEach(s => { html += `<td>${siteTotals[s].toLocaleString()}</td>`; });
  html += `<td class="label">${trueGrand.toLocaleString()}</td>`;
  html += '</tr></tfoot></table>';

  container.innerHTML = html;
}

function renderStatusDonut() {
  const rows = state.bcoming;
  const finished = rows.filter(r => isFinished(r.SampleFinished)).length;
  const notFinished = rows.length - finished;

  destroyChart('statusDonut');
  state.charts.statusDonut = new Chart(document.getElementById('statusDonut'), {
    type: 'doughnut',
    data: {
      labels: ['Finished', 'Not Finished'],
      datasets: [{
        data: [finished, notFinished],
        backgroundColor: [getCssVar('--accent-2'), getCssVar('--accent-3')],
        borderWidth: 2,
        borderColor: getCssVar('--card-bg')
      }]
    },
    options: {
      maintainAspectRatio: false,
      responsive: true,
      cutout: '65%',
      plugins: { legend: { position: 'bottom' } }
    }
  });
}

function renderValidityDonut() {
  const groups = groupCI(state.bcoming, r => r.validity || 'Unspecified');
  destroyChart('validityDonut');
  state.charts.validityDonut = new Chart(document.getElementById('validityDonut'), {
    type: 'doughnut',
    data: {
      labels: groups.map(g => g.display),
      datasets: [{
        data: groups.map(g => g.count),
        backgroundColor: groups.map((_, i) => PALETTE[i % PALETTE.length]),
        borderWidth: 2,
        borderColor: getCssVar('--card-bg')
      }]
    },
    options: {
      maintainAspectRatio: false,
      responsive: true,
      cutout: '65%',
      plugins: { legend: { position: 'bottom' } }
    }
  });
}

function renderProjectSiteChart() {
  const overview = state.samplesOverview;
  destroyChart('projectSite');

  if (!overview.length) {
    document.getElementById('projectSiteChart').parentElement.innerHTML = diagnosticHtml("Couldn't load a SAMPLES_OVERVIEW-style table.");
    return;
  }

  const pivot = buildProjectPivot(overview);
  if (!pivot || !pivot.projectMap.size) return;

  const { projectMap, sites } = pivot;
  const sortedProjects = [...projectMap.keys()].sort((a, b) => {
    const ta = Object.values(projectMap.get(a)).reduce((x, y) => x + y, 0);
    const tb = Object.values(projectMap.get(b)).reduce((x, y) => x + y, 0);
    return tb - ta;
  });

  const grand = sortedProjects.reduce((sum, p) => {
    return sum + Object.values(projectMap.get(p)).reduce((s, v) => s + v, 0);
  }, 0);
  const noSiteCount = state.bcoming.length - grand;

  const labels = noSiteCount > 0 ? [...sortedProjects, 'Not Assigned'] : [...sortedProjects];

  const datasets = sites.map((s, i) => ({
    label: s,
    data: labels.map(p => p === 'Not Assigned' ? 0 : (projectMap.get(p)[s] || 0)),
    backgroundColor: PALETTE[i % PALETTE.length],
    borderRadius: 4
  }));

  if (noSiteCount > 0) {
    datasets.push({
      label: 'No Site',
      data: labels.map(p => p === 'Not Assigned' ? noSiteCount : 0),
      backgroundColor: '#9e9e9e',
      borderRadius: 4
    });
  }

  state.charts.projectSite = new Chart(document.getElementById('projectSiteChart'), {
    type: 'bar',
    data: { labels, datasets },
    options: {
      maintainAspectRatio: false,
      responsive: true,
      plugins: {
        legend: { position: 'top', align: 'end' },
        tooltip: { mode: 'index', intersect: false }
      },
      scales: {
        x: { stacked: true, grid: { display: false } },
        y: { stacked: true, beginAtZero: true, ticks: { precision: 0 } }
      }
    }
  });
}

function renderAnimalSetChart() {
  const groups = groupCI(state.bcoming, r => r.animal_set).slice(0, 10);
  destroyChart('animalSet');
  state.charts.animalSet = new Chart(document.getElementById('animalSetChart'), {
    type: 'bar',
    data: {
      labels: groups.map(g => g.display),
      datasets: [{
        label: 'Samples',
        data: groups.map(g => g.count),
        backgroundColor: groups.map((_, i) => PALETTE[i % PALETTE.length]),
        borderRadius: 4
      }]
    },
    options: {
      maintainAspectRatio: false,
      responsive: true,
      indexAxis: 'y',
      plugins: { legend: { display: false } },
      scales: {
        x: { beginAtZero: true, ticks: { precision: 0 } },
        y: { grid: { display: false } }
      }
    }
  });
}

function renderScrollableBar(canvasId, sizerId, chartKey, groups, color) {
  const sizer = document.getElementById(sizerId);
  const itemHeight = 24;
  const minHeight = 240;
  sizer.style.height = Math.max(minHeight, groups.length * itemHeight + 80) + 'px';

  destroyChart(chartKey);
  state.charts[chartKey] = new Chart(document.getElementById(canvasId), {
    type: 'bar',
    data: {
      labels: groups.map(g => g.display),
      datasets: [{
        label: 'Samples',
        data: groups.map(g => g.count),
        backgroundColor: color,
        borderRadius: 4
      }]
    },
    options: {
      maintainAspectRatio: false,
      responsive: true,
      indexAxis: 'y',
      plugins: { legend: { display: false } },
      scales: {
        x: { beginAtZero: true, ticks: { precision: 0 } },
        y: { grid: { display: false } }
      }
    }
  });
}

function renderSpeciesChart() {
  const groups = groupCI(state.bcoming, r => r.species_field_identification);
  if (!groups.length) {
    document.getElementById('speciesSizer').innerHTML = '<div class="empty-state">No species data available.</div>';
    return;
  }
  renderScrollableBar('speciesChart', 'speciesSizer', 'species', groups, getCssVar('--accent-4'));
}

function renderMaterialChart() {
  const groups = groupCI(state.bcoming, r => r.material);
  if (!groups.length) {
    document.getElementById('materialSizer').innerHTML = '<div class="empty-state">No material data available.</div>';
    return;
  }
  renderScrollableBar('materialChart', 'materialSizer', 'material', groups, getCssVar('--accent-6'));
}

function renderYearChart() {
  const rows = state.bcoming;
  const yearMap = new Map();
  let invalidCount = 0;
  rows.forEach(r => {
    const y = parseYear(r.collection_year);
    if (y === null) { invalidCount++; return; }
    const key = y.toString();
    yearMap.set(key, (yearMap.get(key) || 0) + 1);
  });

  const sortedYears = [...yearMap.entries()].sort((a, b) => a[0].localeCompare(b[0]));
  const labels = sortedYears.map(e => e[0]);
  const data = sortedYears.map(e => e[1]);
  const colors = sortedYears.map(() => getCssVar('--accent-1'));

  if (invalidCount) {
    labels.push('Invalid / Empty');
    data.push(invalidCount);
    colors.push(getCssVar('--accent-5'));
  }

  destroyChart('year');
  state.charts.year = new Chart(document.getElementById('yearChart'), {
    type: 'bar',
    data: {
      labels: labels,
      datasets: [{ label: 'Samples', data: data, backgroundColor: colors, borderRadius: 4 }]
    },
    options: {
      maintainAspectRatio: false,
      responsive: true,
      plugins: { legend: { display: false } },
      scales: {
        x: { grid: { display: false } },
        y: { beginAtZero: true, ticks: { precision: 0 } }
      }
    }
  });
}

function renderConservationChart() {
  const groups = groupCI(state.bcoming, r => r.sample_conservation_method);
  destroyChart('conservation');
  state.charts.conservation = new Chart(document.getElementById('conservationChart'), {
    type: 'bar',
    data: {
      labels: groups.map(g => g.display),
      datasets: [{
        data: groups.map(g => g.count),
        backgroundColor: groups.map((_, i) => PALETTE[i % PALETTE.length]),
        borderRadius: 4
      }]
    },
    options: {
      maintainAspectRatio: false,
      responsive: true,
      plugins: { legend: { display: false } },
      scales: {
        x: { grid: { display: false } },
        y: { beginAtZero: true, ticks: { precision: 0 } }
      }
    }
  });
}

function renderBoxIdChart() {
  const rows = state.bcoming;
  let valid = 0, invalid = 0;
  rows.forEach(r => isValidReference(r.box_id) ? valid++ : invalid++);
  destroyChart('boxId');
  state.charts.boxId = new Chart(document.getElementById('boxIdChart'), {
    type: 'doughnut',
    data: {
      labels: ['Valid Reference', 'Invalid / Empty'],
      datasets: [{
        data: [valid, invalid],
        backgroundColor: [getCssVar('--accent-2'), getCssVar('--accent-5')],
        borderWidth: 2,
        borderColor: getCssVar('--card-bg')
      }]
    },
    options: {
      maintainAspectRatio: false,
      responsive: true,
      cutout: '65%',
      plugins: { legend: { position: 'bottom' } }
    }
  });
}

function renderIndvCodeChart() {
  const rows = state.bcoming;
  let valid = 0, invalid = 0;
  rows.forEach(r => isValidReference(r.individual_code) ? valid++ : invalid++);
  destroyChart('indvCode');
  state.charts.indvCode = new Chart(document.getElementById('indvCodeChart'), {
    type: 'doughnut',
    data: {
      labels: ['Valid Reference', 'Invalid / Empty'],
      datasets: [{
        data: [valid, invalid],
        backgroundColor: [getCssVar('--accent-2'), getCssVar('--accent-5')],
        borderWidth: 2,
        borderColor: getCssVar('--card-bg')
      }]
    },
    options: {
      maintainAspectRatio: false,
      responsive: true,
      cutout: '65%',
      plugins: { legend: { position: 'bottom' } }
    }
  });
}

function renderTubeChart() {
  const groups = groupCI(state.bcoming, r => r.tube_format);
  destroyChart('tube');
  state.charts.tube = new Chart(document.getElementById('tubeChart'), {
    type: 'doughnut',
    data: {
      labels: groups.map(g => g.display),
      datasets: [{
        data: groups.map(g => g.count),
        backgroundColor: groups.map((_, i) => PALETTE[i % PALETTE.length]),
        borderWidth: 2,
        borderColor: getCssVar('--card-bg')
      }]
    },
    options: {
      maintainAspectRatio: false,
      responsive: true,
      cutout: '55%',
      plugins: { legend: { position: 'right' } }
    }
  });
}

function hasValue(v) {
  if (v === null || v === undefined) return false;
  if (typeof v === 'number') return !Number.isNaN(v);
  return safeStr(v).length > 0;
}

function isYesLike(v) {
  if (v === true) return true;
  if (v === false) return false;
  const s = safeStr(v).toLowerCase();
  return ['yes', 'y', 'true', '1', 't'].includes(s);
}

function isNoLike(v) {
  if (v === false) return true;
  const s = safeStr(v).toLowerCase();
  return ['no', 'n', 'false', '0', 'f'].includes(s);
}

function renderIndividualsStats() {
  const rows = state.individuals;
  const total = rows.length;

  const validated = rows.filter(r => r.validated === true || isYesLike(r.validated)).length;
  const issues = rows.filter(r => r.issue === true || isYesLike(r.issue)).length;
  const necropsyAssigned = rows.filter(r => hasValue(r.necropsy_id)).length;
  const necropsyMissing = total - necropsyAssigned;
  const ectoYes = rows.filter(r => isYesLike(r.ectoparasites)).length;
  const withCoords = rows.filter(r => hasValue(r.sample_latitude) && hasValue(r.sample_longitude)).length;
  const withoutCoords = total - withCoords;

  const animalGroups = groupCI(rows, r => r.animal_set);
  const siteGroups = groupCI(rows, r => r.site);
  const speciesGroups = groupCI(rows, r => r.species);

  renderKpis([
    { label: 'Total Individuals', value: total.toLocaleString() },
    { label: 'Validated', value: validated.toLocaleString(), accent: 'accent-green', sub: total ? `${Math.round((validated / total) * 100)}% of total` : '' },
    { label: 'Issues Flagged', value: issues.toLocaleString(), accent: 'accent-red', sub: 'records marked issue' },
    { label: 'Necropsy Assigned', value: necropsyAssigned.toLocaleString(), accent: 'accent-purple', sub: necropsyMissing ? `${necropsyMissing.toLocaleString()} without` : 'all assigned' }
  ], 'indvKpisTop');

  renderKpis([
    { label: 'With Coordinates', value: withCoords.toLocaleString(), accent: 'accent-cyan', sub: withoutCoords ? `${withoutCoords.toLocaleString()} missing lat/lng` : 'all geolocated' },
    { label: 'Ectoparasites (yes)', value: ectoYes.toLocaleString(), accent: 'accent-orange', sub: total ? `${Math.round((ectoYes / total) * 100)}% of total` : '' },
    { label: 'Unique Species', value: speciesGroups.length, accent: 'accent-teal', sub: 'case-insensitive' },
    { label: 'Unique Sites', value: siteGroups.length, accent: 'accent-pink', sub: 'distinct sites' }
  ], 'indvKpisBottom');

  const sexOf = (r) => safeStr(r.individual_sex).toLowerCase();
  const isMale = (r) => { const s = sexOf(r); return s === 'm' || s === 'male'; };
  const isFemale = (r) => { const s = sexOf(r); return s === 'f' || s === 'female'; };
  const isSexOther = (r) => { const s = sexOf(r); return s && !isMale(r) && !isFemale(r); };
  const isSexEmpty = (r) => !sexOf(r);

  let male = 0, female = 0, sexEmpty = 0, sexOther = 0;
  rows.forEach(r => {
    if (isSexEmpty(r)) sexEmpty++;
    else if (isMale(r)) male++;
    else if (isFemale(r)) female++;
    else sexOther++;
  });
  const sexRows = [
    { name: 'Male', dot: 'other', count: male, onClick: () => openIndividualsModal('individual_sex: Male', isMale) },
    { name: 'Female', dot: 'valid', count: female, onClick: () => openIndividualsModal('individual_sex: Female', isFemale) }
  ];
  if (sexOther) sexRows.push({ name: 'Other', dot: 'invalid', count: sexOther, onClick: () => openIndividualsModal('individual_sex: Other', isSexOther) });
  if (sexEmpty) sexRows.push({ name: 'Empty', dot: 'empty', count: sexEmpty, onClick: () => openIndividualsModal('individual_sex: Empty', isSexEmpty) });
  renderQualityCard('indvSexQuality', 'indvSexTotal', total, sexRows);

  const isEctoYes = (r) => hasValue(r.ectoparasites) && isYesLike(r.ectoparasites);
  const isEctoNo = (r) => hasValue(r.ectoparasites) && isNoLike(r.ectoparasites);
  const isEctoEmpty = (r) => !hasValue(r.ectoparasites) || (!isYesLike(r.ectoparasites) && !isNoLike(r.ectoparasites));

  let ectoY = 0, ectoN = 0, ectoEmpty = 0;
  rows.forEach(r => {
    if (isEctoYes(r)) ectoY++;
    else if (isEctoNo(r)) ectoN++;
    else ectoEmpty++;
  });
  renderQualityCard('indvEctoQuality', 'indvEctoTotal', total, [
    { name: 'Yes', dot: 'valid', count: ectoY, onClick: () => openIndividualsModal('ectoparasites: Yes', isEctoYes) },
    { name: 'No', dot: 'invalid', count: ectoN, onClick: () => openIndividualsModal('ectoparasites: No', isEctoNo) },
    { name: 'Empty', dot: 'empty', count: ectoEmpty, onClick: () => openIndividualsModal('ectoparasites: Empty', isEctoEmpty) }
  ]);

  const hasNecro = (r) => hasValue(r.necropsy_id);
  const noNecro = (r) => !hasValue(r.necropsy_id);
  renderQualityCard('indvNecroQuality', 'indvNecroTotal', total, [
    { name: 'Assigned', dot: 'valid', count: necropsyAssigned, onClick: () => openIndividualsModal('necropsy_id: Assigned', hasNecro) },
    { name: 'Unassigned', dot: 'empty', count: necropsyMissing, onClick: () => openIndividualsModal('necropsy_id: Unassigned', noNecro) }
  ]);

  const hasBothCoord = (r) => hasValue(r.sample_latitude) && hasValue(r.sample_longitude);
  const hasLatOnly = (r) => hasValue(r.sample_latitude) && !hasValue(r.sample_longitude);
  const hasLngOnly = (r) => !hasValue(r.sample_latitude) && hasValue(r.sample_longitude);
  const hasNeitherCoord = (r) => !hasValue(r.sample_latitude) && !hasValue(r.sample_longitude);
  const latOnly = rows.filter(hasLatOnly).length;
  const lngOnly = rows.filter(hasLngOnly).length;
  const neither = rows.filter(hasNeitherCoord).length;
  const coordRows = [
    { name: 'Both lat & lng', dot: 'valid', count: withCoords, onClick: () => openIndividualsModal('coordinates: Both lat & lng', hasBothCoord) }
  ];
  if (latOnly) coordRows.push({ name: 'Latitude only', dot: 'other', count: latOnly, onClick: () => openIndividualsModal('coordinates: Latitude only', hasLatOnly) });
  if (lngOnly) coordRows.push({ name: 'Longitude only', dot: 'other', count: lngOnly, onClick: () => openIndividualsModal('coordinates: Longitude only', hasLngOnly) });
  coordRows.push({ name: 'Missing both', dot: 'empty', count: neither, onClick: () => openIndividualsModal('coordinates: Missing both', hasNeitherCoord) });
  renderQualityCard('indvCoordQuality', 'indvCoordTotal', total, coordRows);

  const animalEmpty = rows.filter(r => !safeStr(r.animal_set)).length;
  const animalRows = animalGroups.slice(0, 8).map(g => ({
    name: g.display, dot: 'other', count: g.count,
    onClick: () => openIndividualsModal(`animal_set: ${g.display}`,
      r => safeStr(r.animal_set).toLowerCase() === g.display.toLowerCase())
  }));
  if (animalEmpty) animalRows.push({
    name: 'Empty', dot: 'empty', count: animalEmpty,
    onClick: () => openIndividualsModal('animal_set: Empty', r => !safeStr(r.animal_set))
  });
  renderQualityCard('indvAnimalSetQuality', 'indvAnimalSetTotal', total, animalRows);

  const siteEmpty = rows.filter(r => !safeStr(r.site)).length;
  const siteRows = siteGroups.slice(0, 8).map(g => ({
    name: g.display, dot: 'other', count: g.count,
    onClick: () => openIndividualsModal(`site: ${g.display}`,
      r => safeStr(r.site).toLowerCase() === g.display.toLowerCase())
  }));
  if (siteEmpty) siteRows.push({
    name: 'Empty', dot: 'empty', count: siteEmpty,
    onClick: () => openIndividualsModal('site: Empty', r => !safeStr(r.site))
  });
  renderQualityCard('indvSiteQuality', 'indvSiteTotal', total, siteRows);

  const isValidated = (r) => r.validated === true || isYesLike(r.validated);
  const hasIssue = (r) => r.issue === true || isYesLike(r.issue);
  const isNeither = (r) => !isValidated(r) && !hasIssue(r);
  renderQualityCard('indvValidQuality', 'indvValidTotal', total, [
    { name: 'Validated', dot: 'valid', count: validated, onClick: () => openIndividualsModal('validated: true', isValidated) },
    { name: 'Issue flagged', dot: 'invalid', count: issues, onClick: () => openIndividualsModal('issue: true', hasIssue) },
    { name: 'Neither', dot: 'empty', count: Math.max(0, total - validated - issues), onClick: () => openIndividualsModal('validation: Neither', isNeither) }
  ]);
}

function renderIndvBarChart(canvasId, chartKey, groups, color, opts = {}) {
  destroyChart(chartKey);
  if (!groups.length) return;
  state.charts[chartKey] = new Chart(document.getElementById(canvasId), {
    type: 'bar',
    data: {
      labels: groups.map(g => g.display),
      datasets: [{
        label: 'Individuals',
        data: groups.map(g => g.count),
        backgroundColor: Array.isArray(color) ? color : groups.map((_, i) => Array.isArray(color) ? color[i] : color),
        borderRadius: 4
      }]
    },
    options: {
      maintainAspectRatio: false,
      responsive: true,
      indexAxis: opts.horizontal ? 'y' : 'x',
      plugins: { legend: { display: false } },
      scales: opts.horizontal
        ? { x: { beginAtZero: true, ticks: { precision: 0 } }, y: { grid: { display: false } } }
        : { x: { grid: { display: false } }, y: { beginAtZero: true, ticks: { precision: 0 } } }
    }
  });
}

function renderIndvDonut(canvasId, chartKey, labels, data, colors) {
  destroyChart(chartKey);
  state.charts[chartKey] = new Chart(document.getElementById(canvasId), {
    type: 'doughnut',
    data: {
      labels,
      datasets: [{
        data,
        backgroundColor: colors,
        borderWidth: 2,
        borderColor: getCssVar('--card-bg')
      }]
    },
    options: {
      maintainAspectRatio: false,
      responsive: true,
      cutout: '65%',
      plugins: { legend: { position: 'bottom' } }
    }
  });
}

function renderIndividualsGraphs() {
  const rows = state.individuals;

  const fieldsiteGroups = groupCI(rows, r => r.fieldsite_name).slice(0, 12);
  renderIndvBarChart('indvFieldsiteChart', 'indvFieldsite', fieldsiteGroups,
    fieldsiteGroups.map((_, i) => PALETTE[i % PALETTE.length]), { horizontal: true });

  const trapGroups = groupCI(rows, r => r.trap_type);
  renderIndvBarChart('indvTrapChart', 'indvTrap', trapGroups,
    trapGroups.map((_, i) => PALETTE[i % PALETTE.length]), { horizontal: true });

  const transectGroups = groupCI(rows, r => r.transect);
  renderIndvBarChart('indvTransectChart', 'indvTransect', transectGroups,
    transectGroups.map((_, i) => PALETTE[i % PALETTE.length]));

  const speciesGroups = groupCI(rows, r => r.species);
  if (speciesGroups.length) {
    renderScrollableBar('indvSpeciesChart', 'indvSpeciesSizer', 'indvSpecies', speciesGroups, getCssVar('--accent-4'));
  } else {
    document.getElementById('indvSpeciesSizer').innerHTML = '<div class="empty-state">No species data available.</div>';
  }

  const animalGroups = groupCI(rows, r => r.animal_set);
  if (animalGroups.length) {
    renderScrollableBar('indvAnimalSetChart', 'indvAnimalSetSizer', 'indvAnimalSet', animalGroups, getCssVar('--accent-6'));
  } else {
    document.getElementById('indvAnimalSetSizer').innerHTML = '<div class="empty-state">No animal_set data available.</div>';
  }

  let male = 0, female = 0, sexOther = 0;
  rows.forEach(r => {
    const s = safeStr(r.individual_sex).toLowerCase();
    if (s === 'm' || s === 'male') male++;
    else if (s === 'f' || s === 'female') female++;
    else if (s) sexOther++;
  });
  const sexLabels = ['Male', 'Female'];
  const sexData = [male, female];
  const sexColors = [getCssVar('--accent-1'), getCssVar('--accent-7')];
  if (sexOther) { sexLabels.push('Other'); sexData.push(sexOther); sexColors.push(getCssVar('--accent-3')); }
  renderIndvDonut('indvSexChart', 'indvSex', sexLabels, sexData, sexColors);

  let ectoY = 0, ectoN = 0, ectoEmpty = 0;
  rows.forEach(r => {
    if (!hasValue(r.ectoparasites)) ectoEmpty++;
    else if (isYesLike(r.ectoparasites)) ectoY++;
    else if (isNoLike(r.ectoparasites)) ectoN++;
    else ectoEmpty++;
  });
  renderIndvDonut('indvEctoChart', 'indvEcto',
    ['Yes', 'No', 'Empty'],
    [ectoY, ectoN, ectoEmpty],
    [getCssVar('--accent-2'), getCssVar('--accent-5'), getCssVar('--accent-3')]);

  const necroAssigned = rows.filter(r => hasValue(r.necropsy_id)).length;
  const necroMissing = rows.length - necroAssigned;
  renderIndvDonut('indvNecroChart', 'indvNecro',
    ['Assigned', 'Unassigned'],
    [necroAssigned, necroMissing],
    [getCssVar('--accent-2'), getCssVar('--accent-3')]);
}

function renderIndividuals() {
  if (!state.individuals.length) {
    document.getElementById('indvKpisTop').innerHTML = '<div class="empty-state" style="grid-column: 1/-1;">No individuals data loaded.<span class="diag">Looked for: BECOMING_INDIVIDUALS / BCOMING_INDIVIDUALS</span></div>';
    return;
  }
  renderIndividualsStats();
  renderIndividualsGraphs();
}

function topGroupsCard(rows, fieldFn, displayName, totalId, qualityId, modalFn, max = 8) {
  const groups = groupCI(rows, fieldFn);
  const emptyCount = rows.filter(r => !safeStr(fieldFn(r))).length;
  const cardRows = groups.slice(0, max).map(g => ({
    name: g.display, dot: 'other', count: g.count,
    onClick: () => modalFn(`${displayName}: ${g.display}`, r => safeStr(fieldFn(r)).toLowerCase() === g.display.toLowerCase())
  }));
  if (emptyCount) {
    cardRows.push({
      name: 'Empty', dot: 'empty', count: emptyCount,
      onClick: () => modalFn(`${displayName}: Empty`, r => !safeStr(fieldFn(r)))
    });
  }
  renderQualityCard(qualityId, totalId, rows.length, cardRows);
}

function yesNoEmptyCard(rows, fieldFn, displayName, totalId, qualityId, modalFn) {
  const isYes = (r) => hasValue(fieldFn(r)) && isYesLike(fieldFn(r));
  const isNo = (r) => hasValue(fieldFn(r)) && isNoLike(fieldFn(r));
  const isEmpty = (r) => !hasValue(fieldFn(r)) || (!isYesLike(fieldFn(r)) && !isNoLike(fieldFn(r)));
  let y = 0, n = 0, e = 0;
  rows.forEach(r => {
    if (isYes(r)) y++;
    else if (isNo(r)) n++;
    else e++;
  });
  renderQualityCard(qualityId, totalId, rows.length, [
    { name: 'Yes', dot: 'valid', count: y, onClick: () => modalFn(`${displayName}: Yes`, isYes) },
    { name: 'No', dot: 'invalid', count: n, onClick: () => modalFn(`${displayName}: No`, isNo) },
    { name: 'Empty', dot: 'empty', count: e, onClick: () => modalFn(`${displayName}: Empty`, isEmpty) }
  ]);
}

function validityCard(rows, fieldFn, displayName, totalId, qualityId, modalFn) {
  const isValid = (r) => safeStr(fieldFn(r)).toLowerCase() === 'valid';
  const isInvalid = (r) => { const s = safeStr(fieldFn(r)).toLowerCase(); return s && s !== 'valid'; };
  const isEmpty = (r) => !safeStr(fieldFn(r));
  let v = 0, inv = 0, e = 0;
  rows.forEach(r => {
    if (isValid(r)) v++;
    else if (isInvalid(r)) inv++;
    else e++;
  });
  renderQualityCard(qualityId, totalId, rows.length, [
    { name: 'Valid', dot: 'valid', count: v, onClick: () => modalFn(`${displayName}: Valid`, isValid) },
    { name: 'Other / Invalid', dot: 'invalid', count: inv, onClick: () => modalFn(`${displayName}: Other`, isInvalid) },
    { name: 'Empty', dot: 'empty', count: e, onClick: () => modalFn(`${displayName}: Empty`, isEmpty) }
  ]);
}

function renderBarFromGroups(canvasId, chartKey, groups, options = {}) {
  destroyChart(chartKey);
  if (!groups.length) return;
  state.charts[chartKey] = new Chart(document.getElementById(canvasId), {
    type: 'bar',
    data: {
      labels: groups.map(g => g.display),
      datasets: [{
        data: groups.map(g => g.count),
        backgroundColor: groups.map((_, i) => PALETTE[i % PALETTE.length]),
        borderRadius: 4
      }]
    },
    options: {
      maintainAspectRatio: false,
      responsive: true,
      indexAxis: options.horizontal ? 'y' : 'x',
      plugins: { legend: { display: false } },
      scales: options.horizontal
        ? { x: { beginAtZero: true, ticks: { precision: 0 } }, y: { grid: { display: false } } }
        : { x: { grid: { display: false } }, y: { beginAtZero: true, ticks: { precision: 0 } } }
    }
  });
}

function renderDonutFromGroups(canvasId, chartKey, groups) {
  destroyChart(chartKey);
  if (!groups.length) return;
  state.charts[chartKey] = new Chart(document.getElementById(canvasId), {
    type: 'doughnut',
    data: {
      labels: groups.map(g => g.display),
      datasets: [{
        data: groups.map(g => g.count),
        backgroundColor: groups.map((_, i) => PALETTE[i % PALETTE.length]),
        borderWidth: 2,
        borderColor: getCssVar('--card-bg')
      }]
    },
    options: {
      maintainAspectRatio: false,
      responsive: true,
      cutout: '60%',
      plugins: { legend: { position: 'bottom' } }
    }
  });
}

function renderExtraction() {
  if (!state.extraction.length) {
    const el = document.getElementById('extrKpisTop');
    if (el) el.innerHTML = '<div class="empty-state" style="grid-column: 1/-1;">No extraction data loaded.<span class="diag">Looked for: BCOMING_EXTRACTION / BECOMING_EXTRACTION</span></div>';
    return;
  }
  const rows = state.extraction;
  const total = rows.length;

  const uniqInd = new Set(rows.map(r => r.individual_code).filter(Boolean)).size;
  const uniqMat = new Set(rows.map(r => safeStr(r.material).toLowerCase()).filter(Boolean)).size;
  const uniqPpl = new Set(rows.map(r => safeStr(r.person).toLowerCase()).filter(Boolean)).size;
  const withDna = rows.filter(r => hasValue(r.dna_box_id)).length;
  const withRna = rows.filter(r => hasValue(r.rna_box_id)).length;
  const withSamp = rows.filter(r => hasValue(r.sample_box_id)).length;
  const destroyed = rows.filter(r => hasValue(r.destroyed_box_id)).length;

  renderKpis([
    { label: 'Total Extractions', value: total.toLocaleString() },
    { label: 'Unique Individuals', value: uniqInd.toLocaleString(), accent: 'accent-green' },
    { label: 'Unique Materials', value: uniqMat.toLocaleString(), accent: 'accent-cyan' },
    { label: 'DNA Stored', value: withDna.toLocaleString(), accent: 'accent-purple', sub: `${Math.round(withDna / total * 100)}% of total` }
  ], 'extrKpisTop');

  renderKpis([
    { label: 'RNA Stored', value: withRna.toLocaleString(), accent: 'accent-teal', sub: `${Math.round(withRna / total * 100)}% of total` },
    { label: 'Sample Stored', value: withSamp.toLocaleString(), accent: 'accent-orange', sub: `${Math.round(withSamp / total * 100)}% of total` },
    { label: 'Destroyed', value: destroyed.toLocaleString(), accent: 'accent-red', sub: `${Math.round(destroyed / total * 100)}% of total` },
    { label: 'Unique Extractors', value: uniqPpl.toLocaleString(), accent: 'accent-pink' }
  ], 'extrKpisBottom');

  topGroupsCard(rows, r => r.material, 'material', 'extrMaterialTotal', 'extrMaterialQuality', openExtractionModal);
  validityCard(rows, r => r.dna_validity, 'dna_validity', 'extrDnaValidityTotal', 'extrDnaValidityQuality', openExtractionModal);
  validityCard(rows, r => r.rna_validity, 'rna_validity', 'extrRnaValidityTotal', 'extrRnaValidityQuality', openExtractionModal);
  topGroupsCard(rows, r => r.animal_set, 'animal_set', 'extrAnimalSetTotal', 'extrAnimalSetQuality', openExtractionModal);
  topGroupsCard(rows, r => r.extraction_method, 'extraction_method', 'extrExtractionMethodTotal', 'extrExtractionMethodQuality', openExtractionModal);
  topGroupsCard(rows, r => r.dna_conc_method, 'dna_conc_method', 'extrDnaConcMethodTotal', 'extrDnaConcMethodQuality', openExtractionModal);
  topGroupsCard(rows, r => r.person, 'person', 'extrPersonTotal', 'extrPersonQuality', openExtractionModal);

  const yearMap = new Map();
  rows.forEach(r => {
    const y = parseYear(r.collection_year);
    if (y === null) return;
    yearMap.set(y, (yearMap.get(y) || 0) + 1);
  });
  const yearGroups = [...yearMap.entries()].sort((a, b) => a[0] - b[0]).map(([y, c]) => ({ display: String(y), count: c }));
  renderBarFromGroups('extrTimelineChart', 'extrTimeline', yearGroups);

  renderBarFromGroups('extrMaterialChart', 'extrMaterial', groupCI(rows, r => r.material).slice(0, 10), { horizontal: true });
  renderBarFromGroups('extrAnimalSetChart', 'extrAnimalSet', groupCI(rows, r => r.animal_set).slice(0, 10));
  renderBarFromGroups('extrPersonChart', 'extrPerson', groupCI(rows, r => r.person).slice(0, 15), { horizontal: true });

  const dnaValGroups = groupCI(rows, r => safeStr(r.dna_validity) || 'Empty');
  renderDonutFromGroups('extrDnaValidityChart', 'extrDnaValidityDonut', dnaValGroups);
  const rnaValGroups = groupCI(rows, r => safeStr(r.rna_validity) || 'Empty');
  renderDonutFromGroups('extrRnaValidityChart', 'extrRnaValidityDonut', rnaValGroups);
}

function renderCdna() {
  if (!state.cdna.length) {
    const el = document.getElementById('cdnaKpisTop');
    if (el) el.innerHTML = '<div class="empty-state" style="grid-column: 1/-1;">No CDNA data loaded.<span class="diag">Looked for: BCOMING_CDNA / BECOMING_CDNA</span></div>';
    return;
  }
  const rows = state.cdna;
  const total = rows.length;

  const uniqInd = new Set(rows.map(r => r.individual_code).filter(Boolean)).size;
  const uniqExt = new Set(rows.map(r => r.extraction_id).filter(Boolean)).size;
  const labeled = rows.filter(r => isYesLike(r.labeled)).length;
  const withConc = rows.filter(r => hasValue(r.cdna_concentration)).length;
  const withDate = rows.filter(r => hasValue(r.date)).length;
  const uniqPpl = new Set(rows.map(r => safeStr(r.person).toLowerCase()).filter(Boolean)).size;
  const withNote = rows.filter(r => hasValue(r.cdna_note)).length;

  renderKpis([
    { label: 'Total CDNA Records', value: total.toLocaleString() },
    { label: 'Unique Individuals', value: uniqInd.toLocaleString(), accent: 'accent-green' },
    { label: 'Unique Extractions', value: uniqExt.toLocaleString(), accent: 'accent-cyan' },
    { label: 'Labeled', value: labeled.toLocaleString(), accent: 'accent-purple', sub: total ? `${Math.round(labeled / total * 100)}% of total` : '' }
  ], 'cdnaKpisTop');

  renderKpis([
    { label: 'Has Concentration', value: withConc.toLocaleString(), accent: 'accent-teal' },
    { label: 'Has Date', value: withDate.toLocaleString(), accent: 'accent-orange' },
    { label: 'Unique Persons', value: uniqPpl.toLocaleString(), accent: 'accent-pink' },
    { label: 'Has Note', value: withNote.toLocaleString(), accent: 'accent-red' }
  ], 'cdnaKpisBottom');

  topGroupsCard(rows, r => r.individual_code_animal_set, 'animal_set', 'cdnaAnimalSetTotal', 'cdnaAnimalSetQuality', openCdnaModal);
  topGroupsCard(rows, r => r.sample_id_material_id, 'material', 'cdnaMaterialTotal', 'cdnaMaterialQuality', openCdnaModal);
  yesNoEmptyCard(rows, r => r.labeled, 'labeled', 'cdnaLabeledTotal', 'cdnaLabeledQuality', openCdnaModal);
  topGroupsCard(rows, r => r.cdna_method, 'cdna_method', 'cdnaMethodTotal', 'cdnaMethodQuality', openCdnaModal);
  topGroupsCard(rows, r => r.person, 'person', 'cdnaPersonTotal', 'cdnaPersonQuality', openCdnaModal);
  topGroupsCard(rows, r => r.dna_conc_method, 'dna_conc_method', 'cdnaDnaConcMethodTotal', 'cdnaDnaConcMethodQuality', openCdnaModal);

  let vLow = 0, vMid = 0, vHigh = 0, vEmpty = 0;
  rows.forEach(r => {
    const v = Number(r.rna_volume_used);
    if (!Number.isFinite(v) || v <= 0) vEmpty++;
    else if (v < 10) vLow++;
    else if (v < 30) vMid++;
    else vHigh++;
  });
  renderQualityCard('cdnaRnaVolumeQuality', 'cdnaRnaVolumeTotal', total, [
    { name: '< 10 µl', dot: 'other', count: vLow, onClick: () => openCdnaModal('rna_volume_used: < 10', r => { const v = Number(r.rna_volume_used); return Number.isFinite(v) && v > 0 && v < 10; }) },
    { name: '10 – 30 µl', dot: 'valid', count: vMid, onClick: () => openCdnaModal('rna_volume_used: 10–30', r => { const v = Number(r.rna_volume_used); return Number.isFinite(v) && v >= 10 && v < 30; }) },
    { name: '≥ 30 µl', dot: 'invalid', count: vHigh, onClick: () => openCdnaModal('rna_volume_used: ≥ 30', r => { const v = Number(r.rna_volume_used); return Number.isFinite(v) && v >= 30; }) },
    { name: 'Empty', dot: 'empty', count: vEmpty, onClick: () => openCdnaModal('rna_volume_used: Empty', r => { const v = Number(r.rna_volume_used); return !Number.isFinite(v) || v <= 0; }) }
  ]);

  const labeledGroups = [
    { display: 'Yes', count: rows.filter(r => isYesLike(r.labeled)).length },
    { display: 'No', count: rows.filter(r => isNoLike(r.labeled)).length },
    { display: 'Empty', count: rows.filter(r => !hasValue(r.labeled)).length }
  ].filter(g => g.count);
  renderDonutFromGroups('cdnaLabeledChart', 'cdnaLabeledDonut', labeledGroups);
  renderBarFromGroups('cdnaAnimalSetChart', 'cdnaAnimalSetBar', groupCI(rows, r => r.individual_code_animal_set).slice(0, 10));
  renderBarFromGroups('cdnaMaterialChart', 'cdnaMaterialBar', groupCI(rows, r => r.sample_id_material_id).slice(0, 10), { horizontal: true });
  renderBarFromGroups('cdnaPersonChart', 'cdnaPersonBar', groupCI(rows, r => r.person).slice(0, 15), { horizontal: true });
}

function renderPcr() {
  if (!state.pcr.length) {
    const el = document.getElementById('pcrKpisTop');
    if (el) el.innerHTML = '<div class="empty-state" style="grid-column: 1/-1;">No PCR data loaded.<span class="diag">Looked for: BCOMING_PCR / BECOMING_PCR</span></div>';
    return;
  }
  const rows = state.pcr;
  const total = rows.length;

  const resultLower = (r) => safeStr(r.result).toLowerCase();
  const isPositive = (r) => resultLower(r).includes('positive');
  const isNegative = (r) => resultLower(r).includes('negative');
  const isInconclusive = (r) => { const v = resultLower(r); return v && !v.includes('positive') && !v.includes('negative'); };
  const isResultEmpty = (r) => !resultLower(r);

  const positives = rows.filter(isPositive).length;
  const negatives = rows.filter(isNegative).length;
  const incl = rows.filter(isInconclusive).length;
  const empty = rows.filter(isResultEmpty).length;
  const uniqMarkers = new Set(rows.map(r => safeStr(r.marker).toLowerCase()).filter(Boolean)).size;
  const uniqProtocols = new Set(rows.map(r => safeStr(r.protocol).toLowerCase()).filter(Boolean)).size;
  const withCdna = rows.filter(r => hasValue(r.cdna_id)).length;
  const withTemplate = rows.filter(r => hasValue(r.template)).length;
  const withPicture = rows.filter(r => hasValue(r.picture_path)).length;

  renderKpis([
    { label: 'Total PCR Records', value: total.toLocaleString() },
    { label: 'Positive Results', value: positives.toLocaleString(), accent: 'accent-red', sub: total ? `${Math.round(positives / total * 100)}% of total` : '' },
    { label: 'Negative Results', value: negatives.toLocaleString(), accent: 'accent-green', sub: total ? `${Math.round(negatives / total * 100)}% of total` : '' },
    { label: 'Unique Markers', value: uniqMarkers.toLocaleString(), accent: 'accent-cyan' }
  ], 'pcrKpisTop');

  renderKpis([
    { label: 'Unique Protocols', value: uniqProtocols.toLocaleString(), accent: 'accent-purple' },
    { label: 'Linked to CDNA', value: withCdna.toLocaleString(), accent: 'accent-teal', sub: total ? `${Math.round(withCdna / total * 100)}% of total` : '' },
    { label: 'Has Template', value: withTemplate.toLocaleString(), accent: 'accent-orange' },
    { label: 'Has Picture', value: withPicture.toLocaleString(), accent: 'accent-pink' }
  ], 'pcrKpisBottom');

  renderQualityCard('pcrResultQuality', 'pcrResultTotal', total, [
    { name: 'Positive', dot: 'invalid', count: positives, onClick: () => openPcrModal('result: Positive', isPositive) },
    { name: 'Negative', dot: 'valid', count: negatives, onClick: () => openPcrModal('result: Negative', isNegative) },
    { name: 'Other', dot: 'other', count: incl, onClick: () => openPcrModal('result: Other', isInconclusive) },
    { name: 'Empty', dot: 'empty', count: empty, onClick: () => openPcrModal('result: Empty', isResultEmpty) }
  ]);

  topGroupsCard(rows, r => r.animal_set, 'animal_set', 'pcrAnimalSetTotal', 'pcrAnimalSetQuality', openPcrModal);
  topGroupsCard(rows, r => r.species_field_identification, 'species', 'pcrSpeciesTotal', 'pcrSpeciesQuality', openPcrModal);
  topGroupsCard(rows, r => r.material, 'material', 'pcrMaterialTotal', 'pcrMaterialQuality', openPcrModal);
  topGroupsCard(rows, r => r.protocol, 'protocol', 'pcrProtocolTotal', 'pcrProtocolQuality', openPcrModal);
  topGroupsCard(rows, r => r.template, 'template', 'pcrTemplateTotal', 'pcrTemplateQuality', openPcrModal);
  topGroupsCard(rows, r => r.person, 'person', 'pcrPersonTotal', 'pcrPersonQuality', openPcrModal);

  renderDonutFromGroups('pcrResultChart', 'pcrResultDonut', [
    { display: 'Positive', count: positives },
    { display: 'Negative', count: negatives },
    { display: 'Other', count: incl },
    { display: 'Empty', count: empty }
  ].filter(g => g.count));
  renderBarFromGroups('pcrProtocolChart', 'pcrProtocolBar', groupCI(rows, r => r.protocol).slice(0, 10), { horizontal: true });

  const pcrYearMap = new Map();
  rows.forEach(r => {
    const y = parseYear(r.collection_year);
    if (y === null) return;
    pcrYearMap.set(y, (pcrYearMap.get(y) || 0) + 1);
  });
  const pcrYearGroups = [...pcrYearMap.entries()].sort((a, b) => a[0] - b[0]).map(([y, c]) => ({ display: String(y), count: c }));
  renderBarFromGroups('pcrTimelineChart', 'pcrTimeline', pcrYearGroups);

  renderBarFromGroups('pcrAnimalSetChart', 'pcrAnimalSetBar', groupCI(rows, r => r.animal_set).slice(0, 10));
  renderDonutFromGroups('pcrTemplateChart', 'pcrTemplateDonut', groupCI(rows, r => r.template));
}

function renderSanger() {
  if (!state.sanger.length) {
    const el = document.getElementById('sangKpisTop');
    if (el) el.innerHTML = '<div class="empty-state" style="grid-column: 1/-1;">No Sanger sequencing data loaded.<span class="diag">Looked for: BCOMING_SANGER_SEQUENCING / SangerSequencing</span></div>';
    return;
  }
  const rows = state.sanger;
  const total = rows.length;

  const uniqGenes = new Set(rows.map(r => safeStr(r.target_gene).toLowerCase()).filter(Boolean)).size;
  const uniqCo = new Set(rows.map(r => safeStr(r.sequencing_company).toLowerCase()).filter(Boolean)).size;
  const finalCount = rows.filter(r => hasValue(r.final_seq_name)).length;
  const withQc = rows.filter(r => hasValue(r.QC_Score)).length;
  const withAccession = rows.filter(r => hasValue(r.closest_accession_nr)).length;
  const uniqAnalysts = new Set(rows.map(r => safeStr(r.analyst).toLowerCase()).filter(Boolean)).size;
  const withAnalysisDate = rows.filter(r => hasValue(r.analysis_date)).length;

  renderKpis([
    { label: 'Total Sequences', value: total.toLocaleString() },
    { label: 'Unique Target Genes', value: uniqGenes.toLocaleString(), accent: 'accent-green' },
    { label: 'Unique Companies', value: uniqCo.toLocaleString(), accent: 'accent-cyan' },
    { label: 'Final Sequences', value: finalCount.toLocaleString(), accent: 'accent-purple', sub: total ? `${Math.round(finalCount / total * 100)}% of total` : '' }
  ], 'sangKpisTop');

  renderKpis([
    { label: 'Has QC Score', value: withQc.toLocaleString(), accent: 'accent-teal' },
    { label: 'Has Closest Accession', value: withAccession.toLocaleString(), accent: 'accent-orange' },
    { label: 'Unique Analysts', value: uniqAnalysts.toLocaleString(), accent: 'accent-pink' },
    { label: 'Has Analysis Date', value: withAnalysisDate.toLocaleString(), accent: 'accent-red' }
  ], 'sangKpisBottom');

  topGroupsCard(rows, r => r.sequencing_type, 'sequencing_type', 'sangSeqTypeTotal', 'sangSeqTypeQuality', openSangerModal);
  topGroupsCard(rows, r => r.read_direction, 'read_direction', 'sangReadDirTotal', 'sangReadDirQuality', openSangerModal);
  topGroupsCard(rows, r => r.sanger_purpose, 'sanger_purpose', 'sangPurposeTotal', 'sangPurposeQuality', openSangerModal);
  topGroupsCard(rows, r => r.sequencing_company, 'sequencing_company', 'sangCompanyTotal', 'sangCompanyQuality', openSangerModal);
  topGroupsCard(rows, r => r.target_gene, 'target_gene', 'sangTargetGeneTotal', 'sangTargetGeneQuality', openSangerModal);
  topGroupsCard(rows, r => r.individual_code_animal_set, 'animal_set', 'sangAnimalSetTotal', 'sangAnimalSetQuality', openSangerModal);
  topGroupsCard(rows, r => r.analyst, 'analyst', 'sangAnalystTotal', 'sangAnalystQuality', openSangerModal);

  renderBarFromGroups('sangTargetGeneChart', 'sangTargetGeneBar', groupCI(rows, r => r.target_gene).slice(0, 12), { horizontal: true });
  renderBarFromGroups('sangCompanyChart', 'sangCompanyBar', groupCI(rows, r => r.sequencing_company).slice(0, 10));
  renderBarFromGroups('sangPurposeChart', 'sangPurposeBar', groupCI(rows, r => r.sanger_purpose).slice(0, 10), { horizontal: true });

  const sangYearMap = new Map();
  rows.forEach(r => {
    const od = safeStr(r.order_date);
    const m = od.match(/^(\d{4})/);
    if (!m) return;
    const y = parseInt(m[1], 10);
    if (y < 1900 || y > 2100) return;
    sangYearMap.set(y, (sangYearMap.get(y) || 0) + 1);
  });
  const sangYearGroups = [...sangYearMap.entries()].sort((a, b) => a[0] - b[0]).map(([y, c]) => ({ display: String(y), count: c }));
  renderBarFromGroups('sangTimelineChart', 'sangTimeline', sangYearGroups);

  const qcBuckets = [
    { display: '< 50', count: 0, test: v => v < 50 },
    { display: '50 – 70', count: 0, test: v => v >= 50 && v < 70 },
    { display: '70 – 85', count: 0, test: v => v >= 70 && v < 85 },
    { display: '≥ 85', count: 0, test: v => v >= 85 }
  ];
  rows.forEach(r => {
    const v = Number(r.QC_Score);
    if (!Number.isFinite(v)) return;
    const b = qcBuckets.find(b => b.test(v));
    if (b) b.count++;
  });
  renderBarFromGroups('sangQcChart', 'sangQcBar', qcBuckets.map(b => ({ display: b.display, count: b.count })));
}

function renderAll() {
  if (state.bcoming.length) {
    setupMatrixControls();
    renderStats();
    renderProjectMatrix();
    renderStatusDonut();
    renderValidityDonut();
    renderProjectSiteChart();
    renderAnimalSetChart();
    renderSpeciesChart();
    renderMaterialChart();
    renderYearChart();
    renderConservationChart();
    renderTubeChart();
    renderBoxIdChart();
    renderIndvCodeChart();
  }

  if (state.individuals.length) renderIndividuals();
  if (state.extraction.length) renderExtraction();
  if (state.cdna.length) renderCdna();
  if (state.pcr.length) renderPcr();
  if (state.sanger.length) renderSanger();

  requestAnimationFrame(() => positionVisibleSliders());
}

function tableToRows(tableData) {
  if (!tableData) return [];
  const ids = tableData.id || [];
  return ids.map((_, i) => {
    const row = {};
    Object.keys(tableData).forEach(k => { row[k] = tableData[k][i]; });
    return row;
  });
}

async function listAllTables() {
  try {
    if (typeof grist.docApi.listTables === 'function') {
      const t = await grist.docApi.listTables();
      if (Array.isArray(t)) return t;
    }
  } catch (e) {
    console.warn('listTables failed:', e);
  }
  return [];
}

async function findOverviewByMetadata() {
  try {
    if (!state.allTablesMetadata.length || !state.allColumns.length) return [];
    const tableRows = state.allTablesMetadata;
    const colRows = state.allColumns;

    const tableCols = new Map();
    colRows.forEach(c => {
      const pid = c.parentId;
      if (!tableCols.has(pid)) tableCols.set(pid, []);
      tableCols.get(pid).push(safeStr(c.colId).toLowerCase());
    });

    const matches = [];
    tableRows.forEach(t => {
      const cols = tableCols.get(t.id) || [];
      const hasProject = cols.includes('project');
      const hasSite = cols.includes('site');
      const hasPerSample = ['sample_id', 'material_id', 'individual_code'].some(c => cols.includes(c));
      if (hasProject && hasSite && !hasPerSample) {
        matches.push({
          tableId: safeStr(t.tableId),
          colCount: cols.length,
          isSummary: cols.length <= 6
        });
      }
    });

    matches.sort((a, b) => a.colCount - b.colCount);
    console.log('Metadata-found Project+Site tables (preferred order):', matches.map(m => `${m.tableId}(${m.colCount}cols)`).join(', ') || '(none)');
    return matches.map(m => m.tableId);
  } catch (e) {
    console.warn('Metadata lookup failed:', e);
    return [];
  }
}

async function tryFetchTable(candidates, validator) {
  const seen = new Set();
  for (const name of candidates) {
    if (!name || seen.has(name)) continue;
    seen.add(name);
    try {
      const data = await grist.docApi.fetchTable(name);
      const rows = tableToRows(data);
      if (rows.length === 0) continue;
      if (validator && !validator(rows)) {
        console.log(`Table "${name}" loaded (${rows.length} rows) but failed schema check; trying next candidate...`);
        continue;
      }
      return { name, rows, error: null };
    } catch (e) {
      console.warn(`fetchTable("${name}") failed:`, e.message);
    }
  }
  return { name: null, rows: [], error: 'No matching table returned data' };
}

function overviewValidator(rows) {
  if (!rows.length) return false;
  const sample = rows[0];
  const keys = Object.keys(sample).map(k => k.toLowerCase());
  const hasProject = keys.includes('project');
  const hasSite = keys.includes('site');
  const isPerSample = keys.includes('sample_id') || keys.includes('material_id') || keys.includes('individual_code');
  return hasProject && hasSite && !isPerSample;
}

function showSkeletonLoading() {
  const targets = [
    ['overviewKpisTop', 'Loading samples…'],
    ['indvKpisTop', 'Loading individuals…'],
    ['extrKpisTop', 'Loading extractions…'],
    ['cdnaKpisTop', 'Loading cDNA…'],
    ['pcrKpisTop', 'Loading PCR…'],
    ['sangKpisTop', 'Loading sanger sequences…']
  ];
  targets.forEach(([id, text]) => {
    const el = document.getElementById(id);
    if (el && !el.innerHTML) {
      el.innerHTML = `<div class="empty-state" style="grid-column: 1/-1;"><div class="spinner" style="width:24px;height:24px;border-width:2px;display:inline-block;vertical-align:middle;margin-right:10px;"></div>${escapeHtml(text)}</div>`;
    }
  });
}

async function loadSamplesTab() {
  const metadataCandidates = await findOverviewByMetadata();

  const overviewCandidates = [
    ...metadataCandidates,
    'SAMPLES_OVERVIEW',
    ...state.diag.allTables.filter(t => /^samples?_?overview$/i.test(t)),
    ...state.diag.allTables.filter(t => /samples?_?overview/i.test(t)),
    ...state.diag.allTables.filter(t => /overview/i.test(t)),
    ...state.diag.allTables.filter(t => /summary/i.test(t)),
    ...state.diag.allTables.filter(t => /^gristsummary/i.test(t))
  ];
  const overviewUnique = [...new Set(overviewCandidates)];

  const bcomingCandidates = [
    'BCOMING_SAMPLES',
    ...state.diag.allTables.filter(t => /^bcoming_?samples$/i.test(t)),
    ...state.diag.allTables.filter(t => /bcoming_?samples/i.test(t)),
    ...state.diag.allTables.filter(t => /^samples$/i.test(t))
  ];
  const bcomingUnique = [...new Set(bcomingCandidates)];

  const [overviewResult, bcomingResult] = await Promise.all([
    tryFetchTable(overviewUnique, overviewValidator),
    tryFetchTable(bcomingUnique, null)
  ]);
  state.samplesOverview = overviewResult.rows;
  state.diag.overviewTable = overviewResult.name;
  state.diag.overviewError = overviewResult.error;
  state.bcoming = bcomingResult.rows;
  state.diag.bcomingTable = bcomingResult.name;
  state.diag.bcomingError = bcomingResult.error;

  if (state.diag.bcomingTable) {
    state.columnMeta = getColumnMetaMap(state.diag.bcomingTable);
    await preloadRefTablesFor(state.columnMeta);
  } else {
    state.columnMeta = {};
  }

  console.log(`Loaded ${state.bcoming.length} BCOMING rows from "${state.diag.bcomingTable}"`);
  console.log(`Loaded ${state.samplesOverview.length} SAMPLES_OVERVIEW rows from "${state.diag.overviewTable}"`);

  if (state.bcoming.length) {
    setupMatrixControls();
    renderStats();
    renderProjectMatrix();
    renderStatusDonut();
    renderValidityDonut();
    renderProjectSiteChart();
    renderAnimalSetChart();
    renderSpeciesChart();
    renderMaterialChart();
    renderYearChart();
    renderConservationChart();
    renderTubeChart();
    renderBoxIdChart();
    renderIndvCodeChart();
  } else {
    document.getElementById('overviewKpisTop').innerHTML = diagnosticHtml("Couldn't load BCOMING_SAMPLES data.");
  }
}

async function loadIndividualsTab() {
  const candidates = [
    'BECOMING_INDIVIDUALS',
    'BCOMING_INDIVIDUALS',
    ...state.diag.allTables.filter(t => /^be?coming_?individuals$/i.test(t)),
    ...state.diag.allTables.filter(t => /individuals?/i.test(t))
  ];
  const result = await tryFetchTable([...new Set(candidates)], null);
  state.individuals = result.rows;
  state.diag.individualsTable = result.name;
  state.diag.individualsError = result.error;

  if (state.diag.individualsTable) {
    state.individualsColumnMeta = getColumnMetaMap(state.diag.individualsTable);
    await preloadRefTablesFor(state.individualsColumnMeta);
  } else {
    state.individualsColumnMeta = {};
  }

  console.log(`Loaded ${state.individuals.length} INDIVIDUALS rows from "${state.diag.individualsTable}"`);
  renderIndividuals();
}

async function loadExtractionTab() {
  const candidates = [
    'BCOMING_EXTRACTION', 'BECOMING_EXTRACTION', 'BCOMING_Extraction',
    ...state.diag.allTables.filter(t => /^be?coming_?extraction/i.test(t)),
    ...state.diag.allTables.filter(t => /extraction/i.test(t))
  ];
  const result = await tryFetchTable([...new Set(candidates)], null);
  state.extraction = result.rows;
  state.diag.extractionTable = result.name;
  if (state.diag.extractionTable) {
    state.extractionColumnMeta = getColumnMetaMap(state.diag.extractionTable);
    await preloadRefTablesFor(state.extractionColumnMeta);
  } else {
    state.extractionColumnMeta = {};
  }
  console.log(`Loaded ${state.extraction.length} EXTRACTION rows from "${state.diag.extractionTable}"`);
  renderExtraction();
}

async function loadCdnaTab() {
  const candidates = [
    'BCOMING_CDNA', 'BECOMING_CDNA', 'BCOMING_cDNA', 'BECOMING_cDNA',
    ...state.diag.allTables.filter(t => /^be?coming_?c?dna$/i.test(t)),
    ...state.diag.allTables.filter(t => /^cdna$/i.test(t))
  ];
  const result = await tryFetchTable([...new Set(candidates)], null);
  state.cdna = result.rows;
  state.diag.cdnaTable = result.name;
  if (state.diag.cdnaTable) {
    state.cdnaColumnMeta = getColumnMetaMap(state.diag.cdnaTable);
    await preloadRefTablesFor(state.cdnaColumnMeta);
  } else {
    state.cdnaColumnMeta = {};
  }
  console.log(`Loaded ${state.cdna.length} CDNA rows from "${state.diag.cdnaTable}"`);
  renderCdna();
}

async function loadPcrTab() {
  const candidates = [
    'BCOMING_PCR', 'BECOMING_PCR',
    ...state.diag.allTables.filter(t => /^be?coming_?pcr$/i.test(t)),
    ...state.diag.allTables.filter(t => /^pcr$/i.test(t))
  ];
  const result = await tryFetchTable([...new Set(candidates)], null);
  state.pcr = result.rows;
  state.diag.pcrTable = result.name;
  if (state.diag.pcrTable) {
    state.pcrColumnMeta = getColumnMetaMap(state.diag.pcrTable);
    await preloadRefTablesFor(state.pcrColumnMeta);
  } else {
    state.pcrColumnMeta = {};
  }
  console.log(`Loaded ${state.pcr.length} PCR rows from "${state.diag.pcrTable}"`);
  renderPcr();
}

async function loadSangerTab() {
  const candidates = [
    'BCOMING_SANGER_SEQUENCING', 'BCOMING_SANGER', 'BECOMING_SANGER',
    'BCOMING_SangerSequencing', 'SangerSequencing',
    ...state.diag.allTables.filter(t => /sanger/i.test(t))
  ];
  const result = await tryFetchTable([...new Set(candidates)], null);
  state.sanger = result.rows;
  state.diag.sangerTable = result.name;
  if (state.diag.sangerTable) {
    state.sangerColumnMeta = getColumnMetaMap(state.diag.sangerTable);
    await preloadRefTablesFor(state.sangerColumnMeta);
  } else {
    state.sangerColumnMeta = {};
  }
  console.log(`Loaded ${state.sanger.length} SANGER rows from "${state.diag.sangerTable}"`);
  renderSanger();
}

async function loadData() {
  try {
    delete projectFieldFromBcoming._logged;
    state.refTables = {};
    state.diag.allTables = await listAllTables();
    console.log(`Tables visible to widget (${state.diag.allTables.length}):`, state.diag.allTables.join(', '));

    await Promise.all([
      loadAllColumnMetadata(),
      loadAttachmentsMetadata(),
      ensureGristToken()
    ]);

    document.getElementById('globalLoading').style.display = 'none';
    document.getElementById('dashboardContent').style.display = 'block';
    showSkeletonLoading();
    requestAnimationFrame(() => positionVisibleSliders());

    const tabLoaders = [
      loadIndividualsTab(),
      loadSamplesTab(),
      loadExtractionTab(),
      loadCdnaTab(),
      loadPcrTab(),
      loadSangerTab()
    ];

    const updateStamp = () => {
      const stamp = new Date().toLocaleTimeString();
      document.getElementById('lastUpdate').textContent = `Updated ${stamp}`;
    };
    document.getElementById('lastUpdate').textContent = 'Loading…';
    tabLoaders.forEach(p => p.then(updateStamp).catch(e => console.warn('Tab loader failed:', e)));

    await Promise.allSettled(tabLoaders);
    updateStamp();
  } catch (err) {
    console.error('Data load failed:', err);
    document.getElementById('lastUpdate').textContent = 'Connection error';
    document.getElementById('globalLoading').innerHTML = diagnosticHtml(`Unable to load data: ${err.message}`);
  }
}

function init() {
  if (window.__bcomingDashboardInited) return;
  window.__bcomingDashboardInited = true;

  chartDefaults();
  setupTabs();
  setupModal();
  grist.ready({ requiredAccess: 'full' });
  grist.onRecords(() => loadData());
  loadData();

  window.addEventListener('resize', () => positionVisibleSliders());

  if (window.matchMedia) {
    window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => {
      chartDefaults();
      renderAll();
    });
  }
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', init);
} else {
  init();
}