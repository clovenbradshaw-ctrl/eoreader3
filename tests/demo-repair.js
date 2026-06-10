/* ============================================================
   Narrated demo: conversational repair + the possessive-kin record.

   Replays a real failed conversation (from an exported cleon-audit trace)
   against a reconstruction of its document, driving the engine the way
   app.jsx's runTurn does — mechanically, no model, which is the contract.

   The original session: "whose son is mentioned?" got "The passages do not
   mention who is the son of Tom Turner" four different ways, the user's
   "you're not listening to what i'm saying" was lexically dragged onto the
   page and answered with a parking-garage line, and the page's own answer
   (the son is David Corman's — "his son" at the sentence after Corman's
   introduction) was never reachable because the possessive was never
   resolved into the graph.

     node tests/demo-repair.js
   ============================================================ */
'use strict';
const { loadEngine } = require('./harness');
const E = loadEngine().EOEngine;

const NDP = `Downtown Business Owners Cannot Afford This

If you own a business downtown, you pay the Nashville Downtown Partnership. A significant share of that money funds NDP's private security operation. The fire marshal had warned about the garage. Neither Metro Codes nor the fire marshal allowed storage there.

The structure is complicated. It is run through a recently created entity called NDMC PSO LLC, a shell company of the District Management Corporation, created by the same person who runs the DMC and who then hires his own firm, NDP, to manage the downtown security operations through it. That person is Tom Turner. The contract was never shown to the council. NDP has not had a budget approved by Metro Council in 22 years.

Who actually runs it? NDP's Director of Safety Services is David Corman, a former MNPD precinct commander, who earned $116,943 in 2024 directing the private policing operation. Until recently, his son served as Director of Administration at Solaren Risk Management, the firm staffing the off-duty Tennessee Highway Patrol troopers, overseeing HR, payroll, accounting, vendor management, compliance, and risk mitigation. The younger Corman graduated college in 2022 with a degree in geology; his prior employment was as a team lead at a Regal Cinemas movie theater.`;

const TURNS = [
  'who is tom turner?',
  "what's the deal with his son?",
  'whose son is mentioned?',
  "someone's sone is mentioned",
  'no the son of something involved with ndp',
  "you're not listening to what i'm saying",
  'corman',
  'yeah it does',
];

const ACKS = {
  frustration: ['You’re right to push back — let me re-read instead of repeating myself.', 'Fair. I keep giving you the same thing; here’s the closest the page actually comes.', 'I hear you — taking the question from the top.'],
  contradiction: ['Let me look again rather than insist.', 'You may be right — re-reading.', 'Checking again instead of repeating myself.'],
  refinement: ['Got it — taking that as the question.', 'Right, with that correction:', 'Re-reading with that in mind.'],
};
const ECHO_OPENERS = [
  'I re-read rather than repeat myself, and I land in the same place — I do think this is what the page holds:',
  'Checked again: the page gives me the same line. As far as this document goes, this is the answer:',
  'Re-read once more and it still comes back to this:',
];

(async () => {
  const doc = await E.parseDocument('ndp.txt', NDP, 'ndp');
  const scope = [doc];
  const messages = [];
  let prevGrounded = false;
  let hot = null;            // stand-in for the conversation field's hottest entity
  let repairCount = 0;

  const repairAnchor = () => {
    const users = messages.filter(m => m.role === 'user');
    const refinements = []; let anchor = null;
    for (let i = users.length - 1; i >= 0; i--) {
      const rep = E.repairSignal(users[i].text);
      if (rep) { if (rep.content) refinements.unshift(users[i].text); continue; }
      anchor = users[i].text; break;
    }
    return { anchor, refinements };
  };

  for (const q of TURNS) {
    const hadReply = messages.some(m => m.role === 'assistant');
    const route = E.routeTurn(scope, q, { prevGrounded, hadReply });
    messages.push({ role: 'user', text: q });
    let out, label;
    if (route.decision === 'repair') {
      const rep = route.repair;
      const { anchor, refinements } = repairAnchor();
      const parts = [anchor, ...refinements.slice(-3)]; if (rep.content) parts.push(q);
      let probe = [...new Set(parts.filter(Boolean))].join(' ').trim();
      const last = messages.filter(m => m.role === 'assistant').slice(-1)[0];
      for (const k of E.kinAsked(probe + ' ' + (last ? last.text : ''))) if (!new RegExp('\\b' + k, 'i').test(probe)) probe += ' ' + k;
      const priors = messages.filter(m => m.role === 'assistant').map(m => m.text);
      const mech = E.answerScope(scope, probe || q, { hotEntity: hot });
      const turnIdx = repairCount++;
      const echoed = E.echoesPriorReply(mech.text, priors);
      if (echoed && !(mech.audit && mech.audit.grounded && (mech.cites || []).length)) {
        const variants = [
          'I’ve re-read the document for this and I keep landing on the same lines, so the page may simply not say it' + (anchor ? ' — what I’m trying to answer is: “' + anchor + '”' : '') + '. If you can give me a name or an exact phrase from the text, I’ll chase that instead.',
          'Still stuck on this one — the re-read brought back nothing new. A name or exact phrase from the text would give me something to chase.',
          'I don’t have anything new on this; I’d rather say so than repeat myself again.',
        ];
        out = variants.find(v => !E.echoesPriorReply(v, priors)) || variants[variants.length - 1];
        label = 'repair-stuck (' + rep.kind + ')';
      } else {
        const ackList = ACKS[rep.kind] || ACKS.refinement;
        const opener = echoed ? ECHO_OPENERS[turnIdx % ECHO_OPENERS.length] : ackList[turnIdx % ackList.length];
        out = opener + '\n\n' + mech.text;
        label = 'repair → mechanical (' + rep.kind + ', probe: "' + probe + '")';
      }
      prevGrounded = true;
    } else if (route.decision === 'mechanical' || route.decision === 'escalate') {
      const mech = E.answerScope(scope, q, { hotEntity: hot });
      const priors = messages.filter(m => m.role === 'assistant').map(m => m.text);
      out = mech.text;
      if (E.echoesPriorReply(out, priors)) {
        const substantive = !!(mech.audit && mech.audit.grounded && (mech.cites || []).length);
        out = (substantive
          ? 'Same answer as before, for this one too:'
          : 'I notice this is the same answer I gave before — if it isn’t what you’re after, point me at a name or phrase from the text and I’ll chase that instead.') + '\n\n' + out;
      }
      label = route.decision + ' (' + route.reason + ')';
      prevGrounded = true;
      const matter = (E.referentsScope(scope, q) || {}).matter || [];
      if (matter.length) hot = matter[0];
    } else {
      out = '(plain chat — the model would reply conversationally)'; label = 'chat (' + route.reason + ')';
      prevGrounded = false;
    }
    messages.push({ role: 'assistant', text: out });
    console.log('USER : ' + q);
    console.log('ROUTE: ' + label);
    console.log('CLEON: ' + out.replace(/\{\{[^}]*\}\}/g, '').replace(/\n+/g, ' ⏎ '));
    console.log('');
  }
})().catch(e => { console.error(e); process.exit(1); });
