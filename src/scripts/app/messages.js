/**
 * Tab 3 - Messages.
 *
 * One thread per flat, presented as an ordinary conversation even though the
 * messages travel over different channels underneath - email through the Gmail
 * API for most agencies, leboncoin's own inbox through the Mira agent for the
 * rest. Which pipe a message went down is our problem, not the reader's.
 *
 * The one thing that is never blurred is authorship. A message the AI sent in
 * someone's name is labelled as such, every time, with a different shape and a
 * different colour from anything the person wrote themselves. The reason is
 * practical rather than ethical theatre: the moment someone takes over a
 * thread, they need to know exactly what has already been said in their name,
 * or their first message contradicts the last one.
 */
import * as agent from '../../lib/prems/agent.js';
import { h, appIcon, statusBadge, sectionTitle, empty, toast, input } from './ui.js';

/* Which thread is open, kept outside the render so a live update - a new
 * agency reply arriving - does not throw the reader back to the list. */
let openId = null;

const timeLabel = (ms) => {
  const date = new Date(ms);
  const today = new Date();
  const sameDay =
    date.getFullYear() === today.getFullYear() &&
    date.getMonth() === today.getMonth() &&
    date.getDate() === today.getDate();

  return sameDay
    ? agent.formatTime(ms)
    : `${date.toLocaleDateString('fr-FR', { day: 'numeric', month: 'short' })} · ${agent.formatTime(ms)}`;
};

/* -------------------------------------------------------------------------
 * The list
 * ------------------------------------------------------------------------- */
function threadRow(match, unreadIds) {
  const messages = agent.thread(match);
  const last = messages[messages.length - 1];
  const unread = unreadIds.has(match.id);

  return h(
    'button',
    {
      class: `pm-thread${unread ? ' is-unread' : ''}`,
      type: 'button',
      onClick: () => {
        openId = match.id;
        agent.act(match.id, { readAt: new Date().toISOString() });
      },
    },
    h(
      'span',
      { class: 'pm-thread__avatar', 'aria-hidden': 'true' },
      match.listing.agency.slice(0, 2).toUpperCase(),
    ),
    h(
      'span',
      { class: 'pm-thread__body' },
      h(
        'span',
        { class: 'pm-thread__top' },
        h('span', { class: 'pm-thread__name' }, match.listing.agency),
        h('span', { class: 'pm-thread__time' }, agent.ago(last.at)),
      ),
      h(
        'span',
        { class: 'pm-thread__sub' },
        `${match.listing.district} · ${match.listing.rent_eur} €`,
      ),
      h(
        'span',
        { class: 'pm-thread__preview' },
        last.from === 'agence' ? '' : last.from === 'moi' ? 'Toi : ' : 'Agent : ',
        last.body,
      ),
    ),
    unread ? h('span', { class: 'pm-thread__dot', 'aria-label': 'Non lu' }) : null,
  );
}

/* -------------------------------------------------------------------------
 * One conversation
 * ------------------------------------------------------------------------- */
function bubble(message) {
  const mine = message.from !== 'agence';

  return h(
    'div',
    { class: `pm-msg pm-msg--${message.from}${mine ? ' pm-msg--mine' : ''}` },
    message.from === 'agent'
      ? h(
          'span',
          { class: 'pm-msg__author' },
          appIcon('sparkle', 13),
          'Agent Prems — écrit en ton nom',
        )
      : null,
    h('p', { class: 'pm-msg__body' }, message.body),
    h('span', { class: 'pm-msg__time' }, timeLabel(message.at)),
  );
}

function conversation(match, ctx) {
  const messages = agent.thread(match);
  const manual = Boolean(match.action.manual);
  const replies = match.action.replies || [];

  const all = [
    ...messages,
    ...replies.map((reply) => ({ from: 'moi', at: new Date(reply.at).getTime(), body: reply.body })),
  ].sort((a, b) => a.at - b.at);

  const composerInput = input({
    placeholder: 'Écris ta réponse…',
    'aria-label': 'Ta réponse à l’agence',
  });

  const send = () => {
    const body = composerInput.value.trim();
    if (!body) return;
    agent.act(match.id, {
      replies: [...replies, { at: new Date().toISOString(), body }],
    });
    composerInput.value = '';
  };

  composerInput.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') {
      event.preventDefault();
      send();
    }
  });

  return h(
    'div',
    { class: 'pm-conv' },
    h(
      'header',
      { class: 'pm-conv__head' },
      h(
        'button',
        {
          class: 'pm-conv__back',
          type: 'button',
          onClick: () => {
            openId = null;
            ctx.refresh();
          },
        },
        '‹ Tous les messages',
      ),
      h(
        'div',
        { class: 'pm-conv__title' },
        h('h2', {}, match.listing.agency),
        h(
          'p',
          {},
          `${match.listing.district} · ${match.listing.surface_m2} m² · ${match.listing.rent_eur} €`,
        ),
      ),
      statusBadge(match.status),
    ),

    h('div', { class: 'pm-conv__stream' }, all.map(bubble)),

    /* The handover. Left as a persistent control rather than a menu item: the
     * cases where someone wants it - an agency asking something personal, a
     * negotiation - are exactly the cases where hunting for it is worst. */
    manual
      ? h(
          'div',
          { class: 'pm-conv__composer' },
          h(
            'p',
            { class: 'pm-conv__manual' },
            appIcon('user', 14),
            'Tu as repris la main sur ce fil. L’agent n’écrit plus ici.',
          ),
          h(
            'div',
            { class: 'pm-conv__row' },
            composerInput,
            h(
              'button',
              { class: 'pm-conv__send', type: 'button', onClick: send },
              appIcon('arrowRight', 18),
            ),
          ),
          h(
            'button',
            {
              class: 'pm-conv__handover',
              type: 'button',
              onClick: () => {
                agent.act(match.id, { manual: false });
                toast('L’agent reprend ce fil.');
              },
            },
            'Rendre la main à l’agent',
          ),
        )
      : h(
          'button',
          {
            class: 'pm-conv__handover pm-conv__handover--take',
            type: 'button',
            onClick: () => {
              agent.act(match.id, { manual: true });
              toast('Tu as la main. L’agent n’écrira plus sur ce fil.');
            },
          },
          appIcon('edit', 16),
          'Reprendre la main sur ce fil',
        ),
  );
}

/* -------------------------------------------------------------------------
 * The tab
 * ------------------------------------------------------------------------- */
export default function renderMessages(ctx) {
  const model = ctx.model;
  const wrap = h('div', { class: 'pm-page' });

  const open = openId && model.threads.find((t) => t.id === openId);
  if (open) {
    wrap.append(conversation(open, ctx));
    return wrap;
  }
  openId = null;

  if (!model.threads.length) {
    wrap.append(
      empty({
        icon: 'chat',
        title: 'Rien à lire pour l’instant.',
        text: model.started
          ? 'Dès que l’agent écrit à une agence, la conversation apparaît ici — tu vois exactement ' +
            'ce qui a été envoyé en ton nom, et tu peux reprendre la main à tout moment.'
          : 'L’agent commencera à écrire aux agences dès que tes disponibilités seront enregistrées.',
      }),
    );
    return wrap;
  }

  const unreadIds = new Set(model.unread.map((m) => m.id));

  wrap.append(
    sectionTitle(
      'Conversations',
      unreadIds.size ? `${unreadIds.size} non lue${unreadIds.size > 1 ? 's' : ''}` : null,
    ),
    h(
      'p',
      { class: 'pm-learned' },
      appIcon('sparkle', 15),
      'Les messages marqués « Agent Prems » ont été envoyés en ton nom, jamais par toi.',
    ),
    h('div', { class: 'pm-threads' }, model.threads.map((match) => threadRow(match, unreadIds))),
  );

  return wrap;
}
