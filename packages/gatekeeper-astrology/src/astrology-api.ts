import type {
  AshtakvargaReport,
  BirthChart,
  BirthDetails,
  BhriguYogasReport,
  CareerMarriageReport,
  DashaReport,
  GocharReport,
  NumerologyReport,
  PanchangReport,
  ShadbalaReport,
  VargaReport,
} from "./types";

// Thin typed wrapper around the Navasanganakah Astrology REST API.
// Every request is a JSON POST carrying an x-api-key header (per-user key), matching the
// API documented at https://astro.navasanganakah.com/docs. Errors from the API are normalized
// into AstrologyError; 401/403 are flagged as auth errors so the gatekeeper can mark the
// connection as expired.

export interface AstrologyCredentials {
  apiKey: string;
  baseUrl: string;
}

export class AstrologyError extends Error {
  status: number;
  isAuthError: boolean;
  constructor(message: string, status: number) {
    super(message);
    this.name = "AstrologyError";
    this.status = status;
    this.isAuthError = status === 401 || status === 403;
  }
}

function stripTrailingSlashes(value: string): string {
  let out = value;
  while (out.endsWith("/")) out = out.slice(0, -1);
  return out;
}

// The API expects yyyy-mm-dd (zero-padded) for its date-string endpoints.
export function toDateString(details: BirthDetails): string {
  const y = String(details.year).padStart(4, "0");
  const m = String(details.month).padStart(2, "0");
  const d = String(details.day).padStart(2, "0");
  return y + "-" + m + "-" + d;
}

interface ApiBody {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  lat: number;
  lon: number;
  tz: number;
}

function toApiBody(details: BirthDetails): ApiBody {
  return {
    year: details.year,
    month: details.month,
    day: details.day,
    hour: details.hour ?? 12,
    minute: details.minute ?? 0,
    lat: details.latitude,
    lon: details.longitude,
    tz: details.timezoneOffset ?? 5.5,
  };
}

export class AstrologyRest {
  #baseUrl: string;
  #apiKey: string;

  constructor(credentials: AstrologyCredentials) {
    this.#baseUrl = stripTrailingSlashes(credentials.baseUrl);
    this.#apiKey = credentials.apiKey;
  }

  async #request(path: string, body: unknown): Promise<unknown> {
    let response: Response;
    try {
      response = await fetch(this.#baseUrl + path, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-api-key": this.#apiKey,
        },
        body: JSON.stringify(body),
      });
    } catch (e: any) {
      throw new AstrologyError("Could not reach the Astrology API: " + (e?.message ?? e), 0);
    }
    if (!response.ok) {
      let detail = "";
      try {
        detail = (await response.text()).slice(0, 200);
      } catch {
        detail = "";
      }
      throw new AstrologyError(
        "Astrology API returned HTTP " + response.status + (detail ? ": " + detail : ""),
        response.status,
      );
    }
    return await response.json();
  }

  async #postData<T>(path: string, body: unknown): Promise<T> {
    const raw = await this.#request(path, body);
    if (raw && typeof raw === "object" && !Array.isArray(raw) && "data" in raw) {
      return (raw as { data: T }).data;
    }
    return raw as T;
  }

  async #postText(path: string, body: unknown): Promise<string> {
    let response: Response;
    try {
      response = await fetch(this.#baseUrl + path, {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-api-key": this.#apiKey },
        body: JSON.stringify(body),
      });
    } catch (e: any) {
      throw new AstrologyError("Could not reach the Astrology API: " + (e?.message ?? e), 0);
    }
    if (!response.ok) {
      throw new AstrologyError("Astrology API returned HTTP " + response.status, response.status);
    }
    return await response.text();
  }

  // Lightweight auth probe used by the connect flow.
  async ping(): Promise<NumerologyReport> {
    return await this.#postData<NumerologyReport>("/api/numerology", {
      year: 2000,
      month: 1,
      day: 1,
      name: "Cloudflare OS",
    });
  }

  async getAstro(details: BirthDetails): Promise<BirthChart> {
    return await this.#postData<BirthChart>("/api/astro", toApiBody(details));
  }

  async getDasha(details: BirthDetails, targetDate?: string): Promise<DashaReport> {
    const body = toApiBody(details);
    return await this.#postData<DashaReport>("/api/dasha", targetDate ? { ...body, target_date: targetDate } : body);
  }

  async getGochar(details: BirthDetails, targetDate?: string): Promise<GocharReport> {
    const body = toApiBody(details);
    return await this.#postData<GocharReport>("/api/gochar", targetDate ? { ...body, target_date: targetDate } : body);
  }

  async getVarga(details: BirthDetails): Promise<VargaReport> {
    return await this.#postData<VargaReport>("/api/vargas", { ...toApiBody(details), method: "parashari" });
  }

  async getAshtakvarga(details: BirthDetails): Promise<AshtakvargaReport> {
    return await this.#postData<AshtakvargaReport>("/api/ashtakvarga", toApiBody(details));
  }

  async getPanchang(details: BirthDetails): Promise<PanchangReport> {
    return await this.#postData<PanchangReport>("/api/panchang", toApiBody(details));
  }

  async getShadbala(details: BirthDetails): Promise<ShadbalaReport> {
    return await this.#postData<ShadbalaReport>("/api/shadbala", toApiBody(details));
  }

  async getNumerology(body: { year: number; month: number; day: number; name?: string }): Promise<NumerologyReport> {
    return await this.#postData<NumerologyReport>("/api/numerology", body);
  }

  async getBhriguYogas(dateString: string): Promise<BhriguYogasReport> {
    return await this.#postData<BhriguYogasReport>("/api/bnn/yogas", { date: dateString });
  }

  async getCareerMarriage(dateString: string, gender: "male" | "female"): Promise<CareerMarriageReport> {
    return await this.#postData<CareerMarriageReport>("/api/bnn/career-marriage", { date: dateString, gender });
  }

  async getChartSvg(details: BirthDetails, options?: { style?: "north" | "south"; varga?: string }): Promise<string> {
    const body = {
      ...toApiBody(details),
      style: options?.style ?? "north",
      ...(options?.varga ? { varga: options.varga } : {}),
    };
    return await this.#postText("/api/astro/svg", body);
  }
}
