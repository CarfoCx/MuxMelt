'use strict';

const path = require('path');
const fs = require('fs');
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

function registerIPC(ipcMain, getMainWindow) {

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
