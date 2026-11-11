import * as XLSX from "xlsx";

/**
 * Real .xlsx download (Tanda #4 — formato Excel, no CSV).
 * `totals` is appended as a bold-ish final row for accounting readability.
 */
export function downloadXlsx(
  filename: string,
  sheetName: string,
  headers: string[],
  rows: (string | number)[][],
  totals?: (string | number)[],
): void {
  const aoa: (string | number)[][] = [headers, ...rows];
  if (totals) aoa.push(totals);

  const ws = XLSX.utils.aoa_to_sheet(aoa);

  // Column widths: first col wider (dates/labels), money cols ~16.
  ws["!cols"] = headers.map((_, i) =>
    i === 0 ? { wch: 22 } : { wch: 16 },
  );

  // Bold-ish emphasis on the totals row via cell styling is limited in the
  // community build — highlight by zebra on the header instead.
  ws["!autofilter"] = { ref: XLSX.utils.encode_range({
    s: { r: 0, c: 0 },
    e: { r: 0, c: headers.length - 1 },
  })};

  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, sheetName.slice(0, 31) || "Reporte");
  XLSX.writeFile(wb, filename.endsWith(".xlsx") ? filename : `${filename}.xlsx`);
}
