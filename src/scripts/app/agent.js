/**
 * Onglet 5 — L'agent, à découvert.
 *
 * Les quatre autres onglets montrent des résultats : des matchs, des visites,
 * des messages, un dossier. Celui-ci montre le travail — ce que l'agent a
 * regardé, ce qu'il en a conclu, ce qu'il a fait ensuite, et ce qu'il attend de
 * toi. C'est le seul endroit où un produit autonome devient vérifiable plutôt
 * que magique.
 *
 * Deux principes de lecture, et ils gouvernent toute la mise en page.
 *
 * **Ce qu'il attend passe avant ce qu'il a fait.** Une demande ouverte bloque
 * une candidature ; un journal, non. Les demandes sont donc en haut, et rien
 * ne les replie.
 *
 * **Une pensée n'est pas une action.** L'agent qui « écarte un logement »
 * raisonne ; l'agent qui « envoie la candidature » engage la personne au nom de
 * qui il écrit. Les deux se lisent différemment et se distinguent d'un coup
 * d'œil, parce que confondre les deux est exactement ce qui rend un agent
 * inquiétant.
 */
import * as activity from '../../lib/prems/activity.js';
import * as documents from '../../lib/prems/documents.js';
import { h, appIcon, button, sectionTitle, empty, toast } from './ui.js';

const DOC_LABELS = {
  identite: "Pièce d'identité",
  domicile: 'Justificatif de domicile',
  revenus: 'Justificatif de revenus',
  garant: 'Pièce du garant',
};

/** "il y a 4 min", "hier à 09:12" — une horloge qu'on lit sans compter. */
function when(iso) {
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return '';
  const mins = Math.round((Date.now() - t) / 60000);
  if (mins < 1) return "à l'instant";
  if (mins < 60) return `il y a ${mins} min`;
  const hours = Math.round(mins / 60);
  if (hours < 24) return `il y a ${hours} h`;
  const d = new Date(t);
  const day = d.toLocaleDateString('fr-FR', { day: 'numeric', month: 'short' });
  return `${day} à ${d.toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' })}`;
}

/* -------------------------------------------------------------------------
 * 1. Ce que l'agent attend de toi
 * ------------------------------------------------------------------------- */

/**
 * Une demande, avec de quoi y répondre sur place.
 *
 * Le dépôt de fichier passe par le même chemin que l'onboarding — bucket privé,
 * chemin préfixé par l'identifiant de l'utilisateur — pour qu'il n'existe qu'une
 * façon d'entrer un document dans le dossier.
 */
function requestCard(request, onDone) {
  if (request.status !== 'open') {
    return h(
      'div',
      { class: 'pm-ask pm-ask--done' },
      h('span', { class: 'pm-ask__check' }, '✓'),
      h(
        'div',
        { class: 'pm-ask__body' },
        h('p', { class: 'pm-ask__label' }, request.label),
        h(
          'p',
          { class: 'pm-ask__meta' },
          request.status === 'resolved' ? 'Transmis' : 'Écarté',
          ' · ',
          when(request.created_at),
        ),
      ),
    );
  }

  const card = h('div', { class: 'pm-ask' });
  const busy = (on) => card.classList.toggle('is-busy', on);

  const actions = h('div', { class: 'pm-ask__actions' });

  if (request.kind === 'document') {
    const file = h('input', {
      type: 'file',
      accept: 'image/*,application/pdf',
      class: 'pm-ask__file',
      id: `ask-${request.id}`,
      onChange: async (event) => {
        const chosen = event.target.files?.[0];
        if (!chosen) return;
        busy(true);
        try {
          // `upload` rend { ok, stored } : `stored: false` veut dire que le
          // fichier n'a pas atteint le bucket, et refermer la demande dans ce
          // cas ferait croire à l'agent qu'il a une pièce qu'il n'a pas.
          const saved = await documents.upload(chosen, request.doc_kind || 'garant');
          if (!saved?.stored) throw new Error('non stocké');
          const ok = await activity.resolve(request.id, { answer: `Déposé : ${saved.name}` });
          if (!ok) throw new Error('refus');
          toast('Transmis. L’agent reprend la conversation.');
          onDone();
        } catch {
          toast("Le dépôt n'a pas abouti. Réessaie dans un instant.");
          busy(false);
        }
      },
    });
    actions.append(
      file,
      h(
        'label',
        { class: 'ob-btn ob-btn--accent pm-ask__cta', for: `ask-${request.id}` },
        h('span', { class: 'ob-btn__inner' }, 'Déposer le document'),
      ),
    );
  } else {
    const field = h('input', {
      class: 'ob-input pm-ask__input',
      placeholder: request.kind === 'decision' ? 'Oui / non, et pourquoi' : 'Ta réponse',
      'aria-label': request.label,
    });
    actions.append(
      field,
      button('Envoyer', {
        variant: 'accent',
        onClick: async () => {
          const value = field.value.trim();
          if (!value) return;
          busy(true);
          const ok = await activity.resolve(request.id, { answer: value });
          if (ok) {
            toast('Transmis. L’agent reprend la conversation.');
            onDone();
          } else {
            toast("L'enregistrement n'a pas abouti.");
            busy(false);
          }
        },
      }),
    );
  }

  card.append(
    h(
      'div',
      { class: 'pm-ask__head' },
      h('span', { class: 'pm-ask__icon' }, appIcon(request.kind === 'document' ? 'file' : 'chat', 18)),
      h(
        'div',
        { class: 'pm-ask__body' },
        h('p', { class: 'pm-ask__label' }, request.label),
        request.reason ? h('p', { class: 'pm-ask__reason' }, request.reason) : null,
        h(
          'p',
          { class: 'pm-ask__meta' },
          request.doc_kind ? `${DOC_LABELS[request.doc_kind] ?? request.doc_kind} · ` : '',
          when(request.created_at),
        ),
      ),
    ),
    actions,
    h(
      'button',
      {
        class: 'pm-ask__skip',
        type: 'button',
        onClick: async () => {
          busy(true);
          await activity.dismiss(request.id);
          onDone();
        },
      },
      'Je ne l’ai pas',
    ),
  );

  return card;
}

/* -------------------------------------------------------------------------
 * 2. Le journal
 * ------------------------------------------------------------------------- */

/**
 * Une entrée du journal.
 *
 * Les outils appelés sont affichés sous l'événement, en clair. C'est la
 * différence entre « l'agent a répondu » et « l'agent a consulté ton agenda,
 * relu ton dossier, puis rédigé » — la seconde formulation est vérifiable, la
 * première demande de faire confiance.
 */
function entry(item) {
  const detail = [];
  if (item.payload.summary) detail.push(item.payload.summary);
  if (item.payload.availability) detail.push(`Disponibilités : ${item.payload.availability}`);
  if (item.payload.reason) detail.push(item.payload.reason);
  if (item.payload.skipped_reason) detail.push(item.payload.skipped_reason);

  return h(
    'li',
    { class: `pm-log__item pm-log__item--${item.kind}` },
    h('span', { class: 'pm-log__dot', 'aria-hidden': 'true' }),
    h(
      'div',
      { class: 'pm-log__body' },
      h(
        'p',
        { class: 'pm-log__title' },
        item.title,
        h('span', { class: 'pm-log__time' }, when(item.at)),
      ),
      detail.length ? h('p', { class: 'pm-log__detail' }, detail.join(' · ')) : null,
      item.tools.length
        ? h(
            'ul',
            { class: 'pm-log__tools' },
            item.tools.map((t) => h('li', { class: 'pm-log__tool' }, t)),
          )
        : null,
      item.payload.read_calendar
        ? h('p', { class: 'pm-log__badge' }, 'Agenda Google consulté en direct')
        : null,
    ),
  );
}

/* -------------------------------------------------------------------------
 * L'onglet
 * ------------------------------------------------------------------------- */
export default function renderAgent(ctx) {
  const asks = h('div', { class: 'pm-asks' });
  const log = h('ul', { class: 'pm-log' });

  const refresh = async () => {
    const [items, pending] = await Promise.all([activity.timeline(), activity.requests()]);

    const open = pending.filter((r) => r.status === 'open');
    const closed = pending.filter((r) => r.status !== 'open').slice(0, 3);

    asks.replaceChildren(
      ...[
      open.length
        ? h(
            'div',
            null,
            sectionTitle(
              open.length === 1 ? 'Il attend une chose de toi' : `Il attend ${open.length} choses de toi`,
            ),
            ...open.map((r) => requestCard(r, refresh)),
          )
        : h(
            'div',
            { class: 'pm-asks__clear' },
            h('span', { class: 'pm-asks__clear-icon' }, appIcon('sparkle', 18)),
            h('p', null, "Rien à te demander. L'agent a tout ce qu'il lui faut."),
          ),
      closed.length
        ? h('div', { class: 'pm-asks__past' }, ...closed.map((r) => requestCard(r, refresh)))
        : null,
      ].filter(Boolean),
    );

    log.replaceChildren(
      ...(items.length
        ? items.map(entry)
        : [
            h(
              'li',
              { class: 'pm-log__empty' },
              empty({
                icon: 'radar',
                title: 'Le journal est encore vide',
                text: "Dès que l'agent trouve un logement, décide d'une candidature ou répond à une agence, tout apparaît ici, dans l'ordre.",
              }),
            ),
          ]),
    );
  };

  refresh();
  // Le journal bouge pendant qu'on le regarde : les workers tournent à la
  // minute. Une page qui ne se rafraîchit pas donnerait l'impression d'un agent
  // à l'arrêt. Le minuteur s'arrête quand l'onglet quitte le document — sans ça
  // il continuerait d'interroger la base depuis un onglet qu'on a quitté.
  const timer = setInterval(() => {
    if (page.isConnected) refresh();
    else clearInterval(timer);
  }, 20000);

  const page = h(
    'div',
    { class: 'pm-page pm-agent' },
    h(
      'header',
      { class: 'pm-agent__intro' },
      h(
        'p',
        { class: 'pm-agent__sub' },
        'Chaque décision qu’il prend en ton nom est écrite ici, avec ce qu’il a consulté pour la prendre.',
      ),
    ),
    asks,
    sectionTitle('Journal'),
    log,
  );

  return page;
}
