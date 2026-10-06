/**
 * TMR SYSTEM v12.7.0 ULTRA LITE - HIGH PERFORMANCE BACKEND
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

const SPREADSHEET_ID = '1OHHBiz19jzd2NFDwktI6kj5bSuBP1KBGjd9zJ0U2DVU';

const INPUT_READ_LIMIT = 800;
const DIST_READ_LIMIT = 1200;
const CLIENT_ID_SEARCH_LIMIT = 2000;
const MASTER_CACHE_SECONDS = 180;

// WhatsApp Fonnte Configuration
const ENABLE_WHATSAPP = true;
const FONNTE_TOKEN = 's4PQzNNeenAwmWPC1esY';
const FONNTE_TARGET = '120363155761919988@g.us';
const FONNTE_URL = 'https://api.fonnte.com/send';

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
  DIST_JSON: 18
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
  SOURCE_ROW: 9
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
    var ss = openSpreadsheet_();
    var todayKey = dateKey_(new Date());
    var appMode = e && e.parameter && e.parameter.app ? String(e.parameter.app).toLowerCase().trim() : '';
    
    var master = getMasterData_(ss);
    var responseObj = { ok: true, success: true, status: 'success' };

    // --- MODE 1: APP LOADER ---
    if (appMode === 'loader') {
      responseObj.users = master.users;
      responseObj.pens = master.pens;
      responseObj.targets = master.targets;
      responseObj.specialTonasePens = master.specialTonasePens;
      
      // Ambil history loader hari ini untuk pengecekan locking pen
      var sheetInput = ss.getSheetByName(SHEET_INPUT);
      if (sheetInput) {
        var inputBlock = readRecentRows_(sheetInput, INPUT_READ_LIMIT, Math.max(COL_INPUT.DIST_JSON, sheetInput.getLastColumn()));
        var logsToday = [];
        for (var i = 0; i < inputBlock.values.length; i++) {
          var row = inputBlock.values[i];
          if (dateKeySafe_(row[COL_INPUT.TIMESTAMP - 1]) !== todayKey) continue;
          logsToday.push({
            shift: row[COL_INPUT.SHIFT - 1],
            pens: String(row[COL_INPUT.PENS - 1] || '').trim(),
            processCountValue: normalizeProcessCount_(row[COL_INPUT.PROCESS_COUNT - 1])
          });
        }
        responseObj.history = logsToday;
      }
      return json_(responseObj);
    }

    // --- MODE 2: APP MIXER ---
    if (appMode === 'mixer') {
      responseObj.users = master.users;
      responseObj.masterDist = master.masterDist;
      
      var sheetInputMix = ss.getSheetByName(SHEET_INPUT);
      if (sheetInputMix) {
        var inputBlockMix = readRecentRows_(sheetInputMix, INPUT_READ_LIMIT, Math.max(COL_INPUT.DIST_JSON, sheetInputMix.getLastColumn()));
        var distIndex = buildDistribusiIndexToday_(ss, todayKey);
        var antrian = [];

        for (var j = 0; j < inputBlockMix.values.length; j++) {
          var rowMix = inputBlockMix.values[j];
          var rowNum = inputBlockMix.rowNumbers[j];
          if (dateKeySafe_(rowMix[COL_INPUT.TIMESTAMP - 1]) !== todayKey) continue;

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
      return json_(responseObj);
    }

    // --- MODE 3: APP LIVE MONITORING ---
    if (appMode === 'monitor') {
      var sheetInputMon = ss.getSheetByName(SHEET_INPUT);
      if (sheetInputMon) {
        var inputBlockMon = readRecentRows_(sheetInputMon, INPUT_READ_LIMIT, Math.max(COL_INPUT.DIST_JSON, sheetInputMon.getLastColumn()));
        var distIndexMon = buildDistribusiIndexToday_(ss, todayKey);
        responseObj.monitor = getSupervisorDataLite_(ss, todayKey, inputBlockMon, distIndexMon);
      }
      return json_(responseObj);
    }

    // --- DEFAULT / FULL RESPONSE (BACKWARD COMPATIBILITY) ---
    var sheetInputAll = ss.getSheetByName(SHEET_INPUT);
    if (!sheetInputAll) throw new Error('Sheet Input_Data tidak ditemukan');

    var inputBlockAll = readRecentRows_(sheetInputAll, INPUT_READ_LIMIT, Math.max(COL_INPUT.DIST_JSON, sheetInputAll.getLastColumn()));
    var distIndexAll = buildDistribusiIndexToday_(ss, todayKey);

    var logsTodayAll = [];
    var antrianAll = [];

    for (var k = 0; k < inputBlockAll.values.length; k++) {
      var rowAll = inputBlockAll.values[k];
      var rowNumberAll = inputBlockAll.rowNumbers[k];
      if (dateKeySafe_(rowAll[COL_INPUT.TIMESTAMP - 1]) !== todayKey) continue;

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
    responseObj.pens = master.pens;
    responseObj.targets = master.targets;
    responseObj.history = logsTodayAll;
    responseObj.specialTonasePens = master.specialTonasePens;
    responseObj.antrian = antrianAll;
    responseObj.masterDist = master.masterDist;
    responseObj.monitor = getSupervisorDataLite_(ss, todayKey, inputBlockAll, distIndexAll);

    return json_(responseObj);
  } catch (err) {
    return json_({ ok: false, success: false, status: 'error', message: String(err && err.message ? err.message : err) });
  }
}

function doPost(e) {
  try {
    var data = parsePayload_(e);
    var formType = String(data.formType || '').trim();
    if (formType === 'stopMixing') return json_(handleStopMixing_(data));
    if (formType === 'distribusi') return json_(handleDistribusi_(data));
    return json_(handleLoader_(data));
  } catch (err) {
    return json_({ ok: false, success: false, status: 'error', message: String(err && err.message ? err.message : err) });
  }
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

  var pens = Array.isArray(data.pens) ? data.pens.join(', ') : String(data.pens || '');
  var processCountValue = normalizeProcessCount_(data.processCountValue || data.processCount || data.jumlahProses || data.countProcess || 1);

  // === MENGGUNAKAN TIMESTAMP ASLI SAAT FORM DIISI LOKAL DI HP OPERATOR ===
  var recordTimestamp = data.createdAtLocal ? toValidDate_(data.createdAtLocal) : new Date();
  if (!recordTimestamp) recordTimestamp = new Date();

  sheetInput.appendRow([
    recordTimestamp, // Timestamp input asli
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
    recordTimestamp, // Jam start mixing menggunakan timestamp asli
    '',
    clientId,
    processCountValue,
    '{}'
  ]);

  var row = sheetInput.getLastRow();
  sendWhatsappMixing_(data.shift, pens);

  return { ok: true, success: true, status: 'success', message: 'Data loader tersimpan', clientId: clientId, row: row, processCountValue: processCountValue };
}

function handleStopMixing_(data) {
  var ss = openSpreadsheet_();
  var sheetInput = ss.getSheetByName(SHEET_INPUT);
  if (!sheetInput) throw new Error('Sheet Input_Data tidak ditemukan');

  var rowNum = findInputTransactionRow_(data.clientId, data.sourceRow);
  if (!rowNum) throw new Error('Transaksi tidak ditemukan untuk stop mixing');

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
  if (!rowNum) throw new Error('Transaksi tidak ditemukan untuk distribusi');

  var rowData = sheetInput.getRange(rowNum, 1, 1, Math.max(COL_INPUT.DIST_JSON, sheetInput.getLastColumn())).getValues()[0];
  var clientId = String(rowData[COL_INPUT.CLIENT_ID - 1] || data.clientId || '').trim();

  if (!clientId) {
    clientId = 'LDR-' + new Date().getTime() + '-' + rowNum;
    sheetInput.getRange(rowNum, COL_INPUT.CLIENT_ID).setValue(clientId);
  }

  var pen = cleanPen_(data.pen);
  if (!pen) throw new Error('Pen distribusi kosong');

  var shift = String(data.shift || rowData[COL_INPUT.SHIFT - 1] || '').trim();
  var todayKey = dateKey_(new Date());

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
    tonase: Math.round(Number(data.tonase) || 0)
  };
  sheetInput.getRange(rowNum, COL_INPUT.DIST_JSON).setValue(JSON.stringify(distJson));

  sheetDist.appendRow([
    new Date(),
    data.operator || '',
    shift,
    pen,
    Math.round(Number(data.tonase) || 0),
    'Selesai',
    durasi,
    clientId,
    rowNum
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
  var sheetDist = ss.getSheetByName(SHEET_DISTRIBUSI);
  var monitor = { active: [], pagi: [], siang: [], malam: [] };

  for (var i = 0; i < inputBlock.values.length; i++) {
    var row = inputBlock.values[i];
    var rowNumber = inputBlock.rowNumbers[i];
    if (dateKeySafe_(row[COL_INPUT.TIMESTAMP - 1]) !== todayKey) continue;

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

  var distBlock = sheetDist ? readRecentRows_(sheetDist, DIST_READ_LIMIT, Math.max(COL_DIST.SOURCE_ROW, sheetDist.getLastColumn())) : { values: [], rowNumbers: [] };

  for (var j = 0; j < distBlock.values.length; j++) {
    var r = distBlock.values[j];
    if (dateKeySafe_(r[COL_DIST.TIMESTAMP - 1]) !== todayKey) continue;

    var log = {
      waktu: r[COL_DIST.TIMESTAMP - 1],
      operator: r[COL_DIST.OPERATOR - 1],
      shift: r[COL_DIST.SHIFT - 1],
      pen: r[COL_DIST.PEN - 1],
      tonase: r[COL_DIST.TONASE - 1],
      durasi: r[COL_DIST.DURASI - 1],
      clientId: r[COL_DIST.CLIENT_ID - 1] || ''
    };

    var s = String(log.shift || '').toLowerCase();
    if (s.indexOf('pagi') >= 0) monitor.pagi.push(log);
    else if (s.indexOf('siang') >= 0) monitor.siang.push(log);
    else if (s.indexOf('malam') >= 0) monitor.malam.push(log);
  }

  monitor.pagi.reverse();
  monitor.siang.reverse();
  monitor.malam.reverse();
  return monitor;
}

function getMasterData_(ss) {
  var cache = CacheService.getScriptCache();
  var cacheKey = 'tmr_master_v1270';
  var cached = cache.get(cacheKey);

  if (cached) {
    try { return JSON.parse(cached); } catch (err) {}
  }

  var sheetUsers = ss.getSheetByName(SHEET_USERS);
  var users = sheetUsers && sheetUsers.getLastRow() >= 2
    ? sheetUsers.getRange('A2:A' + sheetUsers.getLastRow()).getValues().map(function(r){ return r[0]; }).filter(String)
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
    users: users,
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
  var values = sheet.getRange(startRow, 1, numRows, width).getValues();
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
    if (dateKeySafe_(row[COL_DIST.TIMESTAMP - 1]) !== todayKey) continue;

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
  var byClientId = findInputRowByClientId_(clientId);
  if (byClientId > 1) return byClientId;

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

function dateKey_(dateObj) {
  var tz = Session.getScriptTimeZone() || 'Asia/Jakarta';
  return Utilities.formatDate(new Date(dateObj), tz, 'yyyy-MM-dd');
}

function dateKeySafe_(value) {
  if (!value) return '';
  var d = toValidDate_(value);
  if (!d) return '';
  return dateKey_(d);
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

  var message = icon + " FEEDING " + s + "\n\n" + pens + "\n🟡 On Proses";
  var options = {
    method: "post",
    headers: { Authorization: FONNTE_TOKEN },
    payload: { target: FONNTE_TARGET, message: message },
    muteHttpExceptions: true
  };
  try { UrlFetchApp.fetch(FONNTE_URL, options); } catch(err) { Logger.log(err); }
}

function clearTmrCache() {
  CacheService.getScriptCache().remove('tmr_master_v1270');
  return { ok: true, success: true, message: 'Cache master data dibersihkan.' };
}