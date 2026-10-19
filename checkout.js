'use strict';
/* POST /api/checkout — crée une session Stripe Checkout pour une carte cadeau et renvoie son URL. */
const { INSTITUT, clean, isEmail, siteUrl, stripe } = require('./_lib');

module.exports = async (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  if (req.method !== 'POST') { res.statusCode = 405; return res.json({ error: 'Méthode non autorisée' }); }

  let body = req.body;
  if (typeof body === 'string') { try { body = JSON.parse(body); } catch { body = {}; } }
  body = body || {};

  const amount = Math.round(Number(body.amount));
  const to = clean(body.to, 40);
  const from = clean(body.from, 40);
  const message = clean(body.message, 160);
  const buyerEmail = clean(body.buyerEmail, 120).toLowerCase();
  const toEmail = clean(body.toEmail, 120).toLowerCase();

  if (!Number.isFinite(amount) || amount < INSTITUT.minAmount || amount > INSTITUT.maxAmount) {
    res.statusCode = 400; return res.json({ error: `Le montant doit être compris entre ${INSTITUT.minAmount} € et ${INSTITUT.maxAmount} €.` });
  }
  if (!isEmail(buyerEmail)) { res.statusCode = 400; return res.json({ error: 'Indiquez une adresse e-mail valide pour recevoir la carte.' }); }
  if (toEmail && !isEmail(toEmail)) { res.statusCode = 400; return res.json({ error: "L'adresse e-mail du destinataire n'est pas valide." }); }

  const base = siteUrl(req);
  try {
    const session = await stripe().checkout.sessions.create({
      mode: 'payment',
      locale: 'fr',
      customer_email: buyerEmail,
      line_items: [{
        quantity: 1,
        price_data: {
          currency: 'eur',
          unit_amount: amount * 100,
          product_data: {
            name: `Carte cadeau ${INSTITUT.name} — ${amount} €`,
            description: to ? `Pour ${to}` : 'Valable sur toutes les prestations de l\'institut',
          },
        },
      }],
      metadata: { kind: 'gift_card', to, from, message, to_email: toEmail },
      payment_intent_data: { description: `Carte cadeau ${amount} €${to ? ' pour ' + to : ''}` },
      success_url: `${base}/merci.html?s={CHECKOUT_SESSION_ID}`,
      cancel_url: `${base}/#cadeau`,
    });
    return res.json({ url: session.url });
  } catch (e) {
    console.error('checkout', e);
    res.statusCode = 500;
    return res.json({ error: 'Le paiement est momentanément indisponible. Appelez-nous au ' + INSTITUT.phone + '.' });
  }
};
