/**
 * Cloudflare Worker — Rappel d'aération + panneau de réglages
 * ------------------------------------------------------------------
 * - Cron : interroge Open-Meteo et notifie (Telegram) sur changement d'état.
 * - HTTP : sert la page de réglages et une petite API JSON (accès libre).
 *   Les réglages sont stockés dans KV, donc modifiables depuis le téléphone
 *   sans redéploiement.
 *
 * Notifications via un bot Telegram personnel :
 *   - le token du bot est un secret du Worker (TELEGRAM_TOKEN) ;
 *   - la destination (chat id) est détectée via le bouton « Connecter Telegram »
 *     (lecture de getUpdates après que l'utilisateur a envoyé /start au bot).
 *
 * "Température idéale pour ouvrir" : aérer ne rafraîchit que si l'air
 * extérieur est plus frais que l'intérieur. Faute de capteur intérieur,
 * `tempIdealeOuverture` sert de confort visé :
 *   extérieur >= seuilAlerte             -> CHAUD : garder fermé
 *   tempIdeale < extérieur < seuilAlerte -> TIEDE : ça redescend
 *   extérieur <= tempIdeale              -> IDEAL : ouvrir
 * ------------------------------------------------------------------
 */

// HTML servi comme module texte (voir [[rules]] type="Text" dans wrangler.toml).
// @ts-ignore
import PAGE_HTML from "./index.html";

// ─────────────────────────── Types ───────────────────────────

interface Env {
  ETAT_METEO: KVNamespace;   // KV : config + dernier état (binding obligatoire)
  TELEGRAM_TOKEN?: string;   // secret : token du bot Telegram (créé via @BotFather)
}

/** Réglages persistés dans KV. */
interface ConfigStockee {
  latitude: number;
  longitude: number;
  seuilAlerte: number;
  tempIdealeOuverture: number;
  telegramChatId: string;    // destination des notifications (id de chat Telegram)
  notificationsActives: boolean;
}

/** Config d'exécution = réglages + token Telegram (non éditable, vient du secret). */
type Config = ConfigStockee & { telegramToken?: string };

type Etat = "CHAUD" | "TIEDE" | "IDEAL";

interface Notification {
  titre: string;
  corps: string;
}

interface OpenMeteoReponse {
  current?: { temperature_2m?: number; apparent_temperature?: number };
}

interface TelegramUpdates {
  ok?: boolean;
  result?: Array<{ message?: { chat?: { id?: number; first_name?: string; title?: string } } }>;
}

// Champs Telegram utilisés par le webhook (sous-ensemble volontairement minimal).
interface TgLocation { latitude?: number; longitude?: number }
interface TgMessage { chat?: { id?: number }; text?: string; location?: TgLocation }
interface TgUpdate { message?: TgMessage; edited_message?: TgMessage }

// ─────────────────────────── Constantes ───────────────────────────

const CLE_CONFIG = "config";
const CLE_ETAT = "dernier_etat";
const CLE_WEBHOOK_SECRET = "webhook_secret"; // jeton partagé avec Telegram pour valider les appels du webhook
const CHAT_ID_REGEX = /^-?\d{1,20}$/; // id de chat Telegram : entier (négatif possible pour les groupes)

const CONFIG_DEFAUT: ConfigStockee = {
  latitude: 45.36,            // position par défaut (modifiable dans la page)
  longitude: 0.92,
  seuilAlerte: 30,
  tempIdealeOuverture: 25,
  telegramChatId: "",
  notificationsActives: false,
};

// ─────────────────── Fonctions pures (testables) ───────────────────

function determinerEtat(temp: number, c: Config): Etat {
  if (temp >= c.seuilAlerte) return "CHAUD";
  if (temp <= c.tempIdealeOuverture) return "IDEAL";
  return "TIEDE";
}

function construireMessage(temp: number, ressenti: number, etat: Etat, c: Config): Notification {
  const t = temp.toFixed(1);
  const r = ressenti.toFixed(1);
  switch (etat) {
    case "IDEAL":
      return {
        titre: "✅ Ouvre maintenant",
        corps: `${t}°C dehors (ressenti ${r}°C). Sous les ${c.tempIdealeOuverture}°C visés : ouvre fenêtres et volets pour rafraîchir la pièce.`,
      };
    case "TIEDE":
      return {
        titre: "🌡️ Ça redescend",
        corps: `${t}°C dehors (ressenti ${r}°C). Sous ${c.seuilAlerte}°C, mais pas encore les ${c.tempIdealeOuverture}°C idéaux pour ouvrir. Patiente encore un peu.`,
      };
    case "CHAUD":
      return {
        titre: "🔥 Garde fermé",
        corps: `${t}°C dehors (ressenti ${r}°C). Au-dessus de ${c.seuilAlerte}°C : volets baissés, fenêtres fermées.`,
      };
  }
}

// ─────────────────────── Config (KV) ───────────────────────

function estNombreFini(v: unknown): v is number {
  return typeof v === "number" && Number.isFinite(v);
}

/** Valide un objet de réglages reçu de l'API. Bornes serveur + format chat id. */
function validerConfig(brut: unknown): { ok: true; valeur: ConfigStockee } | { ok: false; erreur: string } {
  if (typeof brut !== "object" || brut === null) return { ok: false, erreur: "Corps JSON attendu." };
  const b = brut as Record<string, unknown>;

  if (!estNombreFini(b.latitude) || b.latitude < -90 || b.latitude > 90)
    return { ok: false, erreur: "Latitude invalide (-90 à 90)." };
  if (!estNombreFini(b.longitude) || b.longitude < -180 || b.longitude > 180)
    return { ok: false, erreur: "Longitude invalide (-180 à 180)." };
  if (!estNombreFini(b.seuilAlerte) || b.seuilAlerte < -20 || b.seuilAlerte > 60)
    return { ok: false, erreur: "Seuil d'alerte invalide (-20 à 60 °C)." };
  if (!estNombreFini(b.tempIdealeOuverture) || b.tempIdealeOuverture < -20 || b.tempIdealeOuverture > 60)
    return { ok: false, erreur: "Température idéale invalide (-20 à 60 °C)." };
  if (b.tempIdealeOuverture >= b.seuilAlerte)
    return { ok: false, erreur: "La température idéale d'ouverture doit être inférieure au seuil d'alerte." };
  if (typeof b.notificationsActives !== "boolean")
    return { ok: false, erreur: "Le réglage des notifications est invalide." };
  if (typeof b.telegramChatId !== "string")
    return { ok: false, erreur: "Destination Telegram invalide." };

  const chatId = b.telegramChatId.trim();
  if (b.notificationsActives && chatId.length === 0)
    return { ok: false, erreur: "Connecte Telegram pour activer les notifications." };
  if (chatId.length > 0 && !CHAT_ID_REGEX.test(chatId))
    return { ok: false, erreur: "Destination Telegram invalide (id de chat numérique attendu)." };

  return {
    ok: true,
    valeur: {
      latitude: b.latitude,
      longitude: b.longitude,
      seuilAlerte: b.seuilAlerte,
      tempIdealeOuverture: b.tempIdealeOuverture,
      telegramChatId: chatId,
      notificationsActives: b.notificationsActives,
    },
  };
}

async function lireConfig(env: Env): Promise<Config> {
  let stockee: ConfigStockee = { ...CONFIG_DEFAUT };
  const brut = await env.ETAT_METEO.get(CLE_CONFIG);
  if (brut) {
    try {
      const v = validerConfig(JSON.parse(brut));
      if (v.ok) stockee = v.valeur;
      else console.warn("Config KV invalide, retour aux défauts :", v.erreur);
    } catch {
      console.warn("Config KV illisible, retour aux défauts.");
    }
  }
  return { ...stockee, telegramToken: env.TELEGRAM_TOKEN };
}

async function ecrireConfig(env: Env, valeur: ConfigStockee): Promise<void> {
  await env.ETAT_METEO.put(CLE_CONFIG, JSON.stringify(valeur));
}

// ─────────────────────── I/O externes ───────────────────────

async function recupererMeteo(c: Config): Promise<{ temp: number; ressenti: number }> {
  const url = new URL("https://api.open-meteo.com/v1/forecast");
  url.searchParams.set("latitude", String(c.latitude));
  url.searchParams.set("longitude", String(c.longitude));
  url.searchParams.set("current", "temperature_2m,apparent_temperature");
  url.searchParams.set("timezone", "Europe/Paris");

  const reponse = await fetch(url.toString());
  if (!reponse.ok) throw new Error(`Open-Meteo a répondu ${reponse.status}.`);

  const data = (await reponse.json()) as OpenMeteoReponse;
  const temp = data.current?.temperature_2m;
  if (typeof temp !== "number" || Number.isNaN(temp))
    throw new Error("Température absente de la réponse Open-Meteo.");
  const ressenti = data.current?.apparent_temperature ?? temp;
  return { temp, ressenti };
}

async function telegramEnvoyer(token: string, chatId: string, texte: string): Promise<void> {
  const reponse = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ chat_id: chatId, text: texte }),
  });
  if (!reponse.ok) {
    const detail = await reponse.text().catch(() => "");
    throw new Error(`Telegram a répondu ${reponse.status} ${detail}`.trim());
  }
}

async function envoyerNotification(n: Notification, c: Config): Promise<void> {
  if (!c.telegramToken) throw new Error("Bot Telegram non configuré (secret TELEGRAM_TOKEN manquant).");
  if (!c.telegramChatId) throw new Error("Aucune destination Telegram (clique « Connecter Telegram »).");
  await telegramEnvoyer(c.telegramToken, c.telegramChatId, `${n.titre}\n${n.corps}`);
}

/** Lit getUpdates et renvoie le chat le plus récent ayant écrit au bot. */
async function detecterChatTelegram(c: Config): Promise<{ chatId: string; nom: string } | null> {
  if (!c.telegramToken) throw new Error("Bot Telegram non configuré (secret TELEGRAM_TOKEN manquant).");
  const reponse = await fetch(`https://api.telegram.org/bot${c.telegramToken}/getUpdates`);
  if (!reponse.ok) {
    const detail = await reponse.text().catch(() => "");
    throw new Error(`Telegram a répondu ${reponse.status} ${detail}`.trim());
  }
  const data = (await reponse.json()) as TelegramUpdates;
  const updates = data.result ?? [];
  for (let i = updates.length - 1; i >= 0; i--) {
    const chat = updates[i]?.message?.chat;
    if (chat && typeof chat.id === "number") {
      return { chatId: String(chat.id), nom: chat.first_name ?? chat.title ?? "" };
    }
  }
  return null;
}

// ─────────────────────── Bot Telegram : webhook & commandes ───────────────────────

/** Enregistre le webhook auprès de Telegram (commandes en temps réel). */
async function configurerWebhook(env: Env, token: string, origin: string): Promise<void> {
  let secret = await env.ETAT_METEO.get(CLE_WEBHOOK_SECRET);
  if (!secret) {
    secret = crypto.randomUUID().replace(/-/g, ""); // hex -> caractères autorisés par Telegram
    await env.ETAT_METEO.put(CLE_WEBHOOK_SECRET, secret);
  }
  const reponse = await fetch(`https://api.telegram.org/bot${token}/setWebhook`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      url: `${origin}/api/telegram/webhook`,
      secret_token: secret,
      allowed_updates: ["message", "edited_message"],
    }),
  });
  if (!reponse.ok) {
    const detail = await reponse.text().catch(() => "");
    throw new Error(`setWebhook a échoué : ${reponse.status} ${detail}`.trim());
  }
}

function aideTexte(c: Config): string {
  return [
    "🌡️ Aération — commandes :",
    "/etat — météo et conseil actuels",
    "/seuil 30 — régler le seuil « garder fermé » (°C)",
    "/ideale 25 — régler la température idéale d'ouverture (°C)",
    "/alertes on  ·  /alertes off — activer / couper les alertes",
    "📍 Envoie ta position (ou une position en direct) pour mettre à jour le lieu suivi.",
    "",
    `Réglages actuels : ouvrir ≤ ${c.tempIdealeOuverture}°C, fermer ≥ ${c.seuilAlerte}°C, alertes ${c.notificationsActives ? "ON" : "OFF"}.`,
  ].join("\n");
}

/** Applique une modification de réglages venant du bot, valide et confirme (ou explique l'erreur). */
async function appliquerModif(
  env: Env,
  token: string,
  chatId: string,
  stockee: ConfigStockee,
  modif: Partial<ConfigStockee>,
  confirmation: string,
): Promise<void> {
  const v = validerConfig({ ...stockee, ...modif });
  if (!v.ok) { await telegramEnvoyer(token, chatId, "⚠ " + v.erreur); return; }
  await ecrireConfig(env, v.valeur);
  await telegramEnvoyer(token, chatId, confirmation);
}

/** Traite un message reçu du propriétaire (commande texte ou partage de position). */
async function traiterMessage(env: Env, config: Config, msg: TgMessage): Promise<void> {
  const token = config.telegramToken;
  if (!token || typeof msg.chat?.id !== "number") return;
  const chatId = String(msg.chat.id);
  const { telegramToken, ...stockee } = config; // réglages persistables actuels

  // 1) Partage de position (ponctuel ou « position en direct » via edited_message).
  if (msg.location && estNombreFini(msg.location.latitude) && estNombreFini(msg.location.longitude)) {
    const lat = Math.round(msg.location.latitude * 1e4) / 1e4;
    const lon = Math.round(msg.location.longitude * 1e4) / 1e4;
    await appliquerModif(env, token, chatId, stockee, { latitude: lat, longitude: lon },
      `📍 Position mise à jour : ${lat.toFixed(3)}, ${lon.toFixed(3)}.`);
    return;
  }

  // 2) Commande texte.
  const texte = (msg.text ?? "").trim();
  if (!texte) return;
  const morceaux = texte.split(/\s+/);
  let cmd = morceaux[0].toLowerCase();
  if (cmd.startsWith("/")) cmd = cmd.slice(1);
  const arobase = cmd.indexOf("@"); // ex. /seuil@MonBot dans un groupe
  if (arobase >= 0) cmd = cmd.slice(0, arobase);
  const arg = morceaux.slice(1).join(" ").replace(",", ".").trim();

  if (cmd === "seuil" || cmd === "ideale" || cmd === "ideal") {
    const n = Number(arg);
    if (arg === "" || !Number.isFinite(n)) {
      await telegramEnvoyer(token, chatId, `Indique une valeur, ex. /${cmd === "seuil" ? "seuil 30" : "ideale 25"}`);
      return;
    }
    if (cmd === "seuil")
      await appliquerModif(env, token, chatId, stockee, { seuilAlerte: n }, `✅ Seuil d'alerte réglé sur ${n}°C.`);
    else
      await appliquerModif(env, token, chatId, stockee, { tempIdealeOuverture: n }, `✅ Température idéale d'ouverture réglée sur ${n}°C.`);
    return;
  }

  if (cmd === "alertes") {
    const v = arg.toLowerCase();
    if (v !== "on" && v !== "off") { await telegramEnvoyer(token, chatId, "Utilise /alertes on ou /alertes off."); return; }
    await appliquerModif(env, token, chatId, stockee, { notificationsActives: v === "on" },
      v === "on" ? "🔔 Alertes activées." : "🔕 Alertes désactivées.");
    return;
  }

  if (cmd === "etat" || cmd === "meteo") {
    try {
      const { temp, ressenti } = await recupererMeteo(config);
      const etat = determinerEtat(temp, config);
      const libelle = etat === "CHAUD" ? "🔥 Garde fermé" : etat === "TIEDE" ? "🌡️ Ça redescend" : "✅ Ouvre maintenant";
      await telegramEnvoyer(token, chatId,
        `${libelle}\n${temp.toFixed(1)}°C (ressenti ${ressenti.toFixed(1)}°C)\nOuvrir ≤ ${config.tempIdealeOuverture}°C · fermer ≥ ${config.seuilAlerte}°C.`);
    } catch {
      await telegramEnvoyer(token, chatId, "Météo indisponible pour le moment.");
    }
    return;
  }

  // /start, /aide, /help ou commande inconnue -> aide.
  await telegramEnvoyer(token, chatId, aideTexte(config));
}

/** Endpoint appelé par Telegram à chaque update. Toujours répondre 200 (sinon Telegram réessaie). */
async function gererWebhook(request: Request, env: Env): Promise<Response> {
  const config = await lireConfig(env);
  if (!config.telegramToken) return json({ ok: true });

  const secretAttendu = await env.ETAT_METEO.get(CLE_WEBHOOK_SECRET);
  if (!secretAttendu || request.headers.get("X-Telegram-Bot-Api-Secret-Token") !== secretAttendu)
    return new Response("forbidden", { status: 403 });

  let update: TgUpdate;
  try { update = (await request.json()) as TgUpdate; } catch { return json({ ok: true }); }
  const msg = update.message ?? update.edited_message;
  if (!msg) return json({ ok: true });

  // On n'accepte que le chat propriétaire (celui connecté). Les autres sont ignorés.
  if (!config.telegramChatId || String(msg.chat?.id) !== config.telegramChatId) return json({ ok: true });

  try { await traiterMessage(env, config, msg); }
  catch (e) { console.error("Webhook :", e instanceof Error ? e.message : e); }
  return json({ ok: true });
}

const json = (data: unknown, status = 200): Response => Response.json(data, { status });

// ─────────────────────── Handlers Worker ───────────────────────

export default {
  /** Cron : notifie seulement sur transition d'état, et seulement si activé. */
  async scheduled(_controller: ScheduledController, env: Env, _ctx: ExecutionContext): Promise<void> {
    try {
      const config = await lireConfig(env);
      if (!config.notificationsActives) { console.log("Notifications désactivées : cycle ignoré."); return; }
      if (!config.telegramToken || !config.telegramChatId) { console.log("Telegram non configuré : cycle ignoré."); return; }

      const { temp, ressenti } = await recupererMeteo(config);
      const etatActuel = determinerEtat(temp, config);
      const etatPrecedent = (await env.ETAT_METEO.get(CLE_ETAT)) as Etat | null;

      if (etatActuel !== etatPrecedent) {
        // On notifie d'abord : si l'envoi échoue, l'état n'est pas mémorisé et
        // la transition sera retentée au prochain cycle.
        await envoyerNotification(construireMessage(temp, ressenti, etatActuel, config), config);
        await env.ETAT_METEO.put(CLE_ETAT, etatActuel);
        console.log(`Transition ${etatPrecedent ?? "INIT"} -> ${etatActuel} (${temp}°C).`);
      } else {
        console.log(`État inchangé (${etatActuel}, ${temp}°C).`);
      }
    } catch (e) {
      console.error("Échec du cycle météo :", e instanceof Error ? e.message : e);
    }
  },

  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    const chemin = url.pathname;

    // Page (accès libre).
    if (request.method === "GET" && (chemin === "/" || chemin === "/index.html")) {
      return new Response(PAGE_HTML, { headers: { "content-type": "text/html; charset=utf-8" } });
    }

    if (chemin.startsWith("/api/")) {
      // Webhook Telegram : validé par jeton secret (en-tête), pas d'autre auth.
      if (chemin === "/api/telegram/webhook" && request.method === "POST") {
        return gererWebhook(request, env);
      }

      // Accès libre : pas d'authentification (app perso).
      if (chemin === "/api/config" && request.method === "GET") {
        // On exclut telegramToken : ne jamais exposer le token au client.
        // telegramTokenConfigure (booléen) : indique à la page si le secret est bien lu.
        const { telegramToken, ...stockee } = await lireConfig(env);
        return json({ ...stockee, telegramTokenConfigure: Boolean(telegramToken) });
      }

      if (chemin === "/api/config" && request.method === "POST") {
        let corps: unknown;
        try { corps = await request.json(); } catch { return json({ erreur: "JSON invalide." }, 400); }
        const v = validerConfig(corps);
        if (!v.ok) return json({ erreur: v.erreur }, 400);
        await ecrireConfig(env, v.valeur);
        return json({ ok: true });
      }

      if (chemin === "/api/telegram/connect" && request.method === "POST") {
        const config = await lireConfig(env);
        if (!config.telegramToken)
          return json({ erreur: "Ajoute d'abord le secret TELEGRAM_TOKEN sur le worker." }, 400);
        try {
          // getUpdates et le webhook sont exclusifs : on retire le webhook le temps de lire le chat…
          await fetch(`https://api.telegram.org/bot${config.telegramToken}/deleteWebhook`).catch(() => {});
          // Détection du chat, non bloquante : si getUpdates ne renvoie rien (message expiré
          // après 24 h) on retombe sur le chat déjà enregistré, pour armer quand même le webhook.
          let detecte: { chatId: string; nom: string } | null = null;
          try { detecte = await detecterChatTelegram(config); } catch { /* getUpdates indispo : on continue */ }
          const chatId = detecte?.chatId ?? config.telegramChatId;
          if (!chatId)
            return json({ erreur: "Aucun message reçu. Ouvre ton bot dans Telegram et envoie /start, puis réessaie." }, 404);
          // Enregistre le chat si nouvellement détecté.
          if (detecte && detecte.chatId !== config.telegramChatId) {
            const { telegramToken, ...stockee } = config;
            const v = validerConfig({ ...stockee, telegramChatId: detecte.chatId });
            if (v.ok) await ecrireConfig(env, v.valeur);
          }
          // …puis on (ré)arme le webhook pour activer les commandes du bot.
          await configurerWebhook(env, config.telegramToken, new URL(request.url).origin);
          return json({ chatId, nom: detecte?.nom ?? "" });
        } catch (e) {
          return json({ erreur: e instanceof Error ? e.message : "Échec de la connexion Telegram." }, 502);
        }
      }

      if (chemin === "/api/telegram/diag" && request.method === "GET") {
        // Diagnostic : état du webhook côté Telegram (aucun secret renvoyé).
        const config = await lireConfig(env);
        if (!config.telegramToken) return json({ erreur: "TELEGRAM_TOKEN manquant (secret non vu par le worker)." }, 400);
        try {
          const r = await fetch(`https://api.telegram.org/bot${config.telegramToken}/getWebhookInfo`);
          const data = (await r.json()) as {
            result?: { url?: string; pending_update_count?: number; last_error_date?: number; last_error_message?: string };
          };
          const info = data.result ?? {};
          return json({
            webhookUrl: info.url || "(aucun webhook armé)",
            messagesEnAttente: info.pending_update_count ?? 0,
            derniereErreur: info.last_error_message || "(aucune)",
            derniereErreurQuand: info.last_error_date ? new Date(info.last_error_date * 1000).toISOString() : null,
            chatEnregistre: config.telegramChatId || "(aucun)",
          });
        } catch (e) {
          return json({ erreur: e instanceof Error ? e.message : "Échec du diagnostic." }, 502);
        }
      }

      if (chemin === "/api/test" && request.method === "POST") {
        const config = await lireConfig(env);
        if (!config.telegramToken) return json({ erreur: "Ajoute d'abord le secret TELEGRAM_TOKEN sur le worker." }, 400);
        if (!config.telegramChatId) return json({ erreur: "Connecte Telegram d'abord (bouton « Connecter Telegram »)." }, 400);
        try {
          await envoyerNotification(
            { titre: "🔔 Test", corps: "Notification de test — si tu lis ça, tout fonctionne." },
            config,
          );
          return json({ ok: true });
        } catch (e) {
          return json({ erreur: e instanceof Error ? e.message : "Échec de l'envoi." }, 502);
        }
      }

      if (chemin === "/api/etat" && request.method === "GET") {
        const config = await lireConfig(env);
        try {
          const p = url.searchParams.get("temp"); // override de debug
          let temp: number, ressenti: number;
          if (p !== null) {
            temp = Number(p);
            if (Number.isNaN(temp)) return json({ erreur: "Paramètre temp invalide." }, 400);
            ressenti = temp;
          } else {
            ({ temp, ressenti } = await recupererMeteo(config));
          }
          return json({
            temperature: temp,
            ressenti,
            etat: determinerEtat(temp, config),
            seuilAlerte: config.seuilAlerte,
            tempIdealeOuverture: config.tempIdealeOuverture,
          });
        } catch (e) {
          return json({ erreur: e instanceof Error ? e.message : "Météo indisponible." }, 502);
        }
      }

      return json({ erreur: "Route inconnue." }, 404);
    }

    return new Response("Not found", { status: 404 });
  },
};
