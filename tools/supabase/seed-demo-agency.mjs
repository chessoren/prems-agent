/**
 * Une annonce de démonstration, adressée à une boîte que vous contrôlez.
 *
 *   npm run db:demo -- --account project.orionloop@gmail.com \
 *                      --agency  jenie.du.film@gmail.com
 *   npm run db:demo -- --remove
 *
 * ---------------------------------------------------------------------------
 * Pourquoi cet outil existe
 * ---------------------------------------------------------------------------
 * Le produit ne peut se montrer de bout en bout que si une agence répond, et
 * une agence répond quand elle veut. Pour filmer une démonstration reproductible
 * il faut donc jouer les deux rôles : le candidat, et l'agence. C'est ce que
 * fait cette annonce — le bien est fictif, l'adresse de « l'agence » est une
 * boîte que vous relevez vous-même.
 *
 * **L'agent, lui, n'est au courant de rien, et c'est le point.** La ligne
 * insérée est une annonce ordinaire : même table, même filtre, même score, même
 * chemin d'envoi. Rien dans le pipeline ne la distingue, donc ce qu'on observe
 * est le comportement réel et non une mise en scène.
 *
 * Ce qui la rend reconnaissable pour un humain, et seulement pour lui : sa
 * source s'appelle `demo-agency` et son identifiant externe commence par
 * `demo-`. C'est ce qui permet de la retirer d'un seul geste, et de ne jamais
 * la confondre avec le catalogue réel dans une requête d'exploitation.
 *
 * ---------------------------------------------------------------------------
 * Comment le match est garanti
 * ---------------------------------------------------------------------------
 * Aucune valeur n'est devinée. L'annonce est **dérivée de la recherche active
 * du compte** : sa ville, son type de bien, son nombre de pièces, sa zone, son
 * budget. Un bien construit à partir des critères passe le filtre dur par
 * construction, plutôt que par chance — et si les critères changent, il suffit
 * de relancer l'outil.
 *
 * La fraîcheur pèse 27 % du score avec une demi-vie de 90 minutes, donc
 * `published_at` est posé à maintenant : l'annonce arrive en tête, comme le
 * ferait une vraie annonce publiée à l'instant. Relancez juste avant de filmer.
 */
import { loadEnv, require_ } from './env.mjs';

const env = loadEnv();
const ref = require_(env, 'SUPABASE_PROJECT_REF');
const token = require_(env, 'SUPABASE_ACCESS_TOKEN');

const arg = (name, fallback = null) => {
  const i = process.argv.indexOf(`--${name}`);
  return i > -1 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
};

const ACCOUNT = arg('account', 'project.orionloop@gmail.com');
const AGENCY = arg('agency', 'jenie.du.film@gmail.com');
const REMOVE = process.argv.includes('--remove');
const SLUG = 'demo-agency';
const EXTERNAL_ID = 'demo-visite-express';

async function query(sql) {
  const response = await fetch(`https://api.supabase.com/v1/projects/${ref}/database/query`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ query: sql }),
  });
  const text = await response.text();
  if (!response.ok) throw new Error(`HTTP ${response.status}\n${text.slice(0, 800)}`);
  return text ? JSON.parse(text) : [];
}

const quote = (value) => `'${String(value).replace(/'/g, "''")}'`;

/* ------------------------------------------------------------------ retrait */

if (REMOVE) {
  // Les matchs, candidatures et messages partent avec, par cascade sur la
  // source. Une démonstration à moitié effacée est pire que pas d'effacement :
  // elle laisse un match orphelin dans l'écran d'accueil du client.
  await query(`delete from public.sources where slug = ${quote(SLUG)};`);
  console.log(`\nAnnonce de démonstration retirée (source « ${SLUG} »).\n`);
  process.exit(0);
}

/* -------------------------------------------------------------------- pose */

const [target] = await query(`
  select
    s.id           as search_id,
    s.user_id,
    u.email,
    s.city, s.city_slug, s.budget_max_eur,
    coalesce(s.rooms_min, s.rooms, 2)                                as rooms,
    case when cardinality(s.property_types) > 0
         then s.property_types[1] else 'flat' end                    as property_type,
    case when cardinality(s.zones) > 0 then s.zones[1] else null end as zone,
    s.furnished,
    s.surface_min_m2,
    p.gmail_account_id is not null                                   as boite_connectee
  from public.searches s
  join auth.users u on u.id = s.user_id
  left join public.profiles p on p.id = s.user_id
  where lower(u.email) = lower(${quote(ACCOUNT)}) and s.active
  order by s.created_at desc
  limit 1;
`);

if (!target) {
  console.error(
    `\nAucune recherche active pour ${ACCOUNT}.\n` +
      `Terminez l'inscription sur /onboarding avec ce compte, puis relancez.\n`,
  );
  process.exit(1);
}

// Une zone à deux chiffres est un département : il faut un code postal qui
// commence par elle, sinon le filtre `postcode like z || '%'` ne mord pas.
const postcode =
  target.zone && String(target.zone).length === 2 ? `${target.zone}100` : target.zone || '75011';

// Sous le plafond, jamais dessus : le budget porte sur le total charges
// comprises, et c'est le total que le filtre compare.
const rent = Math.max(300, Number(target.budget_max_eur) - 120);
const surface = Math.max(Number(target.surface_min_m2 ?? 0) + 5, 20 + Number(target.rooms) * 12);

const [listing] = await query(`
  with src as (
    insert into public.sources (slug, name, kind, adapter, base_url, contact_channel, enabled, poll_interval_seconds)
    values (${quote(SLUG)}, 'Agence de démonstration', 'agency', 'demo',
            'https://demo.prems.local', 'email', false, 3600)
    on conflict (slug) do update set name = excluded.name
    returning id
  )
  insert into public.listings (
    source_id, external_id, url, title, description,
    property_type, rooms, bedrooms, surface_m2,
    rent_eur, charges_eur, deposit_eur,
    furnished, floor, has_elevator, dpe,
    available_from, address_raw, street, postcode, city, city_slug,
    geo_precision, agency_name, agency_email, is_professional,
    photos, published_at, first_seen_at, last_seen_at, status, matched_at
  )
  select
    src.id, ${quote(EXTERNAL_ID)},
    'https://demo.prems.local/annonce/' || ${quote(EXTERNAL_ID)},
    ${quote(`${target.rooms} pièces — ${target.city}`)},
    'Bel appartement traversant, lumineux, proche commerces et transports. Cuisine équipée, double vitrage, chauffage individuel. Disponible immédiatement. Visites sur rendez-vous.',
    ${quote(target.property_type)}, ${Number(target.rooms)}, ${Math.max(1, Number(target.rooms) - 1)}, ${surface},
    ${rent}, 0, ${rent * 2},
    ${target.furnished === null ? 'null' : target.furnished},
    3, true, 'C',
    current_date, ${quote(`12 rue de la Démonstration, ${postcode} ${target.city}`)},
    'rue de la Démonstration', ${quote(postcode)}, ${quote(target.city)}, ${quote(target.city_slug)},
    'street', 'Agence de démonstration', ${quote(AGENCY)}, true,
    '[]'::jsonb, now(), now(), now(), 'active', null
  from src
  on conflict (source_id, external_id) do update set
    -- Relancer republie : la fraîcheur pèse 27 % du score, donc une annonce
    -- reposée juste avant la démonstration repasse en tête comme une vraie.
    published_at   = now(),
    last_seen_at   = now(),
    agency_email   = excluded.agency_email,
    rent_eur       = excluded.rent_eur,
    rooms          = excluded.rooms,
    surface_m2     = excluded.surface_m2,
    property_type  = excluded.property_type,
    postcode       = excluded.postcode,
    city           = excluded.city,
    city_slug      = excluded.city_slug,
    status         = 'active',
    -- Remise dans la file de matching, sinon une seconde exécution ne
    -- produirait plus rien : `listings_needing_match` ne rend que les annonces
    -- dont `matched_at` est nul.
    matched_at     = null
  returning id, title, city, postcode, rent_eur, agency_email;
`);

// Ce que le matching avait déjà décidé sur l'ancienne version de la ligne doit
// partir avec elle, sinon la contrainte d'unicité empêche un nouveau match et
// la démonstration ne rejoue pas.
await query(`delete from public.matches where listing_id = ${quote(listing.id)};`);

console.log(`
Annonce de démonstration en place.

  compte        ${target.email}
  bien          ${listing.title} — ${listing.postcode} ${listing.city}
  loyer         ${listing.rent_eur} € (plafond du compte : ${target.budget_max_eur} €)
  « agence »    ${listing.agency_email}
  boîte mail    ${target.boite_connectee ? 'connectée' : 'PAS ENCORE CONNECTÉE'}

L'agent la traitera comme n'importe quelle annonce : prems-match la verra dans
la minute, prems-apply enverra la candidature dans les deux minutes qui suivent
— à ${listing.agency_email}, depuis la boîte du compte.
${target.boite_connectee ? '' : '\nRien ne partira tant que la boîte du compte n’est pas connectée :\n/app › Profil › Boîte mail › « Connecter ma boîte mail ».\n'}
Répondez depuis ${listing.agency_email} pour déclencher la suite : lecture,
classification, vérification de l'agenda, réponse autonome.

Pour retirer : npm run db:demo -- --remove
`);
