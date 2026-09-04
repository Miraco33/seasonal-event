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
  questName: string;
  questLevel: number | null;
  questNpc: string;
  questId?: number | null;
  location: EventLocation;
  achievementId: number | null;
  teleport?: TeleportTarget | null;
  rewards: EventReward[];
  sourceUrl: string;
  lastVerifiedAt: string;
}

export interface EventsDocument {
  schemaVersion: 1;
  dataVersion: number;
  publishedAt: string;
  events: SeasonalEvent[];
}
