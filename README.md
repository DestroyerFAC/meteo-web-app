# Rappel d'aération 🌡️

Mini web app **mobile** qui surveille la **température extérieure** (Open-Meteo)
et t'envoie une **notification push** (ntfy) au bon moment pour ouvrir ou fermer
une pièce et la rafraîchir naturellement.

L'app tourne **en arrière-plan côté serveur** (Cloudflare Worker + Cron toutes
les 15 min) : pas besoin que ton téléphone reste allumé ni qu'une app reste
ouverte. Tu reçois juste les notifications.

## Comment ça marche

Aérer ne rafraîchit que si l'air extérieur est plus frais que l'intérieur.
On définit deux seuils réglables depuis la page :

| État | Condition | Notification |
|------|-----------|--------------|
| 🔥 **CHAUD** | extérieur ≥ seuil d'alerte (défaut 30 °C) | « Garde fermé » |
| 🌡️ **TIEDE** | entre les deux seuils | « Ça redescend » |
| ✅ **IDEAL** | extérieur ≤ température idéale (défaut 25 °C) | « Ouvre maintenant » |

Une notification est envoyée **uniquement au changement d'état** (pas de spam).

## Fichiers

```
meteo-web-app/
├── worker.ts       # backend : cron + serveur HTTP (page + API, accès libre)
├── index.html      # page de réglages mobile (importée comme texte par le worker)
├── wrangler.toml   # config Cloudflare (cron, KV, règle Text)
├── tsconfig.json   # type-check strict
└── package.json    # dépendances de dev + scripts
```

## Déploiement (à lancer depuis ta machine)

> Tu as besoin d'un compte Cloudflare (gratuit) et de l'app **ntfy** sur ton
> téléphone (App Store / Play Store).

```bash
# 1. Dépendances
npm install

# 2. Connexion à Cloudflare
npx wrangler login

# 3. (déjà fait) Le namespace KV ETAT_METEO existe et son id est déjà
#    renseigné dans wrangler.toml. Rien à faire ici.
#    Pour en recréer un toi-même : npx wrangler kv namespace create ETAT_METEO

# 4. Déploie (l'app est en accès libre, aucun secret à configurer)
npx wrangler deploy
```

Wrangler affiche à la fin l'URL publique
`https://meteo-rappel-aeration.<ton-sous-domaine>.workers.dev`.
Le cron tourne ensuite tout seul côté Cloudflare. URL HTTPS, gratuite, permanente.

## Première utilisation

1. Ouvre l'app **ntfy** sur ton téléphone → abonne-toi à un topic (un nom au
   choix, ex. `aeration-7f3k9z2q` ; choisis-en un peu devinable, c'est ta clé de
   notification).
2. Ouvre l'URL `workers.dev` → la page de réglages s'affiche directement.
3. Active **« Recevoir des alertes »**, colle le même topic ntfy, règle tes
   seuils, **Enregistre**.
4. **« Envoyer un test »** → la notification doit arriver sur ton téléphone.
5. (Optionnel) « Ajouter à l'écran d'accueil » depuis le navigateur pour avoir
   l'app en raccourci.

## Vérifier le build avant de déployer

```bash
npm run typecheck   # doit renvoyer zéro erreur
```

## Debug de la logique sans attendre la vraie météo

`GET /api/etat?temp=27` renvoie l'état calculé pour une température simulée.
Teste 31 / 27 / 23 pour voir les trois états.

## Sécurité : accès libre

L'app est volontairement **sans mot de passe** : l'URL `workers.dev` est publique,
donc quiconque la connaît peut voir et modifier les réglages (seuils, position,
canal ntfy) et envoyer un test. C'est acceptable pour un usage perso avec une URL
peu devinable. Pour ré-ajouter une protection plus tard, on peut remettre un
secret `MOT_DE_PASSE` et une vérification `Authorization: Bearer` dans le worker.
