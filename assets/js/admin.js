/* ==========================================================================
   Lógica del Panel de Administración (/admin)
   ========================================================================== */

let allGuestsCache = [];
let currentStatusFilter = 'all'; // 'all' | 'accredited' | 'pending'
let searchQuery = '';

document.addEventListener('DOMContentLoaded', () => {
  initAuthCheck();
  initEventListeners();
  window.appStore.onChange(() => {
    refreshDashboardData();
  });
});

/* --------------------------------------------------------------------------
   Autenticación y Bloqueo por PIN
   -------------------------------------------------------------------------- */
function initAuthCheck() {
  const authModal = document.getElementById('auth-modal');
  const mainContent = document.getElementById('admin-main-content');

  if (window.appStore.isAdminAuthenticated()) {
    authModal.classList.add('hidden');
    mainContent.classList.remove('hidden');
    loadInitialAdminState();
  } else {
    authModal.classList.remove('hidden');
    mainContent.classList.add('hidden');
    setTimeout(() => {
      const pinInput = document.getElementById('login-pin-input');
      if (pinInput) pinInput.focus();
    }, 100);
  }
}

function handleLoginSubmit(e) {
  e.preventDefault();
  const pinInput = document.getElementById('login-pin-input');
  const errorMsg = document.getElementById('login-error-msg');
  const pin = pinInput.value;

  if (window.appStore.loginAdmin(pin)) {
    errorMsg.classList.add('hidden');
    pinInput.value = '';
    initAuthCheck();
  } else {
    errorMsg.classList.remove('hidden');
    pinInput.classList.add('animate-shake');
    setTimeout(() => pinInput.classList.remove('animate-shake'), 400);
  }
}

/* --------------------------------------------------------------------------
   Inicialización de Datos y UI
   -------------------------------------------------------------------------- */
async function loadInitialAdminState() {
  updateHeaderAndSettingsUI();
  await refreshDashboardData();
}

function updateHeaderAndSettingsUI() {
  const settings = window.appStore.settings;
  document.getElementById('header-event-name').textContent = settings.eventName || 'Evento';

  // Badge de estado Cloud vs Local
  const modeBadge = document.getElementById('sync-mode-badge');
  if (window.appStore.isCloudActive()) {
    const provider = window.appStore.getActiveCloudProviderLabel();
    modeBadge.className =
      'inline-flex items-center gap-1.5 px-3 py-1 rounded-full text-xs font-semibold bg-emerald-500/15 text-emerald-400 border border-emerald-500/30';
    modeBadge.innerHTML = `<span class="w-2 h-2 rounded-full bg-emerald-400 animate-pulse"></span> Sincronización Nube (${provider})`;
  } else {
    modeBadge.className =
      'inline-flex items-center gap-1.5 px-3 py-1 rounded-full text-xs font-semibold bg-amber-500/15 text-amber-300 border border-amber-500/30';
    modeBadge.innerHTML = `<span class="w-2 h-2 rounded-full bg-amber-400"></span> Modo Local (Este navegador)`;
  }

  // Rellenar formulario de ajustes
  const eventNameInput = document.getElementById('setting-event-name');
  const pinInput = document.getElementById('setting-admin-pin');
  const modeSelect = document.getElementById('setting-sync-mode');
  const fbProjectInput = document.getElementById('setting-firebase-project-id');
  const fbApiKeyInput = document.getElementById('setting-firebase-api-key');
  const fbAppIdInput = document.getElementById('setting-firebase-app-id');
  const fbColInput = document.getElementById('setting-firebase-collection');
  const sbUrlInput = document.getElementById('setting-supabase-url');
  const sbKeyInput = document.getElementById('setting-supabase-key');

  if (eventNameInput) eventNameInput.value = settings.eventName || '';
  if (pinInput) pinInput.value = settings.adminPin || '1234';
  if (modeSelect) modeSelect.value = settings.mode || 'local';
  if (fbProjectInput) fbProjectInput.value = settings.firebaseProjectId || '';
  if (fbApiKeyInput) fbApiKeyInput.value = settings.firebaseApiKey || '';
  if (fbAppIdInput) fbAppIdInput.value = settings.firebaseAppId || '';
  if (fbColInput) fbColInput.value = settings.firebaseCollection || 'acreditacion_invitados';
  if (sbUrlInput) sbUrlInput.value = settings.supabaseUrl || '';
  if (sbKeyInput) sbKeyInput.value = settings.supabaseKey || '';

  toggleSupabaseFieldsVisibility();
}

function toggleSupabaseFieldsVisibility() {
  const mode = document.getElementById('setting-sync-mode').value;
  const firebaseContainer = document.getElementById('firebase-config-fields');
  const cloudContainer = document.getElementById('supabase-config-fields');
  if (firebaseContainer) {
    firebaseContainer.classList.toggle('hidden', mode !== 'firebase');
  }
  if (cloudContainer) {
    cloudContainer.classList.toggle('hidden', mode !== 'supabase');
  }
}

async function refreshDashboardData() {
  try {
    allGuestsCache = await window.appStore.getAllGuests();
    renderStats(allGuestsCache);
    renderGuestsTable();
  } catch (err) {
    showToast(err.message || 'Error al cargar invitados', 'error');
  }
}

/* --------------------------------------------------------------------------
   Estadísticas en Tiempo Real
   -------------------------------------------------------------------------- */
function renderStats(guests) {
  const total = guests.length;
  const accredited = guests.filter((g) => g.acreditado).length;
  const pending = total - accredited;
  const percent = total > 0 ? Math.round((accredited / total) * 100) : 0;

  document.getElementById('stat-total').textContent = total.toLocaleString('es-CL');
  document.getElementById('stat-accredited').textContent = accredited.toLocaleString('es-CL');
  document.getElementById('stat-pending').textContent = pending.toLocaleString('es-CL');
  document.getElementById('stat-percent').textContent = `${percent}%`;

  const progressBar = document.getElementById('stat-progress-bar');
  if (progressBar) {
    progressBar.style.width = `${percent}%`;
  }
}

/* --------------------------------------------------------------------------
   Tabla de Invitados + Buscador + Acciones Manuales
   -------------------------------------------------------------------------- */
function renderGuestsTable() {
  const tbody = document.getElementById('guests-table-body');
  const emptyState = document.getElementById('guests-empty-state');
  const countLabel = document.getElementById('filtered-count-label');

  const q = searchQuery.trim().toLowerCase();
  const qDigits = q.replace(/[^0-9k]/g, '');

  const filtered = allGuestsCache.filter((g) => {
    if (currentStatusFilter === 'accredited' && !g.acreditado) return false;
    if (currentStatusFilter === 'pending' && g.acreditado) return false;

    if (!q) return true;
    const matchName = (g.nombre || '').toLowerCase().includes(q);
    const rutLower = (g.rut || '').toLowerCase();
    const rutDigits = rutLower.replace(/[^0-9k]/g, '');
    const matchRut =
      rutLower.includes(q) ||
      (g.rutDisplay || '').toLowerCase().includes(q) ||
      (qDigits.length >= 2 && rutDigits.includes(qDigits));

    return matchName || matchRut;
  });

  countLabel.textContent = `Mostrando ${filtered.length} de ${allGuestsCache.length} invitados`;

  if (filtered.length === 0) {
    tbody.innerHTML = '';
    emptyState.classList.remove('hidden');
    return;
  }

  emptyState.classList.add('hidden');

  tbody.innerHTML = filtered
    .map((guest) => {
      const statusBadge = guest.acreditado
        ? `<span class="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs font-semibold bg-emerald-500/15 text-emerald-400 border border-emerald-500/30">
             <span class="w-1.5 h-1.5 rounded-full bg-emerald-400"></span> Acreditado
           </span>`
        : `<span class="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs font-semibold bg-slate-700/60 text-slate-300 border border-slate-600">
             <span class="w-1.5 h-1.5 rounded-full bg-slate-400"></span> Pendiente
           </span>`;

      const originBadge =
        guest.origen === 'walk-in'
          ? `<span class="ml-2 px-2 py-0.5 text-[10px] uppercase tracking-wider font-bold rounded bg-indigo-500/20 text-indigo-300 border border-indigo-500/30">Walk-in</span>`
          : '';

      const timeStr = guest.acreditado
        ? window.formatDateTimeChile(guest.hora_acreditacion)
        : '<span class="text-slate-500">—</span>';

      const toggleBtn = guest.acreditado
        ? `<button onclick="toggleGuestAccreditation('${guest.rut}', false)" class="px-3 py-1.5 rounded-lg text-xs font-semibold bg-amber-500/15 hover:bg-amber-500/25 text-amber-300 border border-amber-500/30 transition">
             Desacreditar
           </button>`
        : `<button onclick="toggleGuestAccreditation('${guest.rut}', true)" class="px-3 py-1.5 rounded-lg text-xs font-semibold bg-emerald-600 hover:bg-emerald-500 text-white shadow-sm transition">
             Acreditar
           </button>`;

      return `
        <tr class="border-b border-slate-800/80 hover:bg-slate-800/40 transition">
          <td class="py-3.5 px-4 font-mono text-sm font-semibold text-sky-400 whitespace-nowrap">
            ${escapeHtml(guest.rutDisplay || guest.rut)}
          </td>
          <td class="py-3.5 px-4 text-sm font-medium text-slate-100">
            ${escapeHtml(guest.nombre)} ${originBadge}
          </td>
          <td class="py-3.5 px-4 whitespace-nowrap">
            ${statusBadge}
          </td>
          <td class="py-3.5 px-4 text-xs text-slate-300 whitespace-nowrap">
            ${timeStr}
          </td>
          <td class="py-3.5 px-4 text-right whitespace-nowrap space-x-2">
            ${toggleBtn}
            <button onclick="removeGuest('${guest.rut}')" title="Eliminar invitado" class="p-1.5 rounded-lg text-slate-400 hover:text-rose-400 hover:bg-rose-500/10 transition">
              <svg class="w-4 h-4 inline" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16"/>
              </svg>
            </button>
          </td>
        </tr>
      `;
    })
    .join('');
}

window.toggleGuestAccreditation = async function (rut, newStatus) {
  try {
    await window.appStore.setAccreditationStatus(rut, newStatus);
    showToast(
      newStatus ? 'Invitado acreditado manualmente' : 'Acreditación revertida',
      newStatus ? 'success' : 'info'
    );
    await refreshDashboardData();
  } catch (err) {
    showToast(err.message || 'Error al actualizar estado', 'error');
  }
};

window.removeGuest = async function (rut) {
  if (!confirm(`¿Seguro que deseas eliminar al invitado con RUT ${window.AccreditationStore.formatRutDisplay(rut)}?`)) {
    return;
  }
  try {
    await window.appStore.deleteGuest(rut);
    showToast('Invitado eliminado', 'info');
    await refreshDashboardData();
  } catch (err) {
    showToast(err.message || 'Error al eliminar', 'error');
  }
};

/* --------------------------------------------------------------------------
   Carga de Archivo Excel (.xlsx, .xls, .csv) con SheetJS
   -------------------------------------------------------------------------- */
function handleExcelFileSelect(file) {
  if (!file) return;

  const statusBox = document.getElementById('excel-upload-status');
  statusBox.classList.remove('hidden');
  statusBox.innerHTML = `<div class="text-sky-400 text-sm font-medium flex items-center gap-2">
    <svg class="w-4 h-4 animate-spin" viewBox="0 0 24 24" fill="none" stroke="currentColor"><circle cx="12" cy="12" r="10" stroke-width="4" class="opacity-25"></circle><path d="M4 12a8 8 0 018-8" stroke-width="4" class="opacity-75"></path></svg>
    Procesando archivo "${escapeHtml(file.name)}"...
  </div>`;

  const reader = new FileReader();
  reader.onload = async function (e) {
    try {
      const data = new Uint8Array(e.target.result);
      const workbook = XLSX.read(data, { type: 'array' });
      // Recorrer todas las hojas del archivo Excel (por si los datos están en otra pestaña)
      let allRows = [];
      for (const sheetName of workbook.SheetNames) {
        const ws = workbook.Sheets[sheetName];
        const sheetRows = XLSX.utils.sheet_to_json(ws, { header: 1, defval: '' });
        if (sheetRows && sheetRows.length > 0) {
          allRows = allRows.concat(sheetRows);
        }
      }

      if (allRows.length === 0) {
        throw new Error('El archivo Excel está vacío.');
      }

      const parsedGuests = parseRowsFromExcel(allRows);
      if (parsedGuests.length === 0) {
        throw new Error(
          'No se encontraron filas válidas con RUT y Nombre. Asegúrate de que el Excel tenga una columna para el RUT y otra para el Nombre.'
        );
      }

      const replaceAll = document.getElementById('excel-replace-checkbox').checked;
      const count = await window.appStore.bulkUpsertGuests(parsedGuests, { replaceAll });

      const samplePreview = parsedGuests
        .slice(0, 3)
        .map((g) => `${window.AccreditationStore.formatRutDisplay(g.rut)} (${g.nombre})`)
        .join(' · ');

      statusBox.innerHTML = `
        <div class="p-3 rounded-lg bg-emerald-500/15 border border-emerald-500/30 text-emerald-300 text-sm space-y-1">
          <div>✅ <strong>¡Carga exitosa!</strong> Se importaron <strong>${count}</strong> invitados desde <em>${escapeHtml(file.name)}</em>.</div>
          <div class="text-xs text-emerald-200/80 font-mono">Ejemplo detectado: ${escapeHtml(samplePreview)}</div>
        </div>
      `;
      showToast(`${count} invitados cargados correctamente`, 'success');
      await refreshDashboardData();
    } catch (err) {
      statusBox.innerHTML = `
        <div class="p-3 rounded-lg bg-rose-500/15 border border-rose-500/30 text-rose-300 text-sm">
          ❌ <strong>Error:</strong> ${escapeHtml(err.message)}
        </div>
      `;
      showToast(err.message, 'error');
    }
  };
  reader.readAsArrayBuffer(file);
}

/**
 * Detecta inteligentemente qué columna es RUT y qué columna es Nombre
 * (Soporta encabezados como "RUT", "RUN", "Cedula", "Nombre", "Nombre Completo", o incluso si tiene Nombre y Apellido separados)
 */
function parseRowsFromExcel(rows) {
  let rutColIdx = -1;
  let dvColIdx = -1;
  let nameColIdx = -1;
  let lastNameColIdx = -1;
  let secondLastNameColIdx = -1;
  let headerRowIdx = -1;

  // 1. Buscar la fila de encabezados dentro de las primeras 15 filas (por si el Excel tiene títulos o logos arriba)
  const maxHeaderScan = Math.min(rows.length, 15);
  for (let r = 0; r < maxHeaderScan; r++) {
    const row = rows[r];
    if (!row || !Array.isArray(row)) continue;

    let tempRut = -1;
    let tempDv = -1;
    let tempName = -1;
    let tempLast = -1;
    let tempSecondLast = -1;

    row.forEach((cell, idx) => {
      const colName = String(cell || '')
        .trim()
        .toLowerCase()
        .normalize('NFD')
        .replace(/[\u0300-\u036f]/g, '');

      if (!colName) return;

      if (
        tempRut === -1 &&
        (colName === 'rut' ||
          colName === 'run' ||
          colName.includes('rut ') ||
          colName.includes(' run') ||
          colName.includes('cedula') ||
          colName.includes('documento') ||
          colName.includes('dni') ||
          colName.includes('identificador'))
      ) {
        tempRut = idx;
      } else if (
        tempDv === -1 &&
        (colName === 'dv' ||
          colName === 'd.v.' ||
          colName === 'digito' ||
          colName.includes('verificador'))
      ) {
        tempDv = idx;
      } else if (
        tempName === -1 &&
        (colName.includes('nombre') ||
          colName.includes('invitado') ||
          colName.includes('asistente') ||
          colName.includes('persona') ||
          colName.includes('participante') ||
          colName === 'name' ||
          colName === 'full name')
      ) {
        tempName = idx;
      } else if (colName.includes('apellido') || colName.includes('paterno') || colName.includes('materno')) {
        if (tempLast === -1) tempLast = idx;
        else if (tempSecondLast === -1) tempSecondLast = idx;
      }
    });

    if (tempRut !== -1 || tempName !== -1) {
      rutColIdx = tempRut;
      dvColIdx = tempDv;
      nameColIdx = tempName;
      lastNameColIdx = tempLast;
      secondLastNameColIdx = tempSecondLast;
      headerRowIdx = r;
      break;
    }
  }

  // 2. Si alguna columna no tenía encabezado claro, autodetectarla puntuando el contenido de las filas
  const sampleStart = headerRowIdx !== -1 ? headerRowIdx + 1 : 0;
  const maxCols = rows.reduce((max, r) => Math.max(max, Array.isArray(r) ? r.length : 0), 0);

  if (rutColIdx === -1 && maxCols > 0) {
    let bestRutCol = -1;
    let bestRutScore = 0;

    for (let c = 0; c < maxCols; c++) {
      let score = 0;
      for (let r = sampleStart; r < Math.min(rows.length, sampleStart + 30); r++) {
        const val = String(rows[r]?.[c] ?? '').trim();
        if (!val) continue;
        if (window.AccreditationStore.looksLikeRut(val)) {
          score += 2;
        }
      }
      if (score > bestRutScore) {
        bestRutScore = score;
        bestRutCol = c;
      }
    }
    if (bestRutCol !== -1) rutColIdx = bestRutCol;
  }

  if (nameColIdx === -1 && maxCols > 0) {
    let bestNameCol = -1;
    let bestNameScore = 0;

    for (let c = 0; c < maxCols; c++) {
      if (c === rutColIdx || c === dvColIdx) continue;
      let score = 0;
      for (let r = sampleStart; r < Math.min(rows.length, sampleStart + 30); r++) {
        const val = String(rows[r]?.[c] ?? '').trim();
        if (!val || val.includes('@')) continue;
        // Texto con letras y al menos 3 caracteres que no sea numérico
        if (/[a-zA-ZáéíóúÁÉÍÓÚñÑ]{2,}/.test(val) && !/^\d+$/.test(val)) {
          score += val.includes(' ') ? 3 : 1;
        }
      }
      if (score > bestNameScore) {
        bestNameScore = score;
        bestNameCol = c;
      }
    }
    if (bestNameCol !== -1) nameColIdx = bestNameCol;
  }

  // Fallback a Columna 0 = RUT, Columna 1 = Nombre
  if (rutColIdx === -1) rutColIdx = 0;
  if (nameColIdx === -1) nameColIdx = rutColIdx === 0 ? 1 : 0;

  const result = [];
  for (let r = sampleStart; r < rows.length; r++) {
    const row = rows[r];
    if (!row || !Array.isArray(row) || row.length === 0) continue;

    let rawRut = String(row[rutColIdx] ?? '').trim();
    if (dvColIdx !== -1 && row[dvColIdx] !== undefined && row[dvColIdx] !== '') {
      const rawDv = String(row[dvColIdx]).trim();
      if (rawRut && !rawRut.includes('-')) {
        rawRut = `${rawRut}-${rawDv}`;
      }
    }

    let rawName = String(row[nameColIdx] ?? '').trim();
    if (lastNameColIdx !== -1 && row[lastNameColIdx]) {
      rawName = `${rawName} ${String(row[lastNameColIdx]).trim()}`.trim();
    }
    if (secondLastNameColIdx !== -1 && row[secondLastNameColIdx]) {
      rawName = `${rawName} ${String(row[secondLastNameColIdx]).trim()}`.trim();
    }

    // Si en esta fila están invertidos o el RUT estaba en otra celda de la fila
    if (!window.AccreditationStore.looksLikeRut(rawRut)) {
      if (window.AccreditationStore.looksLikeRut(rawName)) {
        const temp = rawRut;
        rawRut = rawName;
        rawName = temp;
      } else {
        // Buscar en las demás celdas de la misma fila si alguna contiene un RUT claro
        for (let c = 0; c < row.length; c++) {
          const cellVal = String(row[c] ?? '').trim();
          if (window.AccreditationStore.looksLikeRut(cellVal)) {
            rawRut = cellVal;
            break;
          }
        }
      }
    }

    // Si el nombre quedó vacío, intentar tomar la celda de texto más larga de la fila
    if (!rawName || window.AccreditationStore.looksLikeRut(rawName)) {
      for (let c = 0; c < row.length; c++) {
        if (c === rutColIdx || c === dvColIdx) continue;
        const cellVal = String(row[c] ?? '').trim();
        if (
          cellVal.length >= 3 &&
          /[a-zA-ZáéíóúÁÉÍÓÚñÑ]/.test(cellVal) &&
          !cellVal.includes('@') &&
          !window.AccreditationStore.looksLikeRut(cellVal)
        ) {
          rawName = cellVal;
          break;
        }
      }
    }

    const finalRut = window.AccreditationStore.normalizeRut(rawRut);
    if (!finalRut || finalRut.replace(/[^0-9K]/g, '').length < 5 || !rawName) continue;

    // Ignorar si es otra fila de encabezado repetida
    if (finalRut === 'RUT' || rawName.toLowerCase() === 'nombre completo') continue;

    result.push({
      rut: finalRut,
      nombre: rawName
    });
  }

  return result;
}

/* --------------------------------------------------------------------------
   Descargar Plantilla de Ejemplo y Exportar Reporte Excel Actualizado
   -------------------------------------------------------------------------- */
function downloadSampleExcelTemplate() {
  const sampleData = [
    { RUT: '12.345.678-5', 'Nombre Completo': 'Juan Pérez González' },
    { RUT: '9.876.543-3', 'Nombre Completo': 'María Carolina Soto' },
    { RUT: '18.234.567-K', 'Nombre Completo': 'Pedro Pablo Ramírez' },
    { RUT: '15.432.198-2', 'Nombre Completo': 'Camila Andrea Valdés' }
  ];

  const ws = XLSX.utils.json_to_sheet(sampleData);
  ws['!cols'] = [{ wch: 18 }, { wch: 35 }];
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, 'Invitados');
  XLSX.writeFile(wb, 'Plantilla_Invitados_Acreditacion.xlsx');
}

function exportAttendanceExcel() {
  if (!allGuestsCache || allGuestsCache.length === 0) {
    showToast('No hay invitados para exportar', 'error');
    return;
  }

  const exportRows = allGuestsCache.map((g) => ({
    RUT: g.rutDisplay || g.rut,
    'Nombre Completo': g.nombre,
    Estado: g.acreditado ? 'ACREDITADO' : 'PENDIENTE',
    'Hora de Ingreso': g.acreditado ? window.formatDateTimeChile(g.hora_acreditacion) : '',
    Origen: g.origen === 'walk-in' ? 'Walk-in (Puerta)' : 'Lista Excel'
  }));

  const ws = XLSX.utils.json_to_sheet(exportRows);
  ws['!cols'] = [{ wch: 16 }, { wch: 34 }, { wch: 16 }, { wch: 24 }, { wch: 18 }];
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, 'Reporte Acreditacion');

  const safeEventName = (window.appStore.settings.eventName || 'Evento')
    .replace(/[^a-zA-Z0-9_-]/g, '_');
  const dateStr = new Date().toISOString().slice(0, 10);
  XLSX.writeFile(wb, `Reporte_${safeEventName}_${dateStr}.xlsx`);
  showToast('Reporte Excel descargado con éxito', 'success');
}

/* --------------------------------------------------------------------------
   Listeners de Eventos en /admin
   -------------------------------------------------------------------------- */
function initEventListeners() {
  // Login form
  const loginForm = document.getElementById('login-form');
  if (loginForm) loginForm.addEventListener('submit', handleLoginSubmit);

  // Botón Cerrar Sesión
  const logoutBtn = document.getElementById('logout-btn');
  if (logoutBtn) {
    logoutBtn.addEventListener('click', () => {
      window.appStore.logoutAdmin();
      initAuthCheck();
    });
  }

  // Subida de archivo Excel (Input y Drag & Drop)
  const fileInput = document.getElementById('excel-file-input');
  const dropzone = document.getElementById('excel-dropzone');

  if (fileInput) {
    fileInput.addEventListener('change', (e) => {
      if (e.target.files && e.target.files[0]) {
        handleExcelFileSelect(e.target.files[0]);
        e.target.value = '';
      }
    });
  }

  if (dropzone) {
    dropzone.addEventListener('dragover', (e) => {
      e.preventDefault();
      dropzone.classList.add('border-sky-400', 'bg-sky-500/10');
    });
    dropzone.addEventListener('dragleave', () => {
      dropzone.classList.remove('border-sky-400', 'bg-sky-500/10');
    });
    dropzone.addEventListener('drop', (e) => {
      e.preventDefault();
      dropzone.classList.remove('border-sky-400', 'bg-sky-500/10');
      if (e.dataTransfer.files && e.dataTransfer.files[0]) {
        handleExcelFileSelect(e.dataTransfer.files[0]);
      }
    });
  }

  // Botón descargar plantilla Excel
  const templateBtn = document.getElementById('download-template-btn');
  if (templateBtn) templateBtn.addEventListener('click', downloadSampleExcelTemplate);

  // Botón exportar reporte Excel
  const exportBtn = document.getElementById('export-excel-btn');
  if (exportBtn) exportBtn.addEventListener('click', exportAttendanceExcel);

  // Formulario Walk-in (Nuevo invitado de última hora)
  const walkinForm = document.getElementById('walkin-form');
  if (walkinForm) {
    walkinForm.addEventListener('submit', async (e) => {
      e.preventDefault();
      const rutInput = document.getElementById('walkin-rut');
      const nameInput = document.getElementById('walkin-name');
      const autoAccredit = document.getElementById('walkin-accredit-now').checked;

      try {
        const added = await window.appStore.addWalkInGuest({
          rut: rutInput.value,
          nombre: nameInput.value,
          accreditImmediately: autoAccredit
        });
        rutInput.value = '';
        nameInput.value = '';
        showToast(
          `${added.nombre} agregado ${autoAccredit ? 'y acreditado' : 'a la lista'}`,
          'success'
        );
        await refreshDashboardData();
      } catch (err) {
        showToast(err.message, 'error');
      }
    });
  }

  // Buscador de la tabla
  const searchInput = document.getElementById('admin-search-input');
  if (searchInput) {
    searchInput.addEventListener('input', (e) => {
      searchQuery = e.target.value;
      renderGuestsTable();
    });
  }

  // Filtros de estado (Todos / Acreditados / Pendientes)
  document.querySelectorAll('[data-filter-status]').forEach((btn) => {
    btn.addEventListener('click', () => {
      currentStatusFilter = btn.getAttribute('data-filter-status');
      document.querySelectorAll('[data-filter-status]').forEach((b) => {
        b.classList.remove('bg-sky-600', 'text-white');
        b.classList.add('bg-slate-800', 'text-slate-300');
      });
      btn.classList.remove('bg-slate-800', 'text-slate-300');
      btn.classList.add('bg-sky-600', 'text-white');
      renderGuestsTable();
    });
  });

  // Botón vaciar lista completa
  const clearAllBtn = document.getElementById('clear-all-guests-btn');
  if (clearAllBtn) {
    clearAllBtn.addEventListener('click', async () => {
      if (
        !confirm(
          '⚠️ ¿Estás seguro de que quieres BORRAR TODOS los invitados de la base de datos? Esta acción no se puede deshacer.'
        )
      ) {
        return;
      }
      try {
        await window.appStore.clearAllGuests();
        showToast('Base de datos de invitados vaciada', 'info');
        await refreshDashboardData();
      } catch (err) {
        showToast(err.message, 'error');
      }
    });
  }

  // Modal de Configuración de Instancia y Nube
  const openSettingsBtn = document.getElementById('open-settings-btn');
  const closeSettingsBtn = document.getElementById('close-settings-btn');
  const settingsModal = document.getElementById('settings-modal');
  const modeSelect = document.getElementById('setting-sync-mode');
  const settingsForm = document.getElementById('settings-form');

  if (openSettingsBtn && settingsModal) {
    openSettingsBtn.addEventListener('click', () => {
      updateHeaderAndSettingsUI();
      settingsModal.classList.remove('hidden');
    });
  }

  if (closeSettingsBtn && settingsModal) {
    closeSettingsBtn.addEventListener('click', () => {
      settingsModal.classList.add('hidden');
    });
  }

  if (modeSelect) {
    modeSelect.addEventListener('change', toggleSupabaseFieldsVisibility);
  }

  if (settingsForm) {
    settingsForm.addEventListener('submit', async (e) => {
      e.preventDefault();
      const newSettings = {
        eventName: document.getElementById('setting-event-name').value.trim() || 'Mi Evento',
        adminPin: document.getElementById('setting-admin-pin').value.trim() || '1234',
        mode: document.getElementById('setting-sync-mode').value,
        firebaseProjectId: document.getElementById('setting-firebase-project-id').value.trim(),
        firebaseApiKey: document.getElementById('setting-firebase-api-key').value.trim(),
        firebaseAppId: document.getElementById('setting-firebase-app-id').value.trim(),
        firebaseCollection:
          document.getElementById('setting-firebase-collection').value.trim() ||
          'acreditacion_invitados',
        supabaseUrl: document.getElementById('setting-supabase-url').value.trim(),
        supabaseKey: document.getElementById('setting-supabase-key').value.trim()
      };

      window.appStore.saveSettings(newSettings);
      updateHeaderAndSettingsUI();
      settingsModal.classList.add('hidden');
      showToast('Configuración guardada correctamente', 'success');
      await refreshDashboardData();
    });
  }

  // Copiar SQL de Supabase
  const copySqlBtn = document.getElementById('copy-sql-btn');
  if (copySqlBtn) {
    copySqlBtn.addEventListener('click', () => {
      const sqlCode = document.getElementById('supabase-sql-snippet').innerText;
      navigator.clipboard.writeText(sqlCode);
      showToast('Código SQL copiado al portapapeles', 'success');
    });
  }
}

/* --------------------------------------------------------------------------
   Helpers UI
   -------------------------------------------------------------------------- */
function escapeHtml(str) {
  return String(str || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function showToast(message, type = 'info') {
  const container = document.getElementById('toast-container');
  if (!container) return;

  const colors = {
    success: 'bg-emerald-600 border-emerald-400 text-white',
    error: 'bg-rose-600 border-rose-400 text-white',
    info: 'bg-slate-800 border-slate-600 text-slate-100'
  };

  const toast = document.createElement('div');
  toast.className = `px-4 py-3 rounded-xl border shadow-xl text-sm font-medium flex items-center gap-2.5 animate-pop-in ${colors[type] || colors.info}`;
  toast.textContent = message;

  container.appendChild(toast);
  setTimeout(() => {
    toast.style.opacity = '0';
    toast.style.transition = 'opacity 0.3s ease';
    setTimeout(() => toast.remove(), 300);
  }, 3500);
}
