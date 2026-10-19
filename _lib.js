'use strict';
/*
  Bibliothèque partagée des fonctions Vercel (fichier préfixé "_" : pas exposé comme endpoint).
  - Réglages de l'institut
  - Code cadeau signé (HMAC) : vérifiable sans base de données
  - Génération de la carte PDF (pdf-lib)
  - Envoi des e-mails (Resend)
*/
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { PDFDocument, rgb } = require('pdf-lib');
const fontkit = require('@pdf-lib/fontkit');

const INSTITUT = {
  name: 'Beauté & Technologie Stahl',
  shortName: 'Stahl',
  address: '2 rue Jules Méline, 51430 Bezannes',
  phone: '03 51 42 28 21',
  phoneHref: '+33351422821',
  email: process.env.INSTITUT_EMAIL || '',
  minAmount: Number(process.env.GIFT_MIN || 20),
  maxAmount: Number(process.env.GIFT_MAX || 500),
  validityMonths: Number(process.env.GIFT_VALIDITY_MONTHS || 12),
  prefix: 'STAHL',
};

/* ---------- utilitaires ---------- */
function clean(s, max) {
  return String(s == null ? '' : s).replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max);
}
function isEmail(s) { return /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(s); }
function euros(n) { return new Intl.NumberFormat('fr-FR', { style: 'currency', currency: 'EUR', maximumFractionDigits: 0 }).format(n); }
function frDate(d) { return new Intl.DateTimeFormat('fr-FR', { day: 'numeric', month: 'long', year: 'numeric' }).format(d); }
function addMonths(d, m) { const x = new Date(d); x.setMonth(x.getMonth() + m); return x; }
function siteUrl(req) {
  if (process.env.SITE_URL) return process.env.SITE_URL.replace(/\/$/, '');
  const proto = req.headers['x-forwarded-proto'] || 'https';
  return `${proto}://${req.headers['x-forwarded-host'] || req.headers.host}`;
}
function secret() {
  const s = process.env.GIFT_SECRET || process.env.STRIPE_SECRET_KEY;
  if (!s) throw new Error('GIFT_SECRET manquant');
  return crypto.createHash('sha256').update('stahl-gift:' + s).digest();
}

/* ---------- code cadeau signé ----------
   Format : STAHL-XXXXX-XXXXX (alphabet Crockford, sans I, L, O, U).
   Contenu : montant (16 bits) + empreinte de la session Stripe (16 bits) + signature HMAC (16 bits).
   Le même paiement donne toujours le même code ; un code forgé est rejeté par /api/verify. */
const ALPHA = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
function b32encode(big, chars) { let s = ''; for (let i = 0; i < chars; i++) { s = ALPHA[Number(big & 31n)] + s; big >>= 5n; } return s; }
function b32decode(str) { let big = 0n; for (const c of str) { const v = ALPHA.indexOf(c); if (v < 0) return null; big = (big << 5n) | BigInt(v); } return big; }
function mac16(payload) { return crypto.createHmac('sha256', secret()).update(payload).digest().readUInt16BE(0); }
function mask48() { const d = crypto.createHmac('sha256', secret()).update('mask').digest(); return BigInt(d.readUInt32BE(0)) << 16n | BigInt(d.readUInt16BE(4)); }

function makeCode(amountEur, sessionId) {
  const amount = Math.round(amountEur);
  const rnd = crypto.createHmac('sha256', secret()).update('session:' + sessionId).digest().readUInt16BE(0);
  const payload = Buffer.alloc(4); payload.writeUInt16BE(amount, 0); payload.writeUInt16BE(rnd, 2);
  const bits = ((BigInt(payload.readUInt32BE(0)) << 16n) | BigInt(mac16(payload))) ^ mask48();
  const s = b32encode(bits, 10);
  return `${INSTITUT.prefix}-${s.slice(0, 5)}-${s.slice(5)}`;
}
function normalizeCode(input) {
  return clean(input, 40).toUpperCase().replace(/[^0-9A-Z]/g, '').replace(/^STAHL/, '').replace(/I/g, '1').replace(/L/g, '1').replace(/O/g, '0');
}
function verifyCode(input) {
  const s = normalizeCode(input);
  if (s.length !== 10) return { valid: false };
  let bits = b32decode(s);
  if (bits === null || bits >= (1n << 48n)) return { valid: false };
  bits ^= mask48();
  const payload = Buffer.alloc(4); payload.writeUInt32BE(Number(bits >> 16n), 0);
  const sig = Number(bits & 0xffffn);
  if (sig !== mac16(payload)) return { valid: false };
  return { valid: true, amount: payload.readUInt16BE(0), code: `${INSTITUT.prefix}-${s.slice(0, 5)}-${s.slice(5)}` };
}

/* ---------- données de carte à partir d'une session Stripe ---------- */
function cardFromSession(session) {
  const m = session.metadata || {};
  const amount = Math.round((session.amount_total || 0) / 100);
  const created = new Date((session.created || Date.now() / 1000) * 1000);
  return {
    amount,
    to: clean(m.to, 40),
    from: clean(m.from, 40),
    message: clean(m.message, 160),
    toEmail: clean(m.to_email, 120),
    buyerEmail: clean((session.customer_details && session.customer_details.email) || session.customer_email, 120),
    code: makeCode(amount, session.id),
    issued: created,
    expires: addMonths(created, INSTITUT.validityMonths),
  };
}

/* ---------- PDF ---------- */
const FONT_DIR = path.join(__dirname, '_fonts');
const BG = path.join(__dirname, '_assets', 'card-bg.jpg');
const COLORS = {
  ivory: rgb(0.953, 0.929, 0.894), ivory2: rgb(0.914, 0.878, 0.827), sand: rgb(0.812, 0.753, 0.675),
  bronze: rgb(0.725, 0.561, 0.369), glow: rgb(0.922, 0.753, 0.588), muted: rgb(0.6, 0.55, 0.5),
};
function spaced(page, text, x, y, font, size, color, tracking) {
  let cx = x;
  for (const ch of text) { page.drawText(ch, { x: cx, y, size, font, color }); cx += font.widthOfTextAtSize(ch, size) + tracking; }
  return cx - x - tracking;
}
function wrap(text, font, size, maxW) {
  const lines = []; let line = '';
  for (const w of text.split(' ')) {
    const t = line ? line + ' ' + w : w;
    if (font.widthOfTextAtSize(t, size) <= maxW) line = t; else { if (line) lines.push(line); line = w; }
  }
  if (line) lines.push(line);
  return lines;
}
function fitSize(text, font, size, maxW, min) { while (size > min && font.widthOfTextAtSize(text, size) > maxW) size -= 1; return size; }

async function buildCardPdf(card) {
  const pdf = await PDFDocument.create();
  pdf.registerFontkit(fontkit);
  pdf.setTitle(`Carte cadeau ${INSTITUT.name} — ${euros(card.amount)}`);
  pdf.setAuthor(INSTITUT.name);
  const serif = await pdf.embedFont(fs.readFileSync(path.join(FONT_DIR, 'InstrumentSerif-Regular.ttf')));
  const serifIt = await pdf.embedFont(fs.readFileSync(path.join(FONT_DIR, 'InstrumentSerif-Italic.ttf')));
  const sans = await pdf.embedFont(fs.readFileSync(path.join(FONT_DIR, 'Manrope-Regular.ttf')));
  const sansMd = await pdf.embedFont(fs.readFileSync(path.join(FONT_DIR, 'Manrope-Medium.ttf')));
  const sansSb = await pdf.embedFont(fs.readFileSync(path.join(FONT_DIR, 'Manrope-SemiBold.ttf')));
  const bg = await pdf.embedJpg(fs.readFileSync(BG));

  // A5 paysage
  const W = 595.28, H = 419.53, P = 34;
  const page = pdf.addPage([W, H]);
  page.drawImage(bg, { x: 0, y: 0, width: W, height: H });
  // cadre bronze fin
  page.drawRectangle({ x: P * 0.55, y: P * 0.55, width: W - P * 1.1, height: H - P * 1.1, borderColor: COLORS.bronze, borderWidth: 0.6, borderOpacity: 0.7 });

  // en-tête : "CARTE CADEAU" à gauche, nom de la maison à droite
  spaced(page, 'CARTE CADEAU', P, H - P - 8, sansSb, 7.5, COLORS.bronze, 2.6);
  const brand = 'Beauté & Technologie';
  const bw = serif.widthOfTextAtSize(brand, 15);
  page.drawText(brand, { x: W - P - bw, y: H - P - 6, size: 15, font: serif, color: COLORS.ivory });
  const sw = serifIt.widthOfTextAtSize(INSTITUT.shortName, 15);
  page.drawText(INSTITUT.shortName, { x: W - P - sw, y: H - P - 24, size: 15, font: serifIt, color: COLORS.glow });

  // montant
  const amountText = `${card.amount} €`;
  page.drawText(amountText, { x: P - 2, y: H - 160, size: 92, font: serif, color: COLORS.ivory });

  // pour / de la part de
  let y = H - 198;
  {
    const t = card.to ? `Pour ${card.to}` : 'Un moment rien que pour vous';
    const sz = fitSize(t, serifIt, 26, W - 2 * P - 150, 16);
    page.drawText(t, { x: P, y, size: sz, font: serifIt, color: COLORS.glow });
    y -= 26;
  }
  if (card.from) {
    spaced(page, `DE LA PART DE ${card.from.toUpperCase()}`, P, y, sansMd, 7.5, COLORS.sand, 1.8);
    y -= 22;
  }
  // message
  if (card.message) {
    const lines = wrap(`« ${card.message} »`, serifIt, 12.5, 330).slice(0, 4);
    for (const l of lines) { page.drawText(l, { x: P, y, size: 12.5, font: serifIt, color: COLORS.ivory2 }); y -= 16; }
  }

  // bloc code (bas gauche)
  const yCode = P + 46;
  spaced(page, 'CODE', P, yCode + 22, sansSb, 6.5, COLORS.bronze, 2.2);
  spaced(page, card.code, P, yCode, sansSb, 15, COLORS.ivory, 2.2);
  page.drawLine({ start: { x: P, y: yCode - 9 }, end: { x: P + 220, y: yCode - 9 }, thickness: 0.5, color: COLORS.bronze, opacity: 0.6 });
  page.drawText(`Valable jusqu'au ${frDate(card.expires)}`, { x: P, y: yCode - 22, size: 7.5, font: sans, color: COLORS.sand });

  // bloc institut (bas droite)
  const right = (text, yy, font, size, color) => { const w = font.widthOfTextAtSize(text, size); page.drawText(text, { x: W - P - w, y: yy, size, font, color }); };
  right(INSTITUT.address, yCode + 22, sans, 7.5, COLORS.ivory2);
  right(INSTITUT.phone, yCode + 10, sansMd, 7.5, COLORS.ivory2);
  right('Réservation 24h/24 sur Planity', yCode - 2, sans, 7.5, COLORS.sand);
  right('Valable sur toutes les prestations, sur présentation de ce code.', yCode - 16, sans, 6.3, COLORS.muted);
  right('Non remboursable, non échangeable contre des espèces.', yCode - 26, sans, 6.3, COLORS.muted);

  return Buffer.from(await pdf.save());
}

/* ---------- e-mails ---------- */
async function sendEmails(card, pdfBuffer) {
  const key = process.env.RESEND_API_KEY;
  if (!key) return { sent: false, reason: 'RESEND_API_KEY manquant' };
  const { Resend } = require('resend');
  const resend = new Resend(key);
  const from = process.env.EMAIL_FROM || 'Beauté & Technologie Stahl <onboarding@resend.dev>';
  const file = { filename: `carte-cadeau-${card.code}.pdf`, content: pdfBuffer };
  const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const html = (title, intro) => `
  <div style="margin:0;padding:32px 16px;background:#F3EDE4;font-family:Helvetica,Arial,sans-serif;color:#0E0C0B">
    <div style="max-width:560px;margin:0 auto;background:#0E0C0B;color:#F3EDE4;border-radius:10px;padding:36px 32px">
      <p style="margin:0 0 6px;font-size:11px;letter-spacing:3px;text-transform:uppercase;color:#B98F5E">Carte cadeau</p>
      <p style="margin:0 0 18px;font-family:Georgia,serif;font-size:26px;line-height:1.1">${esc(title)}</p>
      <p style="margin:0 0 22px;font-size:15px;line-height:1.6;color:#E9E0D3">${intro}</p>
      <div style="border:1px solid rgba(243,237,228,.2);border-radius:8px;padding:20px 22px;margin-bottom:22px">
        <p style="margin:0;font-family:Georgia,serif;font-size:44px;line-height:1;color:#F3EDE4">${card.amount}&nbsp;€</p>
        ${card.to ? `<p style="margin:10px 0 0;font-family:Georgia,serif;font-style:italic;font-size:18px;color:#EBC096">Pour ${esc(card.to)}</p>` : ''}
        ${card.from ? `<p style="margin:4px 0 0;font-size:12px;letter-spacing:2px;text-transform:uppercase;color:#CFC0AC">De la part de ${esc(card.from)}</p>` : ''}
        ${card.message ? `<p style="margin:14px 0 0;font-family:Georgia,serif;font-style:italic;font-size:15px;color:#E9E0D3">« ${esc(card.message)} »</p>` : ''}
        <p style="margin:18px 0 0;font-size:11px;letter-spacing:2px;text-transform:uppercase;color:#B98F5E">Code</p>
        <p style="margin:4px 0 0;font-size:18px;letter-spacing:3px;font-weight:bold">${card.code}</p>
        <p style="margin:10px 0 0;font-size:12px;color:#CFC0AC">Valable jusqu'au ${frDate(card.expires)}, sur toutes les prestations.</p>
      </div>
      <p style="margin:0 0 6px;font-size:13px;color:#CFC0AC">La carte est jointe en PDF, prête à imprimer ou à transférer.</p>
      <p style="margin:0;font-size:13px;color:#CFC0AC">${esc(INSTITUT.name)} · ${esc(INSTITUT.address)} · ${esc(INSTITUT.phone)}</p>
    </div>
  </div>`;

  const results = {};
  if (card.buyerEmail) {
    results.buyer = await resend.emails.send({
      from, to: card.buyerEmail,
      subject: `Votre carte cadeau ${INSTITUT.name} — ${euros(card.amount)}`,
      html: html('Merci pour votre commande.', `Votre carte cadeau de <b>${card.amount} €</b> est prête. Vous la trouverez en pièce jointe${card.toEmail ? `, et ${esc(card.to || 'votre destinataire')} vient de la recevoir par e-mail` : ''}.`),
      attachments: [file],
    });
  }
  if (card.toEmail && card.toEmail !== card.buyerEmail) {
    results.recipient = await resend.emails.send({
      from, to: card.toEmail,
      subject: `${card.from ? card.from + ' vous offre' : 'On vous offre'} une carte cadeau ${INSTITUT.name}`,
      html: html(card.to ? `${card.to}, on pense à vous.` : 'On pense à vous.', `${card.from ? esc(card.from) : 'Quelqu\'un'} vous offre une carte cadeau de <b>${card.amount} €</b> à ${esc(INSTITUT.name)}, à Bezannes. Présentez le code ci-dessous lors de votre rendez-vous.`),
      attachments: [file],
    });
  }
  if (INSTITUT.email) {
    results.institut = await resend.emails.send({
      from, to: INSTITUT.email,
      subject: `Carte cadeau vendue — ${euros(card.amount)} — ${card.code}`,
      html: `<p>Nouvelle carte cadeau payée en ligne.</p>
        <table style="font-family:Helvetica,Arial,sans-serif;font-size:14px;border-collapse:collapse">
          <tr><td style="padding:4px 12px 4px 0;color:#777">Montant</td><td><b>${card.amount} €</b></td></tr>
          <tr><td style="padding:4px 12px 4px 0;color:#777">Code</td><td><b>${card.code}</b></td></tr>
          <tr><td style="padding:4px 12px 4px 0;color:#777">Acheteur</td><td>${esc(card.buyerEmail || '—')}</td></tr>
          <tr><td style="padding:4px 12px 4px 0;color:#777">Destinataire</td><td>${esc(card.to || '—')}${card.toEmail ? ' (' + esc(card.toEmail) + ')' : ''}</td></tr>
          <tr><td style="padding:4px 12px 4px 0;color:#777">De la part de</td><td>${esc(card.from || '—')}</td></tr>
          <tr><td style="padding:4px 12px 4px 0;color:#777">Valable jusqu'au</td><td>${frDate(card.expires)}</td></tr>
        </table>
        <p style="color:#777;font-size:13px">À reporter dans le registre des cartes cadeaux. La vérification d'un code se fait sur la page /verifier.html du site.</p>`,
      attachments: [file],
    });
  }
  return { sent: true, results };
}

function stripe() {
  if (!process.env.STRIPE_SECRET_KEY) throw new Error('STRIPE_SECRET_KEY manquant');
  return require('stripe')(process.env.STRIPE_SECRET_KEY);
}
async function readRawBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = []; req.on('data', (c) => chunks.push(c)); req.on('end', () => resolve(Buffer.concat(chunks))); req.on('error', reject);
  });
}

module.exports = { INSTITUT, clean, isEmail, euros, frDate, siteUrl, makeCode, verifyCode, cardFromSession, buildCardPdf, sendEmails, stripe, readRawBody };
