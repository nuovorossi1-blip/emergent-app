/**
 * Porting 1:1 di parse_excel_bytes() / estimate_missing() da backend/server.py.
 * Layout colonne Excel fisso (0-based), stesso identico schema del backend originale.
 *
 * NOTA: l'import di "xlsx" e' dinamico (dentro parseExcelBytes) e non in cima
 * al file, cosi' un eventuale problema di caricamento del modulo viene
 * catturato dal try/catch del chiamante invece di far crashare la funzione
 * (che altrimenti risulterebbe in un 502 senza nessun dettaglio).
 */

const ITALIAN_MONTHS: Record<string, number> = {
  gennaio: 1, febbraio: 2, marzo: 3, aprile: 4,
  maggio: 5, giugno: 6, luglio: 7, agosto: 8,
  settembre: 9, ottobre: 10, novembre: 11, dicembre: 12,
};

const DATE_HEADER_RE =
  /(\d{1,2})\s*(gennaio|febbraio|marzo|aprile|maggio|giugno|luglio|agosto|settembre|ottobre|novembre|dicembre)/i;

// Colonne Excel (0-based), stesso schema del backend originale
const COL_ORA = 0;      // A
const COL_MANIF = 1;    // B
const COL_SQ1 = 4;      // E
const COL_SQ2 = 5;      // F
const COL_1 = 8;         // I
const COL_X = 9;         // J
const COL_2 = 10;        // K
const COL_1X = 15;       // P
const COL_X2 = 16;       // Q
const COL_12 = 17;       // R
const COL_U15 = 18;      // S
const COL_O15 = 19;      // T
const COL_U25 = 20;      // U
const COL_O25 = 21;      // V
const COL_U35 = 22;      // W
const COL_O35 = 23;      // X
const COL_GG = 24;       // Y
const COL_NG = 25;       // Z

const REQUIRED_ODDS = [
  "odd_1", "odd_X", "odd_2",
  "odd_U15", "odd_O15",
  "odd_U25", "odd_O25",
  "odd_U35", "odd_O35",
  "odd_GG", "odd_NG",
];

function parseDateHeader(cellValue: any, baseYear: number): Date | null {
  if (cellValue === null || cellValue === undefined || cellValue === "") return null;
  const s = String(cellValue).toLowerCase();
  const m = DATE_HEADER_RE.exec(s);
  if (!m) return null;
  const month = ITALIAN_MONTHS[m[2].toLowerCase()];
  const day = parseInt(m[1], 10);
  if (!month || day < 1 || day > 31) return null;
  const d = new Date(Date.UTC(baseYear, month - 1, day));
  return isNaN(d.getTime()) ? null : d;
}

function parseFirstDay(rows: any[][]): Date | null {
  const baseYear = new Date().getFullYear();
  const maxR = Math.min(20, rows.length);
  for (let r = 0; r < maxR; r++) {
    const maxC = Math.min(6, rows[r]?.length || 0);
    for (let c = 0; c < maxC; c++) {
      const d = parseDateHeader(rows[r][c], baseYear);
      if (d) return d;
    }
  }
  return null;
}

function parseTime(val: any): string | null {
  if (val === null || val === undefined || val === "") return null;
  const s = String(val).trim();
  const f = parseFloat(s);
  if (!isNaN(f) && f >= 0 && f < 1 && /^[\d.]+$/.test(s)) {
    const totalMin = Math.round(f * 24 * 60);
    const h = Math.floor(totalMin / 60);
    const mi = totalMin % 60;
    return `${String(h).padStart(2, "0")}:${String(mi).padStart(2, "0")}`;
  }
  let m = /(\d{1,2})[:.](\d{2})/.exec(s);
  if (m) {
    const h = parseInt(m[1], 10);
    const mi = parseInt(m[2], 10);
    if (h >= 0 && h < 24 && mi >= 0 && mi < 60) {
      return `${String(h).padStart(2, "0")}:${String(mi).padStart(2, "0")}`;
    }
  }
  m = /^(\d{3,4})$/.exec(s);
  if (m) {
    const n = parseInt(m[1], 10);
    const h = Math.floor(n / 100);
    const mi = n % 100;
    if (h >= 0 && h < 24 && mi >= 0 && mi < 60) {
      return `${String(h).padStart(2, "0")}:${String(mi).padStart(2, "0")}`;
    }
  }
  return null;
}

function parseOdd(val: any): number | null {
  if (val === null || val === undefined || val === "") return null;
  const s = String(val).trim().replace(",", ".");
  const f = parseFloat(s);
  if (!isNaN(f) && f >= 1.01) return Math.round(f * 100) / 100;
  return null;
}

function poissonCdf(k: number, lam: number): number {
  let s = 0;
  let fact = 1;
  for (let i = 0; i <= k; i++) {
    if (i > 0) fact *= i;
    s += (Math.exp(-lam) * Math.pow(lam, i)) / fact;
  }
  return s;
}

function lambdaFromO25(oddO25: number): number {
  const target = 1 / oddO25;
  let lo = 0.1, hi = 8.0;
  for (let i = 0; i < 40; i++) {
    const mid = (lo + hi) / 2;
    const pO25 = 1 - poissonCdf(2, mid);
    if (pO25 < target) lo = mid;
    else hi = mid;
  }
  return (lo + hi) / 2;
}

function complement(o: number | null): number | null {
  return o && o > 1.01 ? Math.round((1 / (1 - 1 / o)) * 100) / 100 : null;
}

function estimateMissing(odds: Record<string, number | null>): string[] {
  const estimated: string[] = [];

  if (!odds.odd_1X && odds.odd_1 && odds.odd_X) {
    odds.odd_1X = Math.round(((odds.odd_1 * odds.odd_X) / (odds.odd_1 + odds.odd_X)) * 100) / 100;
    estimated.push("odd_1X");
  }
  if (!odds.odd_X2 && odds.odd_X && odds.odd_2) {
    odds.odd_X2 = Math.round(((odds.odd_X * odds.odd_2) / (odds.odd_X + odds.odd_2)) * 100) / 100;
    estimated.push("odd_X2");
  }
  if (!odds.odd_12 && odds.odd_1 && odds.odd_2) {
    odds.odd_12 = Math.round(((odds.odd_1 * odds.odd_2) / (odds.odd_1 + odds.odd_2)) * 100) / 100;
    estimated.push("odd_12");
  }

  if (!odds.odd_U15 && odds.odd_O15) {
    odds.odd_U15 = complement(odds.odd_O15);
    estimated.push("odd_U15");
  }
  if (!odds.odd_O15 && odds.odd_U15) {
    odds.odd_O15 = complement(odds.odd_U15);
    estimated.push("odd_O15");
  }
  if (!odds.odd_U35 && odds.odd_O35) {
    odds.odd_U35 = complement(odds.odd_O35);
    estimated.push("odd_U35");
  }
  if (!odds.odd_O35 && odds.odd_U35) {
    odds.odd_O35 = complement(odds.odd_U35);
    estimated.push("odd_O35");
  }

  if (odds.odd_O25) {
    const lam = lambdaFromO25(odds.odd_O25);
    if (!odds.odd_O15) {
      const pO15 = 1 - poissonCdf(1, lam);
      if (pO15 > 0.01) {
        odds.odd_O15 = Math.round((1 / pO15) * 100) / 100;
        estimated.push("odd_O15");
        odds.odd_U15 = complement(odds.odd_O15);
        estimated.push("odd_U15");
      }
    }
    if (!odds.odd_O35) {
      const pO35 = 1 - poissonCdf(3, lam);
      if (pO35 > 0.01) {
        odds.odd_O35 = Math.round((1 / pO35) * 100) / 100;
        estimated.push("odd_O35");
        odds.odd_U35 = complement(odds.odd_O35);
        estimated.push("odd_U35");
      }
    }
  }

  return estimated;
}

export type ParsedMatch = {
  day: string;
  time: string;
  manifestazione: string;
  squadra1: string;
  squadra2: string;
  odds: Record<string, number | null> & { estimated: string[] };
};

export type SkippedRow = {
  row: number;
  time: string | null;
  sq1: string;
  sq2: string;
  manif: string;
  reason: string;
  odds_read: Record<string, number>;
  missing: string[];
};

export type ParsedExcel = {
  matches: ParsedMatch[];
  skipped: SkippedRow[];
  rows_seen: number;
};

function toIsoDate(d: Date): string {
  return d.toISOString().slice(0, 10);
}

export async function parseExcelBytes(buffer: ArrayBuffer, filename: string): Promise<ParsedExcel> {
  const XLSX = await import("xlsx");
  const wb = XLSX.read(buffer, { type: "array", cellDates: false });

  // TUTTI i fogli, non solo il primo (corretto il 19/09/2026).
  // iLovePDF, convertendo il PDF Sisal, crea un foglio per ogni PAGINA del PDF:
  // un file da ~1200 partite arriva quindi con decine di fogli. Leggendo solo
  // `SheetNames[0]` se ne importavano 137 e le altre sparivano in silenzio, senza
  // nemmeno finire fra le righe scartate (il parser non le vedeva proprio).
  // I fogli si concatenano nell'ordine del file: e' lo stesso ordine delle pagine
  // del PDF, quindi la logica che fa scattare il giorno successivo quando l'orario
  // torna indietro continua a funzionare da un foglio all'altro.
  const rows: any[][] = [];
  const origine: { foglio: string; riga: number }[] = [];
  for (const nome of wb.SheetNames) {
    const sheet = wb.Sheets[nome];
    if (!sheet) continue;
    const righe: any[][] = XLSX.utils.sheet_to_json(sheet, { header: 1, raw: true, defval: null });
    for (let i = 0; i < righe.length; i++) {
      rows.push(righe[i]);
      origine.push({ foglio: nome, riga: i + 1 });
    }
  }
  const piuFogli = wb.SheetNames.length > 1;
  // Riferimento leggibile per la schermata degli scarti: con un foglio solo resta
  // il numero di riga di sempre, con piu' fogli si aggiunge il nome del foglio.
  const rifRiga = (idx: number) => origine[idx]?.riga ?? idx + 1;
  const rifFoglio = (idx: number) =>
    piuFogli && origine[idx] ? ` (foglio "${origine[idx].foglio}")` : "";

  const baseYear = new Date().getFullYear();
  let firstDay = parseFirstDay(rows);
  if (!firstDay) firstDay = new Date();

  const matches: ParsedMatch[] = [];
  const skipped: SkippedRow[] = [];
  let currentDay = new Date(Date.UTC(firstDay.getUTCFullYear(), firstDay.getUTCMonth(), firstDay.getUTCDate()));
  let prevTimeMin: number | null = null;
  let explicitDaySet = false;
  let rowsSeen = 0;

  for (let idx = 0; idx < rows.length; idx++) {
    const row = rows[idx] || [];

    const dateInRow = parseDateHeader(row[COL_ORA], baseYear);
    if (dateInRow) {
      currentDay = dateInRow;
      prevTimeMin = null;
      explicitDaySet = true;
      continue;
    }

    const oraRaw = row[COL_ORA];
    const timeStr = parseTime(oraRaw);
    if (!timeStr) continue;
    rowsSeen++;

    const sq1 = row[COL_SQ1] != null ? String(row[COL_SQ1]).trim() : "";
    const sq2 = row[COL_SQ2] != null ? String(row[COL_SQ2]).trim() : "";
    if (!sq1 || !sq2) {
      skipped.push({
        row: rifRiga(idx), time: timeStr, sq1, sq2, manif: "N/D",
        reason: "Squadre mancanti" + rifFoglio(idx), odds_read: {}, missing: [],
      });
      continue;
    }

    const manif = row[COL_MANIF] != null ? String(row[COL_MANIF]).trim() : "N/D";

    const curMin = parseInt(timeStr.slice(0, 2), 10) * 60 + parseInt(timeStr.slice(3), 10);
    if (!explicitDaySet && prevTimeMin !== null && curMin < prevTimeMin) {
      currentDay = new Date(currentDay.getTime() + 24 * 60 * 60 * 1000);
    }
    prevTimeMin = curMin;

    const col = (i: number) => (i < row.length ? row[i] : null);

    const odds: Record<string, number | null> = {
      odd_1: parseOdd(col(COL_1)),
      odd_X: parseOdd(col(COL_X)),
      odd_2: parseOdd(col(COL_2)),
      odd_1X: parseOdd(col(COL_1X)),
      odd_X2: parseOdd(col(COL_X2)),
      odd_12: parseOdd(col(COL_12)),
      odd_U15: parseOdd(col(COL_U15)),
      odd_O15: parseOdd(col(COL_O15)),
      odd_U25: parseOdd(col(COL_U25)),
      odd_O25: parseOdd(col(COL_O25)),
      odd_U35: parseOdd(col(COL_U35)),
      odd_O35: parseOdd(col(COL_O35)),
      odd_GG: parseOdd(col(COL_GG)),
      odd_NG: parseOdd(col(COL_NG)),
    };

    const missing = REQUIRED_ODDS.filter((k) => odds[k] === null || odds[k] === undefined);
    if (missing.length) {
      const oddsRead: Record<string, number> = {};
      for (const [k, v] of Object.entries(odds)) if (v !== null) oddsRead[k] = v;
      skipped.push({
        row: rifRiga(idx), time: timeStr, sq1, sq2, manif,
        reason: `Quote mancanti: ${missing.join(", ")}` + rifFoglio(idx),
        odds_read: oddsRead, missing,
      });
      continue;
    }

    const estimated = estimateMissing(odds);

    matches.push({
      day: toIsoDate(currentDay),
      time: timeStr,
      manifestazione: manif,
      squadra1: sq1,
      squadra2: sq2,
      odds: { ...odds, estimated } as ParsedMatch["odds"],
    });
  }

  return { matches, skipped, rows_seen: rowsSeen };
}
