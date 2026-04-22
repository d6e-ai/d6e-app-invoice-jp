// Render a Japanese Qualified Invoice payload to an A4 PDF.
//
// Uses pdf-lib with an embedded M+ 1p Regular font for proper Japanese
// glyph coverage. The layout lays out all six mandatory fields of the
// Japanese Invoice System (インボイス制度) plus optional issuer logo,
// payment terms, and notes.
//
// Accepts either a normalized payload from `validate-qualified-invoice`
// (preferred) or a raw user payload. When `totals` is missing we recompute
// it inline so the rendered document always shows consistent numbers.
//
// Return: { file_data: <base64>, file_name: <string> }

import fontkit from '@d6e-ai/fontkit';
import mplusFontBytes from '@d6e-ai/mplus-1p-regular';
import { PDFDocument, rgb } from '@d6e-ai/pdf-lib';

// --- helpers ---------------------------------------------------------------

function formatNumber(n) {
  const v = Math.round(Number(n) || 0);
  return String(v).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
}

// Accepts "YYYY-MM-DD" and renders it as "YYYY/MM/DD".
function formatYmdDisplay(ymd) {
  if (typeof ymd !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(ymd)) {
    return ymd || '';
  }
  return ymd.replace(/-/g, '/');
}

function roundByMethod(n, method) {
  switch (method) {
    case 'ceil':
      return Math.ceil(n);
    case 'round':
      return Math.round(n);
    case 'floor':
    default:
      return Math.floor(n);
  }
}

function base64ToUint8Array(b64) {
  const binary = atob(b64);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    out[i] = binary.charCodeAt(i);
  }
  return out;
}

// Fallback totals computation (mirrors validate-qualified-invoice).
function computeTotals(items, priceMode, roundingMethod) {
  let rawEx8 = 0;
  let rawEx10 = 0;
  for (const it of items || []) {
    const qty = Number(it.quantity) || 0;
    const up = Number(it.unit_price) || 0;
    const tr = Number(it.tax_rate) || 0;
    const gross = qty * up;
    const excluded = priceMode === 'tax_included' ? gross / (1 + tr) : gross;
    if (tr === 0.08) {
      rawEx8 += excluded;
    } else {
      rawEx10 += excluded;
    }
  }
  const subtotal_8 = roundByMethod(rawEx8, roundingMethod);
  const subtotal_10 = roundByMethod(rawEx10, roundingMethod);
  const tax_8 = roundByMethod(rawEx8 * 0.08, roundingMethod);
  const tax_10 = roundByMethod(rawEx10 * 0.1, roundingMethod);
  const subtotal = subtotal_8 + subtotal_10;
  const tax_total = tax_8 + tax_10;
  return {
    subtotal_8,
    subtotal_10,
    subtotal,
    tax_8,
    tax_10,
    tax_total,
    grand_total: subtotal + tax_total,
  };
}

// Break a string at width-based character boundaries.
function wrapText(text, font, fontSize, maxWidth) {
  const out = [];
  const paragraphs = String(text || '').split('\n');
  for (const para of paragraphs) {
    if (para === '') {
      out.push('');
      continue;
    }
    let current = '';
    for (const ch of [...para]) {
      const candidate = current + ch;
      const candidateWidth = font.widthOfTextAtSize(candidate, fontSize);
      if (candidateWidth > maxWidth && current.length > 0) {
        out.push(current);
        current = ch;
      } else {
        current = candidate;
      }
    }
    if (current) {
      out.push(current);
    }
  }
  return out;
}

// --- input and metadata ----------------------------------------------------

const payload = $input || {};
const documentType = payload.document_type || 'qualified_invoice';

const DOCUMENT_TYPE_META = {
  qualified_invoice: { title: '適格請求書', filePrefix: '適格請求書' },
  simplified_invoice: { title: '適格簡易請求書', filePrefix: '適格簡易請求書' },
  return_invoice: { title: '適格返還請求書', filePrefix: '適格返還請求書' },
};
const meta = DOCUMENT_TYPE_META[documentType] || DOCUMENT_TYPE_META.qualified_invoice;

const issuer = payload.issuer || {};
const recipient = payload.recipient || {};
const items = Array.isArray(payload.items) ? payload.items : [];
const priceMode = payload.price_mode || 'tax_excluded';
const roundingMethod = payload.rounding_method || 'floor';
const totals =
  payload.totals && typeof payload.totals === 'object'
    ? payload.totals
    : computeTotals(items, priceMode, roundingMethod);

// --- PDF setup -------------------------------------------------------------

const pdfDoc = await PDFDocument.create();
pdfDoc.registerFontkit(fontkit);
const font = await pdfDoc.embedFont(mplusFontBytes);

const A4 = [595.28, 841.89];
const MARGIN = { top: 48, bottom: 48, left: 48, right: 48 };
const page = pdfDoc.addPage(A4);
const { width: PAGE_WIDTH, height: PAGE_HEIGHT } = page.getSize();
const CONTENT_LEFT = MARGIN.left;
const CONTENT_RIGHT = PAGE_WIDTH - MARGIN.right;
const CONTENT_WIDTH = CONTENT_RIGHT - CONTENT_LEFT;

const COLOR_PRIMARY = rgb(0.12, 0.15, 0.38);
const COLOR_TEXT = rgb(0.1, 0.1, 0.1);
const COLOR_MUTED = rgb(0.4, 0.4, 0.4);
const COLOR_BORDER = rgb(0.75, 0.75, 0.78);
const COLOR_ACCENT_BG = rgb(0.95, 0.96, 1.0);
const COLOR_HEADER_BG = rgb(0.12, 0.15, 0.38);
const COLOR_WHITE = rgb(1, 1, 1);

function drawText(text, x, y, size, color, customFont) {
  page.drawText(String(text), {
    x,
    y,
    size,
    font: customFont || font,
    color: color || COLOR_TEXT,
  });
}

function drawRightAlignedText(text, rightX, y, size, color) {
  const s = String(text);
  const w = font.widthOfTextAtSize(s, size);
  drawText(s, rightX - w, y, size, color);
}

// --- Header: title + optional logo + document metadata ---------------------

// Title bar
page.drawRectangle({
  x: 0,
  y: PAGE_HEIGHT - MARGIN.top,
  width: PAGE_WIDTH,
  height: MARGIN.top,
  color: COLOR_HEADER_BG,
});
drawText(meta.title, CONTENT_LEFT, PAGE_HEIGHT - MARGIN.top + 14, 22, COLOR_WHITE);

let cursorY = PAGE_HEIGHT - MARGIN.top - 24;

// Optional logo (top-right)
const LOGO_MAX_W = 140;
const LOGO_MAX_H = 56;
let logoHeightUsed = 0;
if (
  issuer.logo &&
  typeof issuer.logo === 'object' &&
  typeof issuer.logo.data_base64 === 'string' &&
  issuer.logo.data_base64.length > 0
) {
  try {
    const bytes = base64ToUint8Array(issuer.logo.data_base64);
    const fmt = (issuer.logo.format || '').toLowerCase();
    const image =
      fmt === 'png'
        ? await pdfDoc.embedPng(bytes)
        : await pdfDoc.embedJpg(bytes);
    const scale = Math.min(LOGO_MAX_W / image.width, LOGO_MAX_H / image.height, 1);
    const drawW = image.width * scale;
    const drawH = image.height * scale;
    page.drawImage(image, {
      x: CONTENT_RIGHT - drawW,
      y: cursorY - drawH,
      width: drawW,
      height: drawH,
    });
    logoHeightUsed = drawH;
  } catch (err) {
    // Non-fatal: render without the logo if embedding fails.
  }
}

// Document number / dates (top-right block, below or to the left of the logo)
const metaBlockRight = CONTENT_RIGHT;
const metaBlockTop = cursorY - logoHeightUsed - (logoHeightUsed > 0 ? 8 : 0);
drawRightAlignedText(
  '書類番号: ' + (payload.document_number || ''),
  metaBlockRight,
  metaBlockTop,
  10,
  COLOR_MUTED
);
drawRightAlignedText(
  '発行日: ' + formatYmdDisplay(payload.issue_date),
  metaBlockRight,
  metaBlockTop - 14,
  10,
  COLOR_MUTED
);
drawRightAlignedText(
  '取引年月日: ' + formatYmdDisplay(payload.transaction_date),
  metaBlockRight,
  metaBlockTop - 28,
  10,
  COLOR_MUTED
);

// Issuer block (left)
drawText('発行事業者', CONTENT_LEFT, cursorY, 10, COLOR_MUTED);
cursorY -= 16;
drawText(issuer.name || '', CONTENT_LEFT, cursorY, 14, COLOR_TEXT);
cursorY -= 18;
drawText(
  '登録番号: ' + (issuer.registration_number || ''),
  CONTENT_LEFT,
  cursorY,
  11,
  COLOR_PRIMARY
);
cursorY -= 16;
if (issuer.address) {
  drawText(issuer.address, CONTENT_LEFT, cursorY, 10, COLOR_MUTED);
  cursorY -= 14;
}
if (issuer.contact) {
  drawText(issuer.contact, CONTENT_LEFT, cursorY, 10, COLOR_MUTED);
  cursorY -= 14;
}

// Reserve vertical space so the recipient block sits below both the issuer text
// and the logo/metadata block on the right.
const afterHeaderY = Math.min(cursorY, metaBlockTop - 40);
cursorY = afterHeaderY - 8;

// --- Recipient (suppressed for simplified_invoice when missing) ------------

if (documentType !== 'simplified_invoice' || recipient.name) {
  page.drawRectangle({
    x: CONTENT_LEFT,
    y: cursorY - 44,
    width: CONTENT_WIDTH,
    height: 44,
    color: COLOR_ACCENT_BG,
  });
  drawText(
    '書類の交付を受ける事業者',
    CONTENT_LEFT + 10,
    cursorY - 14,
    9,
    COLOR_MUTED
  );
  drawText(
    recipient.name || '',
    CONTENT_LEFT + 10,
    cursorY - 30,
    13,
    COLOR_TEXT
  );
  if (recipient.address) {
    drawRightAlignedText(
      recipient.address,
      CONTENT_RIGHT - 10,
      cursorY - 30,
      10,
      COLOR_MUTED
    );
  }
  cursorY -= 54;
}

// --- Return invoice extra header ------------------------------------------

if (documentType === 'return_invoice' && payload.return_info) {
  const ri = payload.return_info;
  const lines = [];
  lines.push('対象となる元請求書番号: ' + (ri.original_document_number || ''));
  if (ri.return_date) {
    lines.push('返還日: ' + formatYmdDisplay(ri.return_date));
  }
  if (ri.reason) {
    lines.push('返還事由: ' + ri.reason);
  }
  const boxHeight = lines.length * 14 + 12;
  page.drawRectangle({
    x: CONTENT_LEFT,
    y: cursorY - boxHeight,
    width: CONTENT_WIDTH,
    height: boxHeight,
    borderColor: COLOR_BORDER,
    borderWidth: 0.8,
  });
  let y = cursorY - 16;
  for (const line of lines) {
    drawText(line, CONTENT_LEFT + 10, y, 10, COLOR_TEXT);
    y -= 14;
  }
  cursorY -= boxHeight + 10;
}

// --- Items table -----------------------------------------------------------

const COL_WIDTHS = [
  Math.round(CONTENT_WIDTH * 0.42), // description
  Math.round(CONTENT_WIDTH * 0.1), // quantity
  Math.round(CONTENT_WIDTH * 0.15), // unit price
  Math.round(CONTENT_WIDTH * 0.1), // tax rate
  Math.round(CONTENT_WIDTH * 0.23), // amount
];
// Adjust last column to match rounding drift.
COL_WIDTHS[4] = CONTENT_WIDTH - (COL_WIDTHS[0] + COL_WIDTHS[1] + COL_WIDTHS[2] + COL_WIDTHS[3]);

const TABLE_ROW_HEIGHT = 22;
const TABLE_HEADER_HEIGHT = 24;
const TABLE_PAD = 6;

// Header row
page.drawRectangle({
  x: CONTENT_LEFT,
  y: cursorY - TABLE_HEADER_HEIGHT,
  width: CONTENT_WIDTH,
  height: TABLE_HEADER_HEIGHT,
  color: COLOR_HEADER_BG,
});
const HEADERS = ['品目', '数量', '単価', '税率', '金額'];
{
  let x = CONTENT_LEFT;
  for (let i = 0; i < HEADERS.length; i++) {
    const label = HEADERS[i];
    if (i === 0) {
      drawText(label, x + TABLE_PAD, cursorY - TABLE_HEADER_HEIGHT + 8, 10, COLOR_WHITE);
    } else {
      const w = font.widthOfTextAtSize(label, 10);
      drawText(
        label,
        x + COL_WIDTHS[i] - TABLE_PAD - w,
        cursorY - TABLE_HEADER_HEIGHT + 8,
        10,
        COLOR_WHITE
      );
    }
    x += COL_WIDTHS[i];
  }
}
cursorY -= TABLE_HEADER_HEIGHT;

// Data rows
// v1 constraint: all line items must fit on the first page. We stop drawing
// additional rows when we would otherwise overflow into the summary / footer
// area. The README documents this limit. Future versions should add a real
// multi-page table layout.
let hasReducedItem = false;
let renderedRows = 0;
for (let i = 0; i < items.length; i++) {
  const it = items[i];
  const qty = Number(it.quantity) || 0;
  const up = Number(it.unit_price) || 0;
  const tr = Number(it.tax_rate) || 0;
  const lineAmount = qty * up;
  const isReduced = tr === 0.08;

  if (cursorY - TABLE_ROW_HEIGHT < MARGIN.bottom + 180) {
    break;
  }

  if (isReduced) {
    hasReducedItem = true;
  }

  // Alternate row background
  if (i % 2 === 1) {
    page.drawRectangle({
      x: CONTENT_LEFT,
      y: cursorY - TABLE_ROW_HEIGHT,
      width: CONTENT_WIDTH,
      height: TABLE_ROW_HEIGHT,
      color: rgb(0.97, 0.97, 0.98),
    });
  }

  let x = CONTENT_LEFT;
  // Description (may need wrapping)
  const descText = String(it.description || '') + (isReduced ? ' ※' : '');
  const descMaxWidth = COL_WIDTHS[0] - TABLE_PAD * 2;
  const descLines = wrapText(descText, font, 10, descMaxWidth);
  const displayDesc = descLines.length > 0 ? descLines[0] : descText;
  drawText(displayDesc, x + TABLE_PAD, cursorY - TABLE_ROW_HEIGHT + 7, 10, COLOR_TEXT);
  x += COL_WIDTHS[0];

  // Quantity (right)
  drawRightAlignedText(
    formatNumber(qty),
    x + COL_WIDTHS[1] - TABLE_PAD,
    cursorY - TABLE_ROW_HEIGHT + 7,
    10,
    COLOR_TEXT
  );
  x += COL_WIDTHS[1];

  // Unit price (right)
  drawRightAlignedText(
    '¥' + formatNumber(up),
    x + COL_WIDTHS[2] - TABLE_PAD,
    cursorY - TABLE_ROW_HEIGHT + 7,
    10,
    COLOR_TEXT
  );
  x += COL_WIDTHS[2];

  // Tax rate (right)
  drawRightAlignedText(
    tr === 0.08 ? '8%' : '10%',
    x + COL_WIDTHS[3] - TABLE_PAD,
    cursorY - TABLE_ROW_HEIGHT + 7,
    10,
    COLOR_TEXT
  );
  x += COL_WIDTHS[3];

  // Amount (right)
  drawRightAlignedText(
    '¥' + formatNumber(lineAmount),
    x + COL_WIDTHS[4] - TABLE_PAD,
    cursorY - TABLE_ROW_HEIGHT + 7,
    10,
    COLOR_TEXT
  );

  cursorY -= TABLE_ROW_HEIGHT;
  renderedRows += 1;
}

const tableHeight = TABLE_HEADER_HEIGHT + renderedRows * TABLE_ROW_HEIGHT;

page.drawRectangle({
  x: CONTENT_LEFT,
  y: cursorY,
  width: CONTENT_WIDTH,
  height: tableHeight,
  borderColor: COLOR_BORDER,
  borderWidth: 0.8,
});

{
  let x = CONTENT_LEFT;
  for (let i = 0; i < COL_WIDTHS.length - 1; i++) {
    x += COL_WIDTHS[i];
    page.drawLine({
      start: { x, y: cursorY },
      end: { x, y: cursorY + tableHeight },
      thickness: 0.5,
      color: COLOR_BORDER,
    });
  }
}

cursorY -= 12;

if (renderedRows < items.length) {
  drawText(
    '※ 明細は紙面の都合で先頭 ' +
      renderedRows +
      ' 行のみ表示しています（全 ' +
      items.length +
      ' 行）。',
    CONTENT_LEFT,
    cursorY,
    9,
    COLOR_MUTED
  );
  cursorY -= 14;
}

if (hasReducedItem) {
  drawText('※ 印は軽減税率（8%）対象', CONTENT_LEFT, cursorY, 9, COLOR_MUTED);
  cursorY -= 14;
}

// --- Tax summary box -------------------------------------------------------

const SUMMARY_LINES = [
  ['10% 対象 小計', '¥' + formatNumber(totals.subtotal_10)],
  ['10% 消費税', '¥' + formatNumber(totals.tax_10)],
  ['8% 対象 小計', '¥' + formatNumber(totals.subtotal_8)],
  ['8% 消費税', '¥' + formatNumber(totals.tax_8)],
  ['小計合計', '¥' + formatNumber(totals.subtotal)],
  ['消費税合計', '¥' + formatNumber(totals.tax_total)],
];

const SUMMARY_WIDTH = 260;
const SUMMARY_LINE_HEIGHT = 16;
const SUMMARY_HEIGHT =
  SUMMARY_LINES.length * SUMMARY_LINE_HEIGHT + SUMMARY_LINE_HEIGHT + 16; // +grand total row + padding
const summaryLeft = CONTENT_RIGHT - SUMMARY_WIDTH;
const summaryTop = cursorY - 8;

page.drawRectangle({
  x: summaryLeft,
  y: summaryTop - SUMMARY_HEIGHT,
  width: SUMMARY_WIDTH,
  height: SUMMARY_HEIGHT,
  borderColor: COLOR_BORDER,
  borderWidth: 0.8,
});

let sy = summaryTop - 14;
for (const [label, value] of SUMMARY_LINES) {
  drawText(label, summaryLeft + 10, sy, 10, COLOR_MUTED);
  drawRightAlignedText(value, CONTENT_RIGHT - 10, sy, 10, COLOR_TEXT);
  sy -= SUMMARY_LINE_HEIGHT;
}

// Grand total (highlighted)
page.drawRectangle({
  x: summaryLeft,
  y: sy - 22,
  width: SUMMARY_WIDTH,
  height: 24,
  color: COLOR_HEADER_BG,
});
drawText('合計金額', summaryLeft + 10, sy - 15, 12, COLOR_WHITE);
drawRightAlignedText(
  '¥' + formatNumber(totals.grand_total),
  CONTENT_RIGHT - 10,
  sy - 15,
  14,
  COLOR_WHITE
);

cursorY = summaryTop - SUMMARY_HEIGHT - 16;

// --- Payment terms and notes ----------------------------------------------

if (payload.payment && (payload.payment.due_date || payload.payment.bank_info)) {
  drawText('お支払い', CONTENT_LEFT, cursorY, 10, COLOR_MUTED);
  cursorY -= 14;
  if (payload.payment.due_date) {
    drawText(
      '支払期限: ' + formatYmdDisplay(payload.payment.due_date),
      CONTENT_LEFT,
      cursorY,
      10,
      COLOR_TEXT
    );
    cursorY -= 14;
  }
  if (payload.payment.bank_info) {
    const bankLines = wrapText(
      '振込先: ' + payload.payment.bank_info,
      font,
      10,
      CONTENT_WIDTH
    );
    for (const line of bankLines) {
      drawText(line, CONTENT_LEFT, cursorY, 10, COLOR_TEXT);
      cursorY -= 14;
    }
  }
  cursorY -= 4;
}

if (payload.notes) {
  drawText('備考', CONTENT_LEFT, cursorY, 10, COLOR_MUTED);
  cursorY -= 14;
  const notesLines = wrapText(payload.notes, font, 10, CONTENT_WIDTH);
  for (const line of notesLines) {
    if (cursorY < MARGIN.bottom + 14) {
      break;
    }
    drawText(line, CONTENT_LEFT, cursorY, 10, COLOR_TEXT);
    cursorY -= 14;
  }
}

// Footer
drawText(
  'Generated by d6e/invoice-jp',
  CONTENT_LEFT,
  MARGIN.bottom - 24,
  8,
  COLOR_MUTED
);

// --- Output ----------------------------------------------------------------

const base64 = await pdfDoc.saveAsBase64();
const dateForName =
  typeof payload.transaction_date === 'string'
    ? payload.transaction_date.replace(/-/g, '')
    : 'undated';
const fileName = meta.filePrefix + '_' + dateForName + '.pdf';

return { file_data: base64, file_name: fileName };
