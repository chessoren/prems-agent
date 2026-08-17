/**
 * Answering the agency, with a date the client can actually keep.
 *
 * This is the part that turns a reply into a viewing. An agent that writes
 * "je suis disponible quand vous voulez" makes the agency do the work and gets
 * answered last; an agent that names three concrete windows gets a slot.
 *
 * It can only do that because availability now lives in the database rather
 * than in the browser. That was the blocking gap: a worker running at eight in
 * the morning cannot read localStorage, so the agent could ask for a visit but
 * never propose a time.
 *
 * Two rules bound what it may do on its own, and both exist because the cost of
 * being wrong is borne by the client, not by us:
 *
 *  - It never invents availability. If the client has saved none, it says so
 *    plainly and asks the agency to propose - which is still better than
 *    silence, and is honest.
 *  - It never argues. A refusal ends the thread. Pushing back on an agency that
 *    has said no is how a client's own address gets marked as spam.
 */
import { createSign } from 'node:crypto';
import { readFileSync } from 'node:fs';

const LOCATION = 'europe-west9';
const MODEL = 'gemini-2.5-flash-lite';

/** The slot vocabulary the interface writes, decoded once here. */
const DAYS: Record<string, string> = {
  lun: 'lundi',
  mar: 'mardi',
  mer: 'mercredi',
  jeu: 'jeudi',
  ven: 'vendredi',
  sam: 'samedi',
  dim: 'dimanche',
};

const WINDOWS: Record<string, string> = {
  matin: 'le matin (9h-12h)',
  midi: 'entre 12h et 14h',
  aprem: "l'après-midi (14h-18h)",
  soir: 'en fin de journée (18h-20h)',
  // The calendar tab also writes bare hours, e.g. `mar-18`.
};

/**
 * Turn saved slots into a sentence a human would write.
 *
 * Grouped by day rather than listed flat: "mardi et jeudi après-midi, samedi
 * matin" is read in one glance, where six bullet points is a form to process.
 */
export function readableAvailability(slots: readonly string[]): string | null {
  if (!slots?.length) return null;

  const byDay = new Map<string, string[]>();
  for (const slot of slots) {
    const [day, rest] = String(slot).split('-');
    if (!day || !rest || !DAYS[day]) continue;
    const label = WINDOWS[rest] ?? (/^\d{1,2}$/.test(rest) ? `à ${rest}h` : null);
    if (!label) continue;
    const list = byDay.get(day) ?? [];
    if (!list.includes(label)) list.push(label);
    byDay.set(day, list);
  }
  if (byDay.size === 0) return null;

  const order = ['lun', 'mar', 'mer', 'jeu', 'ven', 'sam', 'dim'];
  const parts = order
    .filter((d) => byDay.has(d))
    .map((d) => `${DAYS[d]} ${byDay.get(d)!.join(' ou ')}`);

  return parts.length === 1 ? parts[0]! : `${parts.slice(0, -1).join(', ')} et ${parts.at(-1)}`;
}

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

export interface NegotiateInput {
  /** What the agency just wrote. */
  readonly agencyMessage: string;
  /** What has been said so far, oldest first, as "role: text". */
  readonly history: readonly string[];
  readonly availability: readonly string[];
  readonly firstName: string | null;
  readonly lastName: string | null;
  readonly city: string | null;
  readonly rooms: number | null;
  readonly rentEur: number | null;
  readonly hasDossier: boolean;
  readonly employment: string | null;
  readonly monthlyIncomeEur: number | null;
  /** 'question' | 'visit_offered' | 'other' - what the classifier decided. */
  readonly kind: string;
}

/**
 * A plain reply, used when Vertex is unavailable.
 *
 * The alternative is not replying, which loses the apartment for a reason the
 * client would never accept.
 */
export function fallbackReply(input: NegotiateInput): string {
  const slots = readableAvailability(input.availability);
  const name = [input.firstName, input.lastName].filter(Boolean).join(' ');
  return (
    'Bonjour,\n\n' +
    'Merci pour votre retour.\n\n' +
    (slots
      ? `Je suis disponible ${slots}. Dites-moi ce qui vous arrange et je m'organise.`
      : 'Je peux me rendre disponible rapidement — proposez-moi un créneau qui vous convient.') +
    `\n\nBien à vous,\n${name}`
  );
}

/**
 * Write the next message in the thread.
 *
 * Returns null when nothing should be sent - a refusal, or a message the model
 * could not make sense of. Silence is a valid move; a reply that says nothing
 * is not.
 */
export async function writeReply(input: NegotiateInput, project: string): Promise<string | null> {
  if (input.kind === 'refused') return null;

  const slots = readableAvailability(input.availability);

  const prompt = `Tu écris la réponse d'un particulier à une agence immobilière, dans une conversation en cours au sujet d'un logement qu'il veut visiter. Le message part de sa boîte mail et porte son nom.

Ton objectif unique : obtenir une date de visite. Rien d'autre.

Règles :
- 70 mots maximum. Une agence lit trois lignes.
- Réponds précisément à ce qu'elle vient d'écrire. Si elle pose une question, réponds-y d'abord, en une phrase.
- ${
    slots
      ? `Propose une date en te fondant UNIQUEMENT sur ces disponibilités : ${slots}. N'en invente aucune autre, ne donne pas de date calendaire précise (pas de "le 14"), reste sur les jours et les moments.`
      : `Le candidat n'a pas renseigné ses disponibilités. Ne prétends pas en avoir : demande à l'agence de proposer un créneau, en te disant assez souple.`
  }
- Ton neutre, poli, direct. Aucun superlatif, aucune relance insistante.
- N'invente RIEN. Si l'agence demande une information qui ne figure pas ci-dessous — profession, garant, date d'entrée, animal, composition du foyer — ne la fabrique pas : écris que tu la transmets dans la journée. Un mail envoyé au nom de quelqu'un ne peut pas contenir un fait inventé à son sujet.
- Ne mentionne ni Prems, ni outil, ni automatisation, ni IA.
- ${input.hasDossier ? 'Le dossier complet est déjà joint aux échanges : tu peux le rappeler en une demi-phrase, sans lien.' : "Ne parle pas du dossier."}
- Termine par une formule courte et la signature du candidat.

Le bien : ${[input.rooms ? `${input.rooms} pièces` : null, input.city, input.rentEur ? `${input.rentEur} € / mois` : null].filter(Boolean).join(', ')}

Faits connus sur le candidat — les seuls que tu as le droit d'écrire :
${JSON.stringify(
  {
    nom: [input.firstName, input.lastName].filter(Boolean).join(' ') || null,
    situation_professionnelle: input.employment,
    revenu_mensuel_net_eur: input.monthlyIncomeEur,
    dossier_complet_disponible: input.hasDossier,
  },
  null,
  1,
)}
Tout champ nul est une information que tu n'as PAS.

Historique de la conversation (du plus ancien au plus récent) :
${input.history.slice(-6).join('\n---\n').slice(0, 4000)}

Dernier message de l'agence, auquel tu réponds :
${input.agencyMessage.slice(0, 3000)}

Réponds en JSON strict : {"reply":"..."} — ou {"reply":null} si aucune réponse n'est utile.`;

  try {
    const token = await accessToken();
    const r = await fetch(
      `https://${LOCATION}-aiplatform.googleapis.com/v1/projects/${project}/locations/${LOCATION}/publishers/google/models/${MODEL}:generateContent`,
      {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          contents: [{ role: 'user', parts: [{ text: prompt }] }],
          generationConfig: {
            temperature: 0.3,
            maxOutputTokens: 500,
            responseMimeType: 'application/json',
          },
        }),
        signal: AbortSignal.timeout(20000),
      },
    );
    if (!r.ok) return fallbackReply(input);

    const j = (await r.json()) as {
      candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }>;
    };
    const text = j.candidates?.[0]?.content?.parts?.[0]?.text;
    if (!text) return fallbackReply(input);

    const parsed = JSON.parse(text) as { reply?: string | null };
    const reply = typeof parsed.reply === 'string' ? parsed.reply.trim() : null;
    if (!reply) return null;

    // A model that starts inventing calendar dates has stopped using the
    // availability it was given, and a date the client cannot keep is worse
    // than no date at all.
    if (!slots && /\b\d{1,2}\s?(janvier|février|mars|avril|mai|juin|juillet|août|septembre|octobre|novembre|décembre)/i.test(reply)) {
      return fallbackReply(input);
    }

    return reply;
  } catch {
    return fallbackReply(input);
  }
}
