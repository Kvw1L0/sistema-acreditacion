/* ==========================================================================
   Sistema de Acreditación QR / RUT - Core Engine (Local + Supabase Cloud)
   ========================================================================== */

const STORAGE_KEYS = {
  GUESTS: 'acreditacion_guests_v1',
  SETTINGS: 'acreditacion_settings_v1',
  AUTH: 'acreditacion_admin_auth_v1'
};

const DEFAULT_SETTINGS = {
  eventName: 'Evento Corporativo 2026',
  adminPin: '1234',
  mode: 'local', // 'local' | 'supabase'
  supabaseUrl: '',
  supabaseKey: ''
};

class AccreditationStore {
  constructor() {
    this.settings = this.loadSettings();
    this.supabase = null;
    this.realtimeChannel = null;
    this.listeners = new Set();
    this.broadcastChannel = typeof BroadcastChannel !== 'undefined'
      ? new BroadcastChannel('acreditacion_sync_channel')
      : null;

    if (this.broadcastChannel) {
      this.broadcastChannel.onmessage = () => {
        this.notifyListeners();
      };
    }

    window.addEventListener('storage', (e) => {
      if (e.key === STORAGE_KEYS.GUESTS || e.key === STORAGE_KEYS.SETTINGS) {
        this.settings = this.loadSettings();
        this.notifyListeners();
      }
    });

    this.initCloudClient();
  }

  /* --------------------------------------------------------------------------
     Utilidades de RUT Chileno y Escáner Cédula
     -------------------------------------------------------------------------- */

  /**
   * Extrae o limpia un RUT desde cualquier texto (incluyendo URL de QR de Cédula Chilena)
   * Ejemplo URL Registro Civil: https://portal.sidiv.registrocivil.cl/docstatus?RUN=12345678-9&type=CEDULA...
   */
  static extractRutFromInput(rawInput) {
    if (!rawInput) return '';
    const text = String(rawInput).trim();

    // 1. Intentar extraer parámetro RUN= o run= desde URL del Registro Civil
    try {
      if (text.includes('RUN=') || text.includes('run=') || text.startsWith('http')) {
        const matchRun = text.match(/[?&]run=([0-9kK.\-]+)/i);
        if (matchRun && matchRun[1]) {
          return AccreditationStore.normalizeRut(matchRun[1]);
        }
      }
    } catch (_) {
      // Fallback a regex general
    }

    // 2. Buscar patrón de RUT chileno dentro del texto (ej: 12.345.678-9 o 12345678-K)
    const rutPattern = /\b(\d{1,2}\.?\d{3}\.?\d{3}-?[\dkK])\b/;
    const matchPattern = text.match(rutPattern);
    if (matchPattern && matchPattern[1]) {
      return AccreditationStore.normalizeRut(matchPattern[1]);
    }

    // 3. Limpieza directa
    return AccreditationStore.normalizeRut(text);
  }

  /**
   * Normaliza un RUT al formato sin puntos y con guion en mayúscula: "12345678-K"
   * Si tiene entre 7 y 9 caracteres alfanuméricos sin guion, inserta el guion antes del último carácter.
   */
  static normalizeRut(rut) {
    if (!rut) return '';
    let clean = String(rut).toUpperCase().replace(/[^0-9K]/g, '');
    if (clean.length < 2) return clean;
    const body = clean.slice(0, -1).replace(/^0+/, ''); // Quitar ceros a la izquierda
    const dv = clean.slice(-1);
    if (!body) return clean;
    return `${body}-${dv}`;
  }

  /**
   * Formatea un RUT para visualización amigable: "12.345.678-K"
   */
  static formatRutDisplay(rut) {
    const normalized = AccreditationStore.normalizeRut(rut);
    if (!normalized || !normalized.includes('-')) return rut || '';
    const [body, dv] = normalized.split('-');
    const formattedBody = body.replace(/\B(?=(\d{3})+(?!\d))/g, '.');
    return `${formattedBody}-${dv}`;
  }

  /**
   * Valida matemáticamente un RUT chileno (Módulo 11)
   */
  static validateRut(rut) {
    const normalized = AccreditationStore.normalizeRut(rut);
    if (!normalized || !/^\d{6,8}-[\dK]$/.test(normalized)) return false;
    const [body, dv] = normalized.split('-');
    let sum = 0;
    let multiplier = 2;
    for (let i = body.length - 1; i >= 0; i--) {
      sum += parseInt(body.charAt(i), 10) * multiplier;
      multiplier = multiplier === 7 ? 2 : multiplier + 1;
    }
    const expected = 11 - (sum % 11);
    const calculatedDv = expected === 11 ? '0' : expected === 10 ? 'K' : String(expected);
    return calculatedDv === dv;
  }

  /* --------------------------------------------------------------------------
     Configuración & Autenticación
     -------------------------------------------------------------------------- */

  loadSettings() {
    try {
      const saved = localStorage.getItem(STORAGE_KEYS.SETTINGS);
      if (saved) {
        return { ...DEFAULT_SETTINGS, ...JSON.parse(saved) };
      }
    } catch (e) {
      console.error('Error cargando configuración:', e);
    }
    return { ...DEFAULT_SETTINGS };
  }

  saveSettings(newSettings) {
    this.settings = { ...this.settings, ...newSettings };
    localStorage.setItem(STORAGE_KEYS.SETTINGS, JSON.stringify(this.settings));
    this.initCloudClient();
    this.broadcastChange();
    return this.settings;
  }

  isAdminAuthenticated() {
    return sessionStorage.getItem(STORAGE_KEYS.AUTH) === 'true';
  }

  loginAdmin(pin) {
    if (String(pin).trim() === String(this.settings.adminPin).trim()) {
      sessionStorage.setItem(STORAGE_KEYS.AUTH, 'true');
      return true;
    }
    return false;
  }

  logoutAdmin() {
    sessionStorage.removeItem(STORAGE_KEYS.AUTH);
  }

  /* --------------------------------------------------------------------------
     Inicialización de Nube (Supabase)
     -------------------------------------------------------------------------- */

  initCloudClient() {
    if (this.realtimeChannel && this.supabase) {
      try {
        this.supabase.removeChannel(this.realtimeChannel);
      } catch (_) {}
      this.realtimeChannel = null;
    }

    if (
      this.settings.mode === 'supabase' &&
      this.settings.supabaseUrl &&
      this.settings.supabaseKey &&
      typeof window.supabase !== 'undefined'
    ) {
      try {
        this.supabase = window.supabase.createClient(
          this.settings.supabaseUrl.trim(),
          this.settings.supabaseKey.trim()
        );

        // Suscripción en tiempo real a cambios en la tabla 'invitados'
        this.realtimeChannel = this.supabase
          .channel('invitados_realtime')
          .on(
            'postgres_changes',
            { event: '*', schema: 'public', table: 'invitados' },
            () => {
              this.notifyListeners();
            }
          )
          .subscribe();
      } catch (err) {
        console.error('Error inicializando cliente Supabase:', err);
        this.supabase = null;
      }
    } else {
      this.supabase = null;
    }
  }

  isCloudActive() {
    return this.settings.mode === 'supabase' && this.supabase !== null;
  }

  onChange(callback) {
    this.listeners.add(callback);
    return () => this.listeners.delete(callback);
  }

  notifyListeners() {
    this.listeners.forEach((cb) => {
      try {
        cb();
      } catch (e) {
        console.error(e);
      }
    });
  }

  broadcastChange() {
    if (this.broadcastChannel) {
      this.broadcastChannel.postMessage({ updatedAt: Date.now() });
    }
    this.notifyListeners();
  }

  /* --------------------------------------------------------------------------
     Operaciones CRUD de Invitados (Híbrido LocalStorage / Supabase)
     -------------------------------------------------------------------------- */

  getLocalGuests() {
    try {
      const raw = localStorage.getItem(STORAGE_KEYS.GUESTS);
      return raw ? JSON.parse(raw) : [];
    } catch (e) {
      console.error('Error leyendo invitados locales:', e);
      return [];
    }
  }

  saveLocalGuests(guests) {
    localStorage.setItem(STORAGE_KEYS.GUESTS, JSON.stringify(guests));
    this.broadcastChange();
  }

  async getAllGuests() {
    if (this.isCloudActive()) {
      const { data, error } = await this.supabase
        .from('invitados')
        .select('*')
        .order('nombre', { ascending: true });

      if (error) {
        throw new Error(`Error Supabase (${error.code || ''}): ${error.message}`);
      }
      return (data || []).map(this.mapRowToGuest);
    }

    const guests = this.getLocalGuests();
    return guests.sort((a, b) => (a.nombre || '').localeCompare(b.nombre || ''));
  }

  mapRowToGuest(row) {
    return {
      rut: AccreditationStore.normalizeRut(row.rut),
      rutDisplay: AccreditationStore.formatRutDisplay(row.rut),
      nombre: row.nombre || '',
      acreditado: Boolean(row.acreditado),
      hora_acreditacion: row.hora_acreditacion || null,
      origen: row.origen || 'excel'
    };
  }

  /**
   * Carga masiva de invitados desde Excel/CSV.
   * Si merge=true, preserva el estado de acreditación de los RUTs que ya estaban acreditados.
   */
  async bulkUpsertGuests(guestList, { replaceAll = false } = {}) {
    const normalizedMap = new Map();

    for (const item of guestList) {
      const rutNorm = AccreditationStore.normalizeRut(item.rut);
      const nombreClean = String(item.nombre || '').trim();
      if (!rutNorm || !nombreClean) continue;

      normalizedMap.set(rutNorm, {
        rut: rutNorm,
        nombre: nombreClean,
        acreditado: Boolean(item.acreditado),
        hora_acreditacion: item.hora_acreditacion || null,
        origen: item.origen || 'excel'
      });
    }

    const incoming = Array.from(normalizedMap.values());

    if (this.isCloudActive()) {
      if (replaceAll) {
        const { error: delError } = await this.supabase
          .from('invitados')
          .delete()
          .neq('rut', '__NONE__');
        if (delError) throw new Error(`Error limpiando base en nube: ${delError.message}`);
      } else {
        // Obtener existentes para no sobreescribir acreditados previos
        const existing = await this.getAllGuests();
        const existingMap = new Map(existing.map((g) => [g.rut, g]));
        for (const g of incoming) {
          const prev = existingMap.get(g.rut);
          if (prev && prev.acreditado) {
            g.acreditado = true;
            g.hora_acreditacion = prev.hora_acreditacion;
          }
        }
      }

      // Insertar en lotes de 500 para evitar límites de payload
      const batchSize = 500;
      for (let i = 0; i < incoming.length; i += batchSize) {
        const chunk = incoming.slice(i, i + batchSize);
        const { error } = await this.supabase
          .from('invitados')
          .upsert(chunk, { onConflict: 'rut' });
        if (error) throw new Error(`Error subiendo lote a Supabase: ${error.message}`);
      }

      this.broadcastChange();
      return incoming.length;
    }

    // Modo Local
    let current = replaceAll ? [] : this.getLocalGuests();
    const map = new Map(current.map((g) => [AccreditationStore.normalizeRut(g.rut), g]));

    for (const g of incoming) {
      const prev = map.get(g.rut);
      if (prev && prev.acreditado && !replaceAll) {
        map.set(g.rut, {
          ...g,
          acreditado: true,
          hora_acreditacion: prev.hora_acreditacion
        });
      } else {
        map.set(g.rut, g);
      }
    }

    const finalArray = Array.from(map.values());
    this.saveLocalGuests(finalArray);
    return incoming.length;
  }

  /**
   * Agrega un invitado puntual ("Walk-in") y opcionalmente lo acredita de inmediato
   */
  async addWalkInGuest({ rut, nombre, accreditImmediately = true }) {
    const rutNorm = AccreditationStore.normalizeRut(rut);
    const nombreClean = String(nombre || '').trim();

    if (!rutNorm || rutNorm.length < 3) {
      throw new Error('Por favor ingresa un RUT válido.');
    }
    if (!nombreClean) {
      throw new Error('Por favor ingresa el nombre completo del invitado.');
    }

    const nowIso = new Date().toISOString();
    const newGuest = {
      rut: rutNorm,
      nombre: nombreClean,
      acreditado: Boolean(accreditImmediately),
      hora_acreditacion: accreditImmediately ? nowIso : null,
      origen: 'walk-in'
    };

    if (this.isCloudActive()) {
      const { data: existing } = await this.supabase
        .from('invitados')
        .select('*')
        .eq('rut', rutNorm)
        .maybeSingle();

      if (existing) {
        throw new Error(`El RUT ${AccreditationStore.formatRutDisplay(rutNorm)} ya existe en la lista (${existing.nombre}).`);
      }

      const { error } = await this.supabase.from('invitados').insert([newGuest]);
      if (error) throw new Error(`Error al guardar en nube: ${error.message}`);
      this.broadcastChange();
      return this.mapRowToGuest(newGuest);
    }

    const guests = this.getLocalGuests();
    const exists = guests.find((g) => AccreditationStore.normalizeRut(g.rut) === rutNorm);
    if (exists) {
      throw new Error(`El RUT ${AccreditationStore.formatRutDisplay(rutNorm)} ya existe en la lista (${exists.nombre}).`);
    }

    guests.push(newGuest);
    this.saveLocalGuests(guests);
    return this.mapRowToGuest(newGuest);
  }

  /**
   * Cambia el estado de acreditación manualmente desde /admin
   */
  async setAccreditationStatus(rut, status) {
    const rutNorm = AccreditationStore.normalizeRut(rut);
    const nowIso = status ? new Date().toISOString() : null;

    if (this.isCloudActive()) {
      const { error } = await this.supabase
        .from('invitados')
        .update({ acreditado: Boolean(status), hora_acreditacion: nowIso })
        .eq('rut', rutNorm);

      if (error) throw new Error(`Error actualizando estado: ${error.message}`);
      this.broadcastChange();
      return;
    }

    const guests = this.getLocalGuests();
    const idx = guests.findIndex((g) => AccreditationStore.normalizeRut(g.rut) === rutNorm);
    if (idx === -1) throw new Error('Invitado no encontrado.');

    guests[idx].acreditado = Boolean(status);
    guests[idx].hora_acreditacion = nowIso;
    this.saveLocalGuests(guests);
  }

  /**
   * Elimina un invitado puntual
   */
  async deleteGuest(rut) {
    const rutNorm = AccreditationStore.normalizeRut(rut);
    if (this.isCloudActive()) {
      const { error } = await this.supabase.from('invitados').delete().eq('rut', rutNorm);
      if (error) throw new Error(`Error eliminando invitado: ${error.message}`);
      this.broadcastChange();
      return;
    }
    const guests = this.getLocalGuests().filter(
      (g) => AccreditationStore.normalizeRut(g.rut) !== rutNorm
    );
    this.saveLocalGuests(guests);
  }

  /**
   * Elimina toda la base de datos de invitados
   */
  async clearAllGuests() {
    if (this.isCloudActive()) {
      const { error } = await this.supabase.from('invitados').delete().neq('rut', '__NONE__');
      if (error) throw new Error(`Error vaciando tabla en nube: ${error.message}`);
      this.broadcastChange();
      return;
    }
    this.saveLocalGuests([]);
  }

  /**
   * Proceso de escaneo / verificación en /escaner.html
   * Retorna:
   * - { status: 'SUCCESS', guest } -> Recién acreditado con éxito
   * - { status: 'ALREADY_ACCREDITED', guest, previousTime } -> Bloqueado: ya había ingresado antes
   * - { status: 'NOT_FOUND', rutNorm, rutDisplay } -> No está en la lista
   */
  async verifyAndAccreditByRut(rawInput) {
    const rutNorm = AccreditationStore.extractRutFromInput(rawInput);
    const rutDisplay = AccreditationStore.formatRutDisplay(rutNorm);

    if (!rutNorm || rutNorm.length < 3) {
      return { status: 'INVALID_INPUT', rawInput };
    }

    if (this.isCloudActive()) {
      // Buscar exactamente por RUT normalizado o sin dígito verificador si el carnet/lector varía
      const { data: exactMatch, error } = await this.supabase
        .from('invitados')
        .select('*')
        .eq('rut', rutNorm)
        .maybeSingle();

      if (error) throw new Error(`Error consultando nube: ${error.message}`);

      let target = exactMatch;

      // Si no hubo match exacto, probar match por cuerpo de RUT (por si el Excel tenía otro DV o formato)
      if (!target && rutNorm.includes('-')) {
        const bodyOnly = rutNorm.split('-')[0];
        const { data: likeMatches } = await this.supabase
          .from('invitados')
          .select('*')
          .ilike('rut', `${bodyOnly}-%`)
          .limit(1);
        if (likeMatches && likeMatches.length > 0) {
          target = likeMatches[0];
        }
      }

      if (!target) {
        return { status: 'NOT_FOUND', rutNorm, rutDisplay };
      }

      if (target.acreditado) {
        return {
          status: 'ALREADY_ACCREDITED',
          guest: this.mapRowToGuest(target),
          previousTime: target.hora_acreditacion
        };
      }

      const nowIso = new Date().toISOString();
      const { data: updated, error: updateError } = await this.supabase
        .from('invitados')
        .update({ acreditado: true, hora_acreditacion: nowIso })
        .eq('rut', target.rut)
        .select()
        .single();

      if (updateError) throw new Error(`Error acreditando en nube: ${updateError.message}`);
      this.broadcastChange();

      return {
        status: 'SUCCESS',
        guest: this.mapRowToGuest(updated)
      };
    }

    // Modo Local
    const guests = this.getLocalGuests();
    const bodyOnly = rutNorm.split('-')[0];

    let idx = guests.findIndex((g) => AccreditationStore.normalizeRut(g.rut) === rutNorm);
    if (idx === -1 && bodyOnly.length >= 6) {
      idx = guests.findIndex(
        (g) => AccreditationStore.normalizeRut(g.rut).split('-')[0] === bodyOnly
      );
    }

    if (idx === -1) {
      return { status: 'NOT_FOUND', rutNorm, rutDisplay };
    }

    const found = guests[idx];
    if (found.acreditado) {
      return {
        status: 'ALREADY_ACCREDITED',
        guest: this.mapRowToGuest(found),
        previousTime: found.hora_acreditacion
      };
    }

    const nowIso = new Date().toISOString();
    guests[idx].acreditado = true;
    guests[idx].hora_acreditacion = nowIso;
    this.saveLocalGuests(guests);

    return {
      status: 'SUCCESS',
      guest: this.mapRowToGuest(guests[idx])
    };
  }

  /**
   * Búsqueda por texto (RUT o Nombre parcial) para el buscador manual de /escaner.html
   */
  async searchGuests(query) {
    const q = String(query || '').trim().toLowerCase();
    if (!q) return [];

    const qRut = AccreditationStore.normalizeRut(q).toLowerCase();
    const qDigits = q.replace(/[^0-9k]/g, '');

    const all = await this.getAllGuests();
    return all
      .filter((g) => {
        const nombreMatch = (g.nombre || '').toLowerCase().includes(q);
        const rutClean = g.rut.toLowerCase();
        const rutDigits = rutClean.replace(/[^0-9k]/g, '');
        const rutMatch =
          rutClean.includes(q) ||
          (qRut && rutClean.includes(qRut)) ||
          (qDigits.length >= 3 && rutDigits.includes(qDigits));
        return nombreMatch || rutMatch;
      })
      .slice(0, 25);
  }
}

/* --------------------------------------------------------------------------
   Utilidades de Sonido (Feedback auditivo para el escáner sin archivos externos)
   -------------------------------------------------------------------------- */
class SoundEffects {
  static getContext() {
    if (!this.ctx && typeof window !== 'undefined') {
      const AudioCtx = window.AudioContext || window.webkitAudioContext;
      if (AudioCtx) this.ctx = new AudioCtx();
    }
    if (this.ctx && this.ctx.state === 'suspended') {
      this.ctx.resume();
    }
    return this.ctx;
  }

  static playSuccess() {
    try {
      const ctx = this.getContext();
      if (!ctx) return;
      const now = ctx.currentTime;
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = 'sine';
      osc.frequency.setValueAtTime(587.33, now); // D5
      osc.frequency.setValueAtTime(880, now + 0.1); // A5
      gain.gain.setValueAtTime(0.2, now);
      gain.gain.exponentialRampToValueAtTime(0.001, now + 0.35);
      osc.connect(gain);
      gain.connect(ctx.destination);
      osc.start(now);
      osc.stop(now + 0.35);
    } catch (_) {}
  }

  static playError() {
    try {
      const ctx = this.getContext();
      if (!ctx) return;
      const now = ctx.currentTime;
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = 'sawtooth';
      osc.frequency.setValueAtTime(220, now);
      osc.frequency.setValueAtTime(160, now + 0.15);
      gain.gain.setValueAtTime(0.25, now);
      gain.gain.exponentialRampToValueAtTime(0.001, now + 0.45);
      osc.connect(gain);
      gain.connect(ctx.destination);
      osc.start(now);
      osc.stop(now + 0.45);
    } catch (_) {}
  }
}

/* --------------------------------------------------------------------------
   Formateo de Fecha / Hora
   -------------------------------------------------------------------------- */
function formatDateTimeChile(isoString) {
  if (!isoString) return '—';
  try {
    const date = new Date(isoString);
    return date.toLocaleString('es-CL', {
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      day: '2-digit',
      month: '2-digit',
      year: 'numeric'
    });
  } catch (_) {
    return isoString;
  }
}

function formatTimeOnlyChile(isoString) {
  if (!isoString) return '—';
  try {
    const date = new Date(isoString);
    return date.toLocaleTimeString('es-CL', {
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit'
    });
  } catch (_) {
    return isoString;
  }
}

// Instancia global
window.appStore = new AccreditationStore();
window.AccreditationStore = AccreditationStore;
window.SoundEffects = SoundEffects;
window.formatDateTimeChile = formatDateTimeChile;
window.formatTimeOnlyChile = formatTimeOnlyChile;
