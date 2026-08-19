# clubmed-offers — alimentation automatique du fichier d'offres

Le fichier source arrive tous les jours par mail, en `.zip`. Ce worker le reçoit,
l'extrait et le publie ; `cmoffers.netlify.app` le lit directement. Plus rien à
télécharger ni à committer à la main.

```
Boîte pro ──règle de transfert──▶ offers@kwitlyapp.com
                                        │  Cloudflare Email Routing
                                        ▼
                               worker clubmed-offers
                               · contrôle l'expéditeur
                               · extrait la pièce jointe .zip
                               · dézippe le classeur
                               · écrit dans R2 (+ archive datée)
                                        │
                                        ▼
        index.html ──fetch──▶ clubmed-offers.mtoledano10.workers.dev/OFFERS.xlsx
```

## Endpoints

| URL | Rôle |
|---|---|
| `/` ou `/OFFERS.xlsx` | le classeur du jour (CORS ouvert, `x-updated-at` = date de réception) |
| `/status` | JSON : date de réception, taille, nom du fichier dans le zip, sujet du mail |
| `/archive` | liste des copies datées (14 jours glissants) |
| `/archive/AAAA-MM-JJ.xlsx` | revenir à un fichier d'un jour précédent |

## Mise en service (3 étapes manuelles)

1. **Route email** — dashboard Cloudflare → kwitlyapp.com → Email Routing →
   Routes → *Create address* : `offers@kwitlyapp.com`, action **Send to a Worker**
   → `clubmed-offers`.
2. **Allowlist expéditeur** — mettre l'adresse exacte de l'expéditeur du mail
   quotidien dans `ALLOWED_SENDERS` (wrangler.toml), puis redéployer. Tant que
   c'est vide, n'importe qui connaissant l'adresse peut pousser un fichier.
3. **Règle Outlook** — transférer le mail quotidien vers `offers@kwitlyapp.com`.
   Une règle *Transférer* comme *Rediriger* fonctionne : le worker sait lire une
   pièce jointe imbriquée dans un `message/rfc822`.

## Garde-fous

Le worker refuse le message (avec un motif visible dans les logs Cloudflare)
plutôt que d'écraser les données de la veille si : expéditeur non autorisé,
aucune pièce jointe `.zip`, archive illisible, classeur non-Excel ou < 1 Ko.

## Tests

```bash
node worker/scripts/test-parse.mjs          # MIME + zip sur le vrai fichier, sous Node
node worker/scripts/make-test-mail.mjs out.eml [small]   # fabrique un mail de test
```

Pour rejouer un mail dans le runtime réel (miniflare plafonne le corps à 1 MiB,
d'où l'option `small`) :

```bash
wrangler dev --port 8799
curl -X POST "http://localhost:8799/cdn-cgi/handler/email?from=x@y.com&to=offers@kwitlyapp.com" \
     --data-binary @out.eml
```

## Vérifié / pas vérifié

- Vérifié : extraction d'un mail de 10,7 Mo dans workerd, classeur ressorti
  identique au SHA-256 près, en 1,8 s ; cas du mail transféré (pièce jointe
  imbriquée) ; refus des expéditeurs hors allowlist.
- Pas vérifié : la livraison réelle par Cloudflare Email Routing, qui ne peut
  l'être qu'au premier vrai mail. Si le plan Workers du compte est le plan
  gratuit (10 ms de CPU par requête), l'extraction dépassera le quota : il faut
  le plan payant, ou déplacer le dézippage dans le navigateur.
