/**
 * The "aller plus vite" shortcuts.
 *
 * Photograph a document, have the fields filled in for you, then check them.
 * That last part is the whole design: OCR output is a *suggestion* written into
 * editable inputs, never a value committed on the person's behalf. A confident
 * wrong reading has to stay a correctable annoyance.
 *
 * The file goes straight to the private bucket; only its path is sent to the
 * API, which reads it back with credentials the browser never sees.
 */
import { client, ensureSession } from './supabase.js';
import { upload } from './documents.js';

const API = import.meta.env.PUBLIC_PREMS_API_URL || '';

export const isAvailable = () => Boolean(API && client());

/** Open the camera on a phone, the file picker on a desktop. */
function chooseFile() {
  return new Promise((resolve) => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = 'image/*,application/pdf';
    if (matchMedia('(pointer: coarse)').matches) input.capture = 'environment';
    input.style.display = 'none';

    input.addEventListener('change', () => {
      resolve(input.files?.[0] || null);
      input.remove();
    });
    // A cancelled picker fires no event in most browsers; `cancel` covers the
    // ones that support it so the caller is not left waiting forever.
    input.addEventListener('cancel', () => {
      resolve(null);
      input.remove();
    });

    document.body.appendChild(input);
    input.click();
  });
}

const ROUTES = {
  identite: { path: '/ocr/identity', kind: 'identite' },
  revenus: { path: '/ocr/payslip', kind: 'revenus' },
  garant: { path: '/ocr/payslip', kind: 'garant' },
};

/**
 * Run a scan. `onStatus` is called with 'picking' | 'uploading' | 'reading',
 * so the button can say what is happening rather than just spinning.
 *
 * Resolves to { ok, fields } or { ok: false, error }. It never throws: a failed
 * shortcut must leave the visitor exactly where they were, typing by hand.
 */
export async function scan(kind, { onStatus } = {}) {
  const route = ROUTES[kind];
  if (!route) return { ok: false, error: 'Type de document inconnu.' };
  if (!API) return { ok: false, error: 'Le scan automatique n’est pas encore activé.' };

  onStatus?.('picking');
  const file = await chooseFile();
  if (!file) return { ok: false, cancelled: true };

  onStatus?.('uploading');
  const stored = await upload(file, route.kind, 'scan');
  if (!stored.ok) return { ok: false, error: stored.error };
  if (!stored.stored) {
    return { ok: false, error: 'Document enregistré, mais la lecture automatique est indisponible.' };
  }

  const session = await ensureSession();
  if (!session) return { ok: false, error: 'Session expirée, reconnecte-toi.' };

  onStatus?.('reading');
  try {
    const response = await fetch(`${API}${route.path}`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${session.access_token}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({ bucket: stored.bucket, path: stored.path }),
      signal: AbortSignal.timeout(45_000),
    });

    if (!response.ok) {
      const body = await response.json().catch(() => ({}));
      return { ok: false, error: body.error || 'La lecture a échoué.' };
    }

    return { ok: true, fields: await response.json() };
  } catch {
    return { ok: false, error: 'La lecture a pris trop de temps. Saisis les champs à la main.' };
  }
}
