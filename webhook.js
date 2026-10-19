'use strict';
/* POST /api/webhook — reçoit l'événement Stripe "checkout.session.completed",
   génère la carte PDF et envoie les e-mails (acheteur, destinataire, institut). */
const { stripe, readRawBody, cardFromSession, buildCardPdf, sendEmails } = require('./_lib');

module.exports = async (req, res) => {
  if (req.method !== 'POST') { res.statusCode = 405; return res.end('Méthode non autorisée'); }
  const secret = process.env.STRIPE_WEBHOOK_SECRET;
  if (!secret) { res.statusCode = 500; return res.end('STRIPE_WEBHOOK_SECRET manquant'); }

  let event;
  try {
    const raw = await readRawBody(req);
    event = stripe().webhooks.constructEvent(raw, req.headers['stripe-signature'], secret);
  } catch (e) {
    res.statusCode = 400; return res.end(`Signature invalide : ${e.message}`);
  }

  if (event.type === 'checkout.session.completed') {
    const session = event.data.object;
    if (session.payment_status === 'paid' && session.metadata && session.metadata.kind === 'gift_card') {
      try {
        const card = cardFromSession(session);
        const pdf = await buildCardPdf(card);
        const mail = await sendEmails(card, pdf);
        console.log('carte cadeau', card.code, card.amount, mail.sent ? 'e-mails envoyés' : mail.reason);
      } catch (e) {
        console.error('webhook', e);
        res.statusCode = 500; return res.end('Erreur de génération');
      }
    }
  }
  res.statusCode = 200; res.end('ok');
};

// Corps brut obligatoire pour vérifier la signature Stripe (déclaré après l'export de la fonction).
module.exports.config = { api: { bodyParser: false } };
