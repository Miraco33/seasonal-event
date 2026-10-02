export interface EventLocation {
  territoryId: number;
  mapId: number;
  x: number;
  y: number;
  z: number;
  displayX?: number;
  displayY?: number;
}

export interface EventReward {
  name: string;
  category: string;
  description: string;
  flags: string[];
}

export interface TeleportTarget {
  aetheryteId: number;
  subIndex: number;
}

export interface SeasonalEvent {
  id: string;
  title: string;
  startAt: string;
  endAt: string;
  questName: string | null;
  questLevel: number | null;
  questNpc: string | null;
  questId?: number | null;
  location: EventLocation | null;
  achievementId: number | null;
  teleport?: TeleportTarget | null;
  rewards: EventReward[];
  sourceUrl: string;
  announcementUrl?: string;
  lastVerifiedAt: string;
}

export interface EventsDocument {
  schemaVersion: 1 | 2;
  dataVersion: number;
  publishedAt: string;
  events: SeasonalEvent[];
  collectionStatus?: {
    status: "ok" | "alert";
    code: string;
    unavailableSources?: string[];
  };
}
