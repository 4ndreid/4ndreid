/**
 * P2H Alat Berat — Backend (Google Apps Script)
 * Ditingkatkan dengan Notifikasi WA, Manajemen Servis, & Konfirmasi Status Trouble
 */

// KONFIGURASI FONNTE — token diambil dari Script Properties (Project Settings > Script Properties)
// Nama properti: FONNTE_TOKEN
function getFonnteToken() {
  var token = PropertiesService.getScriptProperties().getProperty('FONNTE_TOKEN');
  if (!token) Logger.log('FONNTE_TOKEN belum diatur di Script Properties.');
  return token;
}

// Target nomor/grup WA terpisah
var WA_TARGET_P2H = "6285234192837";      // Penerima Laporan P2H
var WA_TARGET_TROUBLE = "6282334366178,6281339508037,6285234192837";  // Penerima Laporan Trouble
var WA_TARGET_GREASING = "6282334366178,6281339508037,6285234192837"; // Penerima Pengingat Greasing/Pengecekan Mingguan

// Konfigurasi jadwal Greasing & Pengecekan Mingguan
var GREASING_DEFAULT_INTERVAL_HARI = 7;   // Default interval jika belum diatur di sheet Data_Greasing
var GREASING_WARNING_HARI = 2;            // Ambang "Segera" (H-2 sebelum jatuh tempo)

// Konfigurasi jadwal Servis (disamakan dengan ambang di frontend)
var SERVICE_WARNING_HM = 25;              // Ambang "Segera Servis" (dalam HM)

// Konfigurasi Rapor Unit & Operator
var RAPOR_MAX_TROUBLE_PENALTY = 40;
var RAPOR_ACTIVITY_TARGET_P2H = 25;       // Jumlah P2H per periode yang dianggap "aktivitas penuh" (skor operator)

// Konfigurasi Pengingat Tindak Lanjut Temuan P2H
// Filosofi: operator adalah "mata elang" untuk deteksi dini — bukan sumber kerusakan.
// Jika checklist P2H menemukan item CHECK dan belum ditindaklanjuti (belum ada laporan
// trouble untuk unit itu) dalam X jam, sistem mengingatkan agar unit dibawa ke mekanik.
var P2H_REMINDER_DELAY_JAM = 5;
var P2H_REMINDER_COL = 16; // Kolom P di sheet "P2H" — penanda WA reminder sudah terkirim (agar tidak dobel)

// PIN Supervisor untuk mengunci form Penilaian Supervisor — diatur di Script Properties
// (Project Settings > Script Properties), nama properti: SUPERVISOR_PIN
function getSupervisorPin() {
  return PropertiesService.getScriptProperties().getProperty('SUPERVISOR_PIN');
}

function doGet(e) {
  if (!e || !e.parameter) {
    return HtmlService.createHtmlOutput("Web App P2H Aktif.");
  }

  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var action = e.parameter.action;
  var unit = e.parameter.unit || "";
  var limit = parseInt(e.parameter.limit, 10) || 30;

  if (action == "getInitData") return jsonOutput(getInitData(ss));
  if (action == "getHistory") return jsonOutput(getHistory(ss, unit, limit));
  if (action == "getTroubleHistory") return jsonOutput(getTroubleHistory(ss, unit, limit));
  if (action == "getRequestHistory") return jsonOutput(getRequestHistory(ss, unit, limit));
  if (action == "getServisHistory") return jsonOutput(getServisHistory(ss, unit, limit));
  if (action == "getGreasingHistory") return jsonOutput(getGreasingHistory(ss, unit, limit));

  if (action == "getRaporUnit" || action == "getRaporOperator") {
    var period = resolvePeriod(e.parameter.start, e.parameter.end);
    var raporRows = (action == "getRaporUnit")
      ? getRaporUnit(ss, period.start, period.end)
      : getRaporOperator(ss, period.start, period.end);
    return jsonOutput({ rows: raporRows, periodLabel: period.label, start: period.startStr, end: period.endStr });
  }

  if (action == "downloadRaporPdf") return generateRaporPdf(ss, e.parameter);

  if (action == "getP2HFollowupList") return jsonOutput({ rows: getP2HFollowupList(ss) });

  return HtmlService.createHtmlOutput("Web App P2H Aktif.");
}

function doPost(e) {
  if (!e || !e.parameter) {
    return jsonOutput({ result: "error", message: "Parameter tidak ditemukan." });
  }

  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var d = e.parameter;
  var type = d.formType || "p2h";

  if (type === "trouble") return submitTrouble(ss, d);
  if (type === "resolve_trouble") return resolveTrouble(ss, d);
  if (type === "request") return submitRequestServis(ss, d);
  if (type === "history_servis" || type === "servis") return submitHistoryServis(ss, d);
  if (type === "greasing" || type === "history_greasing") return submitHistoryGreasing(ss, d);
  if (type === "penilaian_supervisor") return submitPenilaianSupervisor(ss, d);

  return submitP2H(ss, d);
}

function formatHmValue(val) {
  if (val === undefined || val === null || val === "") return "";
  var str = String(val).trim().replace(/\./g, ",");
  return str;
}

function sendFonnteWA(message, target) {
  try {
    var token = getFonnteToken();
    if (!token) {
      Logger.log("WA tidak terkirim: FONNTE_TOKEN kosong di Script Properties.");
      return;
    }
    var url = "https://api.fonnte.com/send";
    var payload = {
      'target': target,
      'message': message
    };
    var options = {
      'method': 'post',
      'headers': {
        'Authorization': token
      },
      'payload': payload,
      'muteHttpExceptions': true
    };
    UrlFetchApp.fetch(url, options);
  } catch (err) {
    Logger.log("Gagal mengirim WA via Fonnte: " + err.toString());
  }
}

function submitP2H(ss, d) {
  var sheet = ss.getSheetByName("P2H");
  sheet.appendRow([
    new Date(), d.shift, d.operator, d.alat, formatHmValue(d.hm),
    d.p1, d.p2, d.p3, d.p4, d.p5, d.p6, d.p7, d.p8, d.p9,
    d.catatan
  ]);

  var checkList = [d.p1, d.p2, d.p3, d.p4, d.p5, d.p6, d.p7, d.p8, d.p9];
  var checkCount = 0;
  for (var i = 0; i < checkList.length; i++) {
    if (checkList[i] === "CHECK") checkCount++;
  }

  var statusCheck = (checkCount > 0) ? "⚠️ " + checkCount + " Item Perlu Cek" : "✅ Semua OK";

  var msg = "📋 *LAPORAN P2H ALAT BERAT*\n" +
            "------------------------------------\n" +
            "🚜 *Unit*: " + (d.alat || "-") + "\n" +
            "👤 *Operator*: " + (d.operator || "-") + "\n" +
            "⏱️ *HM Saat Ini*: " + formatHmValue(d.hm) + "\n" +
            "🕒 *Shift*: " + (d.shift || "-") + "\n" +
            "📊 *Status Check*: " + statusCheck + "\n" +
            "📝 *Catatan*: " + (d.catatan || "-") + "\n\n" +
            "📅 *Waktu*: " + Utilities.formatDate(new Date(), Session.getScriptTimeZone(), "dd/MM/yyyy HH:mm") + " WIB";

  sendFonnteWA(msg, WA_TARGET_P2H);

  return jsonOutput({ result: "success" });
}

function getHistory(ss, unitFilter, limit) {
  var sheet = ss.getSheetByName("P2H");
  if (!sheet || sheet.getLastRow() < 2) return { rows: [] };

  var numCols = Math.max(sheet.getLastColumn(), 15);
  var data = sheet.getRange(2, 1, sheet.getLastRow() - 1, numCols).getValues();

  var rows = data.map(function (r) {
    return {
      timestamp: r[0] ? Utilities.formatDate(new Date(r[0]), Session.getScriptTimeZone(), "dd/MM/yyyy HH:mm") : "",
      shift: r[1], operator: r[2], unit: r[3], hm: formatHmValue(r[4]),
      checklist: r.slice(5, 14), catatan: r[14] || ""
    };
  });

  if (unitFilter) rows = rows.filter(function (r) { return r.unit == unitFilter; });
  rows.reverse();
  return { rows: rows.slice(0, limit) };
}

var TROUBLE_SHEET_NAMES = ["Trouble_Report", "Trouble Report"];
var TROUBLE_FIELDS = {
  timestamp: ["Timestamp"],
  unit: ["Unit", "Alat"],
  operator: ["Operator", "Nama Operator"],
  deskripsi: ["Deskripsi", "Deskripsi Masalah"],
  lokasi: ["Lokasi", "Tempat Trouble", "Tempat", "Tempat_Trouble"],
  status: ["Status"]
};

function submitTrouble(ss, d) {
  var sheet = findSheet(ss, TROUBLE_SHEET_NAMES);
  if (!sheet) return jsonOutput({ result: "error", message: "Sheet Trouble_Report tidak ditemukan" });

  var tempatTrouble = d.lokasi || d.tempat || d.tempatTrouble || "-";
  
  appendRowFlexible(sheet, {
    timestamp: { candidates: TROUBLE_FIELDS.timestamp, value: new Date() },
    unit: { candidates: TROUBLE_FIELDS.unit, value: d.alat },
    operator: { candidates: TROUBLE_FIELDS.operator, value: d.operator },
    deskripsi: { candidates: TROUBLE_FIELDS.deskripsi, value: d.deskripsi },
    lokasi: { candidates: TROUBLE_FIELDS.lokasi, value: tempatTrouble },
    status: { candidates: TROUBLE_FIELDS.status, value: "Baru" }
  });

  var msg = "Mas mohon bantuannya,\n" +
            (d.alat || "Unit") +
            " di " + tempatTrouble +
            " trouble (" +
            (d.deskripsi || "-") +
            ").\n" +
            "Terima kasih.";

  sendFonnteWA(msg, WA_TARGET_TROUBLE);

  return jsonOutput({ result: "success" });
}

function resolveTrouble(ss, d) {
  var sheet = findSheet(ss, TROUBLE_SHEET_NAMES);
  if (!sheet) return jsonOutput({ result: "error", message: "Sheet Trouble_Report tidak ditemukan" });

  var headerMap = getHeaderMap(sheet);
  var colStatus = resolveColumn(headerMap, sheet, TROUBLE_FIELDS.status);
  var colUnit = resolveColumn(headerMap, sheet, TROUBLE_FIELDS.unit);
  var colTs = resolveColumn(headerMap, sheet, TROUBLE_FIELDS.timestamp);

  var lastRow = sheet.getLastRow();
  if (lastRow < 2) return jsonOutput({ result: "error", message: "Data trouble tidak ditemukan" });

  var targetUnit = String(d.unit || d.alat || "").trim().toLowerCase();
  var targetTs = String(d.timestamp || "").trim();

  var data = sheet.getRange(2, 1, lastRow - 1, sheet.getLastColumn()).getValues();

  var updatedCount = 0;
  for (var i = 0; i < data.length; i++) {
    var rUnit = String(data[i][colUnit - 1]).trim().toLowerCase();
    var rTs = data[i][colTs - 1] ? Utilities.formatDate(new Date(data[i][colTs - 1]), Session.getScriptTimeZone(), "dd/MM/yyyy HH:mm") : "";
    
    if (rUnit === targetUnit && (!targetTs || rTs === targetTs)) {
      sheet.getRange(i + 2, colStatus).setValue("Selesai");
      updatedCount++;
    }
  }

  if (updatedCount > 0) {
    return jsonOutput({ result: "success", message: "Status trouble berhasil dikonfirmasi Selesai!" });
  } else {
    return jsonOutput({ result: "error", message: "Gagal menemukan record trouble yang sesuai." });
  }
}

function getTroubleHistory(ss, unitFilter, limit) {
  var sheet = findSheet(ss, TROUBLE_SHEET_NAMES);
  if (!sheet) return { rows: [] };
  var rows = readSheetFlexible(sheet, TROUBLE_FIELDS).map(function (r) {
    return {
      timestamp: r.timestamp ? Utilities.formatDate(new Date(r.timestamp), Session.getScriptTimeZone(), "dd/MM/yyyy HH:mm") : "",
      unit: r.unit, 
      operator: r.operator, 
      deskripsi: r.deskripsi, 
      lokasi: r.lokasi || r.tempat || "-",
      status: r.status || "Baru"
    };
  });
  if (unitFilter) rows = rows.filter(function (r) { return r.unit == unitFilter; });
  rows.reverse();
  return { rows: rows.slice(0, limit) };
}

function submitHistoryServis(ss, d) {
  var historySheet = ss.getSheetByName("History_Servis");
  if (!historySheet) {
    historySheet = ss.insertSheet("History_Servis");
    historySheet.appendRow(["Timestamp", "Unit", "HM Servis", "Tanggal Servis", "Teknisi / Catatan"]);
  }

  var rawDate = d.tanggalServis || new Date();
  var tglServis = formatDateSafe(rawDate);
  var hmServis = formatHmValue(d.hmServis || d.hm);

  historySheet.appendRow([
    new Date(),
    d.alat,
    hmServis,
    tglServis,
    d.catatan || "-"
  ]);

  updateDataServisTerakhir(ss, d.alat, hmServis, tglServis);

  return jsonOutput({ result: "success", message: "Record servis berhasil disimpan" });
}

function updateDataServisTerakhir(ss, unitName, hm, tgl) {
  var dataServisSheet = findSheet(ss, ["Data_Servis", "Data Servis"]);
  if (!dataServisSheet) return;

  var headerMap = getHeaderMap(dataServisSheet);
  var colUnit = headerMap["unit"];
  var colHm = headerMap["hm_servis_terakhir"] || headerMap["hm servis terakhir"];
  var colTgl = headerMap["tanggal_servis_terakhir"] || headerMap["tanggal servis terakhir"] || headerMap["tgl servis"];

  if (!colUnit) return;

  var lastRow = dataServisSheet.getLastRow();
  if (lastRow < 2) return;

  var units = dataServisSheet.getRange(2, colUnit, lastRow - 1, 1).getValues().flat();

  for (var i = 0; i < units.length; i++) {
    if (String(units[i]).trim().toLowerCase() === String(unitName).trim().toLowerCase()) {
      var targetRow = i + 2;
      if (colHm) dataServisSheet.getRange(targetRow, colHm).setValue(hm);
      if (colTgl) dataServisSheet.getRange(targetRow, colTgl).setValue(tgl);
      break;
    }
  }
}

function getServisHistory(ss, unitFilter, limit) {
  var sheet = ss.getSheetByName("History_Servis");
  if (!sheet || sheet.getLastRow() < 2) return { rows: [] };

  var data = sheet.getRange(2, 1, sheet.getLastRow() - 1, 5).getValues();
  var rows = data.map(function (r) {
    return {
      timestamp: r[0] ? Utilities.formatDate(new Date(r[0]), Session.getScriptTimeZone(), "dd/MM/yyyy HH:mm") : "",
      unit: r[1],
      hmServis: formatHmValue(r[2]),
      tanggalServis: formatDateSafe(r[3]),
      catatan: r[4] || ""
    };
  });

  if (unitFilter) rows = rows.filter(function (r) { return r.unit == unitFilter; });
  rows.reverse();
  return { rows: rows.slice(0, limit) };
}

/* =========================================================
 *  GREASING & PENGECEKAN MINGGUAN
 *  Sheet "Data_Greasing"  : jadwal per unit (interval hari, tgl terakhir, override)
 *  Sheet "History_Greasing": log setiap kali greasing/pengecekan dilakukan
 * ========================================================= */

var GREASING_SCHEDULE_SHEET_NAMES = ["Data_Greasing", "Data Greasing"];
var GREASING_FIELD_DEFS = {
  unit: ["Unit", "Nama Unit"],
  intervalHari: ["Interval_Hari_Greasing", "Interval Hari Greasing", "Interval Greasing (Hari)", "Interval Greasing"],
  tglGreasingTerakhir: ["Tanggal_Greasing_Terakhir", "Tanggal Greasing Terakhir", "Tgl Greasing Terakhir"],
  overrideTglGreasing: ["Override_Tanggal_Greasing_Berikutnya", "Override Tanggal Greasing Berikutnya"],
  pic: ["PIC", "Penanggung Jawab"]
};

function submitHistoryGreasing(ss, d) {
  var historySheet = ss.getSheetByName("History_Greasing");
  if (!historySheet) {
    historySheet = ss.insertSheet("History_Greasing");
    historySheet.appendRow(["Timestamp", "Unit", "Tanggal Greasing/Cek", "Petugas", "Catatan"]);
  }

  var rawDate = d.tanggalGreasing || d.tanggal || new Date();
  var tglGreasing = formatDateSafe(rawDate);

  historySheet.appendRow([
    new Date(),
    d.alat,
    tglGreasing,
    d.operator || d.petugas || "-",
    d.catatan || "-"
  ]);

  updateDataGreasingTerakhir(ss, d.alat, tglGreasing);

  return jsonOutput({ result: "success", message: "Record greasing/pengecekan berhasil disimpan" });
}

function updateDataGreasingTerakhir(ss, unitName, tgl) {
  var sheet = findSheet(ss, GREASING_SCHEDULE_SHEET_NAMES);
  if (!sheet) {
    // Buat sheet jadwal otomatis jika belum ada, supaya fitur tetap jalan out-of-the-box
    sheet = ss.insertSheet("Data_Greasing");
    sheet.appendRow(["Unit", "Interval_Hari_Greasing", "Tanggal_Greasing_Terakhir", "Override_Tanggal_Greasing_Berikutnya", "PIC"]);
  }

  var headerMap = getHeaderMap(sheet);
  var colUnit = resolveColumn(headerMap, sheet, GREASING_FIELD_DEFS.unit);
  var colTgl = resolveColumn(headerMap, sheet, GREASING_FIELD_DEFS.tglGreasingTerakhir);

  var lastRow = sheet.getLastRow();
  var units = lastRow >= 2 ? sheet.getRange(2, colUnit, lastRow - 1, 1).getValues().flat() : [];

  var rowIndex = -1;
  for (var i = 0; i < units.length; i++) {
    if (String(units[i]).trim().toLowerCase() === String(unitName).trim().toLowerCase()) {
      rowIndex = i + 2;
      break;
    }
  }

  if (rowIndex === -1) {
    rowIndex = sheet.getLastRow() + 1;
    sheet.getRange(rowIndex, colUnit).setValue(unitName);
  }
  sheet.getRange(rowIndex, colTgl).setValue(tgl);
}

function getGreasingHistory(ss, unitFilter, limit) {
  var sheet = ss.getSheetByName("History_Greasing");
  if (!sheet || sheet.getLastRow() < 2) return { rows: [] };

  var data = sheet.getRange(2, 1, sheet.getLastRow() - 1, 5).getValues();
  var rows = data.map(function (r) {
    return {
      timestamp: r[0] ? Utilities.formatDate(new Date(r[0]), Session.getScriptTimeZone(), "dd/MM/yyyy HH:mm") : "",
      unit: r[1],
      tanggalGreasing: formatDateSafe(r[2]),
      petugas: r[3] || "-",
      catatan: r[4] || ""
    };
  });

  if (unitFilter) rows = rows.filter(function (r) { return r.unit == unitFilter; });
  rows.reverse();
  return { rows: rows.slice(0, limit) };
}

/**
 * Menghitung status jadwal greasing/pengecekan untuk semua unit.
 * Dipakai bersama oleh getInitData() (untuk ditampilkan di app) dan
 * checkAndSendGreasingReminders() (untuk pengingat WA otomatis).
 */
function computeGreasingSchedule(ss, unitNames) {
  var scheduleMap = {};
  var sheet = findSheet(ss, GREASING_SCHEDULE_SHEET_NAMES);
  if (sheet) {
    readSheetFlexible(sheet, GREASING_FIELD_DEFS).forEach(function (row) {
      if (row.unit) scheduleMap[row.unit] = row;
    });
  }

  var today = new Date();
  today.setHours(0, 0, 0, 0);

  return unitNames.map(function (name) {
    var s = scheduleMap[name] || {};
    var interval = parseInt(s.intervalHari, 10) || GREASING_DEFAULT_INTERVAL_HARI;
    var lastDate = parseDateSafe(s.tglGreasingTerakhir);
    var overrideDate = parseDateSafe(s.overrideTglGreasing);

    var nextDate = null, remainingDays = null, status = "BELUM_DIATUR";
    if (overrideDate) {
      nextDate = overrideDate;
    } else if (lastDate) {
      nextDate = new Date(lastDate.getTime());
      nextDate.setDate(nextDate.getDate() + interval);
    }

    if (nextDate) {
      remainingDays = Math.round((nextDate.getTime() - today.getTime()) / 86400000);
      status = remainingDays <= 0 ? "OVERDUE" : (remainingDays <= GREASING_WARNING_HARI ? "SEGERA" : "AMAN");
    }

    return {
      nama: name,
      intervalHariGreasing: interval,
      tglGreasingTerakhir: formatDateSafe(s.tglGreasingTerakhir),
      overrideTglGreasing: formatDateSafe(s.overrideTglGreasing),
      nextGreasingDate: nextDate ? formatDateSafe(nextDate) : "",
      remainingDaysGreasing: remainingDays,
      statusGreasing: status,
      picGreasing: s.pic || ""
    };
  });
}

function parseDateSafe(value) {
  if (!value) return null;
  try {
    if (value instanceof Date) {
      value.setHours(0, 0, 0, 0);
      return value;
    }
    var str = String(value).trim();
    // Dukung format dd/MM/yyyy (hasil formatDateSafe) maupun format tanggal standar
    var m = str.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
    var d;
    if (m) {
      d = new Date(parseInt(m[3], 10), parseInt(m[2], 10) - 1, parseInt(m[1], 10));
    } else {
      d = new Date(str);
    }
    if (isNaN(d.getTime())) return null;
    d.setHours(0, 0, 0, 0);
    return d;
  } catch (err) {
    return null;
  }
}

/**
 * PENGINGAT OTOMATIS via WhatsApp — dipanggil oleh time-driven trigger harian.
 * Cara pasang trigger: buka Apps Script > jalankan fungsi setupGreasingReminderTrigger() SEKALI,
 * atau atur manual lewat menu Triggers (ikon jam) > pilih fungsi checkAndSendGreasingReminders,
 * pilih "Time-driven" > "Day timer" > jam yang diinginkan (misal 07:00-08:00 WIB).
 */
function checkAndSendGreasingReminders() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var unitSheet = ss.getSheetByName("Unit");
  if (!unitSheet || unitSheet.getLastRow() < 2) return;

  var unitNames = unitSheet.getRange(2, 1, unitSheet.getLastRow() - 1, 1)
    .getValues().flat().filter(function (v) { return v !== ""; });

  var schedule = computeGreasingSchedule(ss, unitNames);
  var due = schedule.filter(function (u) { return u.statusGreasing === "OVERDUE" || u.statusGreasing === "SEGERA"; });

  if (due.length === 0) return;

  due.sort(function (a, b) { return (a.remainingDaysGreasing || 0) - (b.remainingDaysGreasing || 0); });

  var lines = due.map(function (u) {
    var tag = u.statusGreasing === "OVERDUE"
      ? "🔴 TERLAMBAT " + Math.abs(u.remainingDaysGreasing) + " hari"
      : "🟡 Jatuh tempo " + (u.remainingDaysGreasing <= 0 ? "hari ini" : "dalam " + u.remainingDaysGreasing + " hari");
    return "• *" + u.nama + "* — " + tag + " (jadwal: " + (u.nextGreasingDate || "-") + ")";
  });

  var msg = "🛢️ *PENGINGAT GREASING & PENGECEKAN MINGGUAN*\n" +
            "------------------------------------\n" +
            lines.join("\n") + "\n\n" +
            "Mohon segera dijadwalkan/dilaksanakan dan dicatat di aplikasi P2H.\n" +
            "📅 " + Utilities.formatDate(new Date(), Session.getScriptTimeZone(), "dd/MM/yyyy") + " WIB";

  sendFonnteWA(msg, WA_TARGET_GREASING);
}

/**
 * Jalankan fungsi ini SEKALI secara manual dari editor Apps Script untuk memasang
 * trigger harian otomatis (menghapus trigger lama fungsi ini terlebih dulu agar tidak dobel).
 */
function setupGreasingReminderTrigger() {
  var triggers = ScriptApp.getProjectTriggers();
  triggers.forEach(function (t) {
    if (t.getHandlerFunction() === "checkAndSendGreasingReminders") {
      ScriptApp.deleteTrigger(t);
    }
  });
  ScriptApp.newTrigger("checkAndSendGreasingReminders")
    .timeBased()
    .everyDays(1)
    .atHour(7)
    .create();
}

/* =========================================================
 *  RAPOR UNIT & OPERATOR (Penilaian Berkala) + Export PDF
 *  Skor dihitung murni dari data yang sudah tercatat di sheet —
 *  transparan dan bisa direkonstruksi ulang, bukan penilaian subjektif.
 * ========================================================= */

function resolvePeriod(startParam, endParam) {
  var start = startParam ? parseISODate(startParam) : null;
  var end = endParam ? parseISODate(endParam) : null;
  if (end) end.setHours(23, 59, 59, 999);

  if (!start || !end) {
    var now = new Date();
    start = new Date(now.getFullYear(), now.getMonth(), 1);
    end = new Date(now.getFullYear(), now.getMonth() + 1, 0, 23, 59, 59, 999);
  }

  var tz = Session.getScriptTimeZone();
  return {
    start: start,
    end: end,
    startStr: Utilities.formatDate(start, tz, "dd/MM/yyyy"),
    endStr: Utilities.formatDate(end, tz, "dd/MM/yyyy"),
    label: Utilities.formatDate(start, tz, "dd/MM/yyyy") + " – " + Utilities.formatDate(end, tz, "dd/MM/yyyy")
  };
}

function parseISODate(str) {
  if (!str) return null;
  var d = new Date(String(str) + "T00:00:00");
  return isNaN(d.getTime()) ? null : d;
}

function gradeFromScore(score) {
  if (score >= 90) return "A";
  if (score >= 75) return "B";
  if (score >= 60) return "C";
  return "D";
}

/** Baris P2H dalam rentang tanggal tertentu, dalam bentuk siap olah. */
function getP2HRowsInRange(ss, startDate, endDate) {
  var sheet = ss.getSheetByName("P2H");
  if (!sheet || sheet.getLastRow() < 2) return [];
  var numCols = Math.max(sheet.getLastColumn(), 15);
  var data = sheet.getRange(2, 1, sheet.getLastRow() - 1, numCols).getValues();
  var rows = [];
  data.forEach(function (r) {
    var ts = r[0] ? new Date(r[0]) : null;
    if (!ts || isNaN(ts.getTime())) return;
    if (startDate && ts < startDate) return;
    if (endDate && ts > endDate) return;
    rows.push({
      timestamp: ts, shift: r[1], operator: r[2], unit: r[3], hm: r[4],
      checklist: r.slice(5, 14), catatan: r[14] || ""
    });
  });
  return rows;
}

/** Baris Trouble_Report dalam rentang tanggal tertentu. */
function getTroubleRowsInRange(ss, startDate, endDate) {
  var sheet = findSheet(ss, TROUBLE_SHEET_NAMES);
  if (!sheet) return [];
  return readSheetFlexible(sheet, TROUBLE_FIELDS).filter(function (r) {
    if (!r.timestamp) return false;
    var ts = new Date(r.timestamp);
    if (isNaN(ts.getTime())) return false;
    if (startDate && ts < startDate) return false;
    if (endDate && ts > endDate) return false;
    return true;
  });
}

/**
 * Rapor per UNIT: kesehatan checklist, frekuensi trouble, kepatuhan servis & greasing.
 * Skor 0–100: mulai dari % checklist OK, dikurangi penalti trouble/servis/greasing.
 */
function getRaporUnit(ss, startDate, endDate) {
  var unitSheet = ss.getSheetByName("Unit");
  if (!unitSheet || unitSheet.getLastRow() < 2) return [];
  var unitNames = unitSheet.getRange(2, 1, unitSheet.getLastRow() - 1, 1)
    .getValues().flat().filter(function (v) { return v !== ""; });

  var p2hRows = getP2HRowsInRange(ss, startDate, endDate);
  var troubleRows = getTroubleRowsInRange(ss, startDate, endDate);
  var scheduleMap = getServisScheduleRawMap(ss);
  var currentHMMap = getCurrentHMMap(ss);
  var greasingSchedule = computeGreasingSchedule(ss, unitNames);
  var greasingMap = {};
  greasingSchedule.forEach(function (g) { greasingMap[g.nama] = g; });

  return unitNames.map(function (name) {
    var rowsForUnit = p2hRows.filter(function (r) { return r.unit === name; });
    var totalP2H = rowsForUnit.length;

    var totalItems = 0, totalOK = 0;
    rowsForUnit.forEach(function (r) {
      r.checklist.forEach(function (v) {
        if (v === "OK" || v === "CHECK") { totalItems++; if (v === "OK") totalOK++; }
      });
    });
    var pctOK = totalItems > 0 ? (totalOK / totalItems) * 100 : null;

    var troubleCount = troubleRows.filter(function (t) { return t.unit === name; }).length;

    var s = scheduleMap[name] || {};
    var rec = currentHMMap[name];
    var currentHM = rec ? rec.hm : s.hmServisTerakhir;
    var servisCalc = computeServisStatus(Number(s.interval) || 0, s.hmServisTerakhir, currentHM, s.overrideHM);

    var g = greasingMap[name] || {};

    var checklistScore = pctOK !== null ? pctOK : 100; // belum ada data P2H di periode ini → tidak dihukum
    var troublePenalty = Math.min(troubleCount * 10, RAPOR_MAX_TROUBLE_PENALTY);
    var servisPenalty = servisCalc.status === "OVERDUE" ? 20 : (servisCalc.status === "SEGERA" ? 8 : 0);
    var greasingPenalty = g.statusGreasing === "OVERDUE" ? 15 : (g.statusGreasing === "SEGERA" ? 5 : 0);
    var score = Math.max(0, Math.min(100, Math.round(checklistScore - troublePenalty - servisPenalty - greasingPenalty)));

    return {
      unit: name,
      totalP2H: totalP2H,
      pctChecklistOK: pctOK === null ? null : Math.round(pctOK * 10) / 10,
      troubleCount: troubleCount,
      statusServis: servisCalc.status,
      statusGreasing: g.statusGreasing || "BELUM_DIATUR",
      skor: score,
      grade: gradeFromScore(score)
    };
  }).sort(function (a, b) { return a.skor - b.skor; });
}

/**
 * Rapor per OPERATOR: aktivitas pelaporan, kelengkapan catatan saat ada temuan,
 * dan inisiatif melaporkan trouble. Skor 0–100 dari 3 komponen (lihat komentar bawah).
 */
function getRaporOperator(ss, startDate, endDate) {
  var opSheet = ss.getSheetByName("Nama_Operator");
  if (!opSheet || opSheet.getLastRow() < 2) return [];
  var operators = opSheet.getRange(2, 1, opSheet.getLastRow() - 1, 1)
    .getValues().flat().filter(function (v) { return v !== ""; });

  var p2hRows = getP2HRowsInRange(ss, startDate, endDate);
  var troubleRows = getTroubleRowsInRange(ss, startDate, endDate);

  var periodKey = Utilities.formatDate(startDate, Session.getScriptTimeZone(), "yyyy-MM");
  var supervisorMap = getSupervisorAssessmentMap(ss, periodKey);

  return operators.map(function (name) {
    var rowsForOp = p2hRows.filter(function (r) { return r.operator === name; });
    var totalP2H = rowsForOp.length;

    var unitSet = {};
    rowsForOp.forEach(function (r) { if (r.unit) unitSet[r.unit] = true; });
    var unitCount = Object.keys(unitSet).length;

    var totalCheckFound = 0, totalCheckWithNote = 0;
    rowsForOp.forEach(function (r) {
      var hasIssue = r.checklist.indexOf("CHECK") !== -1;
      if (hasIssue) {
        totalCheckFound++;
        if (r.catatan && String(r.catatan).trim() !== "") totalCheckWithNote++;
      }
    });
    var completenessPct = totalCheckFound > 0 ? (totalCheckWithNote / totalCheckFound) * 100 : null;

    var troubleReported = troubleRows.filter(function (t) { return t.operator === name; }).length;

    // Komponen skor data operasional (total maks 100) — TIDAK dipengaruhi kondisi/kerusakan
    // unit itu sendiri, karena unit rusak bukan tanggung jawab operator (lihat catatan di PDF):
    // 1) Aktivitas pelaporan P2H — maks 50
    var activityScore = Math.min(50, Math.round((totalP2H / RAPOR_ACTIVITY_TARGET_P2H) * 50));
    // 2) Kelengkapan catatan saat menemukan item bermasalah — maks 30 (netral/30 jika tidak ada temuan)
    var completenessScore = completenessPct === null ? 30 : Math.round((completenessPct / 100) * 30);
    // 3) Inisiatif melaporkan trouble ke mekanik (deteksi dini) — maks 20
    var proactiveScore = Math.min(20, troubleReported * 5);

    var score = Math.max(0, Math.min(100, activityScore + completenessScore + proactiveScore));

    var sv = supervisorMap[name] || null;
    var svAvg = sv ? Math.round(((sv.k3 + sv.keterampilan + sv.kebersihan + sv.kedisiplinan + sv.problemSolving) / 5) * 10) / 10 : null;

    return {
      operator: name,
      totalP2H: totalP2H,
      unitCount: unitCount,
      pctCatatanLengkap: completenessPct === null ? null : Math.round(completenessPct * 10) / 10,
      troubleReported: troubleReported,
      skor: score,
      grade: gradeFromScore(score),
      supervisor: sv,
      supervisorAvg: svAvg
    };
  }).sort(function (a, b) { return a.skor - b.skor; });
}

/**
 * Menghasilkan file PDF rapor (unit atau operator) untuk 1 target pada 1 periode.
 * Dipanggil lewat doGet?action=downloadRaporPdf&type=unit|operator&target=NAMA&start=YYYY-MM-DD&end=YYYY-MM-DD
 * PENTING: Web app Apps Script tidak bisa mengembalikan Blob biner langsung dari doGet
 * ("nilai yang dikembalikan bukan jenis pengembalian yang didukung"). Solusinya: PDF
 * dikirim sebagai base64 di dalam JSON, lalu browser (frontend) yang merakitnya
 * menjadi file dan memicu unduhan — lihat downloadRaporPdf() di index_P2H.html.
 */
function generateRaporPdf(ss, params) {
  var type = (params.type || "unit").toLowerCase();
  var target = params.target || "";
  var period = resolvePeriod(params.start, params.end);

  var html, filenameBase;
  if (type === "operator") {
    var opRows = getRaporOperator(ss, period.start, period.end);
    var data = opRows.filter(function (r) { return r.operator === target; })[0] ||
      { operator: target, totalP2H: 0, unitCount: 0, pctCatatanLengkap: null, troubleReported: 0, skor: 0, grade: "-" };
    html = buildRaporHtmlOperator(data, period);
    filenameBase = "Rapor_Operator_" + target;
  } else {
    var unitRows = getRaporUnit(ss, period.start, period.end);
    var data2 = unitRows.filter(function (r) { return r.unit === target; })[0] ||
      { unit: target, totalP2H: 0, pctChecklistOK: null, troubleCount: 0, statusServis: "BELUM_DIATUR", statusGreasing: "BELUM_DIATUR", skor: 0, grade: "-" };
    html = buildRaporHtmlUnit(data2, period);
    filenameBase = "Rapor_Unit_" + target;
  }

  try {
    var safeFilename = filenameBase.replace(/[^a-zA-Z0-9_\-]/g, "_") + ".pdf";
    var htmlBlob = Utilities.newBlob(html, "text/html", safeFilename);
    var pdfBlob = htmlBlob.getAs("application/pdf").setName(safeFilename);
    return jsonOutput({
      result: "success",
      filename: safeFilename,
      base64: Utilities.base64Encode(pdfBlob.getBytes())
    });
  } catch (err) {
    return jsonOutput({ result: "error", message: "Gagal membuat PDF: " + err.toString() });
  }
}

function escapeHtmlServer(str) {
  if (str === null || str === undefined) return "";
  return String(str)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

function raporLabel(statusOrGrade) {
  var map = {
    OVERDUE: "Terlambat", SEGERA: "Segera", AMAN: "Aman", BELUM_DIATUR: "Belum Diatur"
  };
  return map[statusOrGrade] || statusOrGrade;
}

function raporHtmlShell(title, subtitle, period, bodyHtml) {
  return "<!DOCTYPE html><html><head><meta charset='utf-8'>" +
    "<style>" +
    "body{font-family:Arial,Helvetica,sans-serif;color:#111827;padding:28px;font-size:12px;}" +
    "h1{font-size:18px;margin:0 0 2px;letter-spacing:.02em;}" +
    ".sub{color:#4b5563;font-size:11px;margin-bottom:14px;}" +
    ".head{border-bottom:2px solid #111827;padding-bottom:10px;margin-bottom:18px;}" +
    ".eyebrow{font-size:10px;letter-spacing:.12em;text-transform:uppercase;color:#2563eb;font-weight:bold;}" +
    "table{width:100%;border-collapse:collapse;margin-bottom:16px;}" +
    "td,th{border:1px solid #d1d5db;padding:7px 10px;text-align:left;font-size:11.5px;}" +
    "th{background:#f3f4f6;width:45%;}" +
    ".score-box{display:table;width:100%;margin-bottom:18px;}" +
    ".score-cell{display:table-cell;width:50%;border:1px solid #d1d5db;padding:14px;text-align:center;vertical-align:middle;}" +
    ".score-num{font-size:34px;font-weight:bold;}" +
    ".score-label{font-size:10px;text-transform:uppercase;letter-spacing:.08em;color:#6b7280;margin-top:2px;}" +
    ".note{font-size:10px;color:#6b7280;margin-top:6px;line-height:1.5;}" +
    ".sign{margin-top:46px;width:100%;}" +
    ".sign-col{display:inline-block;width:45%;vertical-align:top;}" +
    ".sign-col + .sign-col{margin-left:8%;}" +
    ".sign-line{margin-top:56px;border-top:1px solid #111827;padding-top:4px;font-size:11px;}" +
    "</style></head><body>" +
    "<div class='head'>" +
      "<div class='eyebrow'>Dairy Feed Ops — P2H Alat Berat</div>" +
      "<h1>" + title + "</h1>" +
      "<div class='sub'>" + subtitle + " &middot; Periode " + period.label + "</div>" +
    "</div>" +
    bodyHtml +
    "<div class='sign'>" +
      "<div class='sign-col'><div class='sign-line'>Diperiksa oleh (Mekanik/Supervisor)</div></div>" +
      "<div class='sign-col'><div class='sign-line'>Disetujui oleh (Kepala Unit)</div></div>" +
    "</div>" +
    "<div class='note'>Dicetak otomatis dari aplikasi P2H Alat Berat pada " +
      Utilities.formatDate(new Date(), Session.getScriptTimeZone(), "dd/MM/yyyy HH:mm") + " WIB. " +
      "Skor dihitung otomatis dari data yang tercatat pada periode ini dan bersifat indikatif untuk membantu evaluasi, bukan penilaian mutlak." +
    "</div>" +
    "</body></html>";
}

function buildRaporHtmlUnit(d, period) {
  var body =
    "<div class='score-box'>" +
      "<div class='score-cell'><div class='score-num'>" + d.skor + "</div><div class='score-label'>Skor Kesehatan Unit</div></div>" +
      "<div class='score-cell'><div class='score-num'>" + (d.grade || "-") + "</div><div class='score-label'>Grade</div></div>" +
    "</div>" +
    "<table>" +
      "<tr><th>Jumlah Pemeriksaan P2H</th><td>" + d.totalP2H + " kali</td></tr>" +
      "<tr><th>Persentase Checklist OK</th><td>" + (d.pctChecklistOK === null ? "Belum ada data periode ini" : d.pctChecklistOK + " %") + "</td></tr>" +
      "<tr><th>Jumlah Laporan Trouble</th><td>" + d.troubleCount + " laporan</td></tr>" +
      "<tr><th>Status Jadwal Servis (saat ini)</th><td>" + raporLabel(d.statusServis) + "</td></tr>" +
      "<tr><th>Status Jadwal Greasing (saat ini)</th><td>" + raporLabel(d.statusGreasing) + "</td></tr>" +
    "</table>" +
    "<div class='note'>Metodologi skor: mulai dari persentase item checklist berstatus OK, dikurangi penalti " +
    "untuk setiap laporan trouble (maks -" + RAPOR_MAX_TROUBLE_PENALTY + "), status servis terlambat (-20)/segera (-8), " +
    "dan status greasing terlambat (-15)/segera (-5). Grade: A ≥90, B ≥75, C ≥60, D &lt;60. " +
    "Skor ini menilai KONDISI UNIT, bukan kinerja operator yang menanganinya.</div>";
  return raporHtmlShell("RAPOR UNIT — " + escapeHtmlServer(d.unit || "-"), "Unit " + escapeHtmlServer(d.unit || "-"), period, body);
}

function buildRaporHtmlOperator(d, period) {
  var body =
    "<div class='score-box'>" +
      "<div class='score-cell'><div class='score-num'>" + d.skor + "</div><div class='score-label'>Skor Data Operasional</div></div>" +
      "<div class='score-cell'><div class='score-num'>" + (d.grade || "-") + "</div><div class='score-label'>Grade</div></div>" +
    "</div>" +
    "<table>" +
      "<tr><th>Jumlah Laporan P2H Diinput</th><td>" + d.totalP2H + " kali</td></tr>" +
      "<tr><th>Jumlah Unit Ditangani</th><td>" + d.unitCount + " unit</td></tr>" +
      "<tr><th>Kelengkapan Catatan saat Ada Temuan</th><td>" + (d.pctCatatanLengkap === null ? "Tidak ada temuan pada periode ini" : d.pctCatatanLengkap + " %") + "</td></tr>" +
      "<tr><th>Laporan Trouble Diajukan (Deteksi Dini)</th><td>" + d.troubleReported + " laporan</td></tr>" +
    "</table>" +
    "<div class='note'>Metodologi skor data operasional (maks 100): Aktivitas pelaporan P2H (maks 50, penuh jika ≥" + RAPOR_ACTIVITY_TARGET_P2H + " laporan/periode) " +
    "+ Kelengkapan catatan saat ditemukan item bermasalah (maks 30) + Inisiatif melaporkan trouble ke mekanik (maks 20, +5/laporan). " +
    "Grade: A ≥90, B ≥75, C ≥60, D &lt;60. Skor ini TIDAK dikurangi karena unit yang ditangani rusak/trouble — " +
    "operator justru mendapat nilai tambah saat berhasil mendeteksi dan melaporkan masalah lebih awal.</div>";

  var svBlock;
  if (d.supervisor) {
    var sv = d.supervisor;
    svBlock =
      "<div class='sub' style='margin:18px 0 8px;font-weight:bold;color:#111827;font-size:13px;'>Penilaian Supervisor — Periode " + period.label + "</div>" +
      "<table>" +
        "<tr><th>1. Kepatuhan Keselamatan Kerja (K3/Safety)</th><td>" + sv.k3 + " / 5</td></tr>" +
        "<tr><th>2. Keterampilan Operasional (Technical Skill)</th><td>" + sv.keterampilan + " / 5</td></tr>" +
        "<tr><th>3. Tanggung Jawab Kebersihan & Kondisi Alat</th><td>" + sv.kebersihan + " / 5</td></tr>" +
        "<tr><th>4. Kedisiplinan Waktu dan Kehadiran</th><td>" + sv.kedisiplinan + " / 5</td></tr>" +
        "<tr><th>5. Pengambilan Keputusan (Problem Solving)</th><td>" + sv.problemSolving + " / 5</td></tr>" +
        "<tr><th>Rata-rata</th><td><b>" + d.supervisorAvg + " / 5</b></td></tr>" +
        (sv.catatan ? "<tr><th>Catatan Supervisor</th><td>" + escapeHtmlServer(sv.catatan) + "</td></tr>" : "") +
        "<tr><th>Dinilai oleh</th><td>" + escapeHtmlServer(sv.penilai || "-") + "</td></tr>" +
      "</table>";
  } else {
    svBlock = "<div class='sub' style='margin:18px 0 8px;font-weight:bold;color:#111827;font-size:13px;'>Penilaian Supervisor — Periode " + period.label + "</div>" +
      "<div class='note'>Belum ada penilaian supervisor untuk periode ini.</div>";
  }
  body += svBlock;

  return raporHtmlShell("RAPOR OPERATOR — " + escapeHtmlServer(d.operator || "-"), "Operator " + escapeHtmlServer(d.operator || "-"), period, body);
}

/* =========================================================
 *  PENGINGAT TINDAK LANJUT TEMUAN P2H
 *  Jika checklist P2H menemukan item "CHECK" dan sudah lebih dari
 *  P2H_REMINDER_DELAY_JAM jam belum ada laporan trouble untuk unit itu,
 *  dianggap belum ditindaklanjuti → tampil di app (banner) + WA reminder.
 * ========================================================= */

/**
 * Mengumpulkan baris P2H dengan temuan CHECK yang belum ditindaklanjuti
 * (belum ada Trouble_Report untuk unit itu SETELAH waktu P2H tsb) dan
 * sudah melewati ambang waktu P2H_REMINDER_DELAY_JAM jam.
 */
function getP2HFollowupCandidates(ss) {
  var sheet = ss.getSheetByName("P2H");
  if (!sheet || sheet.getLastRow() < 2) return [];

  var lastRow = sheet.getLastRow();
  var numCols = Math.max(sheet.getLastColumn(), P2H_REMINDER_COL);
  var data = sheet.getRange(2, 1, lastRow - 1, numCols).getValues();

  var troubleSheet = findSheet(ss, TROUBLE_SHEET_NAMES);
  var troubleRows = troubleSheet ? readSheetFlexible(troubleSheet, TROUBLE_FIELDS) : [];

  var now = new Date();
  var candidates = [];

  data.forEach(function (row, idx) {
    var ts = row[0] ? new Date(row[0]) : null;
    if (!ts || isNaN(ts.getTime())) return;

    var hasIssue = row.slice(5, 14).indexOf("CHECK") !== -1;
    if (!hasIssue) return;

    var hoursSince = (now.getTime() - ts.getTime()) / 3600000;
    if (hoursSince < P2H_REMINDER_DELAY_JAM) return;

    var unit = row[3];
    var alreadyReported = troubleRows.some(function (t) {
      return t.unit === unit && t.timestamp && new Date(t.timestamp) > ts;
    });
    if (alreadyReported) return;

    candidates.push({
      rowIndex: idx + 2,
      timestamp: ts,
      operator: row[2],
      unit: unit,
      catatan: row[14] || "",
      jamLalu: Math.floor(hoursSince),
      reminderSent: !!row[P2H_REMINDER_COL - 1]
    });
  });

  candidates.sort(function (a, b) { return b.jamLalu - a.jamLalu; });
  return candidates;
}

/** Dipakai frontend untuk menampilkan banner "perlu tindak lanjut" di aplikasi. */
function getP2HFollowupList(ss) {
  return getP2HFollowupCandidates(ss).map(function (c) {
    return {
      timestamp: Utilities.formatDate(c.timestamp, Session.getScriptTimeZone(), "dd/MM/yyyy HH:mm"),
      operator: c.operator,
      unit: c.unit,
      catatan: c.catatan,
      jamLalu: c.jamLalu
    };
  });
}

/**
 * PENGINGAT WA OTOMATIS — dipanggil oleh time-driven trigger tiap jam.
 * Cara pasang: jalankan setupP2HFollowupReminderTrigger() SEKALI dari editor Apps Script.
 */
function checkAndSendP2HFollowupReminders() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sheet = ss.getSheetByName("P2H");
  if (!sheet) return;

  var due = getP2HFollowupCandidates(ss).filter(function (c) { return !c.reminderSent; });
  if (due.length === 0) return;

  var lines = due.map(function (it) {
    return "• *" + it.unit + "* — dilaporkan " + it.operator + " (" +
      Utilities.formatDate(it.timestamp, Session.getScriptTimeZone(), "dd/MM HH:mm") + ", " + it.jamLalu + " jam lalu)" +
      (it.catatan ? "\n   Catatan: " + it.catatan : "");
  });

  var msg = "⚠️ *TINDAK LANJUT TEMUAN P2H*\n" +
    "------------------------------------\n" +
    "Item berikut ditemukan CHECK (perlu perhatian) saat P2H dan sudah lebih dari " + P2H_REMINDER_DELAY_JAM +
    " jam belum ada laporan trouble/tindak lanjut:\n\n" +
    lines.join("\n\n") + "\n\n" +
    "Operator sudah melakukan deteksi dini dengan benar — mohon segera dibawa ke mekanik untuk pemeriksaan/perbaikan.\n" +
    "📅 " + Utilities.formatDate(new Date(), Session.getScriptTimeZone(), "dd/MM/yyyy HH:mm") + " WIB";

  sendFonnteWA(msg, WA_TARGET_TROUBLE);

  due.forEach(function (it) {
    sheet.getRange(it.rowIndex, P2H_REMINDER_COL).setValue(new Date());
  });
}

function setupP2HFollowupReminderTrigger() {
  var triggers = ScriptApp.getProjectTriggers();
  triggers.forEach(function (t) {
    if (t.getHandlerFunction() === "checkAndSendP2HFollowupReminders") {
      ScriptApp.deleteTrigger(t);
    }
  });
  ScriptApp.newTrigger("checkAndSendP2HFollowupReminders")
    .timeBased()
    .everyHours(1)
    .create();
}

/* =========================================================
 *  PENILAIAN SUPERVISOR (5 Kriteria) — khusus diisi supervisor
 *  Dilindungi PIN (SUPERVISOR_PIN di Script Properties), divalidasi di server.
 *  Ditampilkan sebagai bagian terpisah dari skor data operasional di Rapor Operator,
 *  supaya data objektif (P2H/trouble) dan penilaian subjektif tidak tercampur.
 * ========================================================= */

function submitPenilaianSupervisor(ss, d) {
  var pin = getSupervisorPin();
  if (!pin) {
    return jsonOutput({ result: "error", message: "PIN Supervisor belum diatur oleh admin. Atur di Script Properties dengan nama SUPERVISOR_PIN." });
  }
  if (String(d.pin || "") !== String(pin)) {
    return jsonOutput({ result: "error", message: "PIN Supervisor salah." });
  }
  if (!d.operator) {
    return jsonOutput({ result: "error", message: "Operator yang dinilai belum dipilih." });
  }

  var sheet = ss.getSheetByName("Penilaian_Supervisor");
  if (!sheet) {
    sheet = ss.insertSheet("Penilaian_Supervisor");
    sheet.appendRow([
      "Timestamp", "Operator", "Periode", "Penilai",
      "K3_Safety", "Keterampilan_Teknis", "Kebersihan_Alat", "Kedisiplinan", "Problem_Solving",
      "Catatan"
    ]);
  }

  var periode = d.periode || Utilities.formatDate(new Date(), Session.getScriptTimeZone(), "yyyy-MM");

  sheet.appendRow([
    new Date(),
    d.operator,
    periode,
    d.penilai || "-",
    clampSkor1to5(d.k3),
    clampSkor1to5(d.keterampilan),
    clampSkor1to5(d.kebersihan),
    clampSkor1to5(d.kedisiplinan),
    clampSkor1to5(d.problemSolving),
    d.catatan || ""
  ]);

  return jsonOutput({ result: "success", message: "Penilaian supervisor untuk " + d.operator + " berhasil disimpan" });
}

function clampSkor1to5(v) {
  var n = Number(v) || 0;
  return Math.max(1, Math.min(5, Math.round(n)));
}

/** Penilaian supervisor terbaru per operator, untuk 1 periode (yyyy-MM). */
function getSupervisorAssessmentMap(ss, periodKey) {
  var sheet = ss.getSheetByName("Penilaian_Supervisor");
  var map = {};
  if (!sheet || sheet.getLastRow() < 2) return map;

  var data = sheet.getRange(2, 1, sheet.getLastRow() - 1, 10).getValues();
  data.forEach(function (r) {
    var op = String(r[1]).trim();
    var periode = String(r[2]).trim();
    if (!op || periode !== periodKey) return;

    var entry = {
      timestamp: r[0], penilai: r[3],
      k3: Number(r[4]) || 0, keterampilan: Number(r[5]) || 0, kebersihan: Number(r[6]) || 0,
      kedisiplinan: Number(r[7]) || 0, problemSolving: Number(r[8]) || 0, catatan: r[9] || ""
    };
    if (!map[op] || new Date(entry.timestamp) > new Date(map[op].timestamp)) map[op] = entry;
  });
  return map;
}

var REQUEST_SHEET_NAMES = ["Request_Servis", "Request Servis"];
var REQUEST_FIELDS = {
  timestamp: ["Timestamp"],
  unit: ["Unit", "Alat"],
  operator: ["Pemohon", "Operator", "Nama Operator", "Diajukan Oleh"],
  jenisServis: ["Jenis Servis", "JenisServis"],
  tanggalDiinginkan: ["Tanggal Diinginkan", "TanggalDiinginkan"],
  hm: ["HM"],
  catatan: ["Catatan"],
  status: ["Status"]
};

function submitRequestServis(ss, d) {
  var sheet = findSheet(ss, REQUEST_SHEET_NAMES);
  if (!sheet) return jsonOutput({ result: "error", message: "Sheet Request Servis tidak ditemukan" });
  
  appendRowFlexible(sheet, {
    timestamp: { candidates: REQUEST_FIELDS.timestamp, value: new Date() },
    unit: { candidates: REQUEST_FIELDS.unit, value: d.alat },
    operator: { candidates: REQUEST_FIELDS.operator, value: d.operator },
    jenisServis: { candidates: REQUEST_FIELDS.jenisServis, value: d.jenisServis },
    tanggalDiinginkan: { candidates: REQUEST_FIELDS.tanggalDiinginkan, value: d.tanggalDiinginkan },
    hm: { candidates: REQUEST_FIELDS.hm, value: formatHmValue(d.hm) },
    catatan: { candidates: REQUEST_FIELDS.catatan, value: d.catatan },
    status: { candidates: REQUEST_FIELDS.status, value: "Menunggu" }
  });

  return jsonOutput({ result: "success" });
}

function getRequestHistory(ss, unitFilter, limit) {
  var sheet = findSheet(ss, REQUEST_SHEET_NAMES);
  if (!sheet) return { rows: [] };
  var rows = readSheetFlexible(sheet, REQUEST_FIELDS).map(function (r) {
    return {
      timestamp: r.timestamp ? Utilities.formatDate(new Date(r.timestamp), Session.getScriptTimeZone(), "dd/MM/yyyy HH:mm") : "",
      unit: r.unit, operator: r.operator, jenisServis: r.jenisServis,
      tanggalDiinginkan: formatDateSafe(r.tanggalDiinginkan), hm: formatHmValue(r.hm),
      catatan: r.catatan || "", status: r.status || "Menunggu"
    };
  });
  if (unitFilter) rows = rows.filter(function (r) { return r.unit == unitFilter; });
  rows.reverse();
  return { rows: rows.slice(0, limit) };
}

function getInitData(ss) {
  var opSheet = ss.getSheetByName("Nama_Operator");
  var operators = [];
  if (opSheet && opSheet.getLastRow() > 1) {
    operators = opSheet.getRange(2, 1, opSheet.getLastRow() - 1, 1)
      .getValues().flat().filter(function (v) { return v !== ""; });
  }

  // Detect active/unresolved troubles
  var troubledUnits = {};
  var troubleSheet = findSheet(ss, TROUBLE_SHEET_NAMES);
  if (troubleSheet && troubleSheet.getLastRow() > 1) {
    var troubleRows = readSheetFlexible(troubleSheet, TROUBLE_FIELDS);
    troubleRows.forEach(function(r) {
      var st = String(r.status || "").trim().toLowerCase();
      if (st !== "selesai" && st !== "done" && st !== "closed" && r.unit) {
        troubledUnits[String(r.unit).trim().toLowerCase()] = r.deskripsi || "Unit trouble belum diperbaiki";
      }
    });
  }

  var unitSheet = ss.getSheetByName("Unit");
  var units = [];
  if (unitSheet && unitSheet.getLastRow() > 1) {
    var unitNames = unitSheet.getRange(2, 1, unitSheet.getLastRow() - 1, 1)
      .getValues().flat().filter(function (v) { return v !== ""; });

    var scheduleMap = getServisScheduleRawMap(ss);

    unitNames.forEach(function (name) {
      var s = scheduleMap[name] || {};
      var trKey = String(name).trim().toLowerCase();
      units.push({
        nama: name,
        interval: s.interval || 0,
        hmServisTerakhir: s.hmServisTerakhir || 0,
        tglServisTerakhir: formatDateSafe(s.tglServisTerakhir),
        overrideHM: (s.overrideHM === "" || s.overrideHM === null || s.overrideHM === undefined) ? "" : s.overrideHM,
        overrideTgl: formatDateSafe(s.overrideTgl),
        isTrouble: !!troubledUnits[trKey],
        troubleDesc: troubledUnits[trKey] || ""
      });
    });

    var greasingSchedule = computeGreasingSchedule(ss, unitNames);
    var greasingMap = {};
    greasingSchedule.forEach(function (g) { greasingMap[g.nama] = g; });
    units.forEach(function (u) {
      var g = greasingMap[u.nama] || {};
      u.intervalHariGreasing = g.intervalHariGreasing || GREASING_DEFAULT_INTERVAL_HARI;
      u.tglGreasingTerakhir = g.tglGreasingTerakhir || "";
      u.overrideTglGreasing = g.overrideTglGreasing || "";
      u.nextGreasingDate = g.nextGreasingDate || "";
      u.remainingDaysGreasing = g.remainingDaysGreasing;
      u.statusGreasing = g.statusGreasing || "BELUM_DIATUR";
      u.picGreasing = g.picGreasing || "";
    });
  }

  var currentHM = getCurrentHMMap(ss);
  units.forEach(function (u) {
    var rec = currentHM[u.nama];
    u.hmSaatIni = rec ? rec.hm : u.hmServisTerakhir;
  });

  return { operators: operators, units: units };
}

/**
 * Data mentah jadwal servis per unit dari sheet Data_Servis (atau kolom tambahan di sheet Unit).
 * Dipakai bersama oleh getInitData() dan fitur Rapor.
 */
function getServisScheduleRawMap(ss) {
  var scheduleFieldDefs = {
    unit: ["Unit", "Nama Unit"],
    interval: ["Interval_HM_Servis", "Interval HM Servis", "Interval Servis (Jam)", "Interval HM", "Interval"],
    hmServisTerakhir: ["HM_Servis_Terakhir", "HM Servis Terakhir", "HM Terakhir Servis"],
    tglServisTerakhir: ["Tanggal_Servis_Terakhir", "Tanggal Servis Terakhir", "Tanggal Servis", "Tgl Servis"],
    overrideHM: ["Override_HM_Berikutnya", "Override HM Berikutnya"],
    overrideTgl: ["Override_Tanggal_Berikutnya", "Override Tanggal Berikutnya"]
  };

  var scheduleMap = {};
  var dataServisSheet = findSheet(ss, ["Data_Servis", "Data Servis"]);
  if (dataServisSheet) {
    readSheetFlexible(dataServisSheet, scheduleFieldDefs).forEach(function (row) {
      if (row.unit) scheduleMap[row.unit] = row;
    });
  }

  var unitSheet = ss.getSheetByName("Unit");
  if (unitSheet && unitSheet.getLastColumn() > 1) {
    readSheetFlexible(unitSheet, scheduleFieldDefs).forEach(function (row) {
      if (row.unit && !scheduleMap[row.unit]) scheduleMap[row.unit] = row;
    });
  }
  return scheduleMap;
}

/** HM terakhir tercatat per unit, dari sheet P2H (baris terbaru per unit). */
function getCurrentHMMap(ss) {
  var p2hSheet = ss.getSheetByName("P2H");
  var currentHM = {};
  if (p2hSheet && p2hSheet.getLastRow() > 1) {
    var p2hData = p2hSheet.getRange(2, 1, p2hSheet.getLastRow() - 1, 5).getValues();
    p2hData.forEach(function (row) {
      var ts = row[0], unitName = row[3], hm = row[4];
      if (!unitName) return;
      var existing = currentHM[unitName];
      if (!existing || new Date(ts).getTime() > new Date(existing.ts).getTime()) {
        currentHM[unitName] = { hm: hm, ts: ts };
      }
    });
  }
  return currentHM;
}

/**
 * Status jadwal servis (OVERDUE/SEGERA/AMAN/BELUM_DIATUR) — logika ini sinkron
 * dengan perhitungan di frontend (renderJadwalServis) supaya angka yang tampil
 * di aplikasi dan di rapor/PDF selalu konsisten.
 */
function computeServisStatus(interval, lastHM, currentHM, overrideHM) {
  var hasOverride = overrideHM !== "" && overrideHM !== null && overrideHM !== undefined;
  if ((!interval || interval <= 0) && !hasOverride) {
    return { status: "BELUM_DIATUR", nextHM: null, remaining: null };
  }
  var nextHM = hasOverride ? parseHmNumber2(overrideHM) : (parseHmNumber2(lastHM) + Number(interval));
  var remaining = nextHM - parseHmNumber2(currentHM);
  var status = remaining <= 0 ? "OVERDUE" : (remaining <= SERVICE_WARNING_HM ? "SEGERA" : "AMAN");
  return { status: status, nextHM: nextHM, remaining: remaining };
}

function parseHmNumber2(val) {
  if (val === undefined || val === null || val === "") return 0;
  var n = parseFloat(String(val).trim().replace(",", "."));
  return isNaN(n) ? 0 : n;
}

function findSheet(ss, names) {
  for (var i = 0; i < names.length; i++) {
    var sh = ss.getSheetByName(names[i]);
    if (sh) return sh;
  }
  return null;
}

function getHeaderMap(sheet) {
  var lastCol = Math.max(sheet.getLastColumn(), 1);
  var headers = sheet.getRange(1, 1, 1, lastCol).getValues()[0];
  var map = {};
  headers.forEach(function (h, i) {
    if (h !== "" && h !== null && h !== undefined) map[String(h).trim().toLowerCase()] = i + 1;
  });
  return map;
}

function resolveColumn(headerMap, sheet, candidates) {
  for (var i = 0; i < candidates.length; i++) {
    var key = candidates[i].toLowerCase();
    if (headerMap[key]) return headerMap[key];
  }
  var newCol = sheet.getLastColumn() + 1;
  sheet.getRange(1, newCol).setValue(candidates[0]);
  headerMap[candidates[0].toLowerCase()] = newCol;
  return newCol;
}

function appendRowFlexible(sheet, fieldMap) {
  var headerMap = getHeaderMap(sheet);
  var newRow = sheet.getLastRow() + 1;
  Object.keys(fieldMap).forEach(function (key) {
    var col = resolveColumn(headerMap, sheet, fieldMap[key].candidates);
    sheet.getRange(newRow, col).setValue(fieldMap[key].value);
  });
}

function readSheetFlexible(sheet, fieldDefs) {
  if (sheet.getLastRow() < 2) return [];
  var headerMap = getHeaderMap(sheet);
  var colIndex = {};
  Object.keys(fieldDefs).forEach(function (key) {
    var candidates = fieldDefs[key];
    for (var i = 0; i < candidates.length; i++) {
      var k = candidates[i].toLowerCase();
      if (headerMap[k]) { colIndex[key] = headerMap[k]; break; }
    }
  });
  var lastCol = sheet.getLastColumn();
  var data = sheet.getRange(2, 1, sheet.getLastRow() - 1, lastCol).getValues();
  return data.map(function (row) {
    var obj = {};
    Object.keys(fieldDefs).forEach(function (key) {
      var idx = colIndex[key];
      obj[key] = idx ? row[idx - 1] : "";
    });
    return obj;
  });
}

function formatDateSafe(value) {
  if (!value) return "";
  try {
    if (value instanceof Date) {
      return Utilities.formatDate(value, Session.getScriptTimeZone(), "dd/MM/yyyy");
    }
    var d = new Date(value);
    if (!isNaN(d.getTime())) {
      return Utilities.formatDate(d, Session.getScriptTimeZone(), "dd/MM/yyyy");
    }
    return String(value);
  } catch (err) {
    return String(value);
  }
}

function jsonOutput(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
}