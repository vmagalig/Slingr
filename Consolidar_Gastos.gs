/**
 * ============================================================================
 *  CONSOLIDADOR DE GASTOS - Remotely
 * ----------------------------------------------------------------------------
 *  Recorre todas las carpetas "Expenses + año" dentro de una carpeta de Drive,
 *  lee la pestaña "expenses" de cada planilla "Gastos Generales Remotely + año",
 *  unifica las categorías usando una planilla de mapeo y escribe todo en la
 *  pestaña "Consolidado" de ESTA planilla.
 *
 *  Lógica de unificación de categorías:
 *    - Por cada gasto se toma su "ESPECIFIC CATEGORIES".
 *    - Se busca en la planilla de mapeo (col B = específica) y se asigna la
 *      "CATEGORIES" general correcta (col A). El mapeo es la fuente de verdad.
 *
 *  Cómo usarlo:
 *    1. Crear una planilla nueva (será la MAESTRA).
 *    2. Extensiones -> Apps Script. Pegar este archivo. Guardar.
 *    3. Ejecutar "actualizarConsolidado" una vez y autorizar permisos.
 *    4. Ejecutar "crearTriggerAutomatico" una vez para que se actualice solo.
 *    5. Conectar Looker Studio a la pestaña "Consolidado".
 * ============================================================================
 */

// ============================== CONFIGURACIÓN ==============================
const CONFIG = {
  // Carpeta padre que contiene las subcarpetas "Expenses + año"
  PARENT_FOLDER_ID: '1boUcQp2dPnHPRTPBDK7kgLAMayZhbUSH',

  // Planilla de mapeo de categorías (A = CATEGORIES general, B = ESPECIFIC)
  MAPPING_SHEET_ID: '1tA27_IqQt6J4PyIEWOQSlB5Lp_dsraHx1yWiHDX6ias',

  // Prefijos / nombres para encontrar las cosas (no distinguen mayúsculas)
  SUBFOLDER_PREFIX: 'Expenses',                    // "Expenses 2023", "Expenses 2024"...
  SPREADSHEET_PREFIX: 'Gastos Generales Remotely', // "Gastos Generales Remotely 2024"
  EXPENSES_TAB_NAME: 'expenses',                   // pestaña dentro de cada planilla

  // Pestaña destino en la planilla maestra
  CONSOLIDATED_TAB_NAME: 'Consolidado',

  // Si una categoría específica no está en el mapeo, ¿qué hacemos con la general?
  //   true  -> dejamos la "CATEGORIES" original que traía el gasto
  //   false -> ponemos "SIN MAPEAR" para detectar faltantes fácilmente
  KEEP_ORIGINAL_IF_UNMAPPED: true,
};

// Columnas que esperamos en la pestaña "expenses" (se leen por NOMBRE, no por posición)
const EXP_COLS = [
  'MONTH', 'DATE', 'CANT.', 'CATEGORIES', 'ESPECIFIC CATEGORIES', 'EXPENSES',
  'SERVICES', 'CURRENCY', 'AMOUNT', 'PAYMENT', 'CAJAS', 'CIUDAD',
  'LUGAR (RAZON SOCIAL)', 'PAGADO A:', 'TOTAL TICKET', 'COT.', 'MONTOUSD',
  'MONTO$', 'Monto de FACT', 'FACT N°', '1COT.',
];

// Encabezados de salida en la pestaña "Consolidado"
const OUTPUT_HEADERS = [
  'AÑO', 'ARCHIVO ORIGEN', 'CATEGORIA UNIFICADA',
  'MONTH', 'DATE', 'CANT.', 'CATEGORIES (orig)', 'ESPECIFIC CATEGORIES',
  'EXPENSES', 'SERVICES', 'CURRENCY', 'AMOUNT', 'PAYMENT', 'CAJAS', 'CIUDAD',
  'LUGAR (RAZON SOCIAL)', 'PAGADO A:', 'TOTAL TICKET', 'COT.', 'MONTOUSD',
  'MONTO$', 'Monto de FACT', 'FACT N°', '1COT.',
];

// =============================== MENÚ EN LA UI ===============================
function onOpen() {
  SpreadsheetApp.getUi()
    .createMenu('⚙️ Gastos')
    .addItem('🔄 Actualizar consolidado ahora', 'actualizarConsolidado')
    .addSeparator()
    .addItem('⏰ Activar actualización automática', 'crearTriggerAutomatico')
    .addItem('🛑 Desactivar actualización automática', 'eliminarTriggers')
    .addToUi();
}

// =========================== FUNCIÓN PRINCIPAL ===========================
function actualizarConsolidado() {
  try {
    const mapeo = construirMapeoCategorias_();          // específica(lower) -> general
    const carpetaPadre = DriveApp.getFolderById(CONFIG.PARENT_FOLDER_ID);

    const filas = [];
    let archivosProcesados = 0;

    // Recorremos subcarpetas "Expenses *"
    const subcarpetas = carpetaPadre.getFolders();
    while (subcarpetas.hasNext()) {
      const sub = subcarpetas.next();
      const nombreSub = sub.getName().trim();
      if (!startsWithCI_(nombreSub, CONFIG.SUBFOLDER_PREFIX)) continue;

      const anio = extraerAnio_(nombreSub);

      // Buscamos dentro la planilla "Gastos Generales Remotely *"
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

        const filasArchivo = procesarHojaExpenses_(hoja, anio, archivo.getName(), mapeo);
        filas.push.apply(filas, filasArchivo);
        archivosProcesados++;
        Logger.log('✔ %s (%s): %s filas', archivo.getName(), anio, filasArchivo.length);
      }
    }

    escribirConsolidado_(filas);

    const msg = '✅ Consolidado actualizado.\n\n' +
      'Archivos procesados: ' + archivosProcesados + '\n' +
      'Filas totales: ' + filas.length;
    Logger.log(msg);
    if (esContextoUI_()) SpreadsheetApp.getUi().alert(msg);

  } catch (e) {
    const message = 'Ha ocurrido un error: ' + e.message;
    console.error(message + '\n' + (e.stack || ''));
    if (esContextoUI_()) SpreadsheetApp.getUi().alert(message);
    throw e; // para que quede registrado en los logs de ejecución
  }
}

// =================== LECTURA Y NORMALIZACIÓN DE UNA HOJA ===================
function procesarHojaExpenses_(hoja, anio, nombreArchivo, mapeo) {
  const valores = hoja.getDataRange().getValues();
  if (valores.length < 2) return [];

  const headers = valores[0].map(function (h) { return String(h).trim(); });
  const idx = indexarHeaders_(headers, EXP_COLS);

  const out = [];
  for (let r = 1; r < valores.length; r++) {
    const fila = valores[r];

    // Saltar filas totalmente vacías
    if (fila.every(function (c) { return c === '' || c === null; })) continue;

    const especifica = getCell_(fila, idx, 'ESPECIFIC CATEGORIES');
    const generalOrig = getCell_(fila, idx, 'CATEGORIES');
    const unificada = unificarCategoria_(especifica, generalOrig, mapeo);

    out.push([
      anio,
      nombreArchivo,
      unificada,
      getCell_(fila, idx, 'MONTH'),
      getCell_(fila, idx, 'DATE'),
      getCell_(fila, idx, 'CANT.'),
      generalOrig,
      especifica,
      getCell_(fila, idx, 'EXPENSES'),
      getCell_(fila, idx, 'SERVICES'),
      getCell_(fila, idx, 'CURRENCY'),
      parseNum_(getCell_(fila, idx, 'AMOUNT')),
      getCell_(fila, idx, 'PAYMENT'),
      getCell_(fila, idx, 'CAJAS'),
      getCell_(fila, idx, 'CIUDAD'),
      getCell_(fila, idx, 'LUGAR (RAZON SOCIAL)'),
      getCell_(fila, idx, 'PAGADO A:'),
      parseNum_(getCell_(fila, idx, 'TOTAL TICKET')),
      parseNum_(getCell_(fila, idx, 'COT.')),
      parseNum_(getCell_(fila, idx, 'MONTOUSD')),
      parseNum_(getCell_(fila, idx, 'MONTO$')),
      parseNum_(getCell_(fila, idx, 'Monto de FACT')),
      getCell_(fila, idx, 'FACT N°'),
      parseNum_(getCell_(fila, idx, '1COT.')),
    ]);
  }
  return out;
}

// ============================ MAPEO DE CATEGORÍAS ============================
function construirMapeoCategorias_() {
  const ss = SpreadsheetApp.openById(CONFIG.MAPPING_SHEET_ID);
  const hoja = ss.getSheets()[0]; // primera pestaña (gid=0)
  const valores = hoja.getDataRange().getValues();
  if (valores.length < 2) {
    throw new Error('La planilla de mapeo de categorías está vacía.');
  }

  const headers = valores[0].map(function (h) { return String(h).trim(); });
  // Buscamos por nombre; si no aparecen, caemos a A=general, B=específica
  let colGeneral = headers.findIndex(function (h) { return h.toUpperCase() === 'CATEGORIES'; });
  let colEspecif = headers.findIndex(function (h) { return h.toUpperCase() === 'ESPECIFIC CATEGORIES'; });
  if (colGeneral === -1) colGeneral = 0;
  if (colEspecif === -1) colEspecif = 1;

  const mapa = {};
  for (let r = 1; r < valores.length; r++) {
    const especif = normalizar_(valores[r][colEspecif]);
    const general = String(valores[r][colGeneral] || '').trim();
    if (especif) mapa[especif] = general;
  }
  return mapa;
}

function unificarCategoria_(especifica, generalOrig, mapeo) {
  const clave = normalizar_(especifica);
  if (clave && mapeo.hasOwnProperty(clave) && mapeo[clave]) {
    return mapeo[clave];
  }
  return CONFIG.KEEP_ORIGINAL_IF_UNMAPPED
    ? (String(generalOrig || '').trim() || 'SIN CATEGORIA')
    : 'SIN MAPEAR';
}

// =========================== ESCRITURA DEL DESTINO ===========================
function escribirConsolidado_(filas) {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  let hoja = ss.getSheetByName(CONFIG.CONSOLIDATED_TAB_NAME);
  if (!hoja) hoja = ss.insertSheet(CONFIG.CONSOLIDATED_TAB_NAME);

  hoja.clearContents();

  // Encabezados
  hoja.getRange(1, 1, 1, OUTPUT_HEADERS.length).setValues([OUTPUT_HEADERS]);
  hoja.getRange(1, 1, 1, OUTPUT_HEADERS.length).setFontWeight('bold');
  hoja.setFrozenRows(1);

  // Datos
  if (filas.length > 0) {
    hoja.getRange(2, 1, filas.length, OUTPUT_HEADERS.length).setValues(filas);
  }

  // Marca de tiempo de la última actualización en una celda lateral
  const stamp = Utilities.formatDate(new Date(),
    Session.getScriptTimeZone(), 'yyyy-MM-dd HH:mm:ss');
  hoja.getRange(1, OUTPUT_HEADERS.length + 2).setValue('Última actualización:');
  hoja.getRange(1, OUTPUT_HEADERS.length + 3).setValue(stamp);
}

// =============================== TRIGGERS ===============================
function crearTriggerAutomatico() {
  eliminarTriggers(); // evitamos duplicados
  // Cada 1 hora. Cambiá .everyHours(1) por .everyHours(6) o usá .everyDays(1) si preferís.
  ScriptApp.newTrigger('actualizarConsolidado')
    .timeBased()
    .everyHours(1)
    .create();
  const msg = '⏰ Listo. El consolidado se actualizará automáticamente cada 1 hora.';
  Logger.log(msg);
  if (esContextoUI_()) SpreadsheetApp.getUi().alert(msg);
}

function eliminarTriggers() {
  const triggers = ScriptApp.getProjectTriggers();
  triggers.forEach(function (t) {
    if (t.getHandlerFunction() === 'actualizarConsolidado') {
      ScriptApp.deleteTrigger(t);
    }
  });
}

// =============================== UTILIDADES ===============================
function indexarHeaders_(headers, esperadas) {
  const idx = {};
  esperadas.forEach(function (nombre) {
    idx[nombre] = headers.findIndex(function (h) {
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
  for (let i = 0; i < hojas.length; i++) {
    if (hojas[i].getName().trim().toUpperCase() === nombre.toUpperCase()) {
      return hojas[i];
    }
  }
  return null;
}

function extraerAnio_(texto) {
  const m = String(texto).match(/(20\d{2})/); // captura 2020..2099
  return m ? m[1] : texto.replace(CONFIG.SUBFOLDER_PREFIX, '').trim();
}

function normalizar_(v) {
  return String(v == null ? '' : v).trim().toLowerCase();
}

/**
 * Convierte a número valores que pueden venir como texto con formato AR/US.
 * - Si ya es número, lo devuelve tal cual.
 * - Soporta "$ 1.234,56" (AR) y "1,234.56" (US).
 */
function parseNum_(v) {
  if (typeof v === 'number') return v;
  if (v === '' || v === null || v === undefined) return '';
  let s = String(v).replace(/[^\d.,\-]/g, '').trim();
  if (s === '' || s === '-') return '';

  const tienePunto = s.indexOf('.') !== -1;
  const tieneComa = s.indexOf(',') !== -1;

  if (tienePunto && tieneComa) {
    // El último separador es el decimal
    if (s.lastIndexOf(',') > s.lastIndexOf('.')) {
      s = s.replace(/\./g, '').replace(',', '.');   // formato AR: 1.234,56
    } else {
      s = s.replace(/,/g, '');                        // formato US: 1,234.56
    }
  } else if (tieneComa) {
    s = s.replace(',', '.');                          // 1234,56 -> 1234.56
  }
  const n = parseFloat(s);
  return isNaN(n) ? '' : n;
}

function esContextoUI_() {
  try { SpreadsheetApp.getUi(); return true; }
  catch (e) { return false; } // ejecutándose por trigger, sin UI
}
