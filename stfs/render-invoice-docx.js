// Render a Japanese Qualified Invoice payload to a Word (docx) document.
//
// Uses the `docx` library with MS Gothic as the default font for Japanese
// glyph coverage. The layout mirrors `render-invoice-pdf.js`: title bar,
// issuer block (with optional logo), recipient block, return-invoice
// extras when applicable, the itemized table, per-tax-bracket totals,
// payment terms, and notes.
//
// Return: { file_data: <base64>, file_name: <string> }

const {
  Document,
  Packer,
  Paragraph,
  TextRun,
  Table,
  TableRow,
  TableCell,
  ImageRun,
  Header,
  Footer,
  AlignmentType,
  BorderStyle,
  WidthType,
  ShadingType,
  VerticalAlign,
  PageNumber,
  HeadingLevel,
} = docx;

// --- helpers ---------------------------------------------------------------

const BASE_FONT = 'MS Gothic';

function formatNumber(n) {
  const num = Number(n);
  if (!Number.isFinite(num)) return '0';
  // Cap to 4 decimal places so floating-point noise (0.1 + 0.2) does not
  // leak into the rendered output, while still preserving intentional
  // fractional quantities / unit prices that the validator accepts.
  const rounded = Math.round(num * 10000) / 10000;
  const str = String(rounded);
  const [intPart, fracPart] = str.split('.');
  const withCommas = intPart.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  return fracPart ? withCommas + '.' + fracPart : withCommas;
}

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

function getImageDimensions(bytes, fmt) {
  if (fmt === 'png') {
    if (bytes.length < 24) return null;
    const w =
      ((bytes[16] << 24) | (bytes[17] << 16) | (bytes[18] << 8) | bytes[19]) >>> 0;
    const h =
      ((bytes[20] << 24) | (bytes[21] << 16) | (bytes[22] << 8) | bytes[23]) >>> 0;
    return w > 0 && h > 0 ? { width: w, height: h } : null;
  }
  if (fmt === 'jpg' || fmt === 'jpeg') {
    let i = 2;
    while (i + 8 < bytes.length) {
      if (bytes[i] !== 0xff) return null;
      const marker = bytes[i + 1];
      if (
        marker >= 0xc0 &&
        marker <= 0xcf &&
        marker !== 0xc4 &&
        marker !== 0xc8 &&
        marker !== 0xcc
      ) {
        const h = (bytes[i + 5] << 8) | bytes[i + 6];
        const w = (bytes[i + 7] << 8) | bytes[i + 8];
        return w > 0 && h > 0 ? { width: w, height: h } : null;
      }
      const segLength = (bytes[i + 2] << 8) | bytes[i + 3];
      if (segLength < 2) return null;
      i += 2 + segLength;
    }
    return null;
  }
  return null;
}

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

// --- document helpers ------------------------------------------------------

function makeRun(text, opts) {
  const options = opts || {};
  return new TextRun({
    text: String(text == null ? '' : text),
    bold: options.bold || false,
    color: options.color || '222222',
    size: options.size || 20, // 10pt
    font: BASE_FONT,
  });
}

const HAIRLINE = {
  style: BorderStyle.SINGLE,
  size: 4,
  color: 'BFBFBF',
};
const CELL_BORDERS = {
  top: HAIRLINE,
  bottom: HAIRLINE,
  left: HAIRLINE,
  right: HAIRLINE,
};

function makeTableCell(children, width, opts) {
  const options = opts || {};
  return new TableCell({
    borders: options.borders || CELL_BORDERS,
    width: { size: width, type: WidthType.DXA },
    shading: options.fill
      ? { fill: options.fill, type: ShadingType.CLEAR, color: 'auto' }
      : undefined,
    margins: { top: 80, bottom: 80, left: 120, right: 120 },
    verticalAlign: options.verticalAlign || VerticalAlign.CENTER,
    children: Array.isArray(children) ? children : [children],
  });
}

function makeHeaderCell(label, width) {
  return makeTableCell(
    new Paragraph({
      alignment: AlignmentType.CENTER,
      children: [makeRun(label, { bold: true, color: 'FFFFFF', size: 20 })],
    }),
    width,
    { fill: '1E2761' }
  );
}

function makeTextCell(text, width, align, extraRuns) {
  const base = makeRun(text, { size: 20 });
  const children = extraRuns && extraRuns.length
    ? [base, ...extraRuns]
    : [base];
  return makeTableCell(
    new Paragraph({
      alignment: align || AlignmentType.LEFT,
      children,
    }),
    width
  );
}

// --- input + totals --------------------------------------------------------

const payload = $input || {};
const documentType = payload.document_type || 'qualified_invoice';
const DOCUMENT_TYPE_META = {
  qualified_invoice: { title: '適格請求書', filePrefix: '適格請求書' },
  simplified_invoice: { title: '適格簡易請求書', filePrefix: '適格簡易請求書' },
  return_invoice: { title: '適格返還請求書', filePrefix: '適格返還請求書' },
};
const meta =
  DOCUMENT_TYPE_META[documentType] || DOCUMENT_TYPE_META.qualified_invoice;

const issuer = payload.issuer || {};
const recipient = payload.recipient || {};
const items = Array.isArray(payload.items) ? payload.items : [];
const priceMode = payload.price_mode || 'tax_excluded';
const roundingMethod = payload.rounding_method || 'floor';
const totals =
  payload.totals && typeof payload.totals === 'object'
    ? payload.totals
    : computeTotals(items, priceMode, roundingMethod);

// --- page and table metrics ------------------------------------------------

const A4_WIDTH_DXA = 11906;
const A4_HEIGHT_DXA = 16838;
const PAGE_MARGIN_DXA = 1000;
const CONTENT_WIDTH_DXA = A4_WIDTH_DXA - PAGE_MARGIN_DXA * 2;

const COL_WIDTHS = [
  Math.round(CONTENT_WIDTH_DXA * 0.4), // description
  Math.round(CONTENT_WIDTH_DXA * 0.1), // quantity
  Math.round(CONTENT_WIDTH_DXA * 0.18), // unit_price
  Math.round(CONTENT_WIDTH_DXA * 0.12), // tax_rate
  0, // amount (filled in below)
];
COL_WIDTHS[4] =
  CONTENT_WIDTH_DXA -
  (COL_WIDTHS[0] + COL_WIDTHS[1] + COL_WIDTHS[2] + COL_WIDTHS[3]);

// --- build children sequentially ------------------------------------------

const children = [];

// Title (heading)
children.push(
  new Paragraph({
    heading: HeadingLevel.HEADING_1,
    alignment: AlignmentType.CENTER,
    spacing: { before: 0, after: 160 },
    children: [makeRun(meta.title, { bold: true, size: 36, color: '1E2761' })],
  })
);

// Optional logo (centered above issuer block)
if (
  issuer.logo &&
  typeof issuer.logo === 'object' &&
  typeof issuer.logo.data_base64 === 'string' &&
  issuer.logo.data_base64.length > 0
) {
  try {
    const bytes = base64ToUint8Array(issuer.logo.data_base64);
    const fmt = (issuer.logo.format || 'png').toLowerCase();
    const LOGO_MAX_W = 140;
    const LOGO_MAX_H = 56;
    const dims = getImageDimensions(bytes, fmt);
    let drawW = LOGO_MAX_W;
    let drawH = LOGO_MAX_H;
    if (dims) {
      const scale = Math.min(LOGO_MAX_W / dims.width, LOGO_MAX_H / dims.height, 1);
      drawW = dims.width * scale;
      drawH = dims.height * scale;
    }
    children.push(
      new Paragraph({
        alignment: AlignmentType.RIGHT,
        spacing: { before: 0, after: 120 },
        children: [
          new ImageRun({
            type: fmt === 'jpeg' ? 'jpg' : fmt,
            data: bytes,
            transformation: { width: drawW, height: drawH },
            altText: {
              title: 'Issuer logo',
              description: 'Logo of the invoice issuer',
              name: 'issuer-logo',
            },
          }),
        ],
      })
    );
  } catch (err) {
    // Skip the logo on failure; the rest of the document still renders.
  }
}

// Document metadata (number / issue date / transaction date) as a 2-col table
children.push(
  new Table({
    width: { size: CONTENT_WIDTH_DXA, type: WidthType.DXA },
    columnWidths: [Math.round(CONTENT_WIDTH_DXA / 2), Math.round(CONTENT_WIDTH_DXA / 2)],
    rows: [
      new TableRow({
        children: [
          makeTableCell(
            new Paragraph({
              children: [
                makeRun('発行事業者: ', { bold: true, size: 20, color: '666666' }),
                makeRun(issuer.name || '', { size: 22 }),
              ],
            }),
            Math.round(CONTENT_WIDTH_DXA / 2),
            { borders: { top: HAIRLINE, bottom: HAIRLINE, left: HAIRLINE, right: HAIRLINE } }
          ),
          makeTableCell(
            new Paragraph({
              alignment: AlignmentType.RIGHT,
              children: [
                makeRun('書類番号: ', { bold: true, size: 20, color: '666666' }),
                makeRun(payload.document_number || '', { size: 20 }),
              ],
            }),
            Math.round(CONTENT_WIDTH_DXA / 2),
            { borders: { top: HAIRLINE, bottom: HAIRLINE, left: HAIRLINE, right: HAIRLINE } }
          ),
        ],
      }),
      new TableRow({
        children: [
          makeTableCell(
            new Paragraph({
              children: [
                makeRun('登録番号: ', { bold: true, size: 20, color: '666666' }),
                makeRun(issuer.registration_number || '', {
                  size: 22,
                  color: '1E2761',
                  bold: true,
                }),
              ],
            }),
            Math.round(CONTENT_WIDTH_DXA / 2)
          ),
          makeTableCell(
            new Paragraph({
              alignment: AlignmentType.RIGHT,
              children: [
                makeRun('取引年月日: ', { bold: true, size: 20, color: '666666' }),
                makeRun(formatYmdDisplay(payload.transaction_date), { size: 20 }),
              ],
            }),
            Math.round(CONTENT_WIDTH_DXA / 2)
          ),
        ],
      }),
      new TableRow({
        children: [
          makeTableCell(
            new Paragraph({
              children: [
                makeRun(
                  [issuer.address, issuer.contact].filter((s) => !!s).join(' / '),
                  { size: 18, color: '666666' }
                ),
              ],
            }),
            Math.round(CONTENT_WIDTH_DXA / 2)
          ),
          makeTableCell(
            new Paragraph({
              alignment: AlignmentType.RIGHT,
              children: [
                makeRun('発行日: ', { bold: true, size: 20, color: '666666' }),
                makeRun(formatYmdDisplay(payload.issue_date), { size: 20 }),
              ],
            }),
            Math.round(CONTENT_WIDTH_DXA / 2)
          ),
        ],
      }),
    ],
  })
);

// Recipient (omitted when simplified_invoice has no recipient.name)
if (documentType !== 'simplified_invoice' || recipient.name) {
  children.push(
    new Paragraph({ spacing: { before: 200, after: 80 }, children: [makeRun('')] })
  );
  children.push(
    new Table({
      width: { size: CONTENT_WIDTH_DXA, type: WidthType.DXA },
      columnWidths: [CONTENT_WIDTH_DXA],
      rows: [
        new TableRow({
          children: [
            makeTableCell(
              new Paragraph({
                children: [
                  makeRun('書類の交付を受ける事業者', {
                    size: 18,
                    color: '666666',
                  }),
                ],
              }),
              CONTENT_WIDTH_DXA,
              { fill: 'F2F4FA' }
            ),
          ],
        }),
        new TableRow({
          children: [
            makeTableCell(
              new Paragraph({
                children: [
                  makeRun(recipient.name || '', { bold: true, size: 26 }),
                  makeRun('   ' + (recipient.address || ''), {
                    size: 18,
                    color: '666666',
                  }),
                ],
              }),
              CONTENT_WIDTH_DXA
            ),
          ],
        }),
      ],
    })
  );
}

// Return invoice extra block
if (documentType === 'return_invoice' && payload.return_info) {
  const ri = payload.return_info;
  const lines = [];
  lines.push(
    new Paragraph({
      children: [
        makeRun('対象となる元請求書番号: ', { bold: true, size: 20, color: '666666' }),
        makeRun(ri.original_document_number || '', { size: 20 }),
      ],
    })
  );
  if (ri.return_date) {
    lines.push(
      new Paragraph({
        children: [
          makeRun('返還日: ', { bold: true, size: 20, color: '666666' }),
          makeRun(formatYmdDisplay(ri.return_date), { size: 20 }),
        ],
      })
    );
  }
  if (ri.reason) {
    lines.push(
      new Paragraph({
        children: [
          makeRun('返還事由: ', { bold: true, size: 20, color: '666666' }),
          makeRun(ri.reason, { size: 20 }),
        ],
      })
    );
  }
  children.push(
    new Paragraph({ spacing: { before: 120, after: 80 }, children: [makeRun('')] })
  );
  children.push(
    new Table({
      width: { size: CONTENT_WIDTH_DXA, type: WidthType.DXA },
      columnWidths: [CONTENT_WIDTH_DXA],
      rows: [
        new TableRow({
          children: [makeTableCell(lines, CONTENT_WIDTH_DXA)],
        }),
      ],
    })
  );
}

// Items table header + rows
const itemRows = [];
itemRows.push(
  new TableRow({
    tableHeader: true,
    children: [
      makeHeaderCell('品目', COL_WIDTHS[0]),
      makeHeaderCell('数量', COL_WIDTHS[1]),
      makeHeaderCell('単価', COL_WIDTHS[2]),
      makeHeaderCell('税率', COL_WIDTHS[3]),
      makeHeaderCell('金額', COL_WIDTHS[4]),
    ],
  })
);

let hasReducedItem = false;
for (const it of items) {
  const qty = Number(it.quantity) || 0;
  const up = Number(it.unit_price) || 0;
  const tr = Number(it.tax_rate) || 0;
  const lineAmount = qty * up;
  const isReduced = tr === 0.08;
  if (isReduced) {
    hasReducedItem = true;
  }
  const descText = String(it.description || '') + (isReduced ? ' ※' : '');
  itemRows.push(
    new TableRow({
      children: [
        makeTextCell(descText, COL_WIDTHS[0], AlignmentType.LEFT),
        makeTextCell(formatNumber(qty), COL_WIDTHS[1], AlignmentType.RIGHT),
        makeTextCell('¥' + formatNumber(up), COL_WIDTHS[2], AlignmentType.RIGHT),
        makeTextCell(isReduced ? '8%' : '10%', COL_WIDTHS[3], AlignmentType.RIGHT),
        makeTextCell('¥' + formatNumber(lineAmount), COL_WIDTHS[4], AlignmentType.RIGHT),
      ],
    })
  );
}

children.push(
  new Paragraph({ spacing: { before: 200, after: 80 }, children: [makeRun('')] })
);
children.push(
  new Table({
    width: { size: CONTENT_WIDTH_DXA, type: WidthType.DXA },
    columnWidths: COL_WIDTHS,
    rows: itemRows,
  })
);

if (hasReducedItem) {
  children.push(
    new Paragraph({
      spacing: { before: 80, after: 160 },
      children: [
        makeRun('※ 印は軽減税率 (8%) 対象', { size: 18, color: '666666' }),
      ],
    })
  );
}

// Totals summary table (right-aligned, narrower)
const SUMMARY_COL_LABEL = Math.round(CONTENT_WIDTH_DXA * 0.58);
const SUMMARY_COL_VALUE = CONTENT_WIDTH_DXA - SUMMARY_COL_LABEL;

function summaryRow(label, value, emphasize) {
  return new TableRow({
    children: [
      makeTableCell(
        new Paragraph({
          alignment: AlignmentType.RIGHT,
          children: [
            makeRun(label, {
              size: 20,
              color: emphasize ? 'FFFFFF' : '666666',
              bold: !!emphasize,
            }),
          ],
        }),
        SUMMARY_COL_LABEL,
        emphasize ? { fill: '1E2761' } : {}
      ),
      makeTableCell(
        new Paragraph({
          alignment: AlignmentType.RIGHT,
          children: [
            makeRun(value, {
              size: emphasize ? 24 : 20,
              color: emphasize ? 'FFFFFF' : '222222',
              bold: !!emphasize,
            }),
          ],
        }),
        SUMMARY_COL_VALUE,
        emphasize ? { fill: '1E2761' } : {}
      ),
    ],
  });
}

children.push(
  new Table({
    width: { size: CONTENT_WIDTH_DXA, type: WidthType.DXA },
    columnWidths: [SUMMARY_COL_LABEL, SUMMARY_COL_VALUE],
    rows: [
      summaryRow('10% 対象 小計', '¥' + formatNumber(totals.subtotal_10), false),
      summaryRow('10% 消費税', '¥' + formatNumber(totals.tax_10), false),
      summaryRow('8% 対象 小計', '¥' + formatNumber(totals.subtotal_8), false),
      summaryRow('8% 消費税', '¥' + formatNumber(totals.tax_8), false),
      summaryRow('小計合計', '¥' + formatNumber(totals.subtotal), false),
      summaryRow('消費税合計', '¥' + formatNumber(totals.tax_total), false),
      summaryRow('合計金額', '¥' + formatNumber(totals.grand_total), true),
    ],
  })
);

// Payment & notes
if (payload.payment && (payload.payment.due_date || payload.payment.bank_info)) {
  children.push(
    new Paragraph({
      spacing: { before: 260, after: 60 },
      children: [makeRun('お支払い', { bold: true, size: 22, color: '1E2761' })],
    })
  );
  if (payload.payment.due_date) {
    children.push(
      new Paragraph({
        children: [
          makeRun('支払期限: ', { bold: true, size: 20, color: '666666' }),
          makeRun(formatYmdDisplay(payload.payment.due_date), { size: 20 }),
        ],
      })
    );
  }
  if (payload.payment.bank_info) {
    children.push(
      new Paragraph({
        children: [
          makeRun('振込先: ', { bold: true, size: 20, color: '666666' }),
          makeRun(payload.payment.bank_info, { size: 20 }),
        ],
      })
    );
  }
}

if (payload.notes) {
  children.push(
    new Paragraph({
      spacing: { before: 240, after: 60 },
      children: [makeRun('備考', { bold: true, size: 22, color: '1E2761' })],
    })
  );
  children.push(
    new Paragraph({ children: [makeRun(payload.notes, { size: 20 })] })
  );
}

// --- document assembly -----------------------------------------------------

const doc = new Document({
  styles: {
    default: {
      document: {
        run: { font: BASE_FONT, size: 20 },
      },
    },
    paragraphStyles: [
      {
        id: 'Heading1',
        name: 'Heading 1',
        basedOn: 'Normal',
        next: 'Normal',
        quickFormat: true,
        run: { size: 36, bold: true, font: BASE_FONT, color: '1E2761' },
        paragraph: { spacing: { before: 120, after: 120 }, outlineLevel: 0 },
      },
    ],
  },
  sections: [
    {
      properties: {
        page: {
          size: { width: A4_WIDTH_DXA, height: A4_HEIGHT_DXA },
          margin: {
            top: PAGE_MARGIN_DXA,
            right: PAGE_MARGIN_DXA,
            bottom: PAGE_MARGIN_DXA,
            left: PAGE_MARGIN_DXA,
          },
        },
      },
      headers: {
        default: new Header({
          children: [
            new Paragraph({
              alignment: AlignmentType.RIGHT,
              children: [
                makeRun(meta.title, { size: 16, color: '999999' }),
              ],
            }),
          ],
        }),
      },
      footers: {
        default: new Footer({
          children: [
            new Paragraph({
              alignment: AlignmentType.CENTER,
              children: [
                makeRun('Generated by d6e/invoice-jp  |  page ', {
                  size: 16,
                  color: '888888',
                }),
                new TextRun({
                  children: [PageNumber.CURRENT],
                  size: 16,
                  color: '888888',
                  font: BASE_FONT,
                }),
                makeRun(' / ', { size: 16, color: '888888' }),
                new TextRun({
                  children: [PageNumber.TOTAL_PAGES],
                  size: 16,
                  color: '888888',
                  font: BASE_FONT,
                }),
              ],
            }),
          ],
        }),
      },
      children,
    },
  ],
});

const base64 = await Packer.toBase64String(doc);
const dateForName =
  typeof payload.transaction_date === 'string'
    ? payload.transaction_date.replace(/-/g, '')
    : 'undated';
const fileName = meta.filePrefix + '_' + dateForName + '.docx';

return { file_data: base64, file_name: fileName };
