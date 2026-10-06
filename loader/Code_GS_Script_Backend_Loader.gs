/**
 * TMR SYSTEM v13.3.0 ULTRA LITE - HIGH PERFORMANCE BACKEND
 *
 * PERUBAHAN v13.3.0 (tampilan Mixer: muatan tersisa & unit mixer):
 * P. Antrian di aplikasi Mixer sekarang membawa mixerUnit (Trioliet/Supreme), dipakai untuk menampilkan
 *    keterangan unit di layar. Mode mixer & default kini membaca sampai kolom MixerUnit (sebelumnya
 *    berhenti di DistribusiStatusJson, sehingga kolom U belum pernah terbawa ke aplikasi operator).
 *
 * PERUBAHAN v13.2.0 (rekonsiliasi tonase aktual per pen):
 * O. Mode monitor & report sekarang mengirim masterDist (target kg per pen per shift dari MasterDistribusi).
 *    Live Monitoring memakai ini untuk menghitung tonase aktual per pen: Tonase Akhir (batch, dari Loader,
 *    kolom K) dibagi proporsional sesuai target tiap pen -- bukan angka yang diketik operator mixer.
 *    getMasterData_ tetap di-cache (MASTER_CACHE_KEY), jadi ini tidak menambah beban baca spreadsheet.
 *
 * PERUBAHAN v13.1.0 (target molases & unit mixer):
 * M. Target molases dibaca dari sheet MasterTonase (tabel "TARGET MOLASES": PEN | PAGI | SIANG | MALAM).
 *    Dihitung DI SERVER saat batch disimpan (jumlah pen terpilih, faktor 25%/50% untuk pen khusus Pagi seperti
 *    target tonase lain) dan dicatat di TargetJson (kolom S) sebagai key "molases". Tidak dikirim ke layar operator.
 * N. Input_Data kolom U = MixerUnit (Trioliet / Supreme) -> riwayat muatan tiap unit mixer.
 *
 * PERUBAHAN v13.0.0 (rapor loader & helper):
 * J. Input_Data kolom S  = TargetJson (snapshot target tonase saat loader menyimpan; riwayat target).
 *    Input_Data kolom T  = HelperMolases (helper yang menuang molases).
 *    Distribusi kolom J  = Helper (helper yang mendampingi distribusi ke kandang).
 *    Jalankan setupHeaders() sekali untuk memberi judul kolom baru (opsional).
 * K. Master data memuat daftar helper dari sheet Users kolom C ("Nama Helper").
 * L. ?app=monitor dan ?app=report kini juga mengirim data batch loader (untuk rapor akurasi penimbangan
 *    & rapor helper). Semua respon GET membawa serverVersion agar layar bisa mendeteksi backend yang belum di-deploy.
 *
 * PERUBAHAN v12.9.0:
 * F. Rahasia (GEMINI_API_KEY, FONNTE_TOKEN) dibaca dari Script Properties, tidak ada lagi di kode/HTML.
 *    Pemanggilan Gemini lewat backend (proxy) dengan batas pemakaian per menit.
 * G. Mode baru ?app=report&from=yyyy-MM-dd&to=yyyy-MM-dd untuk Live Monitoring: pencarian
 *    distribusi per tanggal (membaca Distribusi + Arsip_Distribusi, hasil hari lampau di-cache 6 jam).
 * H. Cache respon loader/mixer/monitor (8-30 dtk, otomatis dibersihkan tiap ada data masuk) supaya
 *    banyak perangkat yang polling tidak membebani spreadsheet. Cache master data 3 menit.
 * I. WhatsApp dikirim SETELAH kunci dilepas (kunci tidak tertahan oleh panggilan jaringan).
 *
 * PERUBAHAN v12.8.0:
 * A. "Hari operasional" berganti jam 04:00 (bukan 00:00). Status pen loader & antrian mixer
 *    otomatis ter-reset jam 04:00. Ubah DAY_START_HOUR jika jam reset ingin diganti.
 * B. Arsip otomatis harian: Input_Data -> Arsip_Input, Distribusi -> Arsip_Distribusi
 *    (jalankan setupDailyArchiveTrigger() SEKALI dari editor untuk memasang trigger).
 * C. LockService di doPost + proses arsip -> tidak ada data tertimpa/dobel saat bersamaan.
 * D. Cegah data dobel dari antrian offline (cek clientId juga ke Arsip_Input).
 * E. Perbaikan: pencarian transaksi tidak lagi jatuh ke nomor baris (sourceRow) yang bisa
 *    bergeser setelah arsip, dan batch dari hari operasional lama ditolak (status 'expired').
 *
 * Fitur Utama:
 * 1. Smart Parameter Routing (?app=loader|mixer|monitor) - Mengirim HANYA data yang dibutuhkan frontend.
 * 2. Accurate Offline Timestamps - Menggunakan data.createdAtLocal sebagai timestamp asli di Spreadsheet.
 * 3. Fast Master Data Caching - Caching Users, Pen, Target Tonase selama 3 menit via CacheService.
 * 4. Zero Read-Write Bottlenecks - Menghapus operasi setValue berulang pada proses GET/doGet.
 */

const SHEET_INPUT = 'Input_Data';
const SHEET_DISTRIBUSI = 'Distribusi';
const SHEET_USERS = 'Users';
const SHEET_PEN = 'Pen';
const SHEET_TONASE = 'TonaseData';
const SHEET_MASTER_DISTRIBUSI = 'MasterDistribusi';
const SHEET_ARSIP_INPUT = 'Arsip_Input';
const SHEET_ARSIP_DIST = 'Arsip_Distribusi';

// Zona waktu tetap WIB (tidak bergantung setelan project) & jam pergantian hari operasional
const TZ = 'Asia/Jakarta';
const DAY_START_HOUR = 4; // 04:00 -> data hari sebelumnya di-reset & diarsipkan

const SPREADSHEET_ID = '1OHHBiz19jzd2NFDwktI6kj5bSuBP1KBGjd9zJ0U2DVU';

const INPUT_READ_LIMIT = 800;
const DIST_READ_LIMIT = 1200;
const CLIENT_ID_SEARCH_LIMIT = 2000;
const MASTER_CACHE_SECONDS = 180; // 3 menit

// WhatsApp Fonnte Configuration
const ENABLE_WHATSAPP = true;
const FONNTE_TARGET = '120363155761919988@g.us';
const FONNTE_URL = 'https://api.fonnte.com/send';
// Token/API key TIDAK ditulis di sini. Isi di: Project Settings > Script Properties
//   FONNTE_TOKEN   = token Fonnte
//   GEMINI_API_KEY = API key Google AI Studio

const GEMINI_MODEL = 'gemini-3-flash-preview';
const GEMINI_TTS_MODEL = 'gemini-2.5-flash-preview-tts';
const GEMINI_MAX_PER_MINUTE = 20;      // batas panggilan AI seluruh perangkat per menit
const GEMINI_MAX_PROMPT_CHARS = 6000;

// Cache respon GET (detik). Dibersihkan otomatis setiap ada data masuk (doPost) & saat arsip.
const RESP_CACHE_SECONDS = { loader: 20, mixer: 8, monitor: 30 };
const REPORT_MAX_DAYS = 31;
const SERVER_VERSION = '13.3.0';
const MASTER_CACHE_KEY = 'tmr_master_v1310';
const SHEET_MASTER_TONASE = 'MasterTonase';
const MIXER_UNITS = ['Trioliet', 'Supreme'];   // pilihan unit mixer di aplikasi Loader

const COL_INPUT = {
  TIMESTAMP: 1,
  OPERATOR: 2,
  SHIFT: 3,
  PENS: 4,
  SISA: 5,
  ODOT: 6,
  JAGUNG: 7,
  SILASE: 8,
  KONSENTRAT: 9,
  MOL_SEBELUM: 10,
  MOL_AKHIR: 11,
  MOL_TOTAL: 12,
  STATUS: 13,
  JAM_START: 14,
  JAM_STOP: 15,
  CLIENT_ID: 16,
  PROCESS_COUNT: 17,
  DIST_JSON: 18,
  TARGET_JSON: 19,    // S : snapshot target tonase
  HELPER_MOL: 20,     // T : helper penuang molases
  MIXER_UNIT: 21      // U : unit mixer (Trioliet / Supreme)
};

const COL_DIST = {
  TIMESTAMP: 1,
  OPERATOR: 2,
  SHIFT: 3,
  PEN: 4,
  TONASE: 5,
  STATUS: 6,
  DURASI: 7,
  CLIENT_ID: 8,
  SOURCE_ROW: 9,
  HELPER: 10          // J : helper pendamping distribusi
};

function openSpreadsheet_() {
  if (SPREADSHEET_ID && String(SPREADSHEET_ID).trim()) {
    return SpreadsheetApp.openById(String(SPREADSHEET_ID).trim());
  }
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  if (!ss) throw new Error('Spreadsheet aktif tidak ditemukan. Isi SPREADSHEET_ID di Code.gs.');
  return ss;
}

function doGet(e) {
  try {
    var appMode = e && e.parameter && e.parameter.app ? String(e.parameter.app).toLowerCase().trim() : '';

    // Laporan per tanggal (Live Monitoring). Punya cache sendiri.
    if (appMode === 'report') return textJson_(getReportText_(e.parameter));

    // Cache respon singkat: banyak HP/monitor yang polling tidak perlu membaca spreadsheet berulang
    var ttl = RESP_CACHE_SECONDS[appMode];
    var cache = CacheService.getScriptCache();
    var cacheKey = ttl ? respCacheKey_(appMode, opDayKey_(new Date())) : '';
    if (cacheKey) {
      var hit = cache.get(cacheKey);
      if (hit) return textJson_(hit);
    }

    var obj = buildGetResponse_(e);
    var text = JSON.stringify(obj);
    if (cacheKey && obj && obj.ok !== false) {
      try { cache.put(cacheKey, text, ttl); } catch (err) {}
    }
    return textJson_(text);
  } catch (err) {
    return json_({ ok: false, success: false, status: 'error', message: String(err && err.message ? err.message : err) });
  }
}

function buildGetResponse_(e) {
  try {
    var ss = openSpreadsheet_();
    var todayKey = opDayKey_(new Date());
    var appMode = e && e.parameter && e.parameter.app ? String(e.parameter.app).toLowerCase().trim() : '';
    
    var master = getMasterData_(ss);   // di-cache; monitor & report memakainya untuk masterDist (rekonsiliasi aktual per pen)
    var responseObj = { ok: true, success: true, status: 'success', opDay: todayKey, dayStartHour: DAY_START_HOUR, serverVersion: SERVER_VERSION };

    // --- MODE 1: APP LOADER ---
    if (appMode === 'loader') {
      responseObj.users = master.users;
      responseObj.helpers = master.helpers || [];
      responseObj.pens = master.pens;
      responseObj.targets = master.targets;
      responseObj.specialTonasePens = master.specialTonasePens;
      
      var sheetInput = ss.getSheetByName(SHEET_INPUT);
      if (sheetInput) {
        var inputBlock = readRecentRows_(sheetInput, INPUT_READ_LIMIT, Math.max(COL_INPUT.DIST_JSON, sheetInput.getLastColumn()));
        var logsToday = [];
        for (var i = 0; i < inputBlock.values.length; i++) {
          var row = inputBlock.values[i];
          if (opDayKeySafe_(row[COL_INPUT.TIMESTAMP - 1]) !== todayKey) continue;
          logsToday.push({
            shift: row[COL_INPUT.SHIFT - 1],
            pens: String(row[COL_INPUT.PENS - 1] || '').trim(),
            processCountValue: normalizeProcessCount_(row[COL_INPUT.PROCESS_COUNT - 1])
          });
        }
        responseObj.history = logsToday;
      }
      return responseObj;
    }

    // --- MODE 2: APP MIXER ---
    if (appMode === 'mixer') {
      responseObj.users = master.users;
      responseObj.helpers = master.helpers || [];
      responseObj.masterDist = master.masterDist;
      
      var sheetInputMix = ss.getSheetByName(SHEET_INPUT);
      if (sheetInputMix) {
        var inputBlockMix = readRecentRows_(sheetInputMix, INPUT_READ_LIMIT, Math.max(COL_INPUT.MIXER_UNIT, sheetInputMix.getLastColumn()));
        var distIndex = buildDistribusiIndexToday_(ss, todayKey);
        var antrian = [];

        for (var j = 0; j < inputBlockMix.values.length; j++) {
          var rowMix = inputBlockMix.values[j];
          var rowNum = inputBlockMix.rowNumbers[j];
          if (opDayKeySafe_(rowMix[COL_INPUT.TIMESTAMP - 1]) !== todayKey) continue;

          var statusMix = String(rowMix[COL_INPUT.STATUS - 1] || '').trim();
          var targetPensMix = splitPens_(rowMix[COL_INPUT.PENS - 1]);
          var distState = getDistributionStateForRowLite_(rowMix, rowNum, distIndex);

          if (distState.pendingPens.length > 0) {
            antrian.push({
              row: rowNum,
              id: rowMix[COL_INPUT.CLIENT_ID - 1] || '',
              clientId: rowMix[COL_INPUT.CLIENT_ID - 1] || '',
              pen: distState.pendingPens.join(', '),
              pens: distState.pendingPens.join(', '),
              allPens: targetPensMix.join(', '),
              tonase: Number(rowMix[COL_INPUT.MOL_AKHIR - 1]) || Number(rowMix[COL_INPUT.MOL_TOTAL - 1]) || 0,
              mixerUnit: normMixerUnit_(rowMix[COL_INPUT.MIXER_UNIT - 1]),
              shift: rowMix[COL_INPUT.SHIFT - 1],
              jamStart: rowMix[COL_INPUT.JAM_START - 1],
              jamStop: rowMix[COL_INPUT.JAM_STOP - 1],
              penSelesai: distState.donePens,
              distribusiStatus: parseJsonSafe_(rowMix[COL_INPUT.DIST_JSON - 1]),
              processCountValue: normalizeProcessCount_(rowMix[COL_INPUT.PROCESS_COUNT - 1]),
              status: statusMix
            });
          }
        }
        responseObj.antrian = antrian;
      }
      return responseObj;
    }

    // --- MODE 3: APP LIVE MONITORING ---
    if (appMode === 'monitor') {
      var sheetInputMon = ss.getSheetByName(SHEET_INPUT);
      if (sheetInputMon) {
        var inputBlockMon = readRecentRows_(sheetInputMon, INPUT_READ_LIMIT, Math.max(COL_INPUT.MIXER_UNIT, sheetInputMon.getLastColumn()));
        var distIndexMon = buildDistribusiIndexToday_(ss, todayKey);
        responseObj.monitor = getSupervisorDataLite_(ss, todayKey, inputBlockMon, distIndexMon);
      }
      responseObj.masterDist = master.masterDist;
      return responseObj;
    }

    // --- DEFAULT RESPONSE ---
    var sheetInputAll = ss.getSheetByName(SHEET_INPUT);
    if (!sheetInputAll) throw new Error('Sheet Input_Data tidak ditemukan');

    var inputBlockAll = readRecentRows_(sheetInputAll, INPUT_READ_LIMIT, Math.max(COL_INPUT.MIXER_UNIT, sheetInputAll.getLastColumn()));
    var distIndexAll = buildDistribusiIndexToday_(ss, todayKey);

    var logsTodayAll = [];
    var antrianAll = [];

    for (var k = 0; k < inputBlockAll.values.length; k++) {
      var rowAll = inputBlockAll.values[k];
      var rowNumberAll = inputBlockAll.rowNumbers[k];
      if (opDayKeySafe_(rowAll[COL_INPUT.TIMESTAMP - 1]) !== todayKey) continue;

      var statusAll = String(rowAll[COL_INPUT.STATUS - 1] || '').trim();
      var clientIdAll = String(rowAll[COL_INPUT.CLIENT_ID - 1] || '').trim();
      var processCountValAll = normalizeProcessCount_(rowAll[COL_INPUT.PROCESS_COUNT - 1]);
      var pensStrAll = String(rowAll[COL_INPUT.PENS - 1] || '').trim();
      var targetPensAll = splitPens_(pensStrAll);
      var distStatusAll = parseJsonSafe_(rowAll[COL_INPUT.DIST_JSON - 1]);

      logsTodayAll.push({
        row: rowNumberAll,
        id: clientIdAll,
        clientId: clientIdAll,
        shift: rowAll[COL_INPUT.SHIFT - 1],
        pen: pensStrAll,
        pens: pensStrAll,
        processCountValue: processCountValAll,
        status: statusAll
      });

      var distStateAll = getDistributionStateForRowLite_(rowAll, rowNumberAll, distIndexAll);
      if (distStateAll.pendingPens.length > 0) {
        antrianAll.push({
          row: rowNumberAll,
          id: clientIdAll,
          clientId: clientIdAll,
          pen: distStateAll.pendingPens.join(', '),
          pens: distStateAll.pendingPens.join(', '),
          allPens: targetPensAll.join(', '),
          tonase: Number(rowAll[COL_INPUT.MOL_AKHIR - 1]) || Number(rowAll[COL_INPUT.MOL_TOTAL - 1]) || 0,
          mixerUnit: normMixerUnit_(rowAll[COL_INPUT.MIXER_UNIT - 1]),
          shift: rowAll[COL_INPUT.SHIFT - 1],
          jamStart: rowAll[COL_INPUT.JAM_START - 1],
          jamStop: rowAll[COL_INPUT.JAM_STOP - 1],
          penSelesai: distStateAll.donePens,
          distribusiStatus: distStatusAll,
          processCountValue: processCountValAll,
          status: statusAll
        });
      }
    }

    responseObj.users = master.users;
    responseObj.helpers = master.helpers || [];
    responseObj.pens = master.pens;
    responseObj.targets = master.targets;
    responseObj.history = logsTodayAll;
    responseObj.specialTonasePens = master.specialTonasePens;
    responseObj.antrian = antrianAll;
    responseObj.masterDist = master.masterDist;
    responseObj.monitor = getSupervisorDataLite_(ss, todayKey, inputBlockAll, distIndexAll);

    return responseObj;
  } catch (err) {
    return { ok: false, success: false, status: 'error', message: String(err && err.message ? err.message : err) };
  }
}

function doPost(e) {
  var data;
  try { data = parsePayload_(e); } catch (perr) { data = {}; }
  var formType = String(data.formType || '').trim();

  // Proxy AI: lambat (panggilan ke Google) -> JANGAN menahan kunci tulis milik operator
  if (formType === 'gemini' || formType === 'geminiTts') return json_(handleGemini_(data, formType));

  // Kunci agar tulis data tidak bertabrakan (sesama operator maupun dengan proses arsip)
  var lock = LockService.getScriptLock();
  try {
    lock.waitLock(15000);
  } catch (lockErr) {
    return json_({ ok: false, success: false, status: 'busy', message: 'Server sedang sibuk, coba lagi beberapa detik.' });
  }

  var out;
  var wa = null;
  try {
    if (formType === 'stopMixing') out = handleStopMixing_(data);
    else if (formType === 'distribusi') out = handleDistribusi_(data);
    else {
      out = handleLoader_(data);
      wa = out._wa || null;
      delete out._wa;
    }
    invalidateResponseCache_();
  } catch (err) {
    out = { ok: false, success: false, status: 'error', message: String(err && err.message ? err.message : err) };
  } finally {
    lock.releaseLock();
  }

  // WhatsApp dikirim setelah kunci dilepas, agar operator lain tidak menunggu jaringan
  if (wa) sendWhatsappMixing_(wa.shift, wa.pens);
  return json_(out);
}

function handleLoader_(data) {
  var ss = openSpreadsheet_();
  var sheetInput = ss.getSheetByName(SHEET_INPUT);
  if (!sheetInput) throw new Error('Sheet Input_Data tidak ditemukan');

  var clientId = String(data.clientId || ('LDR-' + new Date().getTime())).trim();
  var existingRow = findInputRowByClientId_(clientId);

  if (existingRow > 1) {
    return { ok: true, success: true, status: 'duplicate', message: 'Data sudah pernah tersimpan', clientId: clientId, row: existingRow };
  }
  // Data lama dari antrian offline bisa sudah terlanjur diarsipkan -> jangan disimpan dobel
  if (isClientIdInArchive_(clientId)) {
    return { ok: true, success: true, status: 'duplicate', message: 'Data sudah pernah tersimpan (arsip)', clientId: clientId, row: 0 };
  }

  var pens = Array.isArray(data.pens) ? data.pens.join(', ') : String(data.pens || '');
  var processCountValue = normalizeProcessCount_(data.processCountValue || data.processCount || data.jumlahProses || data.countProcess || 1);

  // === TIMESTAMP ASLI INPUT FORM DARI HP OPERATOR ===
  var recordTimestamp = data.createdAtLocal ? toValidDate_(data.createdAtLocal) : new Date();
  if (!recordTimestamp) recordTimestamp = new Date();

  ensureColumns_(sheetInput, COL_INPUT.MIXER_UNIT);
  sheetInput.appendRow([
    recordTimestamp,
    data.operator || '',
    data.shift || '',
    pens,
    Math.round(Number(data.aktual && data.aktual.sisa) || 0),
    Math.round(Number(data.aktual && data.aktual.odot) || 0),
    Math.round(Number(data.aktual && data.aktual.jagung) || 0),
    Math.round(Number(data.aktual && data.aktual.silase) || 0),
    Math.round(Number(data.aktual && data.aktual.konsentrat) || 0),
    Math.round(Number(data.molases && data.molases.sebelum) || 0),
    Math.round(Number(data.molases && data.molases.akhir) || 0),
    Math.round(Number(data.molases && data.molases.total) || 0),
    'Belum',
    recordTimestamp,
    '',
    clientId,
    processCountValue,
    '{}',
    buildTargetJson_(data, getMasterData_(ss)),   // S: snapshot target tonase + target molases (dihitung server)
    cleanName_(data.helperMolases),               // T: helper penuang molases
    normMixerUnit_(data.mixerUnit)                // U: unit mixer
  ]);

  var row = sheetInput.getLastRow();
  // Jangan kirim WA "On Proses" untuk data offline dari hari operasional yang sudah lewat.
  // Pengiriman dilakukan doPost setelah kunci dilepas.
  var waPending = isFromPreviousOpDay_(recordTimestamp) ? null : { shift: data.shift, pens: pens };

  return { ok: true, success: true, status: 'success', message: 'Data loader tersimpan', clientId: clientId, row: row, processCountValue: processCountValue, _wa: waPending };
}

function handleStopMixing_(data) {
  var ss = openSpreadsheet_();
  var sheetInput = ss.getSheetByName(SHEET_INPUT);
  if (!sheetInput) throw new Error('Sheet Input_Data tidak ditemukan');

  var rowNum = findInputTransactionRow_(data.clientId, data.sourceRow);
  if (!rowNum) {
    if (isClientIdInArchive_(data.clientId)) return expiredResponse_();
    throw new Error('Transaksi tidak ditemukan untuk stop mixing');
  }
  if (isFromPreviousOpDay_(sheetInput.getRange(rowNum, COL_INPUT.TIMESTAMP).getValue())) return expiredResponse_();

  var currentStop = sheetInput.getRange(rowNum, COL_INPUT.JAM_STOP).getValue();
  if (!currentStop) sheetInput.getRange(rowNum, COL_INPUT.JAM_STOP).setValue(new Date());

  return {
    ok: true,
    success: true,
    status: 'success',
    message: 'Stop mixing tersimpan',
    row: rowNum,
    clientId: sheetInput.getRange(rowNum, COL_INPUT.CLIENT_ID).getValue() || ''
  };
}

function handleDistribusi_(data) {
  var ss = openSpreadsheet_();
  var sheetInput = ss.getSheetByName(SHEET_INPUT);
  var sheetDist = ss.getSheetByName(SHEET_DISTRIBUSI);

  if (!sheetInput) throw new Error('Sheet Input_Data tidak ditemukan');
  if (!sheetDist) throw new Error('Sheet Distribusi tidak ditemukan');

  var rowNum = findInputTransactionRow_(data.clientId, data.sourceRow);
  if (!rowNum) {
    if (isClientIdInArchive_(data.clientId)) return expiredResponse_();
    throw new Error('Transaksi tidak ditemukan untuk distribusi');
  }

  var rowData = sheetInput.getRange(rowNum, 1, 1, Math.min(Math.max(COL_INPUT.DIST_JSON, sheetInput.getLastColumn()), sheetInput.getMaxColumns())).getValues()[0];
  if (isFromPreviousOpDay_(rowData[COL_INPUT.TIMESTAMP - 1])) return expiredResponse_();
  var clientId = String(rowData[COL_INPUT.CLIENT_ID - 1] || data.clientId || '').trim();

  if (!clientId) {
    clientId = 'LDR-' + new Date().getTime() + '-' + rowNum;
    sheetInput.getRange(rowNum, COL_INPUT.CLIENT_ID).setValue(clientId);
  }

  var pen = cleanPen_(data.pen);
  if (!pen) throw new Error('Pen distribusi kosong');

  var shift = String(data.shift || rowData[COL_INPUT.SHIFT - 1] || '').trim();
  var todayKey = opDayKey_(new Date());

  if (isPenAlreadyDistributed_(ss, todayKey, shift, pen, clientId, rowNum)) {
    return { ok: true, success: true, status: 'duplicate', message: 'Pen ini sudah pernah didistribusi', clientId: clientId, pen: pen, row: rowNum };
  }

  var jamStart = toValidDate_(rowData[COL_INPUT.JAM_START - 1]);
  var jamStopCell = rowData[COL_INPUT.JAM_STOP - 1];
  var jamStop = toValidDate_(jamStopCell) || new Date();
  if (!jamStopCell) sheetInput.getRange(rowNum, COL_INPUT.JAM_STOP).setValue(jamStop);

  var durasi = formatDurationFromDates_(jamStart, jamStop);

  var distJson = parseJsonSafe_(rowData[COL_INPUT.DIST_JSON - 1]);
  distJson[pen] = {
    done: true,
    waktu: new Date().toISOString(),
    operator: data.operator || '',
    helper: cleanName_(data.helper),
    tonase: Math.round(Number(data.tonase) || 0)
  };
  sheetInput.getRange(rowNum, COL_INPUT.DIST_JSON).setValue(JSON.stringify(distJson));

  ensureColumns_(sheetDist, COL_DIST.HELPER);
  sheetDist.appendRow([
    new Date(),
    data.operator || '',
    shift,
    pen,
    Math.round(Number(data.tonase) || 0),
    'Selesai',
    durasi,
    clientId,
    rowNum,
    cleanName_(data.helper)             // J: helper pendamping distribusi
  ]);

  var targetPens = splitPens_(rowData[COL_INPUT.PENS - 1]);
  var allDone = targetPens.length > 0 && targetPens.every(function(pName) {
    var key = cleanPen_(pName);
    return distJson[key] && distJson[key].done;
  });

  sheetInput.getRange(rowNum, COL_INPUT.STATUS).setValue(allDone ? 'Distribusi' : 'Belum');

  return {
    ok: true,
    success: true,
    status: 'success',
    message: 'Distribusi pen tersimpan',
    clientId: clientId,
    row: rowNum,
    pen: pen,
    allDone: allDone
  };
}

function getSupervisorDataLite_(ss, todayKey, inputBlock, distIndex) {
  var monitor = { active: [], pagi: [], siang: [], malam: [], batches: [] };

  for (var i = 0; i < inputBlock.values.length; i++) {
    var row = inputBlock.values[i];
    var rowNumber = inputBlock.rowNumbers[i];
    if (opDayKeySafe_(row[COL_INPUT.TIMESTAMP - 1]) !== todayKey) continue;
    monitor.batches.push(toBatch_(row, toMs_(row[COL_INPUT.TIMESTAMP - 1])));

    var state = getDistributionStateForRowLite_(row, rowNumber, distIndex);
    var status = String(row[COL_INPUT.STATUS - 1] || '').trim();

    if (state.pendingPens.length > 0 && !isFinishedStatus_(status)) {
      monitor.active.push({
        row: rowNumber,
        id: row[COL_INPUT.CLIENT_ID - 1] || '',
        clientId: row[COL_INPUT.CLIENT_ID - 1] || '',
        jamStart: row[COL_INPUT.JAM_START - 1],
        jamStop: row[COL_INPUT.JAM_STOP - 1],
        operator: row[COL_INPUT.OPERATOR - 1],
        shift: row[COL_INPUT.SHIFT - 1],
        pens: state.pendingPens.join(', '),
        allPens: row[COL_INPUT.PENS - 1],
        penSelesai: state.donePens,
        tonase: row[COL_INPUT.MOL_AKHIR - 1] || row[COL_INPUT.MOL_TOTAL - 1] || 0,
        status: row[COL_INPUT.STATUS - 1]
      });
    }
  }

  // Log distribusi hari operasional berjalan (hanya dari sheet Distribusi yang kecil)
  var range = dayRangeMs_(todayKey, todayKey);
  var logs = readDistribusiLogs_(ss, range.start, range.end, { recentLimit: DIST_READ_LIMIT });
  logs.forEach(function(log) {
    var s = String(log.shift || '').toLowerCase();
    if (s.indexOf('pagi') >= 0) monitor.pagi.push(log);
    else if (s.indexOf('siang') >= 0) monitor.siang.push(log);
    else if (s.indexOf('malam') >= 0) monitor.malam.push(log);
  });
  monitor.opDay = todayKey;

  monitor.pagi.reverse();
  monitor.siang.reverse();
  monitor.malam.reverse();
  return monitor;
}

function getMasterData_(ss) {
  var cache = CacheService.getScriptCache();
  var cacheKey = MASTER_CACHE_KEY;
  var cached = cache.get(cacheKey);

  if (cached) {
    try { return JSON.parse(cached); } catch (err) {}
  }

  var sheetUsers = ss.getSheetByName(SHEET_USERS);
  var users = sheetUsers && sheetUsers.getLastRow() >= 2
    ? sheetUsers.getRange('A2:A' + sheetUsers.getLastRow()).getValues().map(function(r){ return r[0]; }).filter(String)
    : [];

  // Nama helper: sheet Users kolom C (judul "Nama Helper")
  var helpers = sheetUsers && sheetUsers.getLastRow() >= 2 && sheetUsers.getMaxColumns() >= 3
    ? sheetUsers.getRange('C2:C' + sheetUsers.getLastRow()).getValues().map(function(r){ return cleanName_(r[0]); }).filter(String)
    : [];

  var sheetPen = ss.getSheetByName(SHEET_PEN);
  var pens = sheetPen && sheetPen.getLastRow() >= 2
    ? sheetPen.getRange('A2:A' + sheetPen.getLastRow()).getValues().map(function(r){ return r[0]; }).filter(String)
    : [];
  var specialTonasePens = sheetPen && sheetPen.getLastRow() >= 2
    ? sheetPen.getRange('A2:A' + Math.min(9, sheetPen.getLastRow())).getValues().map(function(r){ return r[0]; }).filter(String)
    : [];

  var sheetTonase = ss.getSheetByName(SHEET_TONASE);
  var targets = sheetTonase ? sheetTonase.getDataRange().getValues() : [];

  var master = {
    molasesTarget: getMolasesTargets_(ss),   // hanya dipakai server; TIDAK dikirim ke aplikasi
    users: users,
    helpers: helpers,
    pens: pens,
    targets: targets,
    specialTonasePens: specialTonasePens,
    masterDist: buildMasterDistribusiMap_(ss)
  };

  try { cache.put(cacheKey, JSON.stringify(master), MASTER_CACHE_SECONDS); } catch (err) {}
  return master;
}

function buildMasterDistribusiMap_(ss) {
  var masterDistMap = {};
  var sh = ss.getSheetByName(SHEET_MASTER_DISTRIBUSI);
  if (!sh || sh.getLastRow() < 2) return masterDistMap;

  var values = sh.getDataRange().getValues();
  for (var i = 1; i < values.length; i++) {
    var penName = values[i][1];
    if (!penName) continue;
    masterDistMap[penName] = {
      Pagi: values[i][2],
      Siang: values[i][3],
      Malam: values[i][4]
    };
  }
  return masterDistMap;
}

function readRecentRows_(sheet, limit, width) {
  var lastRow = sheet.getLastRow();
  if (lastRow < 2) return { values: [], rowNumbers: [] };
  var startRow = Math.max(2, lastRow - limit + 1);
  var numRows = lastRow - startRow + 1;
  var safeWidth = Math.min(width, sheet.getMaxColumns());
  var values = sheet.getRange(startRow, 1, numRows, safeWidth).getValues();
  var rowNumbers = [];
  for (var i = 0; i < values.length; i++) rowNumbers.push(startRow + i);
  return { values: values, rowNumbers: rowNumbers };
}

function buildDistribusiIndexToday_(ss, todayKey) {
  var sheetDist = ss.getSheetByName(SHEET_DISTRIBUSI);
  var index = { byClientPen: {}, bySourcePen: {}, byShiftPenLegacy: {} };
  if (!sheetDist || sheetDist.getLastRow() < 2) return index;

  var block = readRecentRows_(sheetDist, DIST_READ_LIMIT, Math.max(COL_DIST.SOURCE_ROW, sheetDist.getLastColumn()));
  for (var i = 0; i < block.values.length; i++) {
    var row = block.values[i];
    if (opDayKeySafe_(row[COL_DIST.TIMESTAMP - 1]) !== todayKey) continue;

    var pen = cleanPen_(row[COL_DIST.PEN - 1]);
    if (!pen) continue;

    var clientId = String(row[COL_DIST.CLIENT_ID - 1] || '').trim();
    var sourceRow = Number(row[COL_DIST.SOURCE_ROW - 1] || 0);
    var shift = String(row[COL_DIST.SHIFT - 1] || '').trim();

    if (clientId) index.byClientPen[clientId + '||' + pen] = true;
    if (sourceRow) index.bySourcePen[sourceRow + '||' + pen] = true;
    if (shift) index.byShiftPenLegacy[shift + '||' + pen] = true;
  }
  return index;
}

function getDistributionStateForRowLite_(rowData, rowNumber, distIndex) {
  var targetPens = splitPens_(rowData[COL_INPUT.PENS - 1]);
  var distStatus = parseJsonSafe_(rowData[COL_INPUT.DIST_JSON - 1]);
  var clientId = String(rowData[COL_INPUT.CLIENT_ID - 1] || '').trim();
  var shift = String(rowData[COL_INPUT.SHIFT - 1] || '').trim();

  var donePens = [];
  var pendingPens = [];

  targetPens.forEach(function(pName) {
    var key = cleanPen_(pName);
    var cell = distStatus[key];
    var doneFromJson = false;

    if (cell && typeof cell === 'object') {
      doneFromJson = cell.done === true || String(cell.status || '').toLowerCase() === 'selesai';
    } else if (typeof cell === 'string') {
      doneFromJson = String(cell).toLowerCase() === 'selesai' || String(cell).toLowerCase() === 'done';
    }

    var doneFromLog = false;
    if (clientId && distIndex.byClientPen[clientId + '||' + key]) doneFromLog = true;
    if (!doneFromLog && rowNumber && distIndex.bySourcePen[rowNumber + '||' + key]) doneFromLog = true;
    if (!doneFromLog && !clientId && !rowNumber && shift && distIndex.byShiftPenLegacy[shift + '||' + key]) doneFromLog = true;

    if (doneFromJson || doneFromLog) donePens.push(key);
    else pendingPens.push(key);
  });
  
  return { totalPens: targetPens.length, donePens: donePens, pendingPens: pendingPens };
}

function isPenAlreadyDistributed_(ss, todayKey, shift, pen, clientId, sourceRow) {
  var distIndex = buildDistribusiIndexToday_(ss, todayKey);
  var cleanPenName = cleanPen_(pen);
  var cleanClientId = String(clientId || '').trim();
  var src = Number(sourceRow || 0);
  var cleanShift = String(shift || '').trim();

  if (cleanClientId && distIndex.byClientPen[cleanClientId + '||' + cleanPenName]) return true;
  if (src && distIndex.bySourcePen[src + '||' + cleanPenName]) return true;
  if (!cleanClientId && !src && cleanShift && distIndex.byShiftPenLegacy[cleanShift + '||' + cleanPenName]) return true;
  return false;
}

function findInputTransactionRow_(clientId, sourceRow) {
  // Jika clientId ada, HANYA cari lewat clientId. Nomor baris bisa bergeser setelah arsip,
  // jadi fallback ke sourceRow berisiko menulis ke transaksi yang salah.
  if (String(clientId || '').trim()) return findInputRowByClientId_(clientId);

  var ss = openSpreadsheet_();
  var sh = ss.getSheetByName(SHEET_INPUT);
  var rowNum = Number(sourceRow || 0);
  if (rowNum > 1 && sh && rowNum <= sh.getLastRow()) return rowNum;
  return 0;
}

function findInputRowByClientId_(clientId) {
  clientId = String(clientId || '').trim();
  if (!clientId) return 0;

  var ss = openSpreadsheet_();
  var sh = ss.getSheetByName(SHEET_INPUT);
  if (!sh || sh.getLastRow() < 2) return 0;

  var lastRow = sh.getLastRow();
  var startRow = Math.max(2, lastRow - CLIENT_ID_SEARCH_LIMIT + 1);
  var values = sh.getRange(startRow, COL_INPUT.CLIENT_ID, lastRow - startRow + 1, 1).getValues();
  for (var i = values.length - 1; i >= 0; i--) {
    if (String(values[i][0] || '').trim() === clientId) return startRow + i;
  }
  return 0;
}

function normalizeProcessCount_(value) {
  var text = String(value || '').trim();
  if (!text) return 1;
  if (text.indexOf('%') >= 0) {
    var pct = Number(text.replace('%', '').trim());
    if (pct === 25) return 1;
    if (pct === 50) return 2;
    if (pct === 75) return 3;
    if (pct === 100) return 4;
  }
  var n = Number(text);
  return isFinite(n) && n > 0 ? n : 1;
}

function isFinishedStatus_(status) {
  var s = String(status || '').trim().toLowerCase();
  return s === 'distribusi' || s === 'done' || s === 'selesai';
}

function splitPens_(value) {
  return String(value || '').split(',').map(function(x) { return cleanPen_(x); }).filter(String);
}

function cleanPen_(value) {
  return String(value || '').replace(/\s+/g, ' ').trim();
}

function parsePayload_(e) {
  if (e && e.postData && e.postData.contents) {
    try { return JSON.parse(e.postData.contents); } catch (err) {}
  }
  return e && e.parameter ? e.parameter : {};
}

function parseJsonSafe_(value) {
  try {
    if (!value) return {};
    if (typeof value === 'object') return value;
    return JSON.parse(String(value));
  } catch (err) {
    return {};
  }
}

function toValidDate_(value) {
  if (!value) return null;
  if (Object.prototype.toString.call(value) === '[object Date]' && !isNaN(value.getTime())) return value;
  var text = String(value).trim();
  if (!text) return null;
  
  var m = text.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})\s+(\d{1,2}):(\d{2})(?::(\d{2}))?$/);
  if (m) {
    var d1 = new Date(Number(m[3]), Number(m[2]) - 1, Number(m[1]), Number(m[4]), Number(m[5]), Number(m[6] || 0));
    if (!isNaN(d1.getTime())) return d1;
  }

  var d2 = new Date(text);
  if (!isNaN(d2.getTime())) return d2;
  return null;
}

function formatDurationFromDates_(startDate, stopDate) {
  if (!startDate || !stopDate) return '00:00';
  var diffMs = stopDate.getTime() - startDate.getTime();
  if (!isFinite(diffMs) || diffMs < 0 || diffMs > 12 * 60 * 60 * 1000) return '00:00';
  return formatDuration_(diffMs);
}

function formatDuration_(diffMs) {
  var totalDetik = Math.max(0, Math.floor(Number(diffMs || 0) / 1000));
  var menit = Math.floor(totalDetik / 60);
  var detik = totalDetik % 60;
  return String(menit).padStart(2, '0') + ':' + String(detik).padStart(2, '0');
}

/**
 * Kunci "hari operasional" (yyyy-MM-dd). Jam 00:00-03:59 masih dihitung hari sebelumnya,
 * hari baru dimulai tepat jam DAY_START_HOUR. WIB tidak punya DST, jadi geser jam aman.
 */
function opDayKey_(dateObj) {
  var shifted = new Date(new Date(dateObj).getTime() - DAY_START_HOUR * 60 * 60 * 1000);
  return Utilities.formatDate(shifted, TZ, 'yyyy-MM-dd');
}

function opDayKeySafe_(value) {
  if (!value) return '';
  var d = toValidDate_(value);
  if (!d) return '';
  return opDayKey_(d);
}

function isFromPreviousOpDay_(value) {
  var k = opDayKeySafe_(value);
  return !!k && k < opDayKey_(new Date());
}

function expiredResponse_() {
  return {
    ok: false, success: false, status: 'expired',
    message: 'Hari operasional sudah berganti (jam 0' + DAY_START_HOUR + ':00). Batch ini sudah di-reset, silakan input ulang dari Loader.'
  };
}

function json_(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
}

function sendWhatsappMixing_(shift, pens) {
  if (!ENABLE_WHATSAPP || !shift || !pens) return;
  var icon = "🚜";
  var s = String(shift).toUpperCase();
  if (s === "PAGI") icon = "🌅";
  else if (s === "SIANG") icon = "☀️";
  else if (s === "MALAM") icon = "🌙";

  var token = getProp_('FONNTE_TOKEN');
  if (!token) { Logger.log('FONNTE_TOKEN belum diisi di Script Properties. WhatsApp dilewati.'); return; }

  var message = icon + " FEEDING " + s + "\n\n" + pens + "\n🟡 On Proses";
  var options = {
    method: "post",
    headers: { Authorization: token },
    payload: { target: FONNTE_TARGET, message: message },
    muteHttpExceptions: true
  };
  try { UrlFetchApp.fetch(FONNTE_URL, options); } catch(err) { Logger.log(err); }
}

function clearTmrCache() {
  CacheService.getScriptCache().remove(MASTER_CACHE_KEY);
  invalidateResponseCache_();
  return { ok: true, success: true, message: 'Cache master data dibersihkan.' };
}

/* =====================================================================
 * ARSIP OTOMATIS HARIAN
 * Input_Data  -> Arsip_Input
 * Distribusi  -> Arsip_Distribusi
 *
 * Yang dipindah HANYA baris dari hari operasional sebelumnya (kunci < hari operasional
 * sekarang). Baris hari ini (mis. loader yang input jam 04:05 sebelum trigger jalan)
 * tidak ikut terpindah. Aman dijalankan berulang (idempotent).
 * ===================================================================== */

/** Jalankan SEKALI dari editor Apps Script untuk memasang trigger harian. */
function setupDailyArchiveTrigger() {
  removeArchiveTriggers();
  // Trigger harian Apps Script hanya bisa "sekitar" menit tertentu (+/- 15 menit).
  // nearMinute(30) -> jalan sekitar 04:15-04:45, tetap di dalam jam 4.
  // Reset di aplikasi tetap tepat 04:00 karena dihitung dari jam, bukan dari trigger ini.
  ScriptApp.newTrigger('archiveDataHarian')
    .timeBased()
    .everyDays(1)
    .atHour(DAY_START_HOUR)
    .nearMinute(30)
    .inTimezone(TZ)
    .create();
  Logger.log('Trigger arsip harian terpasang (sekitar jam 0' + DAY_START_HOUR + ':30 ' + TZ + ').');
}

function removeArchiveTriggers() {
  ScriptApp.getProjectTriggers().forEach(function(t) {
    if (t.getHandlerFunction() === 'archiveDataHarian') ScriptApp.deleteTrigger(t);
  });
}

/** Uji coba tanpa memindahkan apa pun: lihat hasilnya di Execution log. */
function dryRunArchive() {
  var ss = openSpreadsheet_();
  var key = opDayKey_(new Date());
  var a = moveOldRows_(ss, SHEET_INPUT, SHEET_ARSIP_INPUT, COL_INPUT.TIMESTAMP, COL_INPUT.MIXER_UNIT, key, true);
  var b = moveOldRows_(ss, SHEET_DISTRIBUSI, SHEET_ARSIP_DIST, COL_DIST.TIMESTAMP, COL_DIST.HELPER, key, true);
  Logger.log('DRY RUN | hari operasional: ' + key +
    ' | Input_Data: pindah ' + a.moved + ', tetap ' + a.kept +
    ' | Distribusi: pindah ' + b.moved + ', tetap ' + b.kept);
}

/** Dipanggil trigger harian. Bisa juga dijalankan manual kapan saja. */
function archiveDataHarian() {
  var lock = LockService.getScriptLock();
  if (!lock.tryLock(60000)) {
    Logger.log('Arsip dibatalkan: tidak dapat kunci (server sibuk). Akan tersusul di jadwal berikutnya.');
    return;
  }

  try {
    var ss = openSpreadsheet_();
    var key = opDayKey_(new Date());

    // 1) Input_Data dulu (hasilnya dipakai untuk memperbarui SourceRow di Distribusi)
    var a = moveOldRows_(ss, SHEET_INPUT, SHEET_ARSIP_INPUT, COL_INPUT.TIMESTAMP, COL_INPUT.MIXER_UNIT, key, false);

    // 2) Distribusi. Nomor baris Input_Data yang tersisa sudah bergeser -> perbarui SourceRow
    var newRowByClientId = {};
    a.keptRows.forEach(function(row, i) {
      var cid = String(row[COL_INPUT.CLIENT_ID - 1] || '').trim();
      if (cid) newRowByClientId[cid] = i + 2;
    });
    var b = moveOldRows_(ss, SHEET_DISTRIBUSI, SHEET_ARSIP_DIST, COL_DIST.TIMESTAMP, COL_DIST.HELPER, key, false, function(row) {
      var cid = String(row[COL_DIST.CLIENT_ID - 1] || '').trim();
      if (cid && newRowByClientId[cid]) row[COL_DIST.SOURCE_ROW - 1] = newRowByClientId[cid];
    });

    CacheService.getScriptCache().remove(MASTER_CACHE_KEY);
    invalidateResponseCache_();
    Logger.log('ARSIP OK | hari operasional: ' + key +
      ' | Input_Data: pindah ' + a.moved + ', tetap ' + a.kept +
      ' | Distribusi: pindah ' + b.moved + ', tetap ' + b.kept);
  } finally {
    lock.releaseLock();
  }
}

/**
 * Pindahkan baris lama dari sheet sumber ke sheet arsip.
 * Urutan aman: (1) salin ke arsip -> (2) verifikasi -> (3) baru hapus dari sumber.
 * Jika langkah 1/2 gagal, sumber tidak disentuh sama sekali.
 */
function moveOldRows_(ss, srcName, dstName, tsCol, minWidth, currentKey, dryRun, fixKeptRow) {
  var src = ss.getSheetByName(srcName);
  if (!src) throw new Error('Sheet ' + srcName + ' tidak ditemukan');

  var lastRow = src.getLastRow();
  var result = { moved: 0, kept: 0, keptRows: [] };
  if (lastRow < 2) return result;

  var width = Math.min(Math.max(minWidth, src.getLastColumn()), src.getMaxColumns());
  var values = src.getRange(2, 1, lastRow - 1, width).getValues();

  var toMove = [];
  var toKeep = [];
  for (var i = 0; i < values.length; i++) {
    var row = values[i];
    var blank = row.every(function(c) { return c === '' || c === null; });
    if (blank) continue; // baris kosong dibuang
    var key = opDayKeySafe_(row[tsCol - 1]);
    if (key && key >= currentKey) toKeep.push(row);   // hari operasional berjalan (atau lebih baru)
    else toMove.push(row);                            // hari lama / timestamp tak terbaca
  }

  result.moved = toMove.length;
  result.kept = toKeep.length;
  result.keptRows = toKeep;
  if (dryRun || toMove.length === 0) return result;

  // (1) salin ke arsip
  var dst = getOrCreateArchiveSheet_(ss, dstName, src, width);
  var startRow = dst.getLastRow() + 1;
  var endRow = startRow + toMove.length - 1;
  if (endRow > dst.getMaxRows()) dst.insertRowsAfter(dst.getMaxRows(), endRow - dst.getMaxRows());
  if (width > dst.getMaxColumns()) dst.insertColumnsAfter(dst.getMaxColumns(), width - dst.getMaxColumns());
  dst.getRange(startRow, 1, toMove.length, width).setValues(toMove);
  SpreadsheetApp.flush();

  // (2) verifikasi
  if (dst.getLastRow() < endRow) throw new Error('Verifikasi arsip ' + dstName + ' gagal, data sumber tidak dihapus.');

  // (3) tulis ulang sumber hanya berisi baris yang tetap
  if (fixKeptRow) toKeep.forEach(fixKeptRow);
  src.getRange(2, 1, lastRow - 1, width).clearContent();
  if (toKeep.length > 0) src.getRange(2, 1, toKeep.length, width).setValues(toKeep);

  // rapikan grid kosong yang menumpuk (sisakan minimal 500 baris)
  try {
    var keepRows = Math.max(500, toKeep.length + 50);
    if (src.getMaxRows() > keepRows + 500) src.deleteRows(keepRows + 1, src.getMaxRows() - keepRows);
  } catch (err) { Logger.log('Trim grid dilewati: ' + err); }

  return result;
}

function getOrCreateArchiveSheet_(ss, name, srcSheet, width) {
  var sh = ss.getSheetByName(name);
  if (!sh) sh = ss.insertSheet(name);
  if (sh.getLastRow() === 0) {
    // arsip masih kosong -> salin baris judul dari sheet sumber
    var header = srcSheet.getRange(1, 1, 1, width).getValues();
    if (width > sh.getMaxColumns()) sh.insertColumnsAfter(sh.getMaxColumns(), width - sh.getMaxColumns());
    sh.getRange(1, 1, 1, width).setValues(header);
  }
  return sh;
}

/** Apakah clientId sudah ada di Arsip_Input? (mencegah data dobel dari antrian offline) */
function isClientIdInArchive_(clientId) {
  clientId = String(clientId || '').trim();
  if (!clientId) return false;
  var sh = openSpreadsheet_().getSheetByName(SHEET_ARSIP_INPUT);
  if (!sh || sh.getLastRow() < 2 || sh.getMaxColumns() < COL_INPUT.CLIENT_ID) return false;

  var lastRow = sh.getLastRow();
  var startRow = Math.max(2, lastRow - CLIENT_ID_SEARCH_LIMIT + 1);
  var values = sh.getRange(startRow, COL_INPUT.CLIENT_ID, lastRow - startRow + 1, 1).getValues();
  for (var i = values.length - 1; i >= 0; i--) {
    if (String(values[i][0] || '').trim() === clientId) return true;
  }
  return false;
}


/* =====================================================================
 * SCRIPT PROPERTIES, CACHE RESPON, PROXY GEMINI
 * ===================================================================== */

function getProp_(name) {
  return String(PropertiesService.getScriptProperties().getProperty(name) || '').trim();
}

/** Jalankan dari editor untuk memastikan rahasia sudah terisi (nilainya TIDAK ditampilkan). */
function checkSetup() {
  ['GEMINI_API_KEY', 'FONNTE_TOKEN'].forEach(function(k) {
    var v = getProp_(k);
    Logger.log(k + ': ' + (v ? 'terisi (' + v.length + ' karakter)' : 'KOSONG - isi di Project Settings > Script Properties'));
  });
  Logger.log('Hari operasional sekarang: ' + opDayKey_(new Date()) + ' (reset jam 0' + DAY_START_HOUR + ':00 ' + TZ + ')');
  var triggers = ScriptApp.getProjectTriggers().filter(function(t) { return t.getHandlerFunction() === 'archiveDataHarian'; });
  Logger.log('Trigger arsip harian: ' + (triggers.length ? 'terpasang' : 'BELUM - jalankan setupDailyArchiveTrigger()'));
}

function textJson_(text) {
  return ContentService.createTextOutput(text).setMimeType(ContentService.MimeType.JSON);
}

function respCacheKey_(mode, dayKey) {
  return 'tmr_resp_v2_' + mode + '_' + dayKey;
}

/** Hapus cache respon (hari operasional sekarang & sebelumnya). Dipanggil setiap ada data masuk. */
function invalidateResponseCache_() {
  try {
    var now = new Date();
    var days = [opDayKey_(now), opDayKey_(new Date(now.getTime() - 24 * 60 * 60 * 1000))];
    var keys = [];
    days.forEach(function(d) {
      Object.keys(RESP_CACHE_SECONDS).forEach(function(m) { keys.push(respCacheKey_(m, d)); });
    });
    CacheService.getScriptCache().removeAll(keys);
  } catch (err) { Logger.log('invalidateResponseCache_: ' + err); }
}

function gemErr_(message, status) {
  return { ok: false, success: false, status: status || 'error', message: message };
}

/**
 * Proxy Gemini. API key hanya ada di Script Properties.
 * Dipanggil TANPA kunci tulis (lihat doPost). Dibatasi GEMINI_MAX_PER_MINUTE per menit.
 */
function handleGemini_(data, formType) {
  var apiKey = getProp_('GEMINI_API_KEY');
  if (!apiKey) return gemErr_('GEMINI_API_KEY belum diisi di Script Properties.');

  var prompt = String(data.prompt || '').slice(0, GEMINI_MAX_PROMPT_CHARS);
  var sys = String(data.systemInstruction || '').slice(0, 1500);
  if (!prompt.trim()) return gemErr_('Prompt kosong.');

  var cache = CacheService.getScriptCache();
  var rlKey = 'tmr_gem_rl_' + Math.floor(new Date().getTime() / 60000);
  var used = Number(cache.get(rlKey) || 0);
  if (used >= GEMINI_MAX_PER_MINUTE) return gemErr_('AI sedang ramai, coba lagi sebentar lagi.', 'busy');
  try { cache.put(rlKey, String(used + 1), 90); } catch (err) {}

  var model, payload;
  if (formType === 'geminiTts') {
    model = GEMINI_TTS_MODEL;
    payload = {
      contents: [{ parts: [{ text: 'Bacakan ringkasan laporan pakan ini dengan nada tegas, jelas, dan profesional: ' + prompt.slice(0, 500) }] }],
      generationConfig: {
        responseModalities: ['AUDIO'],
        speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: 'Kore' } } }
      }
    };
  } else {
    model = GEMINI_MODEL;
    payload = { contents: [{ parts: [{ text: prompt }] }] };
    if (sys) payload.systemInstruction = { parts: [{ text: sys }] };
  }

  var res;
  try {
    res = UrlFetchApp.fetch('https://generativelanguage.googleapis.com/v1beta/models/' + model + ':generateContent', {
      method: 'post',
      contentType: 'application/json',
      headers: { 'x-goog-api-key': apiKey },
      payload: JSON.stringify(payload),
      muteHttpExceptions: true
    });
  } catch (err) {
    Logger.log('Gemini fetch error: ' + err);
    return gemErr_('Tidak dapat menghubungi layanan AI.');
  }

  var code = res.getResponseCode();
  if (code !== 200) {
    Logger.log('Gemini HTTP ' + code + ': ' + String(res.getContentText()).slice(0, 300));
    return gemErr_('Layanan AI sedang tidak tersedia (HTTP ' + code + ').');
  }

  var json;
  try { json = JSON.parse(res.getContentText()); } catch (err) { return gemErr_('Respon AI tidak valid.'); }
  var parts = (json.candidates && json.candidates[0] && json.candidates[0].content && json.candidates[0].content.parts) || [];

  if (formType === 'geminiTts') {
    var p0 = parts[0] && parts[0].inlineData;
    if (!p0 || !p0.data) return gemErr_('Audio AI tidak tersedia.');
    return { ok: true, success: true, status: 'success', audio: p0.data, mimeType: p0.mimeType || 'audio/L16;rate=24000' };
  }

  var text = parts.map(function(p) { return p.text || ''; }).join('');
  if (!text) return gemErr_('Respon AI kosong.');
  return { ok: true, success: true, status: 'success', text: text };
}


/* =====================================================================
 * LAPORAN DISTRIBUSI PER TANGGAL  (?app=report&from=yyyy-MM-dd&to=yyyy-MM-dd)
 *
 * Hanya-baca, TANPA LockService -> tidak pernah menghalangi operator loader/mixer.
 * Sumber: Distribusi (hari berjalan) + Arsip_Distribusi (hari lampau).
 * Hari lampau tidak berubah lagi -> hasilnya di-cache 6 jam, jadi membuka laporan
 * yang sama berulang kali tidak menyentuh spreadsheet.
 * ===================================================================== */

function isValidDayKey_(s) {
  var m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(s || ''));
  if (!m) return false;
  var y = Number(m[1]), mo = Number(m[2]), d = Number(m[3]);
  var dt = new Date(Date.UTC(y, mo - 1, d));
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === mo - 1 && dt.getUTCDate() === d;
}

/** Batas waktu (ms) dari awal hari operasional `fromKey` sampai akhir hari operasional `toKey`. */
function dayRangeMs_(fromKey, toKey) {
  var hh = (DAY_START_HOUR < 10 ? '0' : '') + DAY_START_HOUR;
  var start = Utilities.parseDate(fromKey + ' ' + hh + ':00', TZ, 'yyyy-MM-dd HH:mm').getTime();
  var lastStart = Utilities.parseDate(toKey + ' ' + hh + ':00', TZ, 'yyyy-MM-dd HH:mm').getTime();
  return { start: start, end: lastStart + 24 * 60 * 60 * 1000 }; // WIB tanpa DST
}

function getReportText_(p) {
  var from = String((p && p.from) || '').trim();
  var to = String((p && p.to) || from).trim();
  if (!isValidDayKey_(from) || !isValidDayKey_(to)) {
    return JSON.stringify({ ok: false, success: false, status: 'error', message: 'Format tanggal harus yyyy-MM-dd.' });
  }
  if (from > to) { var tmp = from; from = to; to = tmp; }

  var range = dayRangeMs_(from, to);
  var days = Math.round((range.end - range.start) / (24 * 60 * 60 * 1000));
  if (days > REPORT_MAX_DAYS) {
    return JSON.stringify({ ok: false, success: false, status: 'error', message: 'Rentang tanggal maksimal ' + REPORT_MAX_DAYS + ' hari.' });
  }

  var todayKey = opDayKey_(new Date());
  var isPast = to < todayKey;
  var cache = CacheService.getScriptCache();
  var cacheKey = 'tmr_rep_v2_' + from + '_' + to;
  var hit = cache.get(cacheKey);
  if (hit) return hit;

  var ssRep = openSpreadsheet_();
  var logs = readDistribusiLogs_(ssRep, range.start, range.end, { includeArchive: true });
  var batches = readInputBatches_(ssRep, range.start, range.end, { includeArchive: true });
  var masterRep = getMasterData_(ssRep);
  var text = JSON.stringify({
    ok: true, success: true, status: 'success',
    serverVersion: SERVER_VERSION,
    from: from, to: to, days: days, opDay: todayKey, dayStartHour: DAY_START_HOUR,
    count: logs.length, logs: logs, batches: batches, masterDist: masterRep.masterDist,
    generatedAt: Utilities.formatDate(new Date(), TZ, "yyyy-MM-dd'T'HH:mm:ssXXX")
  });
  try { cache.put(cacheKey, text, isPast ? 21600 : 30); } catch (err) {} // >100KB dilewati otomatis
  return text;
}

/**
 * Baca log distribusi dengan timestamp di [startMs, endMs).
 * opts.recentLimit : batasi hanya N baris terakhir dari sheet Distribusi (mode live)
 * opts.includeArchive : ikut baca Arsip_Distribusi (mode laporan)
 */
function readDistribusiLogs_(ss, startMs, endMs, opts) {
  opts = opts || {};
  var logs = [];
  var seen = {};

  var sheetDist = ss.getSheetByName(SHEET_DISTRIBUSI);
  if (sheetDist && sheetDist.getLastRow() >= 2) {
    var lastRow = sheetDist.getLastRow();
    var startRow = opts.recentLimit ? Math.max(2, lastRow - opts.recentLimit + 1) : 2;
    collectDistRows_(sheetDist, startRow, lastRow, startMs, endMs, logs, seen);
  }

  if (opts.includeArchive) {
    var arsip = ss.getSheetByName(SHEET_ARSIP_DIST);
    if (arsip && arsip.getLastRow() >= 2) {
      var n = arsip.getLastRow() - 1;
      // Baca HANYA kolom waktu untuk menemukan blok baris yang dibutuhkan, lalu baca blok itu saja
      var ts = arsip.getRange(2, COL_DIST.TIMESTAMP, n, 1).getValues();
      var first = -1, last = -1;
      for (var i = 0; i < n; i++) {
        var t = toMs_(ts[i][0]);
        if (t >= startMs && t < endMs) { if (first < 0) first = i; last = i; }
      }
      if (first >= 0) collectDistRows_(arsip, first + 2, last + 2, startMs, endMs, logs, seen);
    }
  }

  logs.sort(function(a, b) { return a.waktu < b.waktu ? -1 : (a.waktu > b.waktu ? 1 : 0); });
  return logs;
}

function collectDistRows_(sheet, startRow, endRow, startMs, endMs, logs, seen) {
  var n = endRow - startRow + 1;
  if (n < 1) return;
  var width = Math.min(COL_DIST.HELPER, sheet.getMaxColumns());
  var vals = sheet.getRange(startRow, 1, n, width).getValues();
  // Kolom durasi dibaca sebagai teks tampilan: Sheets kadang mengubah "05:23" menjadi nilai jam
  var durs = sheet.getRange(startRow, COL_DIST.DURASI, n, 1).getDisplayValues();

  for (var i = 0; i < n; i++) {
    var row = vals[i];
    var ms = toMs_(row[COL_DIST.TIMESTAMP - 1]);
    if (!(ms >= startMs && ms < endMs)) continue;

    var pen = cleanPen_(row[COL_DIST.PEN - 1]);
    if (!pen) continue;

    var clientId = String(row[COL_DIST.CLIENT_ID - 1] || '').trim();
    var dedupe = (clientId || 'x') + '||' + pen + '||' + ms; // cegah dobel saat arsip sedang berjalan
    if (seen[dedupe]) continue;
    seen[dedupe] = true;

    var d = new Date(ms);
    var iso = Utilities.formatDate(d, TZ, "yyyy-MM-dd'T'HH:mm:ssXXX");
    logs.push({
      waktu: iso,
      cal: iso.slice(0, 10),
      jam: iso.slice(11, 16),
      day: opDayKey_(d),
      operator: String(row[COL_DIST.OPERATOR - 1] || '').trim(),
      shift: normShift_(row[COL_DIST.SHIFT - 1]),
      pen: pen,
      tonase: Number(row[COL_DIST.TONASE - 1]) || 0,
      durasi: normDurasi_(durs[i][0]),
      helper: cleanName_(row[COL_DIST.HELPER - 1]),
      clientId: clientId
    });
  }
}

function toMs_(value) {
  if (value instanceof Date) return value.getTime();
  var d = toValidDate_(value);
  return d ? d.getTime() : NaN;
}

function normShift_(value) {
  var s = String(value || '').trim();
  var l = s.toLowerCase();
  if (l.indexOf('pagi') >= 0) return 'Pagi';
  if (l.indexOf('siang') >= 0) return 'Siang';
  if (l.indexOf('malam') >= 0) return 'Malam';
  return s;
}

/**
 * Rapikan durasi menjadi "MM:SS".
 * Aplikasi menulis "MM:SS" (mis. 05:23). Google Sheets bisa membacanya sebagai jam:menit
 * dan menampilkannya "5:23:00" -> dikembalikan lagi menjadi 05:23.
 */
function normDurasi_(display) {
  var s = String(display == null ? '' : display).trim();
  if (!s) return '';
  var pad = function(n) { n = String(n); return n.length < 2 ? '0' + n : n; };
  var m3 = /^(\d+):(\d{2}):(\d{2})$/.exec(s);
  if (m3) {
    if (m3[3] === '00') return pad(m3[1]) + ':' + m3[2];                       // "5:23:00" -> "05:23"
    return pad(Number(m3[1]) * 60 + Number(m3[2])) + ':' + m3[3];              // durasi jam:menit:detik asli
  }
  var m2 = /^(\d+):(\d{2})$/.exec(s);
  if (m2) return pad(m2[1]) + ':' + m2[2];
  return s;
}



/* =====================================================================
 * v13: TARGET, HELPER, DAN DATA BATCH LOADER UNTUK RAPOR
 * ===================================================================== */

function cleanName_(v) {
  return String(v == null ? '' : v).replace(/\s+/g, ' ').trim().slice(0, 60);
}

/** Snapshot target dari loader -> JSON untuk kolom S. Hanya angka; selain itu dibuang. */
function sanitizeTarget_(t) {
  if (!t || typeof t !== 'object') return '';
  var out = {};
  ['sisa', 'odot', 'jagung', 'silase', 'konsentrat'].forEach(function(k) {
    out[k] = Math.round(Number(t[k]) || 0);
  });
  out.pct = Number(t.pct) || 0;
  return JSON.stringify(out);
}

/** Pastikan sheet punya minimal n kolom (kolom baru S/T/J ditambah otomatis bila belum ada). */
function ensureColumns_(sheet, n) {
  var have = sheet.getMaxColumns();
  if (have < n) sheet.insertColumnsAfter(have, n - have);
}

function numOr0_(v) { var n = Number(v); return isFinite(n) ? n : 0; }

/** Ubah satu baris Input_Data/Arsip_Input menjadi objek batch ringkas untuk rapor. */
function toBatch_(row, ms) {
  var d = new Date(ms);
  var iso = Utilities.formatDate(d, TZ, "yyyy-MM-dd'T'HH:mm:ssXXX");
  var t = parseJsonSafe_(row[COL_INPUT.TARGET_JSON - 1]);
  var hasTarget = t && typeof t === 'object' && t.jagung !== undefined;
  return {
    clientId: String(row[COL_INPUT.CLIENT_ID - 1] || '').trim(),
    waktu: iso,
    cal: iso.slice(0, 10),
    jam: iso.slice(11, 16),
    day: opDayKey_(d),
    shift: normShift_(row[COL_INPUT.SHIFT - 1]),
    loader: cleanName_(row[COL_INPUT.OPERATOR - 1]),
    pens: String(row[COL_INPUT.PENS - 1] || ''),
    akt: {
      sisa: numOr0_(row[COL_INPUT.SISA - 1]), odot: numOr0_(row[COL_INPUT.ODOT - 1]),
      jagung: numOr0_(row[COL_INPUT.JAGUNG - 1]), silase: numOr0_(row[COL_INPUT.SILASE - 1]),
      konsentrat: numOr0_(row[COL_INPUT.KONSENTRAT - 1])
    },
    tgt: hasTarget ? {
      sisa: numOr0_(t.sisa), odot: numOr0_(t.odot), jagung: numOr0_(t.jagung),
      silase: numOr0_(t.silase), konsentrat: numOr0_(t.konsentrat), pct: numOr0_(t.pct), molases: numOr0_(t.molases)
    } : null,
    mol: { sebelum: numOr0_(row[COL_INPUT.MOL_SEBELUM - 1]), akhir: numOr0_(row[COL_INPUT.MOL_AKHIR - 1]), total: numOr0_(row[COL_INPUT.MOL_TOTAL - 1]) },
    helperMol: cleanName_(row[COL_INPUT.HELPER_MOL - 1]),
    mixerUnit: normMixerUnit_(row[COL_INPUT.MIXER_UNIT - 1])
  };
}

/**
 * Batch loader dengan timestamp di [startMs, endMs). Sumber: Input_Data (+ Arsip_Input untuk hari lampau).
 * Pola sama dengan readDistribusiLogs_: hanya membaca kolom waktu arsip lalu blok yang dibutuhkan.
 */
function readInputBatches_(ss, startMs, endMs, opts) {
  opts = opts || {};
  var out = [];
  var seen = {};

  function collect(sheet, startRow, endRow) {
    var n = endRow - startRow + 1;
    if (n < 1) return;
    var width = Math.min(Math.max(COL_INPUT.MIXER_UNIT, sheet.getLastColumn()), sheet.getMaxColumns());
    var vals = sheet.getRange(startRow, 1, n, width).getValues();
    for (var i = 0; i < n; i++) {
      var row = vals[i];
      var ms = toMs_(row[COL_INPUT.TIMESTAMP - 1]);
      if (!(ms >= startMs && ms < endMs)) continue;
      var cid = String(row[COL_INPUT.CLIENT_ID - 1] || '').trim();
      var key = cid || ('x' + ms + '|' + row[COL_INPUT.PENS - 1]);
      if (seen[key]) continue;                       // cegah dobel saat arsip sedang berjalan
      seen[key] = true;
      out.push(toBatch_(row, ms));
    }
  }

  var sheet = ss.getSheetByName(SHEET_INPUT);
  if (sheet && sheet.getLastRow() >= 2) {
    var lastRow = sheet.getLastRow();
    var startRow = opts.recentLimit ? Math.max(2, lastRow - opts.recentLimit + 1) : 2;
    collect(sheet, startRow, lastRow);
  }

  if (opts.includeArchive) {
    var arsip = ss.getSheetByName(SHEET_ARSIP_INPUT);
    if (arsip && arsip.getLastRow() >= 2) {
      var n = arsip.getLastRow() - 1;
      var ts = arsip.getRange(2, COL_INPUT.TIMESTAMP, n, 1).getValues();
      var first = -1, last = -1;
      for (var i = 0; i < n; i++) {
        var t = toMs_(ts[i][0]);
        if (t >= startMs && t < endMs) { if (first < 0) first = i; last = i; }
      }
      if (first >= 0) collect(arsip, first + 2, last + 2);
    }
  }

  out.sort(function(a, b) { return a.waktu < b.waktu ? -1 : (a.waktu > b.waktu ? 1 : 0); });
  return out;
}

/**
 * Jalankan SEKALI (opsional): memberi judul kolom baru bila masih kosong.
 *  Input_Data / Arsip_Input      : S1 = TargetJson, T1 = HelperMolases
 *  Distribusi / Arsip_Distribusi : J1 = Helper
 */
function setupHeaders() {
  var ss = openSpreadsheet_();
  var plan = [
    [SHEET_INPUT, COL_INPUT.TARGET_JSON, 'TargetJson'], [SHEET_INPUT, COL_INPUT.HELPER_MOL, 'HelperMolases'], [SHEET_INPUT, COL_INPUT.MIXER_UNIT, 'MixerUnit'],
    [SHEET_ARSIP_INPUT, COL_INPUT.TARGET_JSON, 'TargetJson'], [SHEET_ARSIP_INPUT, COL_INPUT.HELPER_MOL, 'HelperMolases'], [SHEET_ARSIP_INPUT, COL_INPUT.MIXER_UNIT, 'MixerUnit'],
    [SHEET_DISTRIBUSI, COL_DIST.HELPER, 'Helper'], [SHEET_ARSIP_DIST, COL_DIST.HELPER, 'Helper']
  ];
  plan.forEach(function(p) {
    var sh = ss.getSheetByName(p[0]);
    if (!sh) { Logger.log('Sheet ' + p[0] + ' tidak ada, dilewati.'); return; }
    if (sh.getMaxColumns() < p[1]) sh.insertColumnsAfter(sh.getMaxColumns(), p[1] - sh.getMaxColumns());
    var cell = sh.getRange(1, p[1]);
    if (String(cell.getValue() || '').trim()) return;          // sudah ada judul: jangan ditimpa
    cell.setValue(p[2]);
    try { sh.getRange(1, p[1] - 1).copyTo(cell, SpreadsheetApp.CopyPasteType.PASTE_FORMAT, false); } catch (err) {}
    Logger.log(p[0] + ' kolom ' + p[1] + ' diberi judul "' + p[2] + '"');
  });
}



/* =====================================================================
 * v13.1: TARGET MOLASES (MasterTonase) & UNIT MIXER
 * ===================================================================== */

function normPenKey_(v) {
  return String(v == null ? '' : v).replace(/\s+/g, ' ').trim().toUpperCase();
}

/** Nama unit mixer baku (Trioliet / Supreme); selain itu dikosongkan agar data tetap bersih. */
function normMixerUnit_(v) {
  var k = String(v == null ? '' : v).trim().toLowerCase();
  for (var i = 0; i < MIXER_UNITS.length; i++) {
    if (MIXER_UNITS[i].toLowerCase() === k) return MIXER_UNITS[i];
  }
  return '';
}

/**
 * Baca tabel "TARGET MOLASES" di sheet MasterTonase. Posisi dicari otomatis (judul tabel + baris judul kolom
 * PEN / PAGI / SIANG / MALAM), jadi tetap benar walau tabelnya digeser.
 * Hasil: { "FRESH - (5B)": { Pagi: 53, Siang: 44, Malam: 26 }, ... }  (kunci = nama pen huruf besar)
 */
function getMolasesTargets_(ss) {
  var out = {};
  var sh = ss.getSheetByName(SHEET_MASTER_TONASE);
  if (!sh) return out;
  var lastRow = Math.min(sh.getLastRow(), 300), lastCol = sh.getLastColumn();
  if (lastRow < 3 || lastCol < 3) return out;

  var vals = sh.getRange(1, 1, lastRow, lastCol).getValues();
  var titleRow = -1, titleCol = -1;
  for (var r = 0; r < vals.length && titleRow < 0; r++) {
    for (var c = 0; c < lastCol; c++) {
      if (String(vals[r][c]).toUpperCase().indexOf('TARGET MOLASES') >= 0) { titleRow = r; titleCol = c; break; }
    }
  }
  if (titleRow < 0 || titleRow + 2 >= vals.length) return out;

  var head = vals[titleRow + 1];
  var cols = {};
  for (var c2 = Math.max(0, titleCol - 1); c2 < Math.min(lastCol, titleCol + 8); c2++) {
    var h = String(head[c2]).trim().toUpperCase();
    if (h === 'PEN' || h === 'PAGI' || h === 'SIANG' || h === 'MALAM') cols[h] = c2;
  }
  if (cols.PEN === undefined) return out;

  var blanks = 0;
  for (var i = titleRow + 2; i < vals.length; i++) {
    var pen = normPenKey_(vals[i][cols.PEN]);
    if (!pen) { if (++blanks >= 2) break; continue; }
    blanks = 0;
    out[pen] = {
      Pagi: cols.PAGI !== undefined ? numOr0_(vals[i][cols.PAGI]) : 0,
      Siang: cols.SIANG !== undefined ? numOr0_(vals[i][cols.SIANG]) : 0,
      Malam: cols.MALAM !== undefined ? numOr0_(vals[i][cols.MALAM]) : 0
    };
  }
  return out;
}

/** Target molases (kg) untuk pen-pen yang dipilih pada shift tsb. Pen khusus Pagi memakai faktor tonase 25%/50%. */
function computeMolasesTarget_(data, master, pct) {
  var table = (master && master.molasesTarget) || {};
  var shift = normShift_(data.shift);
  var special = {};
  ((master && master.specialTonasePens) || []).forEach(function(p) { special[normPenKey_(p)] = true; });
  var p = Number(pct) || 25;
  var pens = Array.isArray(data.pens) ? data.pens : String(data.pens || '').split(',');
  var sum = 0;
  pens.forEach(function(pen) {
    var key = normPenKey_(pen);
    var row = table[key];
    if (!row) return;
    var factor = (shift === 'Pagi' && special[key] && p > 0 && p < 100) ? (p / 25) : 1;
    sum += (Number(row[shift]) || 0) * factor;
  });
  return Math.round(sum);
}

/** Snapshot target untuk kolom S: angka dari loader + target molases yang dihitung server. */
function buildTargetJson_(data, master) {
  var base = sanitizeTarget_(data.target);
  if (!base) return '';
  var out = JSON.parse(base);
  out.molases = computeMolasesTarget_(data, master, out.pct);
  return JSON.stringify(out);
}
