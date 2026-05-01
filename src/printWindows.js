const { spawn } = require('child_process');
const fs = require('fs');

/**
 * Print a PDF using SumatraPDF on Windows. Runs one Sumatra process per copy for compatibility.
 */
async function printPdf({ sumatraPath, printerName, pdfPath, copies }) {
  const absSumatra = sumatraPath;
  const absPdf = pdfPath;

  if (!fs.existsSync(absSumatra)) {
    throw new Error(`SumatraPDF not found at ${absSumatra}`);
  }
  if (!fs.existsSync(absPdf)) {
    throw new Error(`PDF not found at ${absPdf}`);
  }

  const n = Math.max(1, Math.min(99, Number(copies) || 1));
  const argsBase = ['-print-to', printerName, '-silent', absPdf];

  for (let i = 0; i < n; i += 1) {
    await spawnSumatra(absSumatra, argsBase);
  }

  return { ok: true, copies: n, printerName };
}

function spawnSumatra(sumatraPath, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(sumatraPath, args, {
      windowsHide: true,
      stdio: 'ignore',
    });
    child.on('error', reject);
    child.on('close', (code) => {
      if (code === 0) resolve();
      else reject(new Error(`SumatraPDF exited with code ${code}`));
    });
  });
}

module.exports = { printPdf };
