'use strict';

const path = require('path');
const fs = require('fs');
const os = require('os');
const { spawn } = require('child_process');
const { PDFDocument } = require('pdf-lib');
const { validateOutputDir, validateOutputName, formatToolError } = require('./path-utils');

/**
 * Merge multiple PDF files into one.
 */
async function mergePDFs(inputPaths, outputPath) {
  const mergedDoc = await PDFDocument.create();

  for (const pdfPath of inputPaths) {
    if (!fs.existsSync(pdfPath)) {
      throw new Error(`File not found: ${pdfPath}`);
    }
    let pdfBytes;
    try {
      pdfBytes = fs.readFileSync(pdfPath);
    } catch (err) {
      throw new Error(`Cannot read file "${path.basename(pdfPath)}": ${err.message}`);
    }
    let srcDoc;
    try {
      srcDoc = await PDFDocument.load(pdfBytes);
    } catch (err) {
      throw new Error(`Invalid PDF file "${path.basename(pdfPath)}": ${err.message}`);
    }
    const copiedPages = await mergedDoc.copyPages(srcDoc, srcDoc.getPageIndices());
    for (const page of copiedPages) {
      mergedDoc.addPage(page);
    }
  }

  const mergedBytes = await mergedDoc.save();
  fs.writeFileSync(outputPath, mergedBytes);
  return outputPath;
}

/**
 * Split a PDF into individual page files.
 */
async function splitPDF(inputPath, outputDir) {
  const pdfBytes = fs.readFileSync(inputPath);
  const srcDoc = await PDFDocument.load(pdfBytes);
  const baseName = path.basename(inputPath, '.pdf');
  const pageCount = srcDoc.getPageCount();
  const outputs = [];

  for (let i = 0; i < pageCount; i++) {
    const newDoc = await PDFDocument.create();
    const [copiedPage] = await newDoc.copyPages(srcDoc, [i]);
    newDoc.addPage(copiedPage);

    const pageNum = String(i + 1).padStart(String(pageCount).length, '0');
    const outPath = path.join(outputDir, `${baseName}_page_${pageNum}.pdf`);
    const newBytes = await newDoc.save();
    fs.writeFileSync(outPath, newBytes);
    outputs.push(outPath);
  }

  return outputs;
}

/**
 * Extract specific pages from a PDF.
 * @param {string} inputPath
 * @param {string} outputPath
 * @param {number[]} pageNumbers - 1-based page numbers
 */
async function extractPages(inputPath, outputPath, pageNumbers) {
  const pdfBytes = fs.readFileSync(inputPath);
  const srcDoc = await PDFDocument.load(pdfBytes);
  const pageCount = srcDoc.getPageCount();

  // Validate and convert to 0-based indices
  const indices = pageNumbers
    .map(n => n - 1)
    .filter(i => i >= 0 && i < pageCount);

  if (indices.length === 0) {
    throw new Error(`No valid pages to extract. PDF has ${pageCount} pages.`);
  }

  const newDoc = await PDFDocument.create();
  const copiedPages = await newDoc.copyPages(srcDoc, indices);
  for (const page of copiedPages) {
    newDoc.addPage(page);
  }

  const newBytes = await newDoc.save();
  fs.writeFileSync(outputPath, newBytes);
  return outputPath;
}

/**
 * Parse a page range string like "1-3,5,8-10" into an array of 1-based page numbers.
 */
function parsePageRange(rangeStr, totalPages) {
  const pages = new Set();
  const parts = rangeStr.split(',').map(s => s.trim()).filter(Boolean);

  for (const part of parts) {
    const rangeParts = part.split('-').map(s => s.trim());
    if (rangeParts.length === 2) {
      const start = parseInt(rangeParts[0], 10);
      const end = parseInt(rangeParts[1], 10);
      if (!isNaN(start) && !isNaN(end)) {
        for (let i = Math.max(1, start); i <= Math.min(totalPages, end); i++) {
          pages.add(i);
        }
      }
    } else {
      const num = parseInt(part, 10);
      if (!isNaN(num) && num >= 1 && num <= totalPages) {
        pages.add(num);
      }
    }
  }

  return Array.from(pages).sort((a, b) => a - b);
}

function splitRedactionTerms(value) {
  return String(value || '')
    .split(/\r?\n|,/)
    .map(item => item.trim())
    .filter(Boolean);
}

async function runPythonPdfEdit(pythonInfo, options) {
  if (!pythonInfo || !pythonInfo.cmd) {
    throw new Error('Python was not found. Secure PDF redaction requires Python with PyMuPDF installed.');
  }

  const jobPath = path.join(os.tmpdir(), `muxmelt-pdf-edit-${Date.now()}-${Math.random().toString(16).slice(2)}.json`);
  fs.writeFileSync(jobPath, JSON.stringify(options), 'utf8');

  const scriptPath = path.join(__dirname, '..', 'python', 'pdf_redact.py');
  let stdout = '';
  let stderr = '';

  try {
    await new Promise((resolve, reject) => {
      const proc = spawn(pythonInfo.cmd, [...(pythonInfo.args || []), scriptPath, jobPath], {
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true,
      });

      proc.stdout.on('data', chunk => { stdout += chunk.toString(); });
      proc.stderr.on('data', chunk => { stderr += chunk.toString(); });
      proc.on('error', reject);
      proc.on('close', code => {
        if (code === 0) resolve();
        else reject(new Error(stderr.trim() || stdout.trim() || `PDF edit worker exited with code ${code}`));
      });
    });
  } finally {
    fs.unlink(jobPath, () => {});
  }

  const lines = stdout.split(/\r?\n/).map(line => line.trim()).filter(Boolean);
  const parsed = JSON.parse(lines[lines.length - 1] || '{}');
  if (!parsed.success) {
    throw new Error(parsed.error || 'PDF edit failed');
  }
  return parsed;
}

function registerIPC(ipcMain, getMainWindow, getPythonInfo) {

  // ---- MERGE ----
  ipcMain.handle('pdf-toolkit-merge', async (event, options) => {
    const { inputPaths, outputDir, outputName } = options;

    try {
      if (!inputPaths || inputPaths.length < 2) {
        return { success: false, error: 'At least 2 PDF files are required for merging' };
      }

      const outDir = validateOutputDir(outputDir) || path.dirname(inputPaths[0]);
      fs.mkdirSync(outDir, { recursive: true });
      const safeName = validateOutputName(outputName) || 'merged.pdf';
      const outputPath = path.join(outDir, safeName);

      const win = getMainWindow();
      if (win) {
        win.webContents.send('tool-progress', {
          tool: 'pdf-toolkit',
          percent: 0,
          status: `Merging ${inputPaths.length} PDFs...`
        });
      }

      await mergePDFs(inputPaths, outputPath);

      if (win) {
        win.webContents.send('tool-progress', {
          tool: 'pdf-toolkit',
          percent: 100,
          status: 'Done'
        });
      }

      return { success: true, output: outputPath };
    } catch (err) {
      return { success: false, error: formatToolError(err, 'PDF Toolkit') };
    }
  });

  // ---- SPLIT ----
  ipcMain.handle('pdf-toolkit-split', async (event, options) => {
    const { inputPath, outputDir } = options;

    try {
      const outDir = validateOutputDir(outputDir) || path.dirname(inputPath);
      fs.mkdirSync(outDir, { recursive: true });

      const win = getMainWindow();
      if (win) {
        win.webContents.send('tool-progress', {
          tool: 'pdf-toolkit',
          percent: 0,
          status: 'Splitting PDF...'
        });
      }

      const outputs = await splitPDF(inputPath, outDir);

      if (win) {
        win.webContents.send('tool-progress', {
          tool: 'pdf-toolkit',
          percent: 100,
          status: 'Done'
        });
      }

      return { success: true, outputs, pageCount: outputs.length };
    } catch (err) {
      return { success: false, error: formatToolError(err, 'PDF Toolkit') };
    }
  });

  // ---- EXTRACT PAGES ----
  ipcMain.handle('pdf-toolkit-extract', async (event, options) => {
    const { inputPath, outputDir, outputName, pages } = options;

    try {
      if (!pages) {
        return { success: false, error: 'No pages specified. Use a range like "1-3,5,8-10".' };
      }

      // Read page count for validation
      const pdfBytes = fs.readFileSync(inputPath);
      const srcDoc = await PDFDocument.load(pdfBytes);
      const totalPages = srcDoc.getPageCount();

      const pageNumbers = parsePageRange(pages, totalPages);
      if (pageNumbers.length === 0) {
        return { success: false, error: `No valid pages found in range "${pages}". PDF has ${totalPages} pages.` };
      }

      const outDir = validateOutputDir(outputDir) || path.dirname(inputPath);
      fs.mkdirSync(outDir, { recursive: true });

      const baseName = path.basename(inputPath, '.pdf');
      const safeName = validateOutputName(outputName) || `${baseName}_extracted.pdf`;
      const outputPath = path.join(outDir, safeName);

      const win = getMainWindow();
      if (win) {
        win.webContents.send('tool-progress', {
          tool: 'pdf-toolkit',
          percent: 0,
          status: `Extracting ${pageNumbers.length} pages...`
        });
      }

      await extractPages(inputPath, outputPath, pageNumbers);

      if (win) {
        win.webContents.send('tool-progress', {
          tool: 'pdf-toolkit',
          percent: 100,
          status: 'Done'
        });
      }

      return {
        success: true,
        output: outputPath,
        extractedPages: pageNumbers,
        totalPages
      };
    } catch (err) {
      return { success: false, error: formatToolError(err, 'PDF Toolkit') };
    }
  });

  // ---- EDIT / SECURE REDACT ----
  ipcMain.handle('pdf-toolkit-edit', async (event, options = {}) => {
    const { inputPath, outputDir, redactTerms, rects, edits: textEdits } = options;

    try {
      if (!inputPath || !fs.existsSync(inputPath)) {
        return { success: false, error: 'Select one PDF to edit or redact.' };
      }

      const terms = splitRedactionTerms(redactTerms);
      const win = getMainWindow();

      if (win) {
        win.webContents.send('tool-progress', {
          tool: 'pdf-toolkit',
          percent: 0,
          status: 'Applying PDF edits...'
        });
      }

      const outDir = validateOutputDir(outputDir) || path.dirname(inputPath);
      fs.mkdirSync(outDir, { recursive: true });

      const baseName = path.basename(inputPath, '.pdf');
      const outputPath = path.join(outDir, `${baseName}_edited.pdf`);

      const pythonInfo = typeof getPythonInfo === 'function' ? getPythonInfo() : null;
      const result = await runPythonPdfEdit(pythonInfo, {
        action: 'edit',
        inputPath,
        outputPath,
        terms,
        rects: rects || [],
        edits: textEdits || [],
      });

      if (win) {
        win.webContents.send('tool-progress', {
          tool: 'pdf-toolkit',
          percent: 100,
          status: 'Done'
        });
      }

      return {
        success: true,
        output: result.output,
        redactions: result.redactions || 0,
        textEdits: result.textEdits || 0,
      };
    } catch (err) {
      return { success: false, error: formatToolError(err, 'PDF Toolkit') };
    }
  });

  // ---- RENDER PREVIEW ----
  ipcMain.handle('pdf-toolkit-render', async (event, options = {}) => {
    const { inputPath, dpi = 150 } = options;

    try {
      if (!inputPath || !fs.existsSync(inputPath)) {
        throw new Error('PDF file not found');
      }

      const pythonInfo = typeof getPythonInfo === 'function' ? getPythonInfo() : null;
      const result = await runPythonPdfEdit(pythonInfo, {
        action: 'render',
        inputPath,
        dpi
      });

      return result;
    } catch (err) {
      return { success: false, error: formatToolError(err, 'PDF Toolkit') };
    }
  });

  // ---- INFO ----
  ipcMain.handle('pdf-toolkit-info', async (event, filePath) => {
    try {
      const pdfBytes = fs.readFileSync(filePath);
      const doc = await PDFDocument.load(pdfBytes);
      return {
        success: true,
        pageCount: doc.getPageCount(),
        title: doc.getTitle() || null,
        author: doc.getAuthor() || null,
        subject: doc.getSubject() || null,
        creator: doc.getCreator() || null
      };
    } catch (err) {
      return { success: false, error: formatToolError(err, 'PDF Toolkit') };
    }
  });
}

module.exports = { registerIPC };
