# Agents for Humans: submission kit

Everything the Devpost form asks for, ready to paste. Track: **Everyday Agents**.

---

## Project name

Prems

## Elevator pitch (≤ 200 characters)

A Strands agent on Amazon Bedrock that applies to rental listings from your own Gmail, negotiates the viewing against your real calendar, and books it.

## About the project

### Inspiration

In Paris, a good apartment is gone in a day and agencies answer whoever wrote first. Renters apply forty times, retype the same facts, and watch their inbox for a reply they must answer within the hour. None of that is judgment; it is repetition and latency, and it hurts most the people with the least free time.

### What it does

Prems handles the whole errand, not a chat about it:

1. **Matches listings.** It watches listings and matches new ones to the renter's saved search within a minute.
2. **Applies.** An **application-writer agent** drafts a short, specific application (apartment type, city, rent, the renter's situation). It is sent from the **renter's own Gmail**.
3. **Reads replies.** A **classifier agent** reads the agency's reply in that inbox: visit offered, visit confirmed, question, refused, or other.
4. **Negotiates.** A **negotiator agent** with six tools reads the renter's saved availability and checks proposed slots against their **real Google Calendar**. It flags any document the agency asked for that is missing, then queues a reply with a slot the renter can actually keep, or stands down.
5. **Books.** A confirmed visit is written to the renter's Google Calendar and shown in the app's Agent tab, with the tools the agent called.

### How we built it

- **Agents:** three agents built with the **Strands Agents SDK (TypeScript)**, running on **Claude Opus 5 via Amazon Bedrock** (`BedrockModel`, EU inference profile, `eu-west-3`).
  - The writer and the classifier use Strands **structured output** (zod schemas).
  - The negotiator uses **tools** defined with `tool()` and zod: `get_client_availability`, `check_calendar_conflicts`, `get_client_facts`, `request_document`, `queue_reply`, `stand_down`.
- **Guardrails in code, around the agent:**
  - refusals end the thread before an agent is built;
  - a per-thread reply cap and an operator kill switch live in the database;
  - a reply that names dates without reading availability is replaced by a safe one;
  - nothing is sent from inside the agent: `queue_reply` feeds an outbox.
- **Tests:** they replay scripted tool calls against the real Strands tools (63 tests in CI).
- **Pipeline:** TypeScript workers in one Docker image, run as scheduled jobs.
  - Supabase Postgres (RLS) is the single source of truth.
  - Composio brokers per-user Gmail and Google Calendar OAuth.
  - The site (Astro on Vercel) holds onboarding and the Agent tab.

### Challenges we ran into

- **Proposing is not confirming.** An early version booked a visit when the agency had only proposed two slots. The classifier now separates `visit_offered` from `visit_confirmed`, and only a confirmation reaches the calendar.
- **Agents that invent availability.** When availability was pasted into the prompt, the model sometimes named a day nobody was free. Moving it behind a tool, and checking in code that the tool was called, fixed it.
- **A failed calendar lookup must not look like an empty calendar.** The tool reports "unreadable" instead, so the agent doesn't accept a slot the renter can't keep.

### Accomplishments that we're proud of

- The negotiator is a real tool-using agent, and every decision is explainable: the tools it called are written next to the message it produced.
- Safety rules are enforced in code and pinned by tests, not requested in a prompt.
- The mail goes out from the renter's own address and reads like they wrote it.

### What we learned

- A tool is a better constraint than a paragraph of instructions.
- Structured output removes a whole class of failures, but not the need to check whether the answer is true (past dates, invented slots).
- Porting between agent frameworks is cheap when tools are plain functions with zod schemas. Moving from Google ADK to Strands touched four files; the guardrails and tests carried over.

### What's next for Prems

- Real users connecting their mailbox.
- More listing sources.
- Moving the interactive side (asking the renter for a missing document) to Amazon Bedrock AgentCore Runtime with per-user sessions.
- Bedrock embeddings, so the whole stack runs on AWS.

## Built with

strands-agents · amazon-bedrock · claude · typescript · node.js · zod · supabase · postgresql · pgvector · composio · gmail-api · google-calendar-api · astro · vercel · docker · google-cloud-run

## Links

- Code: https://github.com/chessoren/prems-agent
- Live site: https://prems.getmira.run
- Demo video (YouTube/Vimeo, public, ≤ 5 min): **TO ADD**
- Architecture diagram to upload in the image gallery: [`docs/architecture-en.png`](architecture-en.png)

---

## Testing instructions for judges

1. **No account needed: the agent guardrails.**

   ```bash
   git clone https://github.com/chessoren/prems-agent && cd prems-agent
   npm install
   npm run ci
   ```

   `workers/test/negotiate.test.ts` replays the negotiator's tool calls against the real Strands tools: calendar conflicts, document requests, idempotent reply, refusal handling.
2. **The product: https://prems.getmira.run.** Onboarding is free (payments are switched off) and opens the app, including the Agent tab.
3. **The full loop with your own AWS account.**
   - Set `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY` and `AWS_REGION` in `.env`.
   - Run `npm run bedrock:models` to confirm Claude Opus 5 answers.
   - Follow *A reproducible end-to-end demo* in the README. It needs a Supabase project and a Composio key.

## Pre-existing work disclosure (paste into the form)

- **Landing page (pre-existing).** The marketing landing page is generated from our own pre-existing Framer site (commits dated 9 August 2026, before the submission period).
- **Agent pipeline (built during the period).** The agent pipeline was written from 10 August 2026 onwards: workers, matching, database, edge functions, onboarding and app.
- **Framework port.** The agents were first built on Google's ADK with Gemini and were ported to the Strands Agents SDK on Amazon Bedrock on 14 September 2026.
- **AI assistance.** AI coding assistants (Claude Code) were used throughout.

---

## Demo video script (target 4:30, hard limit 5:00)

| Time | On screen | Voice-over |
|---|---|---|
| 0:00–0:35 | Listing sites, a Paris apartment gone in hours, an inbox full of "déjà loué" | **The problem.** In Paris a good flat is gone in a day, and agencies answer whoever wrote first. Renters apply forty times and watch their inbox all evening. |
| 0:35–0:55 | Prems landing page | **Who and why.** Prems is for renters who can't be awake at the right moment: students, people moving for work. It does the errand end to end, from their own mailbox. |
| 0:55–1:30 | Onboarding: search, availability, connect Gmail + Calendar | The renter says what they're looking for and when they can visit, and connects their Gmail and Google Calendar. |
| 1:30–2:15 | Terminal: `MODE=demo`; the demo listing is matched; the application arrives in the "agency" inbox | A listing appears. The matcher picks it up and the **Strands writer agent** on **Claude Opus 5 / Bedrock** writes the application. It leaves from the renter's own Gmail. |
| 2:15–3:15 | Agency inbox: reply "mardi 14h ou jeudi 10h ?". Calendar shows Tuesday busy. Next tick: the negotiator's reply arrives, "mardi je ne suis pas disponible, jeudi 10h me convient". | The agency proposes two slots. The classifier reads the reply. The **negotiator agent** calls its tools: it reads the availability, checks the **real Google Calendar**, sees Tuesday is taken and answers with Thursday. |
| 3:15–3:45 | Agency confirms. Google Calendar now has the visit. App Agent tab lists the tools called. | The agency confirms, and the visit lands in the calendar. The Agent tab shows exactly which tools the agent used and why. |
| 3:45–4:15 | Code: `negotiate.ts` tools, `agent.ts` BedrockModel, `negotiate.test.ts` passing | **Under the hood.** Six Strands tools, structured output for the writer and classifier. Guardrails are in code, not the prompt, and tested. |
| 4:15–4:30 | Architecture diagram | One pipeline, three agents, one outbox, from listing to booked visit with no human in between. |

Record the demo part with `npm run db:demo` just before filming. Freshness matters to the score, so the demo listing must be new.
