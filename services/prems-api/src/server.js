/**
 * prems-api — the Cloud Run service.
 *
 * It exists to hold what must never reach a browser: the Document AI
 * credentials and the Supabase service role key. Everything else in the
 * onboarding flow runs client-side against RLS-protected tables, which is why
 * this stays small and why the flow still works when it is down.
 *
 * No framework: four routes over Node's own http server is less code than the
 * configuration a framework would need, and a smaller image to cold-start.
 */
import { createServer } from 'node:http';
import { config } from './config.js';
import { authenticate, AuthError } from './auth.js';
import { readDocument, AccessError } from './storage.js';
import { readIdentity, readPayslip, OcrError } from './documentai.js';
import { verify } from './alur.js';

const MAX_BODY = 16 * 1024;

function cors(request, response) {
  const origin = request.headers.origin;
  // Exact-match allow-list. Reflecting an arbitrary origin here would let any
  // page on the internet call this service with a stolen token.
  if (origin && config.allowedOrigins.includes(origin)) {
    response.setHeader('Access-Control-Allow-Origin', origin);
    response.setHeader('Vary', 'Origin');
    response.setHeader('Access-Control-Allow-Headers', 'authorization, content-type');
    response.setHeader('Access-Control-Allow-Methods', 'POST, GET, OPTIONS');
    response.setHeader('Access-Control-Max-Age', '3600');
  }
}

const send = (response, status, payload) => {
  response.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
  response.end(JSON.stringify(payload));
};

function readBody(request) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    request.on('data', (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY) {
        reject(Object.assign(new Error('Requête trop volumineuse.'), { status: 413 }));
        request.destroy();
        return;
      }
      chunks.push(chunk);
    });
    request.on('end', () => {
      if (!chunks.length) return resolve({});
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));
      } catch {
        reject(Object.assign(new Error('Corps JSON invalide.'), { status: 400 }));
      }
    });
    request.on('error', reject);
  });
}

/** Fetch the caller's document, run a reader over it, return the suggestion. */
async function ocr(request, userId, reader) {
  const { bucket, path } = await readBody(request);
  const { bytes, mimeType } = await readDocument({ bucket, path, userId });
  return reader(bytes, mimeType);
}

const ROUTES = {
  'GET /health': async () => ({ status: 'ok' }),

  'POST /ocr/identity': (request, { userId }) => ocr(request, userId, readIdentity),

  'POST /ocr/payslip': (request, { userId }) => ocr(request, userId, readPayslip),

  'POST /dossier/verify': (_request, { userId }) => verify(userId),
};

const server = createServer(async (request, response) => {
  cors(request, response);

  if (request.method === 'OPTIONS') {
    response.writeHead(204);
    response.end();
    return;
  }

  const url = new URL(request.url, `http://${request.headers.host}`);
  const route = ROUTES[`${request.method} ${url.pathname}`];

  if (!route) return send(response, 404, { error: 'Route inconnue.' });
  // The health check has to answer before any credential is involved, so Cloud
  // Run can tell "starting up" apart from "misconfigured".
  if (url.pathname === '/health') return send(response, 200, { status: 'ok' });

  try {
    const identity = await authenticate(request);
    const result = await route(request, identity);
    send(response, 200, result);
  } catch (error) {
    const status =
      error instanceof AuthError || error instanceof AccessError || error instanceof OcrError
        ? error.status
        : error.status || 500;

    // Client-side problems are worth telling the caller about; anything else is
    // logged here and returned as a generic message, because the detail of a
    // storage or OCR failure is not the browser's business.
    if (status >= 500) console.error(`[prems-api] ${url.pathname}`, error);
    send(response, status, {
      error: status >= 500 ? 'Erreur interne.' : error.message,
    });
  }
});

server.listen(config.port, () => {
  console.log(`[prems-api] à l'écoute sur :${config.port}`);
  console.log(`[prems-api] origines autorisées : ${config.allowedOrigins.join(', ')}`);
});

// Cloud Run sends SIGTERM before reclaiming an instance.
process.on('SIGTERM', () => server.close(() => process.exit(0)));
