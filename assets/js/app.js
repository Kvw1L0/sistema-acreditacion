/* ==========================================================================
   Sistema de Acreditación QR / RUT - Core Engine (Local + Firebase + Supabase)
   ========================================================================== */

const STORAGE_KEYS = {
  GUESTS: 'acreditacion_guests_v1',
  SETTINGS: 'acreditacion_settings_v1',
  AUTH: 'acreditacion_admin_auth_v1'
};

const DEFAULT_SETTINGS = {
  eventName: 'Evento Corporativo 2026',
  adminPin: '1234',
  mode: 'local', // 'local' | 'firebase' | 'supabase'
  firebaseApiKey: '',
  firebaseProjectId: '',
  firebaseAppId: '',
  firebaseCollection: 'acreditacion_invitados',
  supabaseUrl: '',
  supabaseKey: ''
};

class AccreditationStore {
  constructor() {
    this.settings = this.loadSettings();
    this.supabase = null;
    this.realtimeChannel = null;

    this.firebaseApp = null;
    this.firestoreDb = null;
    this.firebaseUnsubscribe = null;

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

  static extractRutFromInput(rawInput) {
    if (!rawInput) return '';
    const text = String(rawInput).trim();

    try {
      if (text.includes('RUN=') || text.includes('run=') || text.startsWith('http')) {
        const matchRun = text.match(/[?&]run=([0-9kK.\-]+)/i);
        if (matchRun && matchRun[1]) {
          return AccreditationStore.normalizeRut(matchRun[1]);
        }
      }
    } catch (_) {}

    const rutPattern = /\b(\d{1,2}\.?\d{3}\.?\d{3}-?[\dkK])\b/;
    const matchPattern = text.match(rutPattern);
    if (matchPattern && matchPattern[1]) {
      return AccreditationStore.normalizeRut(matchPattern[1]);
    }

    return AccreditationStore.normalizeRut(text);
  }

  static normalizeRut(rut) {
    if (!rut) return '';
    let str = String(rut).trim().toUpperCase();
    // Si tiene guion explícito, separar cuerpo y DV
    if (str.includes('-')) {
      const parts = str.split('-');
      const body = parts[0].replace(/[^0-9]/g, '').replace(/^0+/, '');
      const dv = (parts[1] || '').replace(/[^0-9K]/g, '').slice(0, 1);
      if (body && dv) return `${body}-${dv}`;
      if (body) return body;
    }

    let clean = str.replace(/[^0-9K]/g, '').replace(/^0+/, '');
    if (clean.length < 2) return clean;
    const body = clean.slice(0, -1);
    const dv = clean.slice(-1);
    if (!body) return clean;
    return `${body}-${dv}`;
  }

  static looksLikeRut(val) {
    if (!val) return false;
    const str = String(val).trim();
    if (/^\d{1,2}\.?\d{3}\.?\d{3}-?[\dkK]$/.test(str)) return true;
    const clean = str.toUpperCase().replace(/[^0-9K]/g, '');
    return /^\d{6,8}[\dK]$/.test(clean);
  }

  static isSameRut(rutA, rutB) {
    if (!rutA || !rutB) return false;
    const normA = AccreditationStore.normalizeRut(rutA);
    const normB = AccreditationStore.normalizeRut(rutB);
    if (normA === normB) return true;

    const cleanA = normA.replace(/[^0-9K]/g, '');
    const cleanB = normB.replace(/[^0-9K]/g, '');
    if (cleanA === cleanB) return true;

    const bodyA = normA.split('-')[0];
    const bodyB = normB.split('-')[0];
    // Si en el Excel venía el RUT sin dígito verificador (ej. 12345678 -> normalizado a 1234567-8)
    // comparar cleanA con bodyB y viceversa
    if (cleanA.length >= 6 && (cleanA === bodyB || cleanB === bodyA || bodyA === bodyB)) {
      return true;
    }
    return false;
  }

  static formatRutDisplay(rut) {
    const normalized = AccreditationStore.normalizeRut(rut);
    if (!normalized || !normalized.includes('-')) return rut || '';
    const [body, dv] = normalized.split('-');
    const formattedBody = body.replace(/\B(?=(\d{3})+(?!\d))/g, '.');
    return `${formattedBody}-${dv}`;
  }

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
     Inicialización de Nube (Firebase Firestore & Supabase)
     -------------------------------------------------------------------------- */

  initCloudClient() {
    // Limpiar suscripciones previas
    if (this.realtimeChannel && this.supabase) {
      try {
        this.supabase.removeChannel(this.realtimeChannel);
      } catch (_) {}
      this.realtimeChannel = null;
    }
    if (this.firebaseUnsubscribe) {
      try {
        this.firebaseUnsubscribe();
      } catch (_) {}
      this.firebaseUnsubscribe = null;
    }

    this.supabase = null;
    this.firestoreDb = null;

    // 1. Modo Firebase Firestore
    if (
      this.settings.mode === 'firebase' &&
      this.settings.firebaseApiKey &&
      this.settings.firebaseProjectId &&
      typeof window.firebase !== 'undefined'
    ) {
      try {
        const projectId = this.settings.firebaseProjectId.trim();
        const firebaseConfig = {
          apiKey: this.settings.firebaseApiKey.trim(),
          authDomain: `${projectId}.firebaseapp.com`,
          projectId: projectId,
          storageBucket: `${projectId}.firebasestorage.app`,
          appId: (this.settings.firebaseAppId || '').trim() || undefined
        };

        if (!window.firebase.apps.length) {
          this.firebaseApp = window.firebase.initializeApp(firebaseConfig);
        } else {
          this.firebaseApp = window.firebase.app();
        }

        this.firestoreDb = window.firebase.firestore();
        const colName = this.getFirebaseCollectionName();

        this.firebaseUnsubscribe = this.firestoreDb
          .collection(colName)
          .onSnapshot(
            () => {
              this.notifyListeners();
            },
            (err) => {
              console.warn('Firestore listener warning:', err.message);
            }
          );
      } catch (err) {
        console.error('Error inicializando Firebase Firestore:', err);
        this.firestoreDb = null;
      }
      return;
    }

    // 2. Modo Supabase
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
    }
  }

  getFirebaseCollectionName() {
    return (this.settings.firebaseCollection || 'acreditacion_invitados').trim();
  }

  isFirebaseActive() {
    return this.settings.mode === 'firebase' && this.firestoreDb !== null;
  }

  isSupabaseActive() {
    return this.settings.mode === 'supabase' && this.supabase !== null;
  }

  isCloudActive() {
    return this.isFirebaseActive() || this.isSupabaseActive();
  }

  getActiveCloudProviderLabel() {
    if (this.isFirebaseActive()) return 'Firebase Firestore';
    if (this.isSupabaseActive()) return 'Supabase';
    return 'Local';
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
     Operaciones CRUD de Invitados (Híbrido LocalStorage / Firebase / Supabase)
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
    if (this.isFirebaseActive()) {
      const colName = this.getFirebaseCollectionName();
      const snap = await this.firestoreDb.collection(colName).get();
      const list = [];
      snap.forEach((docSnap) => {
        list.push(this.mapRowToGuest({ rut: docSnap.id, ...docSnap.data() }));
      });
      return list.sort((a, b) => (a.nombre || '').localeCompare(b.nombre || ''));
    }

    if (this.isSupabaseActive()) {
      const { data, error } = await this.supabase
        .from('invitados')
        .select('*')
        .order('nombre', { ascending: true });

      if (error) {
        throw new Error(`Error Supabase (${error.code || ''}): ${error.message}`);
      }
      return (data || []).map(this.mapRowToGuest);
    }

    const guests = this.getLocalGuests().map(this.mapRowToGuest);
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

    // 1. Firebase Firestore
    if (this.isFirebaseActive()) {
      const colRef = this.firestoreDb.collection(this.getFirebaseCollectionName());
      const existing = await this.getAllGuests();
      const existingMap = new Map(existing.map((g) => [g.rut, g]));

      if (replaceAll && existing.length > 0) {
        await this.clearAllGuests();
      } else {
        for (const g of incoming) {
          const prev = existingMap.get(g.rut);
          if (prev && prev.acreditado) {
            g.acreditado = true;
            g.hora_acreditacion = prev.hora_acreditacion;
          }
        }
      }

      // Firestore batch limit is 500 operations
      const batchSize = 450;
      for (let i = 0; i < incoming.length; i += batchSize) {
        const chunk = incoming.slice(i, i + batchSize);
        const batch = this.firestoreDb.batch();
        for (const guest of chunk) {
          const docRef = colRef.doc(guest.rut);
          batch.set(docRef, guest, { merge: true });
        }
        await batch.commit();
      }

      this.broadcastChange();
      return incoming.length;
    }

    // 2. Supabase
    if (this.isSupabaseActive()) {
      if (replaceAll) {
        const { error: delError } = await this.supabase
          .from('invitados')
          .delete()
          .neq('rut', '__NONE__');
        if (delError) throw new Error(`Error limpiando base en nube: ${delError.message}`);
      } else {
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

    // 3. Modo Local
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
   * Agrega un invitado puntual ("Walk-in")
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

    if (this.isFirebaseActive()) {
      const docRef = this.firestoreDb
        .collection(this.getFirebaseCollectionName())
        .doc(rutNorm);
      const snap = await docRef.get();
      if (snap.exists) {
        const existing = snap.data();
        throw new Error(
          `El RUT ${AccreditationStore.formatRutDisplay(rutNorm)} ya existe en la lista (${existing.nombre}).`
        );
      }
      await docRef.set(newGuest);
      this.broadcastChange();
      return this.mapRowToGuest(newGuest);
    }

    if (this.isSupabaseActive()) {
      const { data: existing } = await this.supabase
        .from('invitados')
        .select('*')
        .eq('rut', rutNorm)
        .maybeSingle();

      if (existing) {
        throw new Error(
          `El RUT ${AccreditationStore.formatRutDisplay(rutNorm)} ya existe en la lista (${existing.nombre}).`
        );
      }

      const { error } = await this.supabase.from('invitados').insert([newGuest]);
      if (error) throw new Error(`Error al guardar en nube: ${error.message}`);
      this.broadcastChange();
      return this.mapRowToGuest(newGuest);
    }

    const guests = this.getLocalGuests();
    const exists = guests.find((g) => AccreditationStore.normalizeRut(g.rut) === rutNorm);
    if (exists) {
      throw new Error(
        `El RUT ${AccreditationStore.formatRutDisplay(rutNorm)} ya existe en la lista (${exists.nombre}).`
      );
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

    if (this.isFirebaseActive()) {
      const docRef = this.firestoreDb
        .collection(this.getFirebaseCollectionName())
        .doc(rutNorm);
      await docRef.update({
        acreditado: Boolean(status),
        hora_acreditacion: nowIso
      });
      this.broadcastChange();
      return;
    }

    if (this.isSupabaseActive()) {
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
    if (this.isFirebaseActive()) {
      await this.firestoreDb
        .collection(this.getFirebaseCollectionName())
        .doc(rutNorm)
        .delete();
      this.broadcastChange();
      return;
    }

    if (this.isSupabaseActive()) {
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
    if (this.isFirebaseActive()) {
      const colRef = this.firestoreDb.collection(this.getFirebaseCollectionName());
      const snap = await colRef.get();
      const docs = snap.docs;
      const batchSize = 450;
      for (let i = 0; i < docs.length; i += batchSize) {
        const chunk = docs.slice(i, i + batchSize);
        const batch = this.firestoreDb.batch();
        chunk.forEach((d) => batch.delete(d.ref));
        await batch.commit();
      }
      this.broadcastChange();
      return;
    }

    if (this.isSupabaseActive()) {
      const { error } = await this.supabase.from('invitados').delete().neq('rut', '__NONE__');
      if (error) throw new Error(`Error vaciando tabla en nube: ${error.message}`);
      this.broadcastChange();
      return;
    }
    this.saveLocalGuests([]);
  }

  /**
   * Proceso de escaneo / verificación en /escaner.html
   */
  async verifyAndAccreditByRut(rawInput) {
    const rutNorm = AccreditationStore.extractRutFromInput(rawInput);
    const rutDisplay = AccreditationStore.formatRutDisplay(rutNorm);

    if (!rutNorm || rutNorm.length < 3) {
      return { status: 'INVALID_INPUT', rawInput };
    }

    // 1. Firebase Firestore
    if (this.isFirebaseActive()) {
      const colRef = this.firestoreDb.collection(this.getFirebaseCollectionName());
      let docSnap = await colRef.doc(rutNorm).get();
      let targetData = docSnap.exists ? { rut: docSnap.id, ...docSnap.data() } : null;

      // Fallback por cuerpo del RUT o coincidencia flexible
      if (!targetData) {
        const allGuests = await this.getAllGuests();
        const fallback = allGuests.find((g) => AccreditationStore.isSameRut(g.rut, rutNorm));
        if (fallback) {
          targetData = fallback;
        }
      }

      if (!targetData) {
        return { status: 'NOT_FOUND', rutNorm, rutDisplay };
      }

      if (targetData.acreditado) {
        return {
          status: 'ALREADY_ACCREDITED',
          guest: this.mapRowToGuest(targetData),
          previousTime: targetData.hora_acreditacion
        };
      }

      const nowIso = new Date().toISOString();
      await colRef.doc(targetData.rut).update({
        acreditado: true,
        hora_acreditacion: nowIso
      });

      this.broadcastChange();
      return {
        status: 'SUCCESS',
        guest: this.mapRowToGuest({
          ...targetData,
          acreditado: true,
          hora_acreditacion: nowIso
        })
      };
    }

    // 2. Supabase
    if (this.isSupabaseActive()) {
      const { data: exactMatch, error } = await this.supabase
        .from('invitados')
        .select('*')
        .eq('rut', rutNorm)
        .maybeSingle();

      if (error) throw new Error(`Error consultando nube: ${error.message}`);

      let target = exactMatch;

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

    // 3. Modo Local
    const guests = this.getLocalGuests();
    let idx = guests.findIndex((g) => AccreditationStore.isSameRut(g.rut, rutNorm));

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

    const qNorm = q.normalize('NFD').replace(/[\u0300-\u036f]/g, '');
    const qRut = AccreditationStore.normalizeRut(q).toLowerCase();
    const qDigits = q.replace(/[^0-9k]/g, '');

    const all = await this.getAllGuests();
    return all
      .filter((g) => {
        const nombreNorm = (g.nombre || '')
          .toLowerCase()
          .normalize('NFD')
          .replace(/[\u0300-\u036f]/g, '');
        const nombreMatch = nombreNorm.includes(qNorm);

        const rutClean = g.rut.toLowerCase();
        const rutDigits = rutClean.replace(/[^0-9k]/g, '');
        const rutMatch =
          AccreditationStore.isSameRut(g.rut, q) ||
          rutClean.includes(q) ||
          (qRut && rutClean.includes(qRut)) ||
          (qDigits.length >= 2 && rutDigits.includes(qDigits));
        return nombreMatch || rutMatch;
      })
      .slice(0, 25);
  }
}

/* --------------------------------------------------------------------------
   Utilidades de Sonido
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
      osc.frequency.setValueAtTime(587.33, now);
      osc.frequency.setValueAtTime(880, now + 0.1);
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

window.appStore = new AccreditationStore();
window.AccreditationStore = AccreditationStore;
window.SoundEffects = SoundEffects;
window.formatDateTimeChile = formatDateTimeChile;
window.formatTimeOnlyChile = formatTimeOnlyChile;
