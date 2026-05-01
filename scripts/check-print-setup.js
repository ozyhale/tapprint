#!/usr/bin/env node
/**
 * Run on the print-server laptop (Windows) after configuring .env.
 * Checks SumatraPDF path and that configured printer queues exist.
 */

require('dotenv').config({ path: require('path').join(process.cwd(), '.env') });

const fs = require('fs');
const { execSync } = require('child_process');

function listWindowsPrinters() {
  try {
    const out = execSync(
      'powershell -NoProfile -Command "Get-Printer | Select-Object -ExpandProperty Name"',
      { encoding: 'utf8' }
    );
    return out
      .split(/\r?\n/)
      .map((s) => s.trim())
      .filter(Boolean);
  } catch (e) {
    console.error('Could not list printers. Run this script on Windows with PowerShell available.');
    console.error(e.message);
    process.exitCode = 1;
    return [];
  }
}

function main() {
  const sumatra = process.env.SUMATRA_PATH || '';
  const bw = process.env.PRINTER_BW || '';
  const color = process.env.PRINTER_COLOR || '';

  console.log('TapPrint print setup check\n');

  let ok = true;

  if (!sumatra) {
    console.error('[FAIL] SUMATRA_PATH is not set in .env');
    ok = false;
  } else if (!fs.existsSync(sumatra)) {
    console.error(`[FAIL] SumatraPDF not found: ${sumatra}`);
    ok = false;
  } else {
    console.log(`[OK] SumatraPDF found: ${sumatra}`);
  }

  const printers = new Set(listWindowsPrinters());
  if (printers.size === 0 && process.exitCode === 1) {
    return;
  }

  if (!bw) {
    console.error('[FAIL] PRINTER_BW is not set');
    ok = false;
  } else if (!printers.has(bw)) {
    console.error(`[FAIL] BW printer queue not found: "${bw}"`);
    console.log('Installed queues:', [...printers].join(', ') || '(none)');
    ok = false;
  } else {
    console.log(`[OK] BW printer queue exists: ${bw}`);
  }

  if (!color) {
    console.error('[FAIL] PRINTER_COLOR is not set');
    ok = false;
  } else if (!printers.has(color)) {
    console.error(`[FAIL] Color printer queue not found: "${color}"`);
    console.log('Installed queues:', [...printers].join(', ') || '(none)');
    ok = false;
  } else {
    console.log(`[OK] Color printer queue exists: ${color}`);
  }

  console.log('');
  if (ok) {
    console.log('Manual test (prints one copy to the BW queue):');
    console.log(`"${sumatra}" -print-to "${bw}" -silent "C:\\path\\to\\test.pdf"`);
    console.log('\nAll checks passed.');
  } else {
    console.log('Fix .env and Windows printers, then run: npm run check-print');
    process.exitCode = 1;
  }
}

main();
