/* ==========================================================================
   Lógica de la Vista de Escáner y Búsqueda (/escaner.html)
   ========================================================================== */

let html5QrScanner = null;
let isCameraRunning = false;
let scanCooldown = false;

document.addEventListener('DOMContentLoaded', () => {
  initScannerView();
  window.appStore.onChange(() => {
    refreshMiniCounter();
  });
});

async function initScannerView() {
  updateScannerHeader();
  await refreshMiniCounter();
  setupScannerListeners();
}

function updateScannerHeader() {
  const settings = window.appStore.settings;
  const eventTitle = document.getElementById('scanner-event-name');
  if (eventTitle) eventTitle.textContent = settings.eventName || 'Acreditación';

  const modeDot = document.getElementById('scanner-sync-indicator');
  if (modeDot) {
    if (window.appStore.isCloudActive()) {
      modeDot.className = 'inline-flex items-center gap-1.5 text-xs font-medium text-emerald-400';
      modeDot.innerHTML = `<span class="w-2 h-2 rounded-full bg-emerald-400 animate-pulse"></span> Nube Activa`;
    } else {
      modeDot.className = 'inline-flex items-center gap-1.5 text-xs font-medium text-amber-300';
      modeDot.innerHTML = `<span class="w-2 h-2 rounded-full bg-amber-400"></span> Modo Local`;
    }
  }
}

async function refreshMiniCounter() {
  try {
    const guests = await window.appStore.getAllGuests();
    const total = guests.length;
    const accredited = guests.filter((g) => g.acreditado).length;

    const counterEl = document.getElementById('scanner-live-counter');
    if (counterEl) {
      counterEl.textContent = `${accredited} / ${total}`;
    }
  } catch (_) {}
}

/* --------------------------------------------------------------------------
   Cámara Lector QR (Cédula de Identidad Chilena o QR de invitación)
   -------------------------------------------------------------------------- */
async function toggleCameraScanner() {
  const toggleBtn = document.getElementById('toggle-camera-btn');
  const readerWrapper = document.getElementById('camera-reader-wrapper');
  const laserEl = document.getElementById('scanner-laser-line');

  if (isCameraRunning && html5QrScanner) {
    try {
      await html5QrScanner.stop();
      html5QrScanner.clear();
    } catch (_) {}
    isCameraRunning = false;
    readerWrapper.classList.add('hidden');
    if (laserEl) laserEl.classList.add('hidden');
    toggleBtn.innerHTML = `
      <svg class="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
        <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M3 9a2 2 0 012-2h.93a2 2 0 001.664-.89l.812-1.22A2 2 0 0110.07 4h3.86a2 2 0 011.664.89l.812 1.22A2 2 0 0018.07 7H19a2 2 0 012 2v9a2 2 0 01-2 2H5a2 2 0 01-2-2V9z"/>
        <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M15 13a3 3 0 11-6 0 3 3 0 016 0z"/>
      </svg>
      <span>Activar Cámara para Escanear QR de Cédula</span>
    `;
    toggleBtn.className =
      'w-full py-3.5 px-5 rounded-xl font-semibold text-sm bg-sky-600 hover:bg-sky-500 text-white shadow-lg shadow-sky-600/25 flex items-center justify-center gap-2.5 transition';
    return;
  }

  // Iniciar cámara
  readerWrapper.classList.remove('hidden');
  if (!html5QrScanner) {
    html5QrScanner = new Html5Qrcode('qr-reader');
  }

  try {
    toggleBtn.disabled = true;
    toggleBtn.innerHTML = `<span>Iniciando cámara...</span>`;

    await html5QrScanner.start(
      { facingMode: 'environment' },
      {
        fps: 12,
        qrbox: { width: 250, height: 250 },
        aspectRatio: 1.0
      },
      onQrCodeScanned,
      () => {}
    );

    isCameraRunning = true;
    if (laserEl) laserEl.classList.remove('hidden');
    toggleBtn.disabled = false;
    toggleBtn.innerHTML = `
      <svg class="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
        <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M6 18L18 6M6 6l12 12"/>
      </svg>
      <span>Detener Cámara</span>
    `;
    toggleBtn.className =
      'w-full py-3 px-5 rounded-xl font-semibold text-sm bg-slate-800 hover:bg-slate-700 text-rose-400 border border-rose-500/30 flex items-center justify-center gap-2 transition';
  } catch (err) {
    toggleBtn.disabled = false;
    readerWrapper.classList.add('hidden');
    toggleBtn.innerHTML = `<span>Reintentar Activar Cámara</span>`;
    renderResultBanner({
      status: 'CAMERA_ERROR',
      message:
        'No se pudo acceder a la cámara. Asegúrate de dar permisos de cámara en el navegador o usa el buscador manual de abajo.'
    });
  }
}

async function onQrCodeScanned(decodedText) {
  if (scanCooldown) return;
  scanCooldown = true;

  await processRutCheckIn(decodedText);

  // Pequeña pausa de 2.2 segundos para evitar lecturas duplicadas del mismo QR en milisegundos
  setTimeout(() => {
    scanCooldown = false;
  }, 2200);
}

/* --------------------------------------------------------------------------
   Verificación y Acreditación de RUT (QR o Manual)
   -------------------------------------------------------------------------- */
async function processRutCheckIn(rawInput) {
  try {
    const result = await window.appStore.verifyAndAccreditByRut(rawInput);

    if (result.status === 'SUCCESS') {
      window.SoundEffects.playSuccess();
    } else {
      window.SoundEffects.playError();
    }

    renderResultBanner(result);
    await refreshMiniCounter();

    // Si hay una búsqueda activa en lista manual, refrescarla
    const searchInput = document.getElementById('manual-search-input');
    if (searchInput && searchInput.value.trim().length > 0) {
      await handleManualSearch(searchInput.value);
    }
  } catch (err) {
    window.SoundEffects.playError();
    renderResultBanner({
      status: 'ERROR',
      message: err.message || 'Ocurrió un error al verificar el invitado.'
    });
  }
}

window.accreditFromSearchResult = async function (rut) {
  await processRutCheckIn(rut);
};

/* --------------------------------------------------------------------------
   Renderizado de Alertas de Resultado (Verde / Roja YA ACREDITADO / Amarilla No encontrado)
   -------------------------------------------------------------------------- */
function renderResultBanner(result) {
  const container = document.getElementById('scan-result-container');
  if (!container) return;

  container.classList.remove('hidden');

  if (result.status === 'SUCCESS') {
    const guest = result.guest;
    const hora = window.formatTimeOnlyChile(guest.hora_acreditacion);
    container.innerHTML = `
      <div class="p-6 rounded-2xl bg-emerald-500/15 border-2 border-emerald-500 text-center shadow-2xl shadow-emerald-500/10 animate-pop-in">
        <div class="w-16 h-16 mx-auto mb-3 rounded-full bg-emerald-500 text-slate-950 flex items-center justify-center shadow-lg shadow-emerald-500/40">
          <svg class="w-10 h-10" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="3" d="M5 13l4 4L19 7"/>
          </svg>
        </div>
        <span class="inline-block px-3 py-0.5 rounded-full text-xs font-extrabold uppercase tracking-wider bg-emerald-500 text-slate-950 mb-2">
          Acceso Autorizado · Acreditado Ahora
        </span>
        <h2 class="text-2xl sm:text-3xl font-extrabold text-white tracking-tight mt-1">
          ${escapeHtml(guest.nombre)}
        </h2>
        <p class="font-mono text-lg font-semibold text-emerald-300 mt-1">
          RUT: ${escapeHtml(guest.rutDisplay || guest.rut)}
        </p>
        <p class="text-xs text-emerald-200/80 mt-2">
          Hora de ingreso registrada: <strong>${hora}</strong>
        </p>
      </div>
    `;
    return;
  }

  if (result.status === 'ALREADY_ACCREDITED') {
    const guest = result.guest;
    const prevTime = window.formatDateTimeChile(result.previousTime);
    container.innerHTML = `
      <div class="p-6 rounded-2xl bg-rose-500/20 border-2 border-rose-500 text-center shadow-2xl shadow-rose-500/20 animate-shake">
        <div class="w-16 h-16 mx-auto mb-3 rounded-full bg-rose-600 text-white flex items-center justify-center shadow-lg shadow-rose-600/40">
          <svg class="w-10 h-10" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2.5" d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z"/>
          </svg>
        </div>
        <span class="inline-block px-3 py-1 rounded-full text-xs font-extrabold uppercase tracking-wider bg-rose-600 text-white mb-2">
          ⛔ ALERTA: YA ACREDITADO ANTERIORMENTE
        </span>
        <h2 class="text-2xl sm:text-3xl font-extrabold text-white tracking-tight mt-1">
          ${escapeHtml(guest.nombre)}
        </h2>
        <p class="font-mono text-lg font-semibold text-rose-300 mt-1">
          RUT: ${escapeHtml(guest.rutDisplay || guest.rut)}
        </p>
        <div class="mt-3 inline-block px-4 py-2 rounded-xl bg-rose-950/80 border border-rose-500/40 text-sm text-rose-200">
          Ingresó previamente a las: <strong class="text-white">${prevTime}</strong>
        </div>
      </div>
    `;
    return;
  }

  if (result.status === 'NOT_FOUND') {
    container.innerHTML = `
      <div class="p-6 rounded-2xl bg-amber-500/15 border-2 border-amber-500 text-center shadow-xl animate-shake">
        <div class="w-14 h-14 mx-auto mb-3 rounded-full bg-amber-500 text-slate-950 flex items-center justify-center">
          <svg class="w-8 h-8" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2.5" d="M8.228 9c.549-1.165 2.03-2 3.772-2 2.21 0 4 1.343 4 3 0 1.4-1.278 2.575-3.006 2.907-.542.104-.994.54-.994 1.093m0 3h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z"/>
          </svg>
        </div>
        <span class="inline-block px-3 py-0.5 rounded-full text-xs font-extrabold uppercase tracking-wider bg-amber-500 text-slate-950 mb-2">
          No Registrado en Lista
        </span>
        <h3 class="text-xl font-bold text-white mt-1">
          RUT ${escapeHtml(result.rutDisplay || result.rutNorm)} no encontrado
        </h3>
        <p class="text-sm text-amber-200/80 mt-1">
          Esta persona no figura en el listado cargado en el sistema.
        </p>
      </div>
    `;
    return;
  }

  // Error genérico o entrada inválida
  container.innerHTML = `
    <div class="p-4 rounded-xl bg-rose-500/15 border border-rose-500/40 text-rose-200 text-sm text-center">
      ${escapeHtml(result.message || 'No se pudo reconocer un RUT válido en la lectura.')}
    </div>
  `;
}

/* --------------------------------------------------------------------------
   Búsqueda Manual Interactiva (Por RUT o por Nombre)
   -------------------------------------------------------------------------- */
async function handleManualSearch(queryText) {
  const resultsBox = document.getElementById('manual-search-results');
  const q = String(queryText || '').trim();

  if (!q) {
    resultsBox.innerHTML = `
      <div class="text-center py-8 text-slate-500 text-sm">
        Escribe un RUT (ej. <span class="font-mono text-slate-400">12345678-9</span>) o el nombre del invitado para buscarlo instantáneamente.
      </div>
    `;
    return;
  }

  try {
    const matches = await window.appStore.searchGuests(q);

    if (matches.length === 0) {
      resultsBox.innerHTML = `
        <div class="p-6 rounded-xl bg-slate-900/90 border border-slate-800 text-center">
          <p class="text-slate-300 font-medium">No se encontraron invitados para "${escapeHtml(q)}"</p>
          <p class="text-xs text-slate-500 mt-1">Verifica el RUT o agrégalo como Walk-in desde el panel /admin.</p>
        </div>
      `;
      return;
    }

    resultsBox.innerHTML = matches
      .map((guest) => {
        const badge = guest.acreditado
          ? `<span class="px-2.5 py-1 rounded-full text-xs font-bold bg-rose-500/20 text-rose-300 border border-rose-500/30">
               YA INGRESÓ (${window.formatTimeOnlyChile(guest.hora_acreditacion)})
             </span>`
          : `<span class="px-2.5 py-1 rounded-full text-xs font-bold bg-slate-800 text-slate-300 border border-slate-700">
               Pendiente
             </span>`;

        const actionBtn = guest.acreditado
          ? `<button onclick="accreditFromSearchResult('${guest.rut}')" class="px-4 py-2 rounded-xl text-xs font-bold bg-rose-600/20 hover:bg-rose-600/30 text-rose-300 border border-rose-500/40 transition">
               Ver Alerta
             </button>`
          : `<button onclick="accreditFromSearchResult('${guest.rut}')" class="px-4 py-2.5 rounded-xl text-sm font-bold bg-emerald-600 hover:bg-emerald-500 text-white shadow-lg shadow-emerald-600/25 transition">
               Acreditar Ingreso
             </button>`;

        return `
          <div class="p-4 rounded-xl bg-slate-900/90 border border-slate-800 hover:border-slate-700 flex flex-col sm:flex-row sm:items-center justify-between gap-3 transition">
            <div>
              <div class="flex items-center gap-2 flex-wrap">
                <span class="font-mono text-sm font-bold text-sky-400">${escapeHtml(guest.rutDisplay || guest.rut)}</span>
                ${badge}
              </div>
              <h4 class="text-base font-bold text-white mt-0.5">${escapeHtml(guest.nombre)}</h4>
            </div>
            <div class="flex-shrink-0">
              ${actionBtn}
            </div>
          </div>
        `;
      })
      .join('');
  } catch (err) {
    resultsBox.innerHTML = `<div class="text-rose-400 text-sm p-3">${escapeHtml(err.message)}</div>`;
  }
}

function setupScannerListeners() {
  const toggleCamBtn = document.getElementById('toggle-camera-btn');
  if (toggleCamBtn) {
    toggleCamBtn.addEventListener('click', toggleCameraScanner);
  }

  const searchInput = document.getElementById('manual-search-input');
  const directCheckinForm = document.getElementById('manual-search-form');

  if (searchInput) {
    searchInput.addEventListener('input', (e) => {
      handleManualSearch(e.target.value);
    });
  }

  // Si presionan Enter en el buscador (o usan pistola lectora USB), acredita o verifica directo
  if (directCheckinForm) {
    directCheckinForm.addEventListener('submit', async (e) => {
      e.preventDefault();
      const val = searchInput.value.trim();
      if (!val) return;

      // Si escribieron un RUT o escanearon URL de carnet, procesarlo directo
      const matches = await window.appStore.searchGuests(val);
      if (matches.length === 1) {
        await processRutCheckIn(matches[0].rut);
      } else {
        await processRutCheckIn(val);
      }
    });
  }
}

function escapeHtml(str) {
  return String(str || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}
