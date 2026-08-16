/**
 * Writing the application.
 *
 * The message goes out from the client's own mailbox with their name on it, so
 * it has to read like something they wrote. Three rules shape the prompt, and
 * each exists because its opposite is what makes automated mail obvious:
 *
 *  - Short. An agent triaging forty replies reads the first three lines.
 *  - Specific. Naming the actual apartment proves it was not a blast.
 *  - No superlatives. "Je serais ravi de découvrir ce bien d'exception" is how
 *    a template announces itself.
 *
 * Gemini 2.5 Flash-Lite: the cheapest model that writes idiomatic French, and
 * the task is constrained enough that a larger one buys nothing. Note that
 * "Gemini 3.5 Flash-Lite" does not exist - checked against the live endpoint,
 * which answers 404 for it and 200 for this.
 */
import { createSign } from 'node:crypto';
import { readFileSync } from 'node:fs';

const LOCATION = 'europe-west9';
const MODEL = 'gemini-2.5-flash-lite';

async function accessToken(): Promise<string> {
  const metadata =
    'http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/token';
  try {
    const r = await fetch(metadata, {
      headers: { 'Metadata-Flavor': 'Google' },
      signal: AbortSignal.timeout(1500),
    });
    if (r.ok) return ((await r.json()) as { access_token: string }).access_token;
  } catch {
    /* not on Cloud Run */
  }
  const path = process.env.GOOGLE_APPLICATION_CREDENTIALS;
  if (!path) throw new Error('GOOGLE_APPLICATION_CREDENTIALS manquant');
  const sa = JSON.parse(readFileSync(path, 'utf8'));
  const now = Math.floor(Date.now() / 1000);
  const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString('base64url');
  const unsigned = `${b64({ alg: 'RS256', typ: 'JWT' })}.${b64({
    iss: sa.client_email,
    scope: 'https://www.googleapis.com/auth/cloud-platform',
    aud: sa.token_uri,
    exp: now + 3600,
    iat: now,
  })}`;
  const sig = createSign('RSA-SHA256').update(unsigned).sign(sa.private_key, 'base64url');
  const r = await fetch(sa.token_uri, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
      assertion: `${unsigned}.${sig}`,
    }),
  });
  const j = (await r.json()) as { access_token?: string };
  if (!j.access_token) throw new Error('authentification Vertex échouée');
  return j.access_token;
}

export interface DraftInput {
  readonly firstName: string | null;
  readonly lastName: string | null;
  readonly employment: string | null;
  readonly monthlyIncomeEur: number | null;
  readonly hasGuarantor: boolean;
  readonly city: string | null;
  readonly rooms: number | null;
  readonly surfaceM2: number | null;
  readonly rentEur: number;
  readonly title: string | null;
  readonly agencyName: string | null;
  readonly hasDossier: boolean;
}

export interface Draft {
  readonly subject: string;
  readonly body: string;
}

/**
 * A message that does not depend on the model being available.
 *
 * If Vertex is down, an application still goes out - a plain, correct, slightly
 * flatter one. Refusing to write to the agency because the copywriter was
 * unavailable would cost the client the apartment for no reason.
 */
export function fallbackDraft(input: DraftInput): Draft {
  const name = [input.firstName, input.lastName].filter(Boolean).join(' ') || 'Un candidat';
  const what = [
    input.rooms ? `${input.rooms} pièces` : null,
    input.surfaceM2 ? `${Math.round(input.surfaceM2)} m²` : null,
    input.city,
  ]
    .filter(Boolean)
    .join(', ');

  return {
    subject: `Demande de visite — ${what || input.title || 'votre annonce'}`,
    body:
      `Bonjour,\n\n` +
      `Je suis intéressé${input.firstName ? '' : '(e)'} par votre annonce${what ? ` (${what})` : ''} ` +
      `à ${input.rentEur} € par mois, et je souhaiterais organiser une visite.\n\n` +
      (input.monthlyIncomeEur
        ? `Je suis ${input.employment ?? 'en activité'}, avec un revenu net mensuel de ` +
          `${input.monthlyIncomeEur} €${input.hasGuarantor ? ', et je dispose d’un garant' : ''}.\n\n`
        : '') +
      `Mon dossier est complet et disponible immédiatement.\n\n` +
      `Merci d’avance,\n${name}`,
  };
}

export async function writeDraft(input: DraftInput, project: string): Promise<Draft> {
  const prompt = `Tu écris un e-mail de candidature locative, en français, à une agence immobilière.

Contraintes strictes :
- 90 mots maximum, corps du message uniquement.
- Ton neutre et direct. Aucun superlatif, aucune formule commerciale.
- Mentionne concrètement le bien pour prouver que le message n'est pas un envoi de masse.
- Mentionne la situation professionnelle et le revenu s'ils sont fournis, sobrement.
- Termine par une demande de visite claire.
- N'invente rien qui ne soit pas dans les données.
- Ne mentionne ni Prems, ni aucun outil, ni aucune automatisation.

Données :
${JSON.stringify(
  {
    prenom: input.firstName,
    nom: input.lastName,
    situation: input.employment,
    revenu_mensuel_eur: input.monthlyIncomeEur,
    garant: input.hasGuarantor,
    bien: {
      titre: input.title,
      ville: input.city,
      pieces: input.rooms,
      surface_m2: input.surfaceM2,
      loyer_eur: input.rentEur,
    },
    agence: input.agencyName,
  },
  null,
  1,
)}

Réponds en JSON strict : {"subject": "...", "body": "..."}`;

  try {
    const token = await accessToken();
    const url =
      `https://${LOCATION}-aiplatform.googleapis.com/v1/projects/${project}` +
      `/locations/${LOCATION}/publishers/google/models/${MODEL}:generateContent`;

    const response = await fetch(url, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contents: [{ role: 'user', parts: [{ text: prompt }] }],
        generationConfig: {
          temperature: 0.4,
          maxOutputTokens: 600,
          responseMimeType: 'application/json',
        },
      }),
      signal: AbortSignal.timeout(20000),
    });
    if (!response.ok) return fallbackDraft(input);

    const body = (await response.json()) as {
      candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }>;
    };
    const text = body.candidates?.[0]?.content?.parts?.[0]?.text;
    if (!text) return fallbackDraft(input);

    const parsed = JSON.parse(text) as { subject?: string; body?: string };
    if (!parsed.subject || !parsed.body) return fallbackDraft(input);

    // A model that ignores the word limit produces something that reads as
    // generated. Better a plain message that reads as human.
    if (parsed.body.split(/\s+/).length > 180) return fallbackDraft(input);

    return { subject: parsed.subject.slice(0, 180), body: parsed.body };
  } catch {
    return fallbackDraft(input);
  }
}
