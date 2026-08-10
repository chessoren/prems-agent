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
 * bank account. The printed wording is far more reliable here, so the label
 * scan leads and the parser only corroborates.
 * ------------------------------------------------------------------------- */
const NET_LABELS = [
  /net\s+à\s+payer\s+avant\s+imp[oô]t\s+sur\s+le\s+revenu/i,
  /net\s+[àa]\s+payer/i,
  /net\s+pay[ée]/i,
  /net\s+vers[ée]/i,
  /salaire\s+net/i,
  /net\s+social/i,
];

/** French amounts: 2 345,67 / 2.345,67 / 2345.67 */
const AMOUNT = /(\d{1,3}(?:[  . ]\d{3})*|\d+)(?:[,.](\d{2}))?/;

function amountsNearLabels(text) {
  const found = [];
  for (const label of NET_LABELS) {
    const match = label.exec(text);
    if (!match) continue;

    // Look only just past the label: payslips put the figure on the same line
    // or the next one, and widening the window starts catching neighbouring
    // columns like the employer's contribution.
    const window = text.slice(match.index + match[0].length, match.index + match[0].length + 90);
    const amount = AMOUNT.exec(window);
    if (!amount) continue;

    const whole = amount[1].replace(/[  . ]/g, '');
    const value = Number(`${whole}.${amount[2] ?? '00'}`);
    if (Number.isFinite(value) && value > 100 && value < 100000) {
      found.push({ value, priority: NET_LABELS.indexOf(label) });
    }
  }
  // Earlier labels are more specific, so they win.
  found.sort((a, b) => a.priority - b.priority);
  return found;
}

export async function readPayslip(bytes, mimeType) {
  const document = await process(config.documentAi.payslipProcessorId, bytes, mimeType);
  const entities = index(document);
  const text = document.text || '';

  const fromLabels = amountsNearLabels(text);
  const netEntity = pick(entities, 'net_amount', 'total_amount', 'net_pay');
  const fromParser = Number(netEntity?.normalizedValue?.moneyValue?.units) || null;

  const net = fromLabels[0]?.value ?? fromParser;

  return {
    netMonthlyEuros: net ? Math.round(net) : null,
    employer: textOf(pick(entities, 'supplier_name', 'employer', 'receiver_name')),
    period: dateOf(pick(entities, 'receipt_date', 'invoice_date', 'pay_period_end')),
    // A figure the printed label and the parser agree on is worth trusting;
    // one that only the parser produced is worth flagging to the user.
    confidence:
      fromLabels.length && fromParser && Math.abs(fromLabels[0].value - fromParser) < 2
        ? 0.95
        : fromLabels.length
          ? 0.8
          : confidenceOf(netEntity),
    source: fromLabels.length ? 'libellé' : 'analyse',
  };
}
