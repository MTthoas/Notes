// Déclarations de l'environnement : le pont vers l'app native (WKWebView) et les points d'entrée qu'elle appelle.
interface NativeBridge { postMessage(message: Record<string, unknown>): void }

interface Window {
  webkit?: { messageHandlers?: { carnet?: NativeBridge } };
  carnet?: {
    flush(): Promise<void>;
    settings(): void;
    voice(payload: unknown): void;
    bio(payload: unknown): void;
    reply(payload: unknown): void;
  };
}

// Dans Studio, `closest()` sert à retrouver des éléments HTML (boutons, lignes, formulaires) : on le type ainsi,
// ce qui évite une conversion à chaque clic délégué. Un sélecteur peut préciser le type : closest<HTMLInputElement>(…).
interface Element {
  closest<E extends HTMLElement = HTMLElement>(selector: string): E | null;
}

/** Vrai uniquement dans le build de test : expose les modules aux tests automatisés. */
declare const __TEST__: boolean;
