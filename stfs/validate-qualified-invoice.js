// Validate a Japanese Qualified Invoice (適格請求書) payload.
//
// This STF checks the six mandatory fields defined by the Japanese Invoice
// System (インボイス制度 / 適格請求書等保存方式), verifies the registration
// number format (T + 13 digits), validates per-item shape, and computes
// per-tax-rate subtotals and tax amounts with exactly one rounding operation
// per bracket as required by the statute.
//
// Input is taken from the `$input` global set by the d6e JS runtime.
// The runtime wraps this code in `(async function(){ ... })()`, so we use
// a top-level `return` (not `export default`).
//
// Return shape:
//   {
//     valid: boolean,
//     errors:   Array<{ code, field, message }>,
//     warnings: Array<{ code, field, message }>,
//     totals:   { subtotal_8, subtotal_10, subtotal, tax_8, tax_10, tax_total, grand_total } | null,
//     normalized_payload: object | null  // fully populated payload ready for render STFs
//   }

const input = $input || {};
const errors = [];
const warnings = [];

// --- helpers ---------------------------------------------------------------

function isNonEmptyString(v) {
  return typeof v === 'string' && v.trim().length > 0;
}

// Strict YYYY-MM-DD parse; returns a Date in UTC or null when invalid.
function parseDateString(s) {
  if (!isNonEmptyString(s)) {
    return null;
  }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) {
    return null;
  }
  const parts = s.split('-');
  const y = Number(parts[0]);
  const m = Number(parts[1]);
  const d = Number(parts[2]);
  const date = new Date(Date.UTC(y, m - 1, d));
  if (
    date.getUTCFullYear() !== y ||
    date.getUTCMonth() !== m - 1 ||
    date.getUTCDate() !== d
  ) {
    // e.g. 2026-02-30 rolls over to March
    return null;
  }
  return date;
}

function formatYmd(date) {
  return (
    date.getUTCFullYear() +
    '-' +
    String(date.getUTCMonth() + 1).padStart(2, '0') +
    '-' +
    String(date.getUTCDate()).padStart(2, '0')
  );
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

// Non-cryptographic random numeric suffix for auto-generated document numbers.
function randomNumericSuffix(length) {
  let s = '';
  for (let i = 0; i < length; i++) {
    s += String(Math.floor(Math.random() * 10));
  }
  return s;
}

function pushError(code, field, message) {
  errors.push({ code, field, message });
}

function pushWarning(code, field, message) {
  warnings.push({ code, field, message });
}

// --- 1. document_type ------------------------------------------------------

const ALLOWED_DOCUMENT_TYPES = [
  'qualified_invoice',
  'simplified_invoice',
  'return_invoice',
];
const documentType = input.document_type;
if (!ALLOWED_DOCUMENT_TYPES.includes(documentType)) {
  pushError(
    'INVALID_DOCUMENT_TYPE',
    'document_type',
    '`document_type` must be one of: qualified_invoice, simplified_invoice, return_invoice. Got: ' +
      JSON.stringify(documentType)
  );
}

// --- 2. issuer (name + registration number) --------------------------------

const issuer = input.issuer && typeof input.issuer === 'object' ? input.issuer : {};
if (!isNonEmptyString(issuer.name)) {
  pushError(
    'MISSING_ISSUER_NAME',
    'issuer.name',
    'Issuer name (適格請求書発行事業者の氏名または名称) is required.'
  );
}

const registrationNumber = issuer.registration_number;
const REGISTRATION_NUMBER_PATTERN = /^T\d{13}$/;
if (!isNonEmptyString(registrationNumber)) {
  pushError(
    'MISSING_REGISTRATION_NUMBER',
    'issuer.registration_number',
    'Registration number (登録番号) is required.'
  );
} else if (!REGISTRATION_NUMBER_PATTERN.test(registrationNumber)) {
  pushError(
    'INVALID_REGISTRATION_NUMBER',
    'issuer.registration_number',
    'Registration number must be "T" followed by 13 digits (e.g. T1234567890123). Got: ' +
      registrationNumber
  );
}

// --- 3. issuer.logo (optional but validated when present) ------------------

const ALLOWED_LOGO_FORMATS = ['png', 'jpg', 'jpeg'];
if (issuer.logo !== undefined && issuer.logo !== null) {
  if (typeof issuer.logo !== 'object') {
    pushError(
      'INVALID_LOGO',
      'issuer.logo',
      'issuer.logo must be an object like { format, data_base64 } or null.'
    );
  } else {
    if (!ALLOWED_LOGO_FORMATS.includes(issuer.logo.format)) {
      pushError(
        'INVALID_LOGO_FORMAT',
        'issuer.logo.format',
        'issuer.logo.format must be one of: png, jpg, jpeg. Got: ' +
          JSON.stringify(issuer.logo.format)
      );
    }
    if (!isNonEmptyString(issuer.logo.data_base64)) {
      pushError(
        'INVALID_LOGO_DATA',
        'issuer.logo.data_base64',
        'issuer.logo.data_base64 must be a non-empty base64 string.'
      );
    }
  }
}

// --- 4. transaction_date ---------------------------------------------------

const transactionDate = parseDateString(input.transaction_date);
if (!transactionDate) {
  pushError(
    'INVALID_TRANSACTION_DATE',
    'transaction_date',
    'transaction_date (取引年月日) must be a valid YYYY-MM-DD string. Got: ' +
      JSON.stringify(input.transaction_date)
  );
}

// --- 5. items --------------------------------------------------------------

const items = Array.isArray(input.items) ? input.items : [];
if (items.length === 0) {
  pushError(
    'NO_ITEMS',
    'items',
    'items must contain at least one line item.'
  );
}

const ALLOWED_TAX_RATES = [0.08, 0.1];
for (let i = 0; i < items.length; i++) {
  const it = items[i] || {};
  const prefix = 'items[' + i + ']';

  if (!isNonEmptyString(it.description)) {
    pushError(
      'MISSING_ITEM_DESCRIPTION',
      prefix + '.description',
      prefix + ': description (品目名) is required.'
    );
  }

  const qty = Number(it.quantity);
  if (!Number.isFinite(qty) || qty <= 0) {
    pushError(
      'INVALID_ITEM_QUANTITY',
      prefix + '.quantity',
      prefix +
        ': quantity (数量) must be a positive finite number. Got: ' +
        JSON.stringify(it.quantity)
    );
  }

  const up = Number(it.unit_price);
  if (!Number.isFinite(up) || up < 0) {
    pushError(
      'INVALID_ITEM_UNIT_PRICE',
      prefix + '.unit_price',
      prefix +
        ': unit_price (単価) must be a finite number >= 0. Got: ' +
        JSON.stringify(it.unit_price)
    );
  }

  const tr = Number(it.tax_rate);
  if (!ALLOWED_TAX_RATES.includes(tr)) {
    pushError(
      'INVALID_ITEM_TAX_RATE',
      prefix + '.tax_rate',
      prefix +
        ': tax_rate must be 0.08 (reduced) or 0.10 (standard). Got: ' +
        JSON.stringify(it.tax_rate)
    );
  }
}

// --- 6. recipient (required except for simplified_invoice) -----------------

const recipient =
  input.recipient && typeof input.recipient === 'object' ? input.recipient : {};
if (documentType !== 'simplified_invoice') {
  if (!isNonEmptyString(recipient.name)) {
    pushError(
      'MISSING_RECIPIENT_NAME',
      'recipient.name',
      'recipient.name (書類の交付を受ける事業者の氏名または名称) is required for this document_type.'
    );
  }
}

// --- 7. return_info (required for return_invoice) --------------------------

let returnInfo = null;
if (documentType === 'return_invoice') {
  returnInfo =
    input.return_info && typeof input.return_info === 'object'
      ? input.return_info
      : {};
  if (!isNonEmptyString(returnInfo.reason)) {
    pushError(
      'MISSING_RETURN_REASON',
      'return_info.reason',
      'return_info.reason (返還事由) is required for return_invoice.'
    );
  }
  if (!isNonEmptyString(returnInfo.original_document_number)) {
    pushError(
      'MISSING_ORIGINAL_DOCUMENT_NUMBER',
      'return_info.original_document_number',
      'return_info.original_document_number (対象となる元請求書番号) is required for return_invoice.'
    );
  }
}

// --- 8. price_mode and rounding_method -------------------------------------

const ALLOWED_PRICE_MODES = ['tax_excluded', 'tax_included'];
const priceMode = input.price_mode || 'tax_excluded';
if (!ALLOWED_PRICE_MODES.includes(priceMode)) {
  pushError(
    'INVALID_PRICE_MODE',
    'price_mode',
    'price_mode must be one of: tax_excluded, tax_included. Got: ' +
      JSON.stringify(input.price_mode)
  );
}

const ALLOWED_ROUNDING = ['floor', 'ceil', 'round'];
const roundingMethod = input.rounding_method || 'floor';
if (!ALLOWED_ROUNDING.includes(roundingMethod)) {
  pushError(
    'INVALID_ROUNDING_METHOD',
    'rounding_method',
    'rounding_method must be one of: floor, ceil, round. Got: ' +
      JSON.stringify(input.rounding_method)
  );
}

// --- early return on structural failure ------------------------------------

if (errors.length > 0) {
  return {
    valid: false,
    errors,
    warnings,
    totals: null,
    normalized_payload: null,
  };
}

// --- 9. compute per-tax-bracket totals -------------------------------------
// One rounding per bracket, as required by the Japanese Invoice System.

let rawExcluded_8 = 0;
let rawExcluded_10 = 0;
const normalizedItems = [];

for (const it of items) {
  const qty = Number(it.quantity);
  const up = Number(it.unit_price);
  const tr = Number(it.tax_rate);
  const lineGross = qty * up; // as-entered under priceMode

  let lineExcluded;
  if (priceMode === 'tax_included') {
    lineExcluded = lineGross / (1 + tr);
  } else {
    lineExcluded = lineGross;
  }

  if (tr === 0.08) {
    rawExcluded_8 += lineExcluded;
  } else {
    rawExcluded_10 += lineExcluded;
  }

  normalizedItems.push({
    description: it.description,
    quantity: qty,
    unit_price: up,
    tax_rate: tr,
    line_amount: lineGross,
  });
}

const subtotal_8 = roundByMethod(rawExcluded_8, roundingMethod);
const subtotal_10 = roundByMethod(rawExcluded_10, roundingMethod);
const tax_8 = roundByMethod(rawExcluded_8 * 0.08, roundingMethod);
const tax_10 = roundByMethod(rawExcluded_10 * 0.1, roundingMethod);

const subtotal = subtotal_8 + subtotal_10;
const taxTotal = tax_8 + tax_10;
const grandTotal = subtotal + taxTotal;

// --- 10. build normalized payload ------------------------------------------

const transactionDateStr = formatYmd(transactionDate);

let documentNumber = input.document_number;
if (!isNonEmptyString(documentNumber)) {
  documentNumber =
    transactionDateStr.replace(/-/g, '') + '-' + randomNumericSuffix(6);
  pushWarning(
    'AUTO_GENERATED_DOCUMENT_NUMBER',
    'document_number',
    'document_number was omitted; auto-generated as ' + documentNumber
  );
}

let issueDateStr;
const parsedIssueDate = parseDateString(input.issue_date);
if (parsedIssueDate) {
  issueDateStr = formatYmd(parsedIssueDate);
} else {
  issueDateStr = transactionDateStr;
  if (input.issue_date !== undefined) {
    pushWarning(
      'INVALID_ISSUE_DATE_FALLBACK',
      'issue_date',
      'issue_date was invalid; fell back to transaction_date (' +
        transactionDateStr +
        ').'
    );
  } else {
    pushWarning(
      'FALLBACK_ISSUE_DATE',
      'issue_date',
      'issue_date was omitted; using transaction_date (' +
        transactionDateStr +
        ').'
    );
  }
}

const normalizedPayload = {
  document_type: documentType,
  document_number: documentNumber,
  transaction_date: transactionDateStr,
  issue_date: issueDateStr,
  issuer: {
    name: issuer.name,
    registration_number: issuer.registration_number,
    address: isNonEmptyString(issuer.address) ? issuer.address : '',
    contact: isNonEmptyString(issuer.contact) ? issuer.contact : '',
    logo:
      issuer.logo && typeof issuer.logo === 'object'
        ? {
            format: issuer.logo.format,
            data_base64: issuer.logo.data_base64,
          }
        : null,
  },
  recipient: {
    name: isNonEmptyString(recipient.name) ? recipient.name : '',
    address: isNonEmptyString(recipient.address) ? recipient.address : '',
  },
  items: normalizedItems,
  price_mode: priceMode,
  rounding_method: roundingMethod,
  payment:
    input.payment && typeof input.payment === 'object'
      ? {
          due_date: isNonEmptyString(input.payment.due_date)
            ? input.payment.due_date
            : '',
          bank_info: isNonEmptyString(input.payment.bank_info)
            ? input.payment.bank_info
            : '',
        }
      : null,
  notes: isNonEmptyString(input.notes) ? input.notes : '',
  return_info:
    documentType === 'return_invoice' && returnInfo
      ? {
          original_document_number: returnInfo.original_document_number,
          return_date: isNonEmptyString(returnInfo.return_date)
            ? returnInfo.return_date
            : '',
          reason: returnInfo.reason,
        }
      : null,
  totals: {
    subtotal_8,
    subtotal_10,
    subtotal,
    tax_8,
    tax_10,
    tax_total: taxTotal,
    grand_total: grandTotal,
  },
};

return {
  valid: true,
  errors: [],
  warnings,
  totals: normalizedPayload.totals,
  normalized_payload: normalizedPayload,
};
