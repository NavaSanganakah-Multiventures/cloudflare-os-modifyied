# gatekeeper-astrology

First-class Cloudflare OS gatekeeper for the Navasanganakah Astrology API
(https://astro.navasanganakah.com/docs, API host https://astrology.navasanganakah.com).

## What it does

Computes a Vedic Kundli (birth chart) and Hindi astrological analysis from birth details
(date, time, place/lat-lon, and timezone offset). The session exposes 12 read-only methods:

- getBirthChart, getDasha, getGochar, getPanchang, getAshtakvarga, getShadbala, getVargas,
  getBhriguYogas, getCareerMarriage, getNumerology, getChartSvg, and analyzeKundli
  (a structured Hindi report composed from the astro/dasha/panchang/ashtakvarga/shadbala/
  bnn endpoints).

## Connect flow (no deployment secret)

The API requires an x-api-key. Each user connects their OWN key through the Connectors page:
the connect form stores the key (and the API base URL, normalized to host-only) in the
UserAccount Durable Object. There is no wrangler secret and no deployment-level API key.

## API

- Base URL default: https://astrology.navasanganakah.com
- Docs: https://astro.navasanganakah.com/docs
- Endpoints used: /api/astro, /api/dasha, /api/gochar, /api/panchang, /api/ashtakvarga,
  /api/shadbala, /api/vargas, /api/bnn/yogas, /api/bnn/career-marriage, /api/numerology,
  /api/astro/svg.

## Notes

- The session is fully read-only: all methods are authorized as observations; there are no
  write actions (getAutoApprovableActions returns an empty list).
- API responses are returned mostly verbatim; analyzeKundli composes the Hindi report.
