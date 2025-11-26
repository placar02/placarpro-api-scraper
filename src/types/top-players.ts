export interface PlayerStatistics {
  rating: number;
  id: number;
  type: string;
  appearances: number;
  statisticsType: {
    sportSlug: string;
    statisticsType: string;
  };
}

export interface SimplePlayer {
  name: string;
  slug: string;
  shortName: string;
  position: string;
  userCount: number;
  gender: string;
  id: number;
}

export interface SimpleTeam {
  name: string;
  slug: string;
  shortName: string;
  id: number;
  nameCode: string;
}

export interface TopPlayerEntry {
  statistics: PlayerStatistics;
  playedEnough: boolean;
  player: SimplePlayer;
  team: SimpleTeam;
}

export interface TopPlayersRating {
  rating: TopPlayerEntry[];
}

export interface ApiTopPlayersResponse {
  topPlayers: TopPlayersRating;
}

export interface NormalizedTopPlayer {
  playerId: number;
  playerName: string;
  playerSlug: string;
  playerPosition: string;
  playerUserCount: number;
  teamId: number;
  teamName: string;
  teamSlug: string;
  rating: number;
  statisticsId: number;
  statisticsType: string;
  appearances: number;
  playedEnough: boolean;
}

export interface NormalizedTopPlayersResponse {
  tournamentId: number;
  seasonId: number;
  teamId: number;
  topPlayers: NormalizedTopPlayer[];
  totalPlayers: number;
  lastUpdated: number;
}

export interface FetchTopPlayersResult {
  status: number;
  data?: NormalizedTopPlayersResponse;
  error?: string;
}
