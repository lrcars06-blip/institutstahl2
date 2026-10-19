# Beauté & Technologie Stahl — site vitrine + carte cadeau

Site d'une page (`index.html` + images à la racine) et un système de carte cadeau :
paiement Stripe Checkout, carte PDF générée par une fonction Vercel, envoi par e-mail.

```
index.html        le site (section #cadeau = formulaire carte cadeau)
merci.html        confirmation après paiement : code, aperçu, téléchargement du PDF (ajouter ?demo=1 pour une démo sans payer)
verifier.html     page pour l'institut : vérifie qu'un code est authentique et affiche son montant
api/checkout.js   POST → crée la session Stripe Checkout et renvoie son URL
api/webhook.js    reçoit checkout.session.completed → génère le PDF et envoie les e-mails
api/card.js       GET ?s=<session> → le PDF ; &json=1 → les données pour merci.html
api/verify.js     GET ?code=STAHL-XXXXX-XXXXX → { valid, amount }
api/_lib.js       code signé HMAC, génération PDF (pdf-lib), e-mails (Resend)
api/_fonts, api/_assets   polices (licence OFL) et fond de carte du PDF
```

## Mettre en ligne

1. GitHub : **New repository** → **uploading an existing file** → glisser tout le contenu du dossier (y compris `api/`, `package.json`, `vercel.json`).
2. Vercel : **Add New → Project**, importer le dépôt, laisser les réglages par défaut, **Deploy**. Vercel installe `package.json` et expose les fonctions `api/`.
3. Variables d'environnement (Vercel → Settings → Environment Variables), voir `.env.example` :
   - `STRIPE_SECRET_KEY` : Stripe → Développeurs → Clés API (commencer par `sk_test_…`).
   - `STRIPE_WEBHOOK_SECRET` : Stripe → Développeurs → Webhooks → **Ajouter un endpoint** `https://VOTRE-SITE.vercel.app/api/webhook`, événement `checkout.session.completed` → copier le secret `whsec_…`.
   - `GIFT_SECRET` : une longue chaîne aléatoire. **Ne jamais la changer après la première vente** (les codes déjà émis deviendraient invalides).
   - `RESEND_API_KEY` + `EMAIL_FROM` : compte resend.com avec un domaine vérifié. Sans ces deux variables, aucun e-mail ne part, mais la carte reste téléchargeable sur la page de confirmation.
   - `INSTITUT_EMAIL` : reçoit une copie de chaque vente (montant, code, acheteur, PDF).
4. Redéployer après avoir ajouté les variables.

## Tester

- Mode test Stripe : carte `4242 4242 4242 4242`, date future, CVC quelconque.
- `merci.html?demo=1` montre la page de confirmation avec des données fictives (pratique en démo client).
- `verifier.html` : coller un code reçu par e-mail.
- Passage en production : remplacer `sk_test_` par `sk_live_` et recréer le webhook en mode live.

## Fonctionnement des codes

Le code (`STAHL-XXXXX-XXXXX`) contient le montant et une signature HMAC : `/api/verify` l'authentifie sans base de données.
Il ne sait pas si la carte a déjà été utilisée : l'institut tient un registre (e-mail reçu à chaque vente) et y note les cartes encaissées.
Montants autorisés : 20 à 500 € (`GIFT_MIN`, `GIFT_MAX`), validité 12 mois (`GIFT_VALIDITY_MONTHS`).

## Modifier

- Lien de réservation : constante `PLANITY_URL` en bas de `index.html`.
- Carte des soins : tableau `CARTE` dans le script de `index.html`.
- Mentions imprimées sur le PDF, adresse, téléphone : objet `INSTITUT` dans `api/_lib.js`.

## Crédits images

- Photos de l'institut et de l'équipe : fiche Planity de l'institut (accord de la gérante requis avant mise en ligne).
- Photos d'illustration `soin-visage`, `soin-pinceau`, `fontaine-zellige`, `modelage`, `argile` : Unsplash (licence Unsplash).
- Polices Instrument Serif et Manrope : licence SIL OFL.
