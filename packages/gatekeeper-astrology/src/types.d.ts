// Navasanganakah Astrology gatekeeper session types.
//
// This file is self-contained: it does not import from @gadgets/workshop-shared so the
// getTypeScriptTypes() payload can be evaluated standalone. The runtime implementation returns
// the raw API responses mostly verbatim; the fields below document the JSON shapes the
// Navasanganakah Astrology API (https://astro.navasanganakah.com/docs) returns.

// Birth details used by every session method. All fields are required except hour/minute/
// timezoneOffset, which default on the API side.
export interface BirthDetails {
  year: number;
  month: number;
  day: number;
  hour?: number;
  minute?: number;
  latitude: number;
  longitude: number;
  timezoneOffset?: number;
}

export interface PlanetPosition {
  name?: string;
  rashi?: string;
  rashiName?: string;
  nakshatra?: string;
  nakshatraName?: string;
  degree?: number;
  nakshatraPada?: number;
  bhav?: number;
  longitude?: number;
  house?: number;
}

export interface BirthChart {
  ascendant?: string;
  lagna?: PlanetPosition;
  planets?: {
    lagna?: PlanetPosition;
    sun?: PlanetPosition;
    moon?: PlanetPosition;
    mars?: PlanetPosition;
    mercury?: PlanetPosition;
    jupiter?: PlanetPosition;
    venus?: PlanetPosition;
    saturn?: PlanetPosition;
    rahu?: PlanetPosition;
    ketu?: PlanetPosition;
  };
  houses?: Record<string, unknown>;
}

export interface DashaPeriod {
  lord?: string;
  start?: string;
  end?: string;
  isActive?: boolean;
  subPeriods?: DashaPeriod[];
}

export interface DashaReport {
  startingNakshatra?: number;
  startingNakshatraName?: string;
  dashas?: DashaPeriod[];
}

export interface GocharPosition {
  planet?: string;
  rashi?: string;
  rashiName?: string;
  isRetrograde?: boolean;
}

export interface GocharReport {
  targetDate?: string;
  positions?: GocharPosition[];
}

export interface PanchangReport {
  tithi?: { name?: string; paksha?: string };
  vaar?: { name?: string };
  nakshatra?: { name?: string };
  yoga?: { name?: string };
  karana?: { name?: string };
}

export interface AshtakvargaReport {
  bindus?: Record<string, Record<string, number>>;
  sarvashtakvarga?: Record<string, { points?: number; sign?: string }>;
}

export interface ShadbalaPlanet {
  name?: string;
  total?: number;
  total_rupas?: number;
  interpretation?: string;
}

export interface ShadbalaReport {
  sun?: ShadbalaPlanet;
  moon?: ShadbalaPlanet;
  mars?: ShadbalaPlanet;
  mercury?: ShadbalaPlanet;
  jupiter?: ShadbalaPlanet;
  venus?: ShadbalaPlanet;
  saturn?: ShadbalaPlanet;
}

export interface VargaPlanet {
  name?: string;
  rashi?: string;
  rashiName?: string;
}

export interface VargaChart {
  varga?: string;
  name?: string;
  planets?: VargaPlanet[];
}

export interface VargaReport {
  charts?: VargaChart[];
}

export interface BhriguYoga {
  yogaName?: string;
  prediction?: string;
}

export interface BhriguYogasReport {
  bhriguYogas?: BhriguYoga[];
}

export interface ImpactingPlanet {
  planet?: string;
  type?: string;
  isBenefic?: boolean;
}

export interface CareerMarriageReport {
  career?: {
    prediction?: string;
    karaka?: string;
    impactingPlanets?: ImpactingPlanet[];
  };
  marriage?: {
    prediction?: string;
    karaka?: string;
    impactingPlanets?: ImpactingPlanet[];
  };
}

export interface NumerologyReport {
  numbers?: Record<string, number>;
  predictions?: Record<string, string>;
}

export interface PlanetReading {
  planet?: string;
  rashiName?: string;
  nakshatraName?: string;
  bhav?: number;
  reading?: string;
}

export interface KundliAnalysis {
  summary: string;
  lagna?: { rashiName?: string; nakshatraName?: string; bhav?: number };
  planets: PlanetReading[];
  dasha?: { startingNakshatra?: number; active?: string; dashas: DashaPeriod[] };
  panchangSummary?: string;
  ashtakvargaSummary?: string;
  shadbalaSummary?: string;
  yogas: Array<{ yogaName?: string; prediction?: string }>;
  career?: { karaka?: string; prediction?: string };
  marriage?: { karaka?: string; prediction?: string };
  recommendations: string[];
}

// The RPC surface exposed by the Astrology gatekeeper session. Every method is a read-only
// observation (there are no write actions, so applyAction/rejectAction/revertAction are not
// part of this surface).
export interface AstrologySession {
  getBirthChart(details: BirthDetails): Promise<BirthChart>;
  getDasha(details: BirthDetails, targetDate?: string): Promise<DashaReport>;
  getGochar(details: BirthDetails, targetDate?: string): Promise<GocharReport>;
  getPanchang(details: BirthDetails): Promise<PanchangReport>;
  getAshtakvarga(details: BirthDetails): Promise<AshtakvargaReport>;
  getShadbala(details: BirthDetails): Promise<ShadbalaReport>;
  getVargas(details: BirthDetails): Promise<VargaReport>;
  getBhriguYogas(details: BirthDetails): Promise<BhriguYogasReport>;
  getCareerMarriage(details: BirthDetails, gender?: "male" | "female"): Promise<CareerMarriageReport>;
  getNumerology(details: BirthDetails, name?: string): Promise<NumerologyReport>;
  getChartSvg(details: BirthDetails, options?: { style?: "north" | "south"; varga?: string }): Promise<string>;
  analyzeKundli(details: BirthDetails, options?: { gender?: "male" | "female"; name?: string }): Promise<KundliAnalysis>;
}
