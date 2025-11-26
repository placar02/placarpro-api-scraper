export interface FieldTranslations {
  nameTranslation?: Record<string, string>;
  shortNameTranslation?: Record<string, string>;
}

export interface Player {
  name: string;
  firstName?: string;
  lastName?: string;
  slug: string;
  shortName: string;
  position: string;
  jerseyNumber: string;
  height?: number;
  userCount?: number;
  gender?: string;
  id: number;
  marketValueCurrency?: string;
  dateOfBirthTimestamp?: number;
  proposedMarketValueRaw?: {
    value: number;
    currency: string;
  };
  fieldTranslations?: FieldTranslations;
  sofascoreId?: string;
}

export interface PlayerCoordinates {
  x: number;
  y: number;
}

export interface PassingNetworkAction {
  player?: Player;
  eventType: string;
  bodyPart?: string;
  isAssist?: boolean;
  time: number;
  playerCoordinates?: PlayerCoordinates;
  passEndCoordinates?: PlayerCoordinates;
  gkCoordinates?: PlayerCoordinates;
  goalShotCoordinates?: PlayerCoordinates;
  goalMouthCoordinates?: PlayerCoordinates;
  goalkeeper?: Player;
  isHome: boolean;
  goalType?: string;
}

// Union type for all possible incident types
export type Incident =
  | PeriodIncident
  | CardIncident
  | InjuryTimeIncident
  | SubstitutionIncident
  | GoalIncident;

export interface BaseIncident {
  id?: number;
  time: number;
  addedTime?: number;
  isHome?: boolean;
  incidentClass?: string;
  reversedPeriodTime?: number;
  reversedPeriodTimeSeconds?: number;
  incidentType: string;
  timeSeconds?: number;
  periodTimeSeconds?: number;
}

export interface PeriodIncident extends BaseIncident {
  incidentType: 'period';
  text: string;
  homeScore?: number;
  awayScore?: number;
  isLive?: boolean;
}

export interface CardIncident extends BaseIncident {
  incidentType: 'card';
  player: Player;
  playerName: string;
  reason: string;
  rescinded: boolean;
  incidentClass: 'yellow' | 'red' | 'yellowRed';
}

export interface InjuryTimeIncident extends BaseIncident {
  incidentType: 'injuryTime';
  length: number;
}

export interface SubstitutionIncident extends BaseIncident {
  incidentType: 'substitution';
  playerIn: Player;
  playerOut: Player;
  injury: boolean;
  incidentClass: string;
}

export interface GoalIncident extends BaseIncident {
  incidentType: 'goal';
  homeScore: number;
  awayScore: number;
  player: Player;
  assist1?: Player;
  footballPassingNetworkAction?: PassingNetworkAction[];
  incidentClass: string;
}

export interface TeamColors {
  primary: string;
  number: string;
  outline: string;
  fancyNumber?: string;
}

export interface TeamColorSet {
  goalkeeperColor: TeamColors;
  playerColor: TeamColors;
}

export interface IncidentsApiResponse {
  incidents: Incident[];
  home: TeamColorSet;
  away: TeamColorSet;
  id?: number;
}

export interface NormalizedIncident {
  id?: number;
  eventId: number;
  type: string;
  class?: string;
  time: number;
  addedTime?: number;
  isHome?: boolean;

  // Period info
  periodText?: string;
  score?: {
    home: number;
    away: number;
  };

  // Card info
  player?: {
    id: number;
    name: string;
    slug: string;
    position: string;
    jerseyNumber: string;
  };
  cardReason?: string;
  cardType?: string;

  // Goal info
  goalScorer?: {
    id: number;
    name: string;
    slug: string;
    position: string;
    jerseyNumber: string;
  };
  assist?: {
    id: number;
    name: string;
    slug: string;
  };
  goalkeeper?: {
    id: number;
    name: string;
    slug: string;
  };
  goalType?: string;

  // Substitution info
  playerIn?: {
    id: number;
    name: string;
    slug: string;
    position: string;
    jerseyNumber: string;
  };
  playerOut?: {
    id: number;
    name: string;
    slug: string;
    position: string;
    jerseyNumber: string;
  };
  isInjury?: boolean;

  // Injury time
  injuryTimeLength?: number;
}

export interface IncidentsData {
  eventId: number;
  incidents: NormalizedIncident[];
  teamColors: {
    home: TeamColorSet;
    away: TeamColorSet;
  };
}
