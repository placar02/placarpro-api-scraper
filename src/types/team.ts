export interface Country {
  alpha2: string;
  alpha3: string;
  name: string;
  slug: string;
}

export interface Manager {
  name: string;
  slug: string;
  shortName: string;
  id: number;
  country: Country;
}

export interface VenueCoordinates {
  latitude: number;
  longitude: number;
}

export interface VenueCity {
  name: string;
}

export interface Stadium {
  name: string;
  capacity: number;
}

export interface Venue {
  city: VenueCity;
  venueCoordinates: VenueCoordinates;
  hidden: boolean;
  slug: string;
  name: string;
  capacity: number;
  id: number;
  country: Country;
  stadium: Stadium;
}

export interface TeamColors {
  primary: string;
  secondary: string;
  text: string;
}

export interface Sport {
  name: string;
  slug: string;
  id: number;
}

export interface TransferPeriod {
  activeFrom: string;
  activeTo: string;
}

export interface Category {
  name: string;
  slug: string;
  sport: Sport;
  id: number;
  country: Country;
  flag: string;
  alpha2: string;
  transferPeriod: TransferPeriod[];
}

export interface UniqueTournament {
  name: string;
  slug: string;
  primaryColorHex: string;
  secondaryColorHex: string;
  category: Category;
  userCount: number;
  hasPerformanceGraphFeature: boolean;
  id: number;
  country: Record<string, unknown>;
  displayInverseHomeAwayTeams: boolean;
}

export interface Tournament {
  name: string;
  slug: string;
  category: Category;
  uniqueTournament: UniqueTournament;
  priority: number;
  isLive: boolean;
  id: number;
}

export interface FormItem {
  form: string[];
  avgRating: string;
  position: number;
  value: string;
}

export interface ApiTeam {
  name: string;
  slug: string;
  shortName: string;
  gender: string;
  sport: Sport;
  category: Category;
  tournament: Tournament;
  primaryUniqueTournament: UniqueTournament;
  userCount: number;
  manager: Manager;
  venue: Venue;
  nameCode: string;
  class: number;
  disabled: boolean;
  national: boolean;
  type: number;
  id: number;
  country: Country;
  fullName: string;
  teamColors: TeamColors;
  foundationDateTimestamp: number;
}

export interface PregameForm {
  avgRating: string;
  position: number;
  value: string;
  form: string[];
}

export interface ApiTeamResponse {
  team: ApiTeam;
  pregameForm: PregameForm;
}

export interface NormalizedTeamResponse {
  teamId: number;
  name: string;
  shortName: string;
  fullName: string;
  slug: string;
  nameCode: string;
  gender: string;
  national: boolean;
  sport: {
    name: string;
    slug: string;
  };
  country: {
    alpha2: string;
    alpha3: string;
    name: string;
  };
  manager: {
    id: number;
    name: string;
    slug: string;
    country: string;
  } | null;
  venue: {
    id: number;
    name: string;
    slug: string;
    capacity: number;
    city: string;
    coordinates: {
      latitude: number;
      longitude: number;
    };
  } | null;
  colors: {
    primary: string;
    secondary: string;
    text: string;
  };
  tournament: {
    name: string;
    slug: string;
  } | null;
  userCount: number;
  foundation: {
    timestamp: number;
    year: number;
  };
  pregameForm: PregameForm | null;
  lastUpdated: number;
}

export interface FetchTeamResult {
  status: number;
  data?: NormalizedTeamResponse;
  error?: string;
}
