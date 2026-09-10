// Bytes in, plain text out. PDF, DOCX, or text — everything downstream only
// ever sees a string, so the parser doesn't care where the resume came from.

const MIN_USEFUL_CHARS = 100;

// pdf-parse's package entry point runs a debug block when it thinks it's the
// main module, which misfires under ESM. Import the library file directly.
async function loadPdfParse() {
  const mod = await import('pdf-parse/lib/pdf-parse.js');
  return mod.default || mod;
}

export class ExtractionError extends Error {
  constructor(message, code) {
    super(message);
    this.code = code;
  }
}

/**
 * @param {Buffer} buffer
 * @param {string} filename — only used to pick the decoder
 * @returns {Promise<{ text: string, source: string, pages?: number }>}
 */
export async function extractFromBuffer(buffer, filename = '') {
  const name = filename.toLowerCase();

  if (name.endsWith('.pdf') || isPdf(buffer)) {
    const pdfParse = await loadPdfParse();
    let result;
    try {
      result = await pdfParse(buffer);
    } catch (error) {
      throw new ExtractionError(`This PDF could not be opened (${error.message}). Try exporting it again from your editor.`, 'pdf_unreadable');
    }
    const text = clean(result.text);
    // Under 100 characters from a PDF means an image, not a document. We say
    // so plainly rather than scoring garbage. OCR is on the cut list.
    if (text.length < MIN_USEFUL_CHARS) {
      throw new ExtractionError(
        'That PDF looks like a scanned image — almost no text came out of it. Export a text PDF from Word or Google Docs, or paste the resume text instead. (We do not run OCR.)',
        'scanned_image',
      );
    }
    return { text, source: 'pdf', pages: result.numpages };
  }

  if (name.endsWith('.docx')) {
    const mammoth = (await import('mammoth')).default;
    const result = await mammoth.extractRawText({ buffer });
    const text = clean(result.value);
    if (text.length < MIN_USEFUL_CHARS) {
      throw new ExtractionError('That DOCX came out almost empty. Paste the resume text instead.', 'empty_docx');
    }
    return { text, source: 'docx' };
  }

  if (name.endsWith('.doc')) {
    throw new ExtractionError('Legacy .doc files are not supported — save as .docx or PDF.', 'unsupported_format');
  }

  const text = clean(buffer.toString('utf8'));
  if (text.length < MIN_USEFUL_CHARS) {
    throw new ExtractionError('Not enough text to work with — send at least a few lines.', 'too_short');
  }
  return { text, source: 'text' };
}

/** Pasted text path. Same guard, so both routes fail identically. */
export function extractFromText(raw) {
  const text = clean(raw);
  if (text.length < MIN_USEFUL_CHARS) {
    throw new ExtractionError(`Only ${text.length} characters of text — send at least ${MIN_USEFUL_CHARS}.`, 'too_short');
  }
  return { text, source: 'text' };
}

const isPdf = (buffer) => Buffer.isBuffer(buffer) && buffer.subarray(0, 5).toString() === '%PDF-';

function clean(text) {
  return String(text || '')
    .replace(/\r\n?/g, '\n')
    .replace(/ /g, ' ')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

export { MIN_USEFUL_CHARS };
