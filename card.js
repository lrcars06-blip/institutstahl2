'use strict';
/* GET /api/card?s=<session Stripe>          → la carte en PDF (téléchargement)
   GET /api/card?s=<session Stripe>&json=1   → les données de la carte (page merci.html) */
const { stripe, cardFromSession, buildCardPdf, frDate } = require('./_lib');

module.exports = async (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  const id = String((req.query && req.query.s) || '');
  if (!/^cs_(test|live)_[A-Za-z0-9]+$/.test(id)) { res.statusCode = 400; return res.json({ error: 'Session invalide' }); }

  let session;
  try { session = await stripe().checkout.sessions.retrieve(id); }
  catch { res.statusCode = 404; return res.json({ error: 'Session introuvable' }); }

  if (session.payment_status !== 'paid' || !session.metadata || session.metadata.kind !== 'gift_card') {
    res.statusCode = 402; return res.json({ error: 'Paiement non confirmé' });
  }
  const card = cardFromSession(session);

  if (req.query.json) {
    return res.json({
      amount: card.amount, to: card.to, from: card.from, message: card.message,
      code: card.code, buyerEmail: card.buyerEmail, toEmail: card.toEmail, expires: frDate(card.expires),
    });
  }
  const pdf = await buildCardPdf(card);
  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', `attachment; filename="carte-cadeau-${card.code}.pdf"`);
  res.statusCode = 200;
  return res.end(pdf);
};
