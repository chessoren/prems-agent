/**
 * Document AI.
 *
 * Two processors, one client. The processors live in the `eu` multi-region
 * because Document AI offers no europe-west9 location - data still stays in the
 * EU, which is the constraint that actually applies here.
 *
 * Everything returned from this file is a *suggestion*. The flow prefills the
 * fields with it and the person checks them before validating, so a confident
 * wrong answer is a correctable annoyance rather than a wrong tenancy file.
 */
import { DocumentProcessorServiceClient } from '@google-cloud/documentai';
import { config } from './config.js';

const client = new DocumentProcessorServiceClient({
  apiEndpoint: `${config.documentAi.location}-documentai.googleapis.com`,
});

export class OcrError extends Error {
  constructor(message, status = 502) {
    super(message);
    this.status = status;
  }
}

async function process(processorId, bytes, mimeType) {
  if (!processorId) throw new OcrError('Processeur Document AI non configuré.', 503);

  const name =
    `projects/${config.documentAi.projectId}` +
    `/locations/${config.documentAi.location}/processors/${processorId}`;

  try {
    const [result] = await client.processDocument({
      name,
      rawDocument: { content: bytes, mimeType },
    });
    return result.document || {};
  } catch (error) {
    throw new OcrError(`Document AI a refusé le document : ${error.message}`);
  }
}

/** Entity type names vary by processor version; compare them normalised. */
const normalise = (value) =>
  String(value || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_|_$/g, '');

function index(document) {
  const map = new Map();
  for (const entity of document.entities || []) {
    const key = normalise(entity.type);
    // Keep the highest-confidence occurrence of each type.
    const existing = map.get(key);
    if (!existing || (entity.confidence ?? 0) > (existing.confidence ?? 0)) map.set(key, entity);
  }
  return map;
}

const pick = (entities, ...aliases) => {
  for (const alias of aliases) {
    const entity = entities.get(normalise(alias));
    if (entity) return entity;
  }
  return null;
};

const textOf = (entity) => entity?.mentionText?.trim() || null;

/** Prefer the parser's structured date over re-parsing the printed string. */
function dateOf(entity) {
  const value = entity?.normalizedValue?.dateValue;
  if (value?.year && value?.month && value?.day) {
    const pad = (n) => String(n).padStart(2, '0');
    return `${value.year}-${pad(value.month)}-${pad(value.day)}`;
  }

  const raw = textOf(entity);
  const match = raw?.match(/(\d{2})[/. -](\d{2})[/. -](\d{4})/);
  return match ? `${match[3]}-${match[2]}-${match[1]}` : null;
}

const confidenceOf = (...entities) => {
  const values = entities.filter(Boolean).map((entity) => entity.confidence ?? 0);
  return values.length ? Number((values.reduce((a, b) => a + b, 0) / values.length).toFixed(2)) : 0;
};

/* -------------------------------------------------------------------------
 * Identity documents
 * ------------------------------------------------------------------------- */
export async function readIdentity(bytes, mimeType) {
  const document = await process(config.documentAi.identityProcessorId, bytes, mimeType);
  const entities = index(document);

  const family = pick(entities, 'Family Name', 'family_name', 'surname', 'last_name');
  const given = pick(entities, 'Given Names', 'given_name', 'first_name');
  const number = pick(entities, 'Document Id', 'document_number', 'document_id');
  const birth = pick(entities, 'Date of Birth', 'date_of_birth', 'birth_date', 'dob');

  return {
    firstName: textOf(given),
    lastName: textOf(family),
    birthDate: dateOf(birth),
    documentNumber: textOf(number)?.replace(/\s+/g, '') || null,
    documentType: guessDocumentType(document.text || ''),
    confidence: confidenceOf(family, given, number, birth),
  };
}

/** Which of the three French documents this is, from wording on the page. */
function guessDocumentType(text) {
  const haystack = text.toLowerCase();
  if (haystack.includes('titre de séjour') || haystack.includes('carte de séjour')) {
    return 'titre_sejour';
  }
  if (haystack.includes('passeport') || haystack.includes('passport')) return 'passeport';
  if (haystack.includes("carte nationale d'identité") || haystack.includes('identity card')) {
    return 'cni';
  }
  return null;
}

/* -------------------------------------------------------------------------
 * Payslips
 *
 * The Expense Parser is built for receipts, and on a French bulletin de paie it
 * frequently returns the gross or a line total rather than what lands in the
 * bank account. The printed wording is far more reliable, so the label leads.
 *
 * But "the amount printed next to the label" is a geometric statement, not a
 * textual one. A payslip is a table, and the OCR often serialises it column by
 * column - every label, then every figure - so the text immediately after
 * "NET À PAYER" can be the gross from three rows up. Reading the row from the
 * token positions is the only way to mean what we say. A synthetic payslip
 * reading 2 450 € net came back as the 3 150 € gross under the text-order
 * heuristic; that is the failure this exists to prevent.
 * ------------------------------------------------------------------------- */
const NET_LABELS = [
  /net\s+à\s+payer\s+avant\s+imp[oô]t\s+sur\s+le\s+revenu/i,
  /net\s+[àa]\s+payer/i,
  /net\s+pay[ée]/i,
  /net\s+vers[ée]/i,
  /salaire\s+net/i,
  /net\s+social/i,
];

/**
 * A French amount, and nothing that merely starts like one.
 *
 * The lookarounds matter: without them `\d{1,3}` happily matches "315" inside
 * "3150,00" and silently reports a tenth of the salary.
 */
const AMOUNT = /(?<!\d)(\d{1,3}(?:[\s.\u00a0]\d{3})+|\d+)(?:[,.](\d{2}))?(?!\d)/;

export function parseAmount(text) {
  const match = AMOUNT.exec(text);
  if (!match) return null;
  const whole = match[1].replace(/[\s.\u00a0]/g, '');
  const value = Number(`${whole}.${match[2] ?? '00'}`);
  // A monthly net outside this range is a page number or a SIRET, not a salary.
  return Number.isFinite(value) && value > 100 && value < 100000 ? value : null;
}

/** Tokens with their text span and position on the page. */
function layoutTokens(document) {
  const text = document.text || '';
  const tokens = [];

  for (const page of document.pages || []) {
    for (const token of page.tokens || []) {
      const segment = token.layout?.textAnchor?.textSegments?.[0];
      if (!segment) continue;

      const vertices = token.layout?.boundingPoly?.normalizedVertices || [];
      if (!vertices.length) continue;

      const ys = vertices.map((v) => v.y ?? 0);
      const xs = vertices.map((v) => v.x ?? 0);
      const top = Math.min(...ys);
      const bottom = Math.max(...ys);

      tokens.push({
        start: Number(segment.startIndex ?? 0),
        end: Number(segment.endIndex ?? 0),
        text: text.slice(Number(segment.startIndex ?? 0), Number(segment.endIndex ?? 0)),
        y: (top + bottom) / 2,
        x: (Math.min(...xs) + Math.max(...xs)) / 2,
        height: bottom - top,
      });
    }
  }
  return tokens;
}

/**
 * The net figure printed on the same row as the most specific label found.
 *
 * Amounts are read from the row's joined text rather than token by token,
 * because "2 450,00" is frequently two tokens.
 */
export function netFromRow(document) {
  const text = document.text || '';
  const tokens = layoutTokens(document);
  if (!tokens.length) return null;

  for (const [priority, label] of NET_LABELS.entries()) {
    const match = label.exec(text);
    if (!match) continue;

    const anchor = tokens.find((t) => t.start <= match.index && t.end > match.index);
    if (!anchor) continue;

    const tolerance = Math.max(anchor.height * 0.6, 0.004);
    const rest = tokens
      .filter((t) => Math.abs(t.y - anchor.y) <= tolerance && t.start >= match.index + match[0].length)
      .sort((a, b) => a.start - b.start)
      .map((t) => t.text)
      .join(' ');

    const value = parseAmount(rest);
    if (value != null) return { value, priority };
  }
  return null;
}

export async function readPayslip(bytes, mimeType) {
  const document = await process(config.documentAi.payslipProcessorId, bytes, mimeType);
  const entities = index(document);

  const fromRow = netFromRow(document);
  const netEntity = pick(entities, 'net_amount', 'total_amount', 'net_pay');
  const fromParser = Number(netEntity?.normalizedValue?.moneyValue?.units) || null;

  // Deliberately conservative. A plausible wrong salary that the visitor does
  // not notice is far worse than an empty field they type themselves, so the
  // figure is only offered when the printed row gives it - the parser alone is
  // not enough to put a number in front of someone.
  const agree = fromRow && fromParser && Math.abs(fromRow.value - fromParser) < 2;

  return {
    netMonthlyEuros: fromRow ? Math.round(fromRow.value) : null,
    employer: textOf(pick(entities, 'supplier_name', 'employer', 'receiver_name')),
    period: dateOf(pick(entities, 'receipt_date', 'invoice_date', 'pay_period_end')),
    confidence: agree ? 0.95 : fromRow ? 0.8 : 0,
    source: fromRow ? 'libellé' : null,
  };
}
