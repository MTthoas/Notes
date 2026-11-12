// Types du domaine, partagés par tous les modules.

/** Texte chiffré AES-GCM, en base64. */
export interface Box { iv: string; ct: string }
/** Texte chiffré par une clé dérivée d'un mot de passe (le sel accompagne le chiffré). */
export interface SaltedBox extends Box { salt: string }

export interface Note {
  id: string;
  title: string;
  /** Vide quand la note est chiffrée par mot de passe : le contenu est alors dans `enc`. */
  body: string;
  created: number;
  updated: number;
  pinned: boolean;
  inbox: boolean;
  /** Clé AAAA-MM-JJ pour une note du jour. */
  daily: string | null;
  expiresAt: number | null;
  deletedAt: number | null;
  enc: SaltedBox | null;
  /** Note « Tâches » qui reçoit les tâches rapides. */
  todo?: boolean;
}

export interface Version { id: string; noteId: string; ts: number; title: string; body?: string; enc?: Box }

export interface TaskLine { line: number; text: string; done: boolean }
export interface NoteMeta { body: string | null; tags: string[]; links: string[]; tasks: TaskLine[]; snippet: string }

/** Vue courante de l'application. */
export interface ViewState { type: string; tag?: string; tab?: string; project?: string | null }

/** Fonctions de l'application offertes aux pages et intégrations (fournies par app.ts à l'initialisation). */
export interface AppShell {
  setView(v: ViewState): Promise<void>;
  openNote(id: string): void;
  capture(text: string): Promise<unknown>;
  view(): string;
  viewState(): ViewState;
  renderSidebar(): void;
  tbLeft(): string;
  crumb(current: string): string;
  onCount?(): void;
}
