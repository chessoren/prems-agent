/**
 * Le mode démonstration : la boucle complète, toutes les huit secondes.
 *
 * Les cadences de production sont faites pour tenir un mois sans surveillance —
 * une minute pour le scraping, deux pour les envois, huit heures pour la relève
 * de boîte. Elles sont justes, et elles sont inutilisables devant un public :
 * personne ne filme huit heures d'attente.
 *
 * Ce mode ne change rien à ce que fait l'agent. Il change quand il le fait :
 * une exécution enchaîne le cycle entier en continu, du repérage à la
 * réservation, pendant toute la durée de la démonstration. Chaque tour appelle
 * exactement les fonctions que les jobs planifiés appellent — même matching,
 * même rédaction, même classification, mêmes garde-fous. Ce qu'on montre est le
 * produit, pas une maquette qui lui ressemble.
 *
 *   MODE=demo DEMO_MINUTES=12 node workers/dist/index.js
 *
 * L'annonce de démonstration est posée par le même tour de boucle, pour chaque
 * compte qui a connecté sa boîte et n'en a pas encore une. C'est ce qui rend la
 * démonstration indépendante du compte utilisé : on se connecte, et dans les
 * secondes qui suivent l'agent a de quoi travailler.
 */
import { db, logEvent } from './db.js';
import { matchPending } from './match.js';
import { closeLostMatches, queueApplications, sendDue, sendOutbox } from './apply.js';
import { watchAllInboxes } from './inbox.js';

/** La source des annonces de démonstration. Reconnaissable, et supprimable. */
const SOURCE_SLUG = 'demo-agency';

/**
 * Où atterrissent les candidatures de démonstration.
 *
 * C'est la boîte du « propriétaire » de l'annonce fabriquée, celle où quelqu'un
 * répond en direct pendant la démonstration. Elle doit être différente du
 * compte connecté, sinon l'agent lit ses propres messages.
 */
const AGENCY_EMAIL = process.env.DEMO_AGENCY_EMAIL ?? 'jenie.du.film@gmail.com';

/** Un tour toutes les huit secondes : au-dessous, on paie des appels pour rien. */
const TICK_MS = Number(process.env.DEMO_TICK_MS ?? 8000);

/**
 * La source, créée une fois.
 *
 * `enabled: false` : le scraper ne doit jamais essayer de crawler une agence
 * qui n'existe pas. Le matching, lui, ne regarde pas ce drapeau — il ne
 * s'intéresse qu'aux annonces.
 */
async function ensureSource(): Promise<string | null> {
  const client = db();
  const { data: existing } = await client
    .from('sources')
    .select('id')
    .eq('slug', SOURCE_SLUG)
    .maybeSingle();
  if (existing?.id) return existing.id as string;

  const { data: created } = await client
    .from('sources')
    .insert({
      slug: SOURCE_SLUG,
      name: 'Agence de démonstration',
      kind: 'agency',
      adapter: 'demo',
      base_url: 'https://demo.prems.local',
      contact_channel: 'email',
      enabled: false,
      poll_interval_seconds: 3600,
    })
    .select('id')
    .single();
  return (created?.id as string) ?? null;
}

/**
 * Une annonce par compte servi, dérivée de ses propres critères.
 *
 * Dériver plutôt que deviner est ce qui rend la démonstration indépendante du
 * compte : quels que soient la ville, le budget ou le nombre de pièces
 * demandés, le bien posé les respecte, donc il passe le filtre dur par
 * construction. Un bien « générique » échouerait au premier compte dont les
 * critères sortent de l'ordinaire — c'est-à-dire le jour de la démonstration.
 */
async function ensureListings(sourceId: string): Promise<number> {
  const client = db();

  // Seuls les comptes qui peuvent réellement recevoir quelque chose : sans
  // boîte connectée le pipeline n'engage rien, et poser une annonce pour eux
  // remplirait la base sans rien montrer.
  const { data: profiles } = await client
    .from('profiles')
    .select('id')
    .not('gmail_account_id', 'is', null)
    .limit(50);
  if (!profiles?.length) return 0;

  let posed = 0;
  for (const profile of profiles) {
    const userId = profile.id as string;

    const { data: search } = await client
      .from('searches')
      .select('*')
      .eq('user_id', userId)
      .eq('active', true)
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle();
    if (!search) continue;

    const externalId = `demo-${userId}`;

    // Déjà posée : on ne la repose pas, sinon chaque tour relancerait une
    // candidature sur le même bien.
    const { data: already } = await client
      .from('listings')
      .select('id')
      .eq('source_id', sourceId)
      .eq('external_id', externalId)
      .maybeSingle();
    if (already) continue;

    const zones = (search.zones as string[] | null) ?? [];
    const zone = zones[0] ?? null;
    const postcode = zone && zone.length === 2 ? `${zone}100` : (zone ?? '75011');
    const rooms = Number(search.rooms_min ?? search.rooms ?? 2);
    const rent = Math.max(300, Number(search.budget_max_eur) - 120);
    const types = (search.property_types as string[] | null) ?? [];

    await client.from('listings').insert({
      source_id: sourceId,
      external_id: externalId,
      url: `https://demo.prems.local/annonce/${externalId}`,
      title: `${rooms} pièces — ${search.city}`,
      description:
        'Bel appartement traversant, lumineux, proche commerces et transports. ' +
        'Cuisine équipée, double vitrage, chauffage individuel. Disponible ' +
        'immédiatement. Visites sur rendez-vous.',
      property_type: types[0] ?? 'flat',
      rooms,
      bedrooms: Math.max(1, rooms - 1),
      surface_m2: Math.max(Number(search.surface_min_m2 ?? 0) + 5, 20 + rooms * 12),
      rent_eur: rent,
      charges_eur: 0,
      deposit_eur: rent * 2,
      furnished: search.furnished ?? null,
      floor: 3,
      has_elevator: true,
      dpe: 'C',
      available_from: new Date().toISOString().slice(0, 10),
      address_raw: `12 rue de la Démonstration, ${postcode} ${search.city}`,
      street: 'rue de la Démonstration',
      postcode,
      city: search.city,
      city_slug: search.city_slug,
      geo_precision: 'street',
      agency_name: 'Agence de démonstration',
      agency_email: AGENCY_EMAIL,
      is_professional: true,
      photos: [],
      // Maintenant : la fraîcheur pèse 27 % du score avec une demi-vie de
      // 90 minutes, donc une annonce publiée à l'instant arrive en tête.
      published_at: new Date().toISOString(),
      status: 'active',
      matched_at: null,
    });

    posed += 1;
    await logEvent({
      userId,
      type: 'demo.listing_posted',
      subjectType: 'listing',
      payload: { city: search.city, rent, agency: AGENCY_EMAIL },
    });
  }
  return posed;
}

/**
 * Pourquoi rien n'est parti.
 *
 * `queueApplications` écrit la raison dans `matches.skipped_reason` et rend
 * simplement zéro. En production c'est le bon choix — la raison est consultable
 * quand on la cherche. Pendant une démonstration, zéro sans explication est la
 * pire sortie possible : on regarde un écran vide sans savoir si le système est
 * cassé ou s'il applique une règle.
 *
 * Les trois plafonds de `may_send` sont les suspects habituels, et deux d'entre
 * eux se déclenchent précisément parce qu'on a répété la démonstration :
 * `agency_cooldown` compte deux candidatures vers la même adresse sur sept
 * jours, et `too_many_active` compte les candidatures encore ouvertes.
 */
async function explainSilence(): Promise<string> {
  const client = db();
  const { data: ready } = await client.rpc('matches_ready_to_send_demo', { want: 5 });
  const rows = (ready ?? []) as Array<Record<string, any>>;

  if (rows.length === 0) {
    // Distinguer « plus rien à faire » de « quelque chose bloque ». Compter tous
    // les matchs du système répondait à la mauvaise question : il en reste des
    // milliers en permanence, et le message donnait l'alarme à chaque tour d'une
    // démonstration qui se déroulait bien.
    const { count } = await client
      .from('matches')
      .select('id, listings!inner(external_id)', { count: 'exact', head: true })
      .eq('status', 'new')
      .like('listings.external_id', 'demo-%');
    return (count ?? 0) === 0
      ? 'rien en attente : la candidature de démonstration est déjà partie'
      : `${count} match(s) de démonstration retenus (boîte non connectée, ou candidature déjà existante)`;
  }

  const verdicts: string[] = [];
  for (const row of rows.slice(0, 3)) {
    const { data: gate } = await client.rpc('may_send', {
      p_user_id: row.user_id,
      p_agency_email: row.agency_email,
    });
    const verdict = Array.isArray(gate) ? gate[0] : gate;
    verdicts.push(verdict?.allowed ? 'autorisé' : (verdict?.reason ?? 'refusé sans raison'));
  }
  return `${rows.length} prêt(s), verdicts : ${verdicts.join(', ')}`;
}

/** Un tour complet : poser, matcher, candidater, relever, répondre. */
async function cycle(project: string): Promise<string> {
  const started = Date.now();
  const sourceId = await ensureSource();
  const posed = sourceId ? await ensureListings(sourceId) : 0;

  const matched = await matchPending(Number(process.env.MATCH_LIMIT ?? 50));
  // La seule différence avec la production, et elle est de portée, pas de
  // comportement : on ne candidate que sur la source fabriquée. Ouvrir la vanne
  // globale enverrait des messages vers de vraies agences pendant une
  // répétition.
  const queued = await queueApplications(
    Number(process.env.QUEUE_LIMIT ?? 20),
    'matches_ready_to_send_demo',
  );
  const sent = await sendDue(project, Number(process.env.SEND_LIMIT ?? 20));
  const outbox = await sendOutbox(Number(process.env.OUTBOX_LIMIT ?? 20));
  await closeLostMatches();

  // La relève de boîte, à chaque tour. C'est elle qui, en production, attend
  // huit heures — et c'est elle qui doit répondre en quelques secondes ici.
  const inbox = await watchAllInboxes(project);

  // Zéro candidature : dire pourquoi à chaque tour, pas seulement au tour qui a
  // créé le match. Un match posé au premier tour et bloqué au second serait
  // resté sans explication, ce qui est exactement le cas qu'on cherche à voir.
  const why = queued === 0 ? ` · ${await explainSilence()}` : '';

  return (
    `posées ${posed} · matchs ${matched.matches} · en file ${queued} · ` +
    `envoyées ${sent.sent} · relances ${outbox.sent} · ` +
    `boîtes ${inbox.clients} · réponses ${inbox.replies} · ${Date.now() - started} ms${why}`
  );
}

/**
 * La boucle, bornée dans le temps.
 *
 * Bornée parce qu'un job Cloud Run a une échéance et qu'un processus qui la
 * dépasse est tué au milieu d'un envoi. `DEMO_MINUTES` doit rester sous
 * `--task-timeout`, et le job est relancé pour la démonstration suivante.
 */
export async function runDemoLoop(project: string): Promise<void> {
  const minutes = Number(process.env.DEMO_MINUTES ?? 10);
  const deadline = Date.now() + minutes * 60_000;
  let round = 0;

  // Repartir de zéro, sinon la troisième répétition ne montre rien.
  //
  // Deux des trois plafonds de `may_send` comptent des candidatures passées :
  // deux messages vers la même adresse en sept jours, cinq candidatures
  // ouvertes. Une démonstration répétée les atteint, et l'agent se tait — à
  // raison, mais devant le public. `demo_reset` (0018) efface la source
  // fabriquée et rien d'autre ; les annonces sont reposées au premier tour.
  if (process.env.DEMO_RESET !== '0') {
    const { data } = await db().rpc('demo_reset');
    console.log(`démo: remise à zéro, ${data ?? 0} annonce(s) de démonstration effacée(s)`);
  }

  console.log(`démo: boucle de ${minutes} min, un tour toutes les ${TICK_MS / 1000} s`);

  while (Date.now() < deadline) {
    round += 1;
    try {
      console.log(`démo #${round}: ${await cycle(project)}`);
    } catch (error) {
      // Un tour qui échoue ne doit pas arrêter la démonstration : le suivant
      // repart huit secondes plus tard, et l'erreur est visible dans les logs.
      console.error(`démo #${round}: ${error instanceof Error ? error.message : String(error)}`);
    }
    const wait = Math.max(0, Math.min(TICK_MS, deadline - Date.now()));
    if (wait > 0) await new Promise((resolve) => setTimeout(resolve, wait));
  }

  console.log(`démo: terminée après ${round} tour(s)`);
}
