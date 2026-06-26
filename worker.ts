/**
 * Cloudflare Worker — Rappel d'aération + panneau de réglages
 * ------------------------------------------------------------------
 * - Cron : interroge Open-Meteo et notifie (ntfy) sur changement d'état.
 * - HTTP : sert la page de réglages et une petite API JSON protégée par
 *   mot de passe. Les réglages sont stockés dans KV, donc modifiables
 *   depuis le téléphone sans redéploiement.
 *
 * "Température idéale pour ouvrir" : aérer ne rafraîchit que si l'air
 * extérieur est plus frais que l'intérieur. Faute de capteur intérieur,
 * `tempIdealeOuverture` sert de confort visé :
 *   extérieur >= seuilAlerte           -> CHAUD : garder fermé
 *   tempIdeale < extérieur < seuilAlerte -> TIEDE : ça redescend
 *   extérieur <= tempIdeale            -> IDEAL : ouvrir
 * ------------------------------------------------------------------
 */

// HTML servi comme module texte (voir [[rules]] type="Text" dans wrangler.toml).
// @ts-ignore
import PAGE_HTML from "./index.html";

// ─────────────────────────── Types ───────────────────────────

interface Env {
  ETAT_METEO: KVNamespace;   // KV : config + dernier état (binding obligatoire)
}

/** Réglages persistés dans KV. */
interface ConfigStockee {
  latitude: number;
  longitude: number;
  seuilAlerte: number;
  tempIdealeOuverture: number;
  ntfyTopic: string;
  notificationsActives: boolean;
}

/** Config d'exécution = réglages + serveur ntfy (non éditable). */
type Config = ConfigStockee & { ntfyServeur: string };

type Etat = "CHAUD" | "TIEDE" | "IDEAL";

interface Notification {
  titre: string;
  corps: string;
  tags: string[];   // shortcodes ntfy -> emojis
  priorite: number; // 1 (min) à 5 (max)
}

interface OpenMeteoReponse {
  current?: { temperature_2m?: number; apparent_temperature?: number };
}

// ─────────────────────────── Constantes ───────────────────────────

const NTFY_SERVEUR = "https://ntfy.sh";
const CLE_CONFIG = "config";
const CLE_ETAT = "dernier_etat";
const TOPIC_REGEX = /^[A-Za-z0-9_-]+$/; // segments d'URL ntfy : pas d'injection possible

const CONFIG_DEFAUT: ConfigStockee = {
  latitude: 45.36,            // position par défaut (modifiable dans la page)
  longitude: 0.92,
  seuilAlerte: 30,
  tempIdealeOuverture: 25,
  ntfyTopic: "",
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
        tags: ["white_check_mark", "house"],
        priorite: 4,
      };
    case "TIEDE":
      return {
        titre: "🌡️ Ça redescend",
        corps: `${t}°C dehors (ressenti ${r}°C). Sous ${c.seuilAlerte}°C, mais pas encore les ${c.tempIdealeOuverture}°C idéaux pour ouvrir. Patiente encore un peu.`,
        tags: ["thermometer"],
        priorite: 3,
      };
    case "CHAUD":
      return {
        titre: "🔥 Garde fermé",
        corps: `${t}°C dehors (ressenti ${r}°C). Au-dessus de ${c.seuilAlerte}°C : volets baissés, fenêtres fermées.`,
        tags: ["fire"],
        priorite: 2,
      };
  }
}

// ─────────────────────── Config (KV) ───────────────────────

function estNombreFini(v: unknown): v is number {
  return typeof v === "number" && Number.isFinite(v);
}

/** Valide un objet de réglages reçu de l'API. Bornes serveur + whitelist topic. */
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
  if (typeof b.ntfyTopic !== "string")
    return { ok: false, erreur: "Canal de notification invalide." };

  const topic = b.ntfyTopic.trim();
  if (b.notificationsActives && topic.length === 0)
    return { ok: false, erreur: "Renseigne un canal de notification pour activer les notifications." };
  if (topic.length > 64 || (topic.length > 0 && !TOPIC_REGEX.test(topic)))
    return { ok: false, erreur: "Canal invalide : lettres, chiffres, tirets et underscores uniquement (max 64)." };

  return {
    ok: true,
    valeur: {
      latitude: b.latitude,
      longitude: b.longitude,
      seuilAlerte: b.seuilAlerte,
      tempIdealeOuverture: b.tempIdealeOuverture,
      ntfyTopic: topic,
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
  return { ...stockee, ntfyServeur: NTFY_SERVEUR };
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

async function envoyerNotification(n: Notification, c: Config): Promise<void> {
  // API JSON de ntfy : titre/message en UTF-8 dans le corps -> aucun souci d'encodage d'en-tête.
  const reponse = await fetch(c.ntfyServeur, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ topic: c.ntfyTopic, title: n.titre, message: n.corps, tags: n.tags, priority: n.priorite }),
  });
  if (!reponse.ok) {
    const detail = await reponse.text().catch(() => "");
    throw new Error(`ntfy a répondu ${reponse.status} ${detail}`.trim());
  }
}

const json = (data: unknown, status = 200): Response => Response.json(data, { status });

// ─────────────────────── Handlers Worker ───────────────────────

export default {
  /** Cron : notifie seulement sur transition d'état, et seulement si activé. */
  async scheduled(_controller: ScheduledController, env: Env, _ctx: ExecutionContext): Promise<void> {
    try {
      const config = await lireConfig(env);
      if (!config.notificationsActives) { console.log("Notifications désactivées : cycle ignoré."); return; }
      if (!config.ntfyTopic) { console.log("Canal non configuré : cycle ignoré."); return; }

      const { temp, ressenti } = await recupererMeteo(config);
      const etatActuel = determinerEtat(temp, config);
      const etatPrecedent = (await env.ETAT_METEO.get(CLE_ETAT)) as Etat | null;

      if (etatActuel !== etatPrecedent) {
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

    // Page (sans secret : les valeurs sensibles passent par l'API authentifiée).
    if (request.method === "GET" && (chemin === "/" || chemin === "/index.html")) {
      return new Response(PAGE_HTML, { headers: { "content-type": "text/html; charset=utf-8" } });
    }

    if (chemin.startsWith("/api/")) {
      // Accès libre : pas d'authentification (app perso, mot de passe désactivé).
      if (chemin === "/api/config" && request.method === "GET") {
        const { ntfyServeur, ...stockee } = await lireConfig(env);
        return json(stockee);
      }

      if (chemin === "/api/config" && request.method === "POST") {
        let corps: unknown;
        try { corps = await request.json(); } catch { return json({ erreur: "JSON invalide." }, 400); }
        const v = validerConfig(corps);
        if (!v.ok) return json({ erreur: v.erreur }, 400);
        await ecrireConfig(env, v.valeur);
        return json({ ok: true });
      }

      if (chemin === "/api/test" && request.method === "POST") {
        const config = await lireConfig(env);

        // Topic optionnel dans le corps : permet de tester sans enregistrer d'abord.
        let topicDemande = "";
        try {
          const corps = await request.json();
          if (corps && typeof corps === "object" && typeof (corps as Record<string, unknown>).topic === "string") {
            topicDemande = ((corps as Record<string, unknown>).topic as string).trim();
          }
        } catch { /* pas de corps : on retombe sur le topic enregistré */ }

        const topic = topicDemande || config.ntfyTopic;
        if (!topic) return json({ erreur: "Renseigne d'abord un canal de notification." }, 400);
        // Whitelist (segment d'URL ntfy) : pas d'injection possible.
        if (topic.length > 64 || !TOPIC_REGEX.test(topic))
          return json({ erreur: "Canal invalide : lettres, chiffres, tirets et underscores uniquement (max 64)." }, 400);

        try {
          await envoyerNotification(
            { titre: "🔔 Test", corps: "Notification de test — si tu lis ça, tout fonctionne.", tags: ["bell"], priorite: 3 },
            { ...config, ntfyTopic: topic },
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
