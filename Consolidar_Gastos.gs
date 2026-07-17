/**
 * ============================================================================
 *  CONSOLIDADOR DE GASTOS - Remotely
 * ----------------------------------------------------------------------------
 *  Lee las planillas "Gastos Generales Remotely + año" desde Drive,
 *  aplica el mapeo de categorías y escribe el resultado en la pestaña
 *  "GASTOS" de la planilla maestra (que el dashboard de Vercel consume).
 *
 *  ACTUALIZACIÓN MANUAL ÚNICAMENTE:
 *    Menú "⚙️ Gastos" → "🔄 Actualizar ahora"
 *
 *  Fixes incluidos en esta versión:
 *    - Clave de mapeo: usa COLUMNA E (col D) en vez de ESPECIFIC CATEGORIES
 *    - Normalización: lowercase + sin tildes + sin puntos extra
 *    - Output: 3 columnas de categoría (CATEGORIES_GRAL, CATEGORIES_MAP, ESPECIFIC_CAT_MAP)
 *    - Tab destino: GASTOS (lo que lee el dashboard de Vercel)
 *    - Sin trigger automático
 * ============================================================================
 */

// ============================== CONFIGURACIÓN ==============================
const CONFIG = {
  // Carpeta padre que contiene las subcarpetas "Expenses + año"
  PARENT_FOLDER_ID: '1boUcQp2dPnHPRTPBDK7kgLAMayZhbUSH',

  // Planilla de mapeo de categorías
  // Columnas: A=CATEGORIES GRAL, B=CATEGORIES, C=ESPECIFIC CATEGORIES, D=COLUMNA E (clave)
  MAPPING_SHEET_ID: '1tA27_IqQt6J4PyIEWOQSlB5Lp_dsraHx1yWiHDX6ias',

  // Planilla MAESTRA donde se escribe la pestaña GASTOS (la que lee el dashboard).
  // Pegá acá el ID de esa planilla (está en su URL:
  //   https://docs.google.com/spreadsheets/d/<ESTE_ID>/edit ).
  // Si se deja vacío, se usa la planilla activa (solo funciona al correr desde el menú).
  MASTER_SHEET_ID: '1ad1aOTha1abiYbOiSXsoCh-9Q4b0jLuSDaE5vPJIkGY',

  // Prefijos para encontrar carpetas y planillas
  SUBFOLDER_PREFIX: 'Expenses',
  SPREADSHEET_PREFIX: 'Gastos Generales Remotely',
  EXPENSES_TAB_NAME: 'expenses',

  // Pestaña destino en la planilla maestra (debe coincidir con sheets.ts del dashboard)
  GASTOS_TAB_NAME: 'GASTOS',

  // Si un valor no está en el mapeo: true = usar categoría original, false = "sin mapear"
  KEEP_ORIGINAL_IF_UNMAPPED: true,
};

// Columnas esperadas en la pestaña "expenses" de cada planilla fuente
const EXP_COLS = [
  'MONTH', 'DATE', 'CANT.', 'CATEGORIES', 'ESPECIFIC CATEGORIES', 'EXPENSES',
  'SERVICES', 'CURRENCY', 'AMOUNT', 'PAYMENT', 'CAJAS', 'CIUDAD',
  'LUGAR (RAZON SOCIAL)', 'PAGADO A:', 'TOTAL TICKET', 'COT.', 'MONTOUSD',
  'MONTO$', 'Monto de FACT', 'FACT N°', '1COT.',
];

/**
 * Encabezados de salida en la pestaña GASTOS.
 * El orden y los nombres deben coincidir exactamente con parseSheets.ts.
 * Layout "con ciudad" — 28 columnas:
 *   [0]  MONTH
 *   [1]  DATE
 *   [2]  CANT.
 *   [3]  CATEGORIES          ← valor original normalizado
 *   [4]  ESPECIFIC_CAT       ← valor original normalizado
 *   [5]  EXPENSES
 *   [6]  SERVICES
 *   [7]  CURRENCY
 *   [8]  AMOUNT
 *   [9]  PAYMENT
 *   [10] CAJAS
 *   [11] CIUDAD
 *   [12] LUGAR_RAZON_SOCIAL
 *   [13] PAGADO_A
 *   [14] TOTAL_TICKET
 *   [15] COT_FUENTE
 *   [16] MONTOUSD_FUENTE
 *   [17] MONTO_ARS
 *   [18] CATEGORIES_GRAL     ← del mapeo
 *   [19] CATEGORIES_MAP      ← del mapeo
 *   [20] ESPECIFIC_CAT_MAP   ← del mapeo
 *   [21] ANO
 *   [22] MES
 *   [23] MONTO_USD_REAL
 *   [24] COT_OFICIAL
 *   [25] MONTO_USD_OFICIAL
 *   [26] COT_BLUE
 *   [27] MONTO_USD_BLUE
 */
const OUTPUT_HEADERS = [
  'MONTH', 'DATE', 'CANT.', 'CATEGORIES', 'ESPECIFIC_CAT',
  'EXPENSES', 'SERVICES', 'CURRENCY', 'AMOUNT', 'PAYMENT', 'CAJAS',
  'CIUDAD', 'LUGAR_RAZON_SOCIAL', 'PAGADO_A', 'TOTAL_TICKET',
  'COT_FUENTE', 'MONTOUSD_FUENTE', 'MONTO_ARS',
  'CATEGORIES_GRAL', 'CATEGORIES_MAP', 'ESPECIFIC_CAT_MAP',
  'ANO', 'MES',
  'MONTO_USD_REAL', 'COT_OFICIAL', 'MONTO_USD_OFICIAL', 'COT_BLUE', 'MONTO_USD_BLUE',
];

// =============================== MENÚ EN LA UI ===============================
function onOpen() {
  SpreadsheetApp.getUi()
    .createMenu('⚙️ Gastos')
    .addItem('🔄 Actualizar ahora', 'actualizarConsolidado')
    .addSeparator()
    .addItem('🔧 Normalizar planilla de mapeo', 'normalizarMapeo')
    .addItem('🛑 Eliminar triggers automáticos', 'eliminarTriggers')
    .addToUi();
}

// =========================== FUNCIÓN PRINCIPAL ===========================
function actualizarConsolidado() {
  try {
    const mapeo = construirMapeoCategorias_();
    const carpetaPadre = DriveApp.getFolderById(CONFIG.PARENT_FOLDER_ID);

    const filas = [];
    let archivosProcesados = 0;

    const subcarpetas = carpetaPadre.getFolders();
    while (subcarpetas.hasNext()) {
      const sub = subcarpetas.next();
      const nombreSub = sub.getName().trim();
      if (!startsWithCI_(nombreSub, CONFIG.SUBFOLDER_PREFIX)) continue;

      const anio = extraerAnio_(nombreSub);

      const archivos = sub.getFilesByType(MimeType.GOOGLE_SHEETS);
      while (archivos.hasNext()) {
        const archivo = archivos.next();
        if (!startsWithCI_(archivo.getName().trim(), CONFIG.SPREADSHEET_PREFIX)) continue;

        const ss = SpreadsheetApp.openById(archivo.getId());
        const hoja = getSheetCI_(ss, CONFIG.EXPENSES_TAB_NAME);
        if (!hoja) {
          Logger.log('⚠️ "%s" no tiene pestaña "%s". Se omite.',
            archivo.getName(), CONFIG.EXPENSES_TAB_NAME);
          continue;
        }

        const filasArchivo = procesarHojaExpenses_(hoja, anio, mapeo);
        filas.push.apply(filas, filasArchivo);
        archivosProcesados++;
        Logger.log('✔ %s (%s): %s filas', archivo.getName(), anio, filasArchivo.length);
      }
    }

    escribirGastos_(filas);

    const msg = '✅ GASTOS actualizado.\nArchivos procesados: ' + archivosProcesados +
      '\nFilas totales: ' + filas.length;
    Logger.log(msg);
    if (esContextoUI_()) SpreadsheetApp.getUi().alert(msg);

  } catch (e) {
    const message = 'Error al actualizar: ' + e.message;
    console.error(message + '\n' + (e.stack || ''));
    if (esContextoUI_()) SpreadsheetApp.getUi().alert(message);
    throw e;
  }
}

// =================== LECTURA Y PROCESAMIENTO DE UNA HOJA ===================
function procesarHojaExpenses_(hoja, anio, mapeo) {
  const valores = hoja.getDataRange().getValues();
  if (valores.length < 2) return [];

  const headers = valores[0].map(function(h) { return String(h).trim(); });
  const idx = indexarHeaders_(headers, EXP_COLS);

  const out = [];
  for (var r = 1; r < valores.length; r++) {
    const fila = valores[r];
    if (fila.every(function(c) { return c === '' || c === null; })) continue;

    const especificaOrig = String(getCell_(fila, idx, 'ESPECIFIC CATEGORIES') || '').trim();
    const categoriaOrig  = String(getCell_(fila, idx, 'CATEGORIES') || '').trim();
    const cat = mapearCategoria_(especificaOrig, categoriaOrig, mapeo);

    const dateVal  = getCell_(fila, idx, 'DATE');
    const monthVal = parseNum_(getCell_(fila, idx, 'MONTH'));
    const mes      = monthVal > 0 ? monthVal : mesDeDate_(dateVal);

    const montoArs    = parseNum_(getCell_(fila, idx, 'MONTO$'));
    const cotFuente   = parseNum_(getCell_(fila, idx, 'COT.'));
    const montoUsdSrc = parseNum_(getCell_(fila, idx, 'MONTOUSD'));
    const cotOficial  = parseNum_(getCell_(fila, idx, '1COT.'));
    const montoUsdOf  = (cotOficial > 0 && montoArs > 0) ? montoArs / cotOficial : montoUsdSrc;
    const montoUsdReal = montoUsdSrc > 0 ? montoUsdSrc : montoUsdOf;

    out.push([
      monthVal || mes,                                              // [0]  MONTH
      dateVal,                                                      // [1]  DATE
      parseNum_(getCell_(fila, idx, 'CANT.')),                      // [2]  CANT.
      normCat_(categoriaOrig),                                      // [3]  CATEGORIES (normalizado)
      normCat_(especificaOrig),                                     // [4]  ESPECIFIC_CAT (normalizado)
      str_(getCell_(fila, idx, 'EXPENSES')),                        // [5]  EXPENSES
      str_(getCell_(fila, idx, 'SERVICES')),                        // [6]  SERVICES
      str_(getCell_(fila, idx, 'CURRENCY')),                        // [7]  CURRENCY
      parseNum_(getCell_(fila, idx, 'AMOUNT')),                     // [8]  AMOUNT
      str_(getCell_(fila, idx, 'PAYMENT')),                         // [9]  PAYMENT
      str_(getCell_(fila, idx, 'CAJAS')),                           // [10] CAJAS
      str_(getCell_(fila, idx, 'CIUDAD')),                          // [11] CIUDAD
      str_(getCell_(fila, idx, 'LUGAR (RAZON SOCIAL)')),            // [12] LUGAR_RAZON_SOCIAL
      str_(getCell_(fila, idx, 'PAGADO A:')),                       // [13] PAGADO_A
      parseNum_(getCell_(fila, idx, 'TOTAL TICKET')),               // [14] TOTAL_TICKET
      cotFuente,                                                    // [15] COT_FUENTE
      montoUsdSrc,                                                  // [16] MONTOUSD_FUENTE
      montoArs,                                                     // [17] MONTO_ARS
      cat.gral,                                                     // [18] CATEGORIES_GRAL
      cat.categories,                                               // [19] CATEGORIES_MAP
      cat.especific,                                                // [20] ESPECIFIC_CAT_MAP
      anio,                                                         // [21] ANO
      mes,                                                          // [22] MES
      montoUsdReal,                                                 // [23] MONTO_USD_REAL
      cotOficial,                                                   // [24] COT_OFICIAL
      montoUsdOf,                                                   // [25] MONTO_USD_OFICIAL
      0,                                                            // [26] COT_BLUE (no disponible en fuente)
      0,                                                            // [27] MONTO_USD_BLUE (no disponible)
    ]);
  }
  return out;
}

// ============================ MAPEO DE CATEGORÍAS ============================
/**
 * Construye el mapa de categorías desde la planilla de mapeo.
 *
 * La planilla de mapeo tiene 4 columnas:
 *   A: CATEGORIES GRAL      → categoría general
 *   B: CATEGORIES           → categoría media
 *   C: ESPECIFIC CATEGORIES → categoría específica
 *   D: COLUMNA E            → clave de búsqueda (valor que aparece en los gastos)
 *
 * Mapa: normalizar(COLUMNA E) → { gral, categories, especific }
 */
function construirMapeoCategorias_() {
  const ss = SpreadsheetApp.openById(CONFIG.MAPPING_SHEET_ID);
  const hoja = ss.getSheets()[0]; // primera pestaña (gid=0)
  const valores = hoja.getDataRange().getValues();
  if (valores.length < 2) throw new Error('La planilla de mapeo está vacía.');

  // Detectar columnas por nombre normalizado
  const headers = valores[0].map(function(h) { return normalizar_(String(h)); });
  var colGral    = headers.findIndex(function(h) { return h.includes('gral'); });
  var colCateg   = headers.findIndex(function(h) { return h === 'categories'; });
  var colEspecif = headers.findIndex(function(h) { return h.includes('especif'); });
  var colKey     = headers.findIndex(function(h) { return h.includes('columna'); });

  // Fallback por posición si no se detectan por nombre
  if (colGral    === -1) colGral    = 0;
  if (colCateg   === -1) colCateg   = 1;
  if (colEspecif === -1) colEspecif = 2;
  if (colKey     === -1) colKey     = 3;

  const mapa = {};
  for (var r = 1; r < valores.length; r++) {
    const key = normalizar_(valores[r][colKey]);
    if (!key) continue;
    if (mapa[key]) continue; // la primera definición gana; evita sobreescribir
    mapa[key] = {
      gral:       normCat_(String(valores[r][colGral]    || '')),
      categories: normCat_(String(valores[r][colCateg]   || '')),
      especific:  normCat_(String(valores[r][colEspecif] || '')),
    };
  }
  Logger.log('Mapeo construido: %s entradas únicas.', Object.keys(mapa).length);
  return mapa;
}

function mapearCategoria_(especifica, categoriaOrig, mapeo) {
  const clave = normalizar_(especifica);
  if (clave && mapeo[clave]) return mapeo[clave];

  if (!CONFIG.KEEP_ORIGINAL_IF_UNMAPPED) {
    Logger.log('Sin mapeo para: "%s"', especifica);
    return { gral: 'sin mapear', categories: 'sin mapear', especific: normCat_(especifica) };
  }
  const fallback = normCat_(categoriaOrig) || 'sin categoria';
  return {
    gral:       fallback,
    categories: fallback,
    especific:  normCat_(especifica) || 'sin categoria',
  };
}

// =========================== ESCRITURA DEL DESTINO ===========================
function escribirGastos_(filas) {
  const ss = getMasterSpreadsheet_();
  let hoja = ss.getSheetByName(CONFIG.GASTOS_TAB_NAME);
  if (!hoja) hoja = ss.insertSheet(CONFIG.GASTOS_TAB_NAME);

  hoja.clearContents();
  hoja.getRange(1, 1, 1, OUTPUT_HEADERS.length).setValues([OUTPUT_HEADERS]);
  hoja.getRange(1, 1, 1, OUTPUT_HEADERS.length).setFontWeight('bold');
  hoja.setFrozenRows(1);

  if (filas.length > 0) {
    hoja.getRange(2, 1, filas.length, OUTPUT_HEADERS.length).setValues(filas);
  }

  const stamp = Utilities.formatDate(new Date(),
    Session.getScriptTimeZone(), 'yyyy-MM-dd HH:mm:ss');
  hoja.getRange(1, OUTPUT_HEADERS.length + 2).setValue('Ultima actualizacion:');
  hoja.getRange(1, OUTPUT_HEADERS.length + 3).setValue(stamp);
}

// ====================== NORMALIZAR PLANILLA DE MAPEO ========================
/**
 * Normaliza la planilla de mapeo in-place:
 *   - Convierte TODOS los valores a minúscula sin tildes ni puntos
 *   - Elimina filas duplicadas (mismo COLUMNA E normalizado)
 * Ejecutar UNA SOLA VEZ desde el menú "⚙️ Gastos" → "🔧 Normalizar planilla de mapeo".
 */
function normalizarMapeo() {
  const ss = SpreadsheetApp.openById(CONFIG.MAPPING_SHEET_ID);
  const hoja = ss.getSheets()[0];
  const valores = hoja.getDataRange().getValues();
  if (valores.length < 2) {
    if (esContextoUI_()) SpreadsheetApp.getUi().alert('Planilla de mapeo vacía.');
    return;
  }

  const headers = valores[0].map(function(h) { return normalizar_(String(h)); });
  var colGral    = headers.findIndex(function(h) { return h.includes('gral'); });
  var colCateg   = headers.findIndex(function(h) { return h === 'categories'; });
  var colEspecif = headers.findIndex(function(h) { return h.includes('especif'); });
  var colKey     = headers.findIndex(function(h) { return h.includes('columna'); });
  if (colGral    === -1) colGral    = 0;
  if (colCateg   === -1) colCateg   = 1;
  if (colEspecif === -1) colEspecif = 2;
  if (colKey     === -1) colKey     = 3;

  const keysSeen = {};
  const nuevasFilas = [valores[0]]; // conservar encabezados originales

  for (var r = 1; r < valores.length; r++) {
    const fila = valores[r].slice(); // copia
    const keyNorm = normalizar_(fila[colKey]);

    if (!keyNorm) continue;           // saltar filas vacías
    if (keysSeen[keyNorm]) continue;  // saltar duplicados
    keysSeen[keyNorm] = true;

    // Normalizar todas las columnas de categoría
    fila[colGral]    = normCat_(String(fila[colGral]    || ''));
    fila[colCateg]   = normCat_(String(fila[colCateg]   || ''));
    fila[colEspecif] = normCat_(String(fila[colEspecif] || ''));
    fila[colKey]     = keyNorm;
    nuevasFilas.push(fila);
  }

  hoja.clearContents();
  hoja.getRange(1, 1, nuevasFilas.length, valores[0].length).setValues(nuevasFilas);
  hoja.getRange(1, 1, 1, valores[0].length).setFontWeight('bold');
  hoja.setFrozenRows(1);

  const msg = '✅ Mapeo normalizado.\n' +
    'Filas originales: ' + (valores.length - 1) + '\n' +
    'Filas únicas (sin duplicados): ' + (nuevasFilas.length - 1);
  Logger.log(msg);
  if (esContextoUI_()) SpreadsheetApp.getUi().alert(msg);
}

// =============================== TRIGGERS ===============================
/**
 * Elimina todos los triggers automáticos. Llamar una vez si existían triggers previos.
 * NO hay función para crear triggers: la actualización es solo manual.
 */
function eliminarTriggers() {
  const triggers = ScriptApp.getProjectTriggers();
  var eliminados = 0;
  triggers.forEach(function(t) {
    if (t.getHandlerFunction() === 'actualizarConsolidado') {
      ScriptApp.deleteTrigger(t);
      eliminados++;
    }
  });
  const msg = '✅ Triggers eliminados: ' + eliminados + '. La actualización es ahora 100% manual.';
  Logger.log(msg);
  if (esContextoUI_()) SpreadsheetApp.getUi().alert(msg);
}

// =============================== UTILIDADES ===============================
/**
 * Devuelve la planilla maestra donde se escribe GASTOS.
 * Prioriza CONFIG.MASTER_SHEET_ID (funciona desde el editor y desde triggers);
 * si está vacío, cae en la planilla activa (solo funciona desde el menú de la planilla).
 */
function getMasterSpreadsheet_() {
  if (CONFIG.MASTER_SHEET_ID) return SpreadsheetApp.openById(CONFIG.MASTER_SHEET_ID);
  const activa = SpreadsheetApp.getActiveSpreadsheet();
  if (activa) return activa;
  throw new Error(
    'No hay planilla activa. Configurá CONFIG.MASTER_SHEET_ID con el ID de la ' +
    'planilla maestra, o ejecutá desde el menú "⚙️ Gastos" dentro de esa planilla.');
}

function indexarHeaders_(headers, esperadas) {
  const idx = {};
  esperadas.forEach(function(nombre) {
    idx[nombre] = headers.findIndex(function(h) {
      return h.toUpperCase() === nombre.toUpperCase();
    });
  });
  return idx;
}

function getCell_(fila, idx, nombre) {
  const i = idx[nombre];
  return (i === undefined || i === -1) ? '' : fila[i];
}

function startsWithCI_(texto, prefijo) {
  return String(texto).toUpperCase().indexOf(String(prefijo).toUpperCase()) === 0;
}

function getSheetCI_(ss, nombre) {
  const hojas = ss.getSheets();
  for (var i = 0; i < hojas.length; i++) {
    if (hojas[i].getName().trim().toUpperCase() === nombre.toUpperCase()) return hojas[i];
  }
  return null;
}

function extraerAnio_(texto) {
  const m = String(texto).match(/(20\d{2})/);
  return m ? m[1] : texto.replace(CONFIG.SUBFOLDER_PREFIX, '').trim();
}

/**
 * Normaliza para comparación/lookup:
 * minúscula + sin tildes + sin puntos + espacios colapsados.
 * "Lic. Programas" → "lic programas"
 * "Administración" → "administracion"
 */
function normalizar_(v) {
  if (v == null || v === '') return '';
  return String(v)
    .trim()
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '') // quitar tildes y acentos
    .replace(/\./g, ' ')             // punto → espacio ("lic." → "lic ")
    .replace(/\s+/g, ' ')            // colapsar espacios múltiples
    .trim();
}

/**
 * Normaliza un valor de categoría para escritura en el sheet:
 * igual que normalizar_ pero también colapsa separadores comunes.
 */
function normCat_(v) {
  return normalizar_(v);
}

/**
 * Devuelve el string limpio (solo trim), sin normalización de contenido.
 * Para campos descriptivos como lugar, pagado_a, etc.
 */
function str_(v) {
  return (v == null ? '' : String(v)).trim();
}

/**
 * Extrae el mes (1-12) de un valor DATE.
 * Soporta objetos Date de Apps Script y strings "DD/MM/YYYY" (Argentina).
 */
function mesDeDate_(v) {
  if (!v) return 0;
  if (v instanceof Date) return v.getMonth() + 1;
  const m = String(v).trim().match(/^(\d{1,2})[\/\-](\d{1,2})[\/\-](\d{2,4})/);
  if (m) return parseInt(m[2], 10); // DD/MM/YYYY → m[2] es el mes
  return 0;
}

/**
 * Convierte a número valores que pueden venir como texto con formato AR/US.
 */
function parseNum_(v) {
  if (typeof v === 'number') return v;
  if (v === '' || v === null || v === undefined) return 0;
  let s = String(v).replace(/[^\d.,\-]/g, '').trim();
  if (s === '' || s === '-') return 0;

  const tienePunto = s.indexOf('.') !== -1;
  const tieneComa  = s.indexOf(',') !== -1;

  if (tienePunto && tieneComa) {
    if (s.lastIndexOf(',') > s.lastIndexOf('.')) {
      s = s.replace(/\./g, '').replace(',', '.'); // AR: 1.234,56
    } else {
      s = s.replace(/,/g, '');                     // US: 1,234.56
    }
  } else if (tieneComa) {
    s = s.replace(',', '.');
  }
  const n = parseFloat(s);
  return isNaN(n) ? 0 : n;
}

function esContextoUI_() {
  try { SpreadsheetApp.getUi(); return true; }
  catch (e) { return false; }
}

