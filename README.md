# Rappel d'aération 🌡️

Mini web app **mobile** qui surveille la **température extérieure** (Open-Meteo)
et t'envoie une **notification Telegram** au bon moment pour ouvrir ou fermer
une pièce et la rafraîchir naturellement.

L'app tourne **en arrière-plan côté serveur** (Cloudflare Worker + Cron toutes
les 15 min) : pas besoin que ton téléphone reste allumé ni qu'une app reste
ouverte. Tu reçois juste les notifications dans Telegram.

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

> Tu as besoin d'un compte Cloudflare (gratuit) et de l'app **Telegram**.

```bash
# 1. Dépendances
npm install

# 2. Connexion à Cloudflare
npx wrangler login

# 3. (déjà fait) Le namespace KV ETAT_METEO existe et son id est déjà
#    renseigné dans wrangler.toml. Rien à faire ici.
#    Pour en recréer un toi-même : npx wrangler kv namespace create ETAT_METEO

# 4. Déploie
npx wrangler deploy

# 5. Ajoute le token de ton bot Telegram (voir « Bot Telegram » ci-dessous)
npx wrangler secret put TELEGRAM_TOKEN
```

Wrangler affiche l'URL publique `https://<nom>.<ton-sous-domaine>.workers.dev`.
Le cron tourne ensuite tout seul côté Cloudflare. URL HTTPS, gratuite, permanente.

## Bot Telegram (gratuit, sans limite de débit)

1. Dans Telegram, ouvre **@BotFather** → `/newbot` → choisis un nom et un
   identifiant. Il te donne un **token** du type `123456789:AAH...`.
2. Ajoute ce token comme **secret** du Worker, nom exact **`TELEGRAM_TOKEN`** :
   - Dashboard Cloudflare → Worker → *Settings → Variables and Secrets → Add →
     Secret*, nom `TELEGRAM_TOKEN`, valeur = le token.
   - ou en CLI : `npx wrangler secret put TELEGRAM_TOKEN`
3. Ouvre **ton bot** dans Telegram et envoie-lui **/start** (indispensable : un
   bot ne peut pas écrire à quelqu'un qui ne l'a pas démarré).

Le token reste un secret côté serveur (jamais renvoyé à la page). La destination
(chat id) est détectée automatiquement par le bouton « Connecter Telegram » de la
page (lecture de `getUpdates`).

## Première utilisation

1. Ouvre l'URL `workers.dev` → la page de réglages s'affiche directement.
2. Vérifie que le statut sous **Telegram** indique « Bot prêt » (sinon, le secret
   `TELEGRAM_TOKEN` n'est pas en place).
3. Clique **« Connecter Telegram »** → le chat est détecté et enregistré.
4. **« Envoyer un test »** → le message arrive dans Telegram.
5. Active **« Recevoir des alertes »**, règle tes seuils, **Enregistre**.
6. (Optionnel) « Ajouter à l'écran d'accueil » depuis le navigateur.

## Piloter le bot par message

Une fois « Connecter Telegram » fait (ce qui arme le webhook), tu peux régler
l'app directement depuis Telegram :

| Message | Effet |
|---------|-------|
| `/etat` | météo et conseil actuels |
| `/seuil 30` | règle le seuil « garder fermé » (°C) |
| `/ideale 25` | règle la température idéale d'ouverture (°C) |
| `/alertes on` / `/alertes off` | active / coupe les alertes |
| `/aide` | liste des commandes |
| 📍 **partage de position** | met à jour le lieu suivi |

**Suivi de position automatique** : une web app ne peut pas suivre le GPS en
arrière-plan. Pour un suivi « auto », partage ta **position en direct** avec le
bot (Telegram : trombone → Position → *Partager ma position en direct*, 15 min
à 8 h) : chaque mise à jour repositionne le lieu suivi. Un partage de position
ponctuel le fixe une fois.

Côté technique : `/api/telegram/connect` lit le chat (getUpdates) puis enregistre
un **webhook** (`setWebhook`) protégé par un jeton secret stocké en KV ; le worker
ne traite que les messages venant du chat propriétaire.

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
destination Telegram) et envoyer un test. C'est acceptable pour un usage perso
avec une URL peu devinable. Le token du bot, lui, reste un secret côté serveur.
Pour ré-ajouter une protection, on peut remettre un secret `MOT_DE_PASSE` et une
vérification `Authorization: Bearer` dans le worker.
